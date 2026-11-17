<?php
declare(strict_types=1);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'backend.php';

asf_start_session();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

try {
    if ($method === 'GET' && $action === 'csrf') {
        $_SESSION['csrf_token'] ??= bin2hex(random_bytes(32));
        asf_json_response(['csrfToken' => $_SESSION['csrf_token']]);
    }

    if ($method === 'POST' && $action === 'login') {
        asf_require_csrf();
        $input = asf_read_json();
        $username = is_string($input['username'] ?? null) ? trim($input['username']) : '';
        $password = is_string($input['password'] ?? null) ? $input['password'] : '';
        if ($username === '' || strlen($username) > 64 || $password === '' || strlen($password) > 1024) {
            asf_json_response(['error' => 'Enter a valid username and password.'], 400);
        }
        $pdo = asf_db();
        $since = time() - 900;
        $attempt = $pdo->prepare('SELECT COUNT(*) FROM login_attempts WHERE username = ? COLLATE NOCASE AND attempted_at >= ?');
        $attempt->execute([$username, $since]);
        if ((int) $attempt->fetchColumn() >= 5) {
            header('Retry-After: 900');
            asf_json_response(['error' => 'Too many sign-in attempts. Wait 15 minutes and try again.'], 429);
        }
        $query = $pdo->prepare('SELECT id, username, password_hash, role FROM users WHERE username = ? COLLATE NOCASE');
        $query->execute([$username]);
        $user = $query->fetch();
        if (!$user || !password_verify($password, $user['password_hash'])) {
            $record = $pdo->prepare('INSERT INTO login_attempts (username, ip_hash, attempted_at) VALUES (?, ?, ?)');
            $record->execute([
                $username,
                hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown'),
                time(),
            ]);
            asf_json_response(['error' => 'Username or password is incorrect.'], 401);
        }
        $clear = $pdo->prepare('DELETE FROM login_attempts WHERE username = ? COLLATE NOCASE');
        $clear->execute([$username]);
        session_regenerate_id(true);
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
        asf_json_response([
            'user' => ['id' => $user['id'], 'username' => $user['username'], 'role' => $user['role']],
            'csrfToken' => $_SESSION['csrf_token'],
        ]);
    }

    if ($method === 'POST' && $action === 'logout') {
        asf_require_csrf();
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => time() - 42000,
                'path' => $params['path'],
                'domain' => $params['domain'],
                'secure' => $params['secure'],
                'httponly' => true,
                'samesite' => 'Strict',
            ]);
        }
        session_destroy();
        asf_json_response(['ok' => true]);
    }

    $user = asf_require_user();
    $pdo = asf_db();
    if ($method === 'GET' && $action === 'state') {
        $_SESSION['csrf_token'] ??= bin2hex(random_bytes(32));
        asf_json_response(asf_state($pdo, $user));
    }
    if ($method === 'GET' && $action === 'backup') {
        asf_json_response([
            'format' => 'bohol-asf-watch-backup',
            'version' => 2,
            'exportedAt' => gmdate('c'),
            'reports' => asf_load_reports($pdo),
            'auditLog' => asf_load_audit($pdo),
        ]);
    }
    if ($method === 'GET' && $action === 'users') {
        asf_require_user(['admin']);
        $users = $pdo->query('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY username COLLATE NOCASE')->fetchAll();
        asf_json_response(['users' => $users]);
    }

    if ($method === 'POST') {
        asf_require_csrf();
        $input = asf_read_json();
        if ($action === 'report') {
            asf_require_user(['admin', 'editor']);
            $candidate = is_array($input['report'] ?? null) ? $input['report'] : [];
            $existingQuery = $pdo->prepare('SELECT * FROM reports WHERE id = ?');
            $existingQuery->execute([is_string($candidate['id'] ?? null) ? $candidate['id'] : '']);
            $row = $existingQuery->fetch() ?: null;
            $existing = $row ? asf_row_to_report($row) : null;
            $report = asf_validate_report($candidate, $existing);
            $pdo->beginTransaction();
            if ($existing) {
                $fields = [
                    'municipality' => 'Municipality',
                    'barangayCode' => 'Barangay',
                    'status' => 'Status',
                    'date' => 'Report date',
                    'farms' => 'Affected farms',
                    'pigsAffected' => 'Pigs affected',
                    'pigsDead' => 'Pigs dead',
                    'pigsCulled' => 'Pigs culled',
                    'source' => 'Source',
                    'notes' => 'Notes',
                ];
                $changed = [];
                foreach ($fields as $key => $label) {
                    if ($existing[$key] !== $report[$key]) {
                        $changed[] = $label;
                    }
                }
                if (!$changed) {
                    $pdo->commit();
                    asf_json_response(asf_state($pdo, $user));
                }
                asf_store_report($pdo, $report);
                asf_add_audit($pdo, 'edited', $report['id'], asf_report_location($report), $report['date'], $changed, $user['id']);
                $actionName = 'edited';
            } else {
                asf_store_report($pdo, $report);
                asf_add_audit($pdo, 'created', $report['id'], asf_report_location($report), $report['date'], [], $user['id']);
                $actionName = 'created';
            }
            $pdo->commit();
            asf_json_response(asf_state($pdo, $user) + ['savedAction' => $actionName]);
        }
        if ($action === 'restore') {
            asf_require_user(['admin']);
            $backup = $input['backup'] ?? null;
            $restored = asf_validate_backup($backup);
            $pdo->beginTransaction();
            $pdo->exec('DELETE FROM reports');
            $pdo->exec('DELETE FROM audit_log');
            foreach ($restored['reports'] as $report) {
                asf_store_report($pdo, $report);
            }
            foreach ($restored['auditLog'] as $event) {
                asf_store_audit($pdo, $event);
            }
            asf_add_audit(
                $pdo,
                'restored',
                'backup',
                'Backup file',
                asf_today(),
                ['Restored ' . count($restored['reports']) . ' reports'],
                $user['id']
            );
            $pdo->commit();
            asf_json_response(asf_state($pdo, $user));
        }
        if ($action === 'users') {
            asf_require_user(['admin']);
            $username = trim(is_string($input['username'] ?? null) ? $input['username'] : '');
            $password = is_string($input['password'] ?? null) ? $input['password'] : '';
            $role = $input['role'] ?? '';
            if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username) ||
                strlen($password) < 12 || strlen($password) > 1024 ||
                !in_array($role, ['admin', 'editor', 'viewer'], true)) {
                asf_json_response(['error' => 'Use a 3–32 character username, a 12–1024 byte password, and a valid role.'], 422);
            }
            try {
                $create = $pdo->prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
                $now = gmdate('c');
                $create->execute([asf_new_id(), $username, password_hash($password, PASSWORD_DEFAULT), $role, $now, $now]);
            } catch (PDOException $error) {
                if (str_contains($error->getMessage(), 'UNIQUE')) {
                    asf_json_response(['error' => 'That username is already in use.'], 409);
                }
                throw $error;
            }
            asf_json_response(['users' => asf_load_users($pdo)]);
        }
    }

    if ($method === 'PUT' && $action === 'users') {
        asf_require_csrf();
        asf_require_user(['admin']);
        $input = asf_read_json();
        $id = is_string($input['id'] ?? null) ? $input['id'] : '';
        $role = $input['role'] ?? '';
        if (!in_array($role, ['admin', 'editor', 'viewer'], true)) {
            asf_json_response(['error' => 'Select a valid account role.'], 422);
        }
        $pdo->beginTransaction();
        $target = $pdo->prepare('SELECT id, role FROM users WHERE id = ?');
        $target->execute([$id]);
        $account = $target->fetch();
        if (!$account) {
            $pdo->rollBack();
            asf_json_response(['error' => 'Account not found.'], 404);
        }
        if ($id === $user['id']) {
            $pdo->rollBack();
            asf_json_response(['error' => 'You cannot change the role of your own signed-in account.'], 409);
        }
        if ($account['role'] === 'admin' && $role !== 'admin' && (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn() <= 1) {
            $pdo->rollBack();
            asf_json_response(['error' => 'At least one administrator account must remain.'], 409);
        }
        $update = $pdo->prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?');
        $update->execute([$role, gmdate('c'), $id]);
        $pdo->commit();
        asf_json_response(['users' => asf_load_users($pdo)]);
    }

    if ($method === 'DELETE' && $action === 'users') {
        asf_require_csrf();
        asf_require_user(['admin']);
        $id = is_string($_GET['id'] ?? null) ? $_GET['id'] : '';
        $pdo->beginTransaction();
        if ($id === $user['id']) {
            $pdo->rollBack();
            asf_json_response(['error' => 'You cannot delete your own signed-in account.'], 409);
        }
        $target = $pdo->prepare('SELECT id, role FROM users WHERE id = ?');
        $target->execute([$id]);
        $account = $target->fetch();
        if (!$account) {
            $pdo->rollBack();
            asf_json_response(['error' => 'Account not found.'], 404);
        }
        if ($account['role'] === 'admin' && (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn() <= 1) {
            $pdo->rollBack();
            asf_json_response(['error' => 'At least one administrator account must remain.'], 409);
        }
        $delete = $pdo->prepare('DELETE FROM users WHERE id = ?');
        $delete->execute([$id]);
        $pdo->commit();
        asf_json_response(['users' => asf_load_users($pdo)]);
    }

    if ($method === 'DELETE' && $action === 'report') {
        asf_require_csrf();
        asf_require_user(['admin', 'editor']);
        $id = is_string($_GET['id'] ?? null) ? $_GET['id'] : '';
        $query = $pdo->prepare('SELECT * FROM reports WHERE id = ?');
        $query->execute([$id]);
        $row = $query->fetch();
        if (!$row) {
            asf_json_response(['error' => 'Report not found.'], 404);
        }
        $report = asf_row_to_report($row);
        $pdo->beginTransaction();
        $delete = $pdo->prepare('DELETE FROM reports WHERE id = ?');
        $delete->execute([$id]);
        asf_add_audit($pdo, 'deleted', $id, asf_report_location($report), $report['date'], [], $user['id']);
        $pdo->commit();
        asf_json_response(asf_state($pdo, $user));
    }

    asf_json_response(['error' => 'Unknown API action.'], 404);
} catch (InvalidArgumentException $error) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    asf_json_response(['error' => $error->getMessage()], 422);
} catch (Throwable $error) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('Bohol ASF API error: ' . $error->getMessage());
    asf_json_response(['error' => 'The server could not complete this request. Check the PHP server log.'], 500);
}

function asf_row_to_report(array $row): array
{
    return [
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
    ];
}

function asf_store_report(PDO $pdo, array $report): void
{
    $query = $pdo->prepare(
        'INSERT INTO reports (id, municipality, barangay_code, status, report_date, farms, pigs_affected, pigs_dead, pigs_culled, source, notes, created_at, updated_at)
         VALUES (:id, :municipality, :barangay_code, :status, :report_date, :farms, :pigs_affected, :pigs_dead, :pigs_culled, :source, :notes, :created_at, :updated_at)
         ON CONFLICT(id) DO UPDATE SET municipality=excluded.municipality, barangay_code=excluded.barangay_code, status=excluded.status,
         report_date=excluded.report_date, farms=excluded.farms, pigs_affected=excluded.pigs_affected, pigs_dead=excluded.pigs_dead,
         pigs_culled=excluded.pigs_culled, source=excluded.source, notes=excluded.notes, created_at=excluded.created_at, updated_at=excluded.updated_at'
    );
    $query->execute([
        ':id' => $report['id'],
        ':municipality' => $report['municipality'],
        ':barangay_code' => $report['barangayCode'],
        ':status' => $report['status'],
        ':report_date' => $report['date'],
        ':farms' => $report['farms'],
        ':pigs_affected' => $report['pigsAffected'],
        ':pigs_dead' => $report['pigsDead'],
        ':pigs_culled' => $report['pigsCulled'],
        ':source' => $report['source'],
        ':notes' => $report['notes'],
        ':created_at' => $report['createdAt'],
        ':updated_at' => $report['updatedAt'],
    ]);
}

function asf_store_audit(PDO $pdo, array $event): void
{
    $query = $pdo->prepare(
        'INSERT INTO audit_log (id, action, report_id, location, report_date, changed_fields, timestamp, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
    );
    $query->execute([
        $event['id'], $event['action'], $event['reportId'], $event['location'], $event['reportDate'],
        json_encode($event['changedFields'], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), $event['timestamp'],
    ]);
}

function asf_validate_backup(mixed $backup): array
{
    if (!is_array($backup) || ($backup['format'] ?? null) !== 'bohol-asf-watch-backup' ||
        !in_array($backup['version'] ?? null, [1, 2], true) ||
        !is_array($backup['reports'] ?? null) || count($backup['reports']) > 50000) {
        throw new InvalidArgumentException('This file is not a supported Bohol ASF Watch backup.');
    }
    $reports = [];
    $ids = [];
    foreach ($backup['reports'] as $index => $candidate) {
        if (!is_array($candidate)) {
            throw new InvalidArgumentException('Report ' . ($index + 1) . ' is invalid.');
        }
        $report = asf_validate_report($candidate);
        if (isset($ids[$report['id']])) {
            throw new InvalidArgumentException('The backup contains duplicate report IDs.');
        }
        $ids[$report['id']] = true;
        $reports[] = $report;
    }
    $events = $backup['version'] === 2 ? ($backup['auditLog'] ?? null) : [];
    if (!is_array($events) || count($events) > 1000) {
        throw new InvalidArgumentException('The backup contains an invalid change history.');
    }
    $auditLog = [];
    foreach ($events as $index => $event) {
        if (!is_array($event) ||
            !is_string($event['id'] ?? null) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $event['id']) ||
            !in_array($event['action'] ?? null, ['created', 'edited', 'deleted', 'restored'], true) ||
            !is_string($event['reportId'] ?? null) ||
            !is_string($event['location'] ?? null) || strlen($event['location']) > 250 ||
            !is_string($event['reportDate'] ?? null) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $event['reportDate']) ||
            !checkdate((int) substr($event['reportDate'], 5, 2), (int) substr($event['reportDate'], 8, 2), (int) substr($event['reportDate'], 0, 4)) ||
            !is_string($event['timestamp'] ?? null) || strtotime($event['timestamp']) === false ||
            !is_array($event['changedFields'] ?? [])) {
            throw new InvalidArgumentException('Change history entry ' . ($index + 1) . ' is invalid.');
        }
        $auditLog[] = [
            'id' => $event['id'],
            'action' => $event['action'],
            'reportId' => $event['reportId'],
            'location' => $event['location'],
            'reportDate' => $event['reportDate'],
            'changedFields' => array_values(array_filter($event['changedFields'], 'is_string')),
            'timestamp' => $event['timestamp'],
        ];
    }
    return ['reports' => $reports, 'auditLog' => $auditLog];
}

function asf_load_users(PDO $pdo): array
{
    return $pdo->query('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY username COLLATE NOCASE')->fetchAll();
}
