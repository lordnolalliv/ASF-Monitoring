<?php
declare(strict_types=1);

function asf_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    ini_set('session.use_strict_mode', '1');
    ini_set('session.cookie_httponly', '1');
    ini_set('session.cookie_samesite', 'Strict');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function asf_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
        throw new RuntimeException('PHP PDO SQLite is required. Enable the pdo_sqlite extension and restart PHP.');
    }

    $configured = getenv('ASF_DB_PATH');
    $databasePath = $configured !== false && $configured !== ''
        ? $configured
        : dirname(__DIR__) . DIRECTORY_SEPARATOR . 'bohol-asf-data' . DIRECTORY_SEPARATOR . 'bohol-asf.sqlite';
    $directory = dirname($databasePath);
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to create the configured ASF data directory.');
    }
    if (!is_writable($directory)) {
        throw new RuntimeException('The configured ASF data directory is not writable by PHP.');
    }

    $pdo = new PDO('sqlite:' . $databasePath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ("admin", "editor", "viewer")),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY,
            municipality TEXT NOT NULL,
            barangay_code TEXT NOT NULL,
            status TEXT NOT NULL,
            report_date TEXT NOT NULL,
            farms INTEGER NOT NULL DEFAULT 0,
            pigs_affected INTEGER NOT NULL DEFAULT 0,
            pigs_dead INTEGER NOT NULL DEFAULT 0,
            pigs_culled INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT "",
            created_at TEXT NOT NULL,
            updated_at TEXT
        )'
    );
    $pdo->exec('CREATE INDEX IF NOT EXISTS reports_date_idx ON reports(report_date)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS reports_barangay_idx ON reports(barangay_code, report_date)');
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            report_id TEXT NOT NULL,
            location TEXT NOT NULL,
            report_date TEXT NOT NULL,
            changed_fields TEXT NOT NULL DEFAULT "[]",
            timestamp TEXT NOT NULL,
            actor_id TEXT,
            FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
        )'
    );
    $pdo->exec('CREATE INDEX IF NOT EXISTS audit_timestamp_idx ON audit_log(timestamp)');
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS login_attempts (
            username TEXT NOT NULL,
            ip_hash TEXT NOT NULL,
            attempted_at INTEGER NOT NULL
        )'
    );
    $pdo->exec('CREATE INDEX IF NOT EXISTS login_attempts_lookup_idx ON login_attempts(username, ip_hash, attempted_at)');
    chmod($databasePath, 0600);
    $pdo->exec('PRAGMA wal_checkpoint(PASSIVE)');
    return $pdo;
}

function asf_json_response(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}

function asf_read_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 5 * 1024 * 1024) {
        asf_json_response(['error' => 'Request body is missing or exceeds 5 MB.'], 413);
    }
    try {
        $data = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        asf_json_response(['error' => 'Request body must contain valid JSON.'], 400);
    }
    if (!is_array($data)) {
        asf_json_response(['error' => 'Request JSON must be an object.'], 400);
    }
    return $data;
}

function asf_current_user(): ?array
{
    asf_start_session();
    $userId = $_SESSION['user_id'] ?? null;
    if (!is_string($userId)) {
        return null;
    }
    $query = asf_db()->prepare('SELECT id, username, role FROM users WHERE id = ?');
    $query->execute([$userId]);
    $user = $query->fetch();
    if (!$user) {
        $_SESSION = [];
        session_regenerate_id(true);
        return null;
    }
    return $user;
}

function asf_require_user(array $roles = []): array
{
    $user = asf_current_user();
    if (!$user) {
        asf_json_response(['error' => 'Please sign in to continue.'], 401);
    }
    if ($roles && !in_array($user['role'], $roles, true)) {
        asf_json_response(['error' => 'Your account does not have permission for this action.'], 403);
    }
    return $user;
}

function asf_check_origin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return;
    }
    $originParts = parse_url($origin);
    $requestParts = parse_url(
        ((!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https://' : 'http://') .
        ($_SERVER['HTTP_HOST'] ?? '')
    );
    if (!is_array($originParts) || !is_array($requestParts) ||
        strtolower((string) ($originParts['scheme'] ?? '')) !== strtolower((string) ($requestParts['scheme'] ?? '')) ||
        strtolower((string) ($originParts['host'] ?? '')) !== strtolower((string) ($requestParts['host'] ?? '')) ||
        ($originParts['port'] ?? null) !== ($requestParts['port'] ?? null)) {
        asf_json_response(['error' => 'Cross-origin requests are not allowed.'], 403);
    }
}

function asf_require_csrf(): void
{
    asf_start_session();
    asf_check_origin();
    $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $expected = $_SESSION['csrf_token'] ?? '';
    if (!is_string($provided) || !is_string($expected) || $expected === '' || !hash_equals($expected, $provided)) {
        asf_json_response(['error' => 'The security token expired. Refresh the page and try again.'], 403);
    }
}

function asf_new_id(): string
{
    return bin2hex(random_bytes(16));
}

function asf_today(): string
{
    return (new DateTimeImmutable('now'))->format('Y-m-d');
}

function asf_text_length(string $value): int
{
    $count = preg_match_all('/./us', $value);
    if ($count === false) {
        throw new InvalidArgumentException('Text must be valid UTF-8.');
    }
    return $count;
}

function asf_directory(): array
{
    static $directory = null;
    if (is_array($directory)) {
        return $directory;
    }
    $source = file_get_contents(__DIR__ . DIRECTORY_SEPARATOR . 'barangays.js');
    if (is_string($source)) {
        $source = preg_replace('/^\xEF\xBB\xBF/', '', $source);
    }
    if (!is_string($source) || !preg_match('/^window\.BOHOL_BARANGAYS\s*=\s*(\{.*\});\s*$/s', trim($source), $matches)) {
        throw new RuntimeException('Unable to read the bundled barangay directory.');
    }
    $data = json_decode($matches[1], true, 64, JSON_THROW_ON_ERROR);
    $directory = [];
    foreach ($data['municipalities'] ?? [] as $municipality) {
        foreach ($municipality['barangays'] ?? [] as $barangay) {
            $directory[$barangay['code']] = [
                'municipality' => $municipality['name'],
                'name' => $barangay['name'],
            ];
        }
    }
    return $directory;
}

function asf_validate_report(array $report, ?array $existing = null): array
{
    $directory = asf_directory();
    $statusLabels = [
        'No suspected cases' => true,
        'Suspected ASF' => true,
        'Confirmed ASF' => true,
        'Under surveillance' => true,
        'Cleared' => true,
    ];
    $municipality = $report['municipality'] ?? null;
    $barangayCode = $report['barangayCode'] ?? null;
    $status = $report['status'] ?? null;
    $date = $report['date'] ?? null;
    $source = $report['source'] ?? null;
    $notes = $report['notes'] ?? '';
    $id = $report['id'] ?? ($existing['id'] ?? asf_new_id());
    if (!is_string($id) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $id) ||
        !is_string($municipality) || !is_string($barangayCode) ||
        !is_string($status) || !isset($statusLabels[$status]) ||
        !is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) ||
        !checkdate((int) substr($date, 5, 2), (int) substr($date, 8, 2), (int) substr($date, 0, 4)) ||
        !is_string($source) || trim($source) === '' || asf_text_length($source) > 100 ||
        !is_string($notes) || asf_text_length($notes) > 500) {
        throw new InvalidArgumentException('Report has missing or invalid required fields.');
    }
    if (!isset($directory[$barangayCode]) || $directory[$barangayCode]['municipality'] !== $municipality) {
        throw new InvalidArgumentException('Barangay does not belong to the selected municipality.');
    }
    $numbers = [];
    foreach (['farms', 'pigsAffected', 'pigsDead', 'pigsCulled'] as $field) {
        $value = $report[$field] ?? 0;
        if (!is_int($value) || $value < 0 || $value > 1000000000) {
            throw new InvalidArgumentException('Report contains an invalid count.');
        }
        $numbers[$field] = $value;
    }
    if ($numbers['pigsDead'] + $numbers['pigsCulled'] > $numbers['pigsAffected']) {
        throw new InvalidArgumentException('Dead and culled counts cannot exceed pigs affected.');
    }
    return [
        'id' => $id,
        'municipality' => $municipality,
        'barangayCode' => $barangayCode,
        'status' => $status,
        'date' => $date,
        'farms' => $numbers['farms'],
        'pigsAffected' => $numbers['pigsAffected'],
        'pigsDead' => $numbers['pigsDead'],
        'pigsCulled' => $numbers['pigsCulled'],
        'source' => trim($source),
        'notes' => $notes,
        'createdAt' => $existing['createdAt'] ?? ($report['createdAt'] ?? gmdate('c')),
        'updatedAt' => $existing ? gmdate('c') : ($report['updatedAt'] ?? null),
    ];
}

function asf_report_location(array $report): string
{
    $barangay = asf_directory()[$report['barangayCode']]['name'] ?? 'Unknown barangay';
    return $report['municipality'] . ' · ' . $barangay;
}

function asf_add_audit(PDO $pdo, string $action, string $reportId, string $location, string $reportDate, array $changedFields, ?string $actorId): void
{
    $query = $pdo->prepare(
        'INSERT INTO audit_log (id, action, report_id, location, report_date, changed_fields, timestamp, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $query->execute([
        asf_new_id(), $action, $reportId, $location, $reportDate,
        json_encode($changedFields, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
        gmdate('c'), $actorId,
    ]);
    $pdo->exec(
        'DELETE FROM audit_log WHERE id IN (
            SELECT id FROM audit_log ORDER BY timestamp DESC LIMIT -1 OFFSET 1000
        )'
    );
}

function asf_load_reports(PDO $pdo): array
{
    $rows = $pdo->query('SELECT * FROM reports ORDER BY report_date DESC, created_at DESC')->fetchAll();
    return array_map(static fn(array $row): array => [
        'id' => $row['id'],
        'municipality' => $row['municipality'],
        'barangayCode' => $row['barangay_code'],
        'status' => $row['status'],
        'date' => $row['report_date'],
        'farms' => (int) $row['farms'],
        'pigsAffected' => (int) $row['pigs_affected'],
        'pigsDead' => (int) $row['pigs_dead'],
        'pigsCulled' => (int) $row['pigs_culled'],
        'source' => $row['source'],
        'notes' => $row['notes'],
        'createdAt' => $row['created_at'],
        ...($row['updated_at'] !== null ? ['updatedAt' => $row['updated_at']] : []),
    ], $rows);
}

function asf_load_audit(PDO $pdo): array
{
    $rows = $pdo->query(
        'SELECT audit_log.*, users.username AS actor
         FROM audit_log LEFT JOIN users ON users.id = audit_log.actor_id
         ORDER BY audit_log.timestamp DESC LIMIT 1000'
    )->fetchAll();
    return array_map(static fn(array $row): array => [
        'id' => $row['id'],
        'action' => $row['action'],
        'reportId' => $row['report_id'],
        'location' => $row['location'],
        'reportDate' => $row['report_date'],
        'changedFields' => json_decode($row['changed_fields'], true, 32, JSON_THROW_ON_ERROR),
        'timestamp' => $row['timestamp'],
        ...($row['actor'] !== null ? ['actor' => $row['actor']] : []),
    ], $rows);
}

function asf_state(PDO $pdo, array $user): array
{
    return [
        'reports' => asf_load_reports($pdo),
        'auditLog' => asf_load_audit($pdo),
        'user' => ['id' => $user['id'], 'username' => $user['username'], 'role' => $user['role']],
        'csrfToken' => $_SESSION['csrf_token'],
    ];
}
