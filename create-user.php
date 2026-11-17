<?php
declare(strict_types=1);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'backend.php';

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$username = $argv[1] ?? '';
$role = $argv[2] ?? 'editor';
if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
    fwrite(STDERR, "Usage: php create-user.php <username> [admin|editor|viewer]\nUsername must be 3–32 letters, numbers, dots, underscores or hyphens.\n");
    exit(2);
}
if (!in_array($role, ['admin', 'editor', 'viewer'], true)) {
    fwrite(STDERR, "Role must be admin, editor, or viewer.\n");
    exit(2);
}

function asf_read_cli_password(string $prompt): string
{
    if (PHP_OS_FAMILY !== 'Windows') {
        fwrite(STDOUT, $prompt . ' (terminal input is visible): ');
        return rtrim((string) fgets(STDIN), "\r\n");
    }
    $script = '$secure = Read-Host ' . var_export($prompt, true) .
        ' -AsSecureString; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); ' .
        'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } ' .
        'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }';
    $encoded = base64_encode(iconv('UTF-8', 'UTF-16LE', $script));
    $process = proc_open(
        'powershell.exe -NoProfile -EncodedCommand ' . $encoded,
        [0 => STDIN, 1 => ['pipe', 'w'], 2 => STDERR],
        $pipes
    );
    if (!is_resource($process)) {
        throw new RuntimeException('Unable to open the secure password prompt.');
    }
    $password = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    if (proc_close($process) !== 0 || !is_string($password)) {
        throw new RuntimeException('Unable to read the password.');
    }
    return rtrim($password, "\r\n");
}

try {
    $pdo = asf_db();
    $hasAdmin = (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn() > 0;
    if (!$hasAdmin && $role !== 'admin') {
        fwrite(STDERR, "Create the first account with the admin role.\n");
        exit(2);
    }
    if ($hasAdmin && $role === 'admin') {
        fwrite(STDERR, "Additional admin accounts must be created by a signed-in admin in the dashboard.\n");
        exit(2);
    }
    $password = asf_read_cli_password('Password (minimum 12 characters)');
    if (strlen($password) < 12 || strlen($password) > 1024) {
        throw new InvalidArgumentException('Password must be at least 12 characters and no more than 1024 bytes.');
    }
    $confirm = $password;
    $confirm = asf_read_cli_password('Confirm password');
    if (!hash_equals($password, $confirm)) {
        throw new InvalidArgumentException('Passwords did not match.');
    }
    $pdo->beginTransaction();
    $hasAdmin = (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn() > 0;
    if (!$hasAdmin && $role !== 'admin') {
        throw new RuntimeException('Create the first account with the admin role.');
    }
    if ($hasAdmin && $role === 'admin') {
        throw new RuntimeException('An administrator account was created while this command was running. Use the dashboard to create additional admin accounts.');
    }
    $now = gmdate('c');
    $insert = $pdo->prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    $insert->execute([asf_new_id(), $username, password_hash($password, PASSWORD_DEFAULT), $role, $now, $now]);
    $pdo->commit();
    fwrite(STDOUT, "Created {$role} account '{$username}'. Sign in at /login.php.\n");
} catch (Throwable $error) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    fwrite(STDERR, 'Unable to create account: ' . $error->getMessage() . "\n");
    exit(1);
} finally {
    if (isset($password)) {
        $password = str_repeat("\0", strlen($password));
    }
    if (isset($confirm)) {
        $confirm = str_repeat("\0", strlen($confirm));
    }
}
