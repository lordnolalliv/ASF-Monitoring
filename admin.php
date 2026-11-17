<?php
declare(strict_types=1);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'backend.php';

try {
    $user = asf_current_user();
    if (!$user) {
        header('Location: login.php');
        exit;
    }
    if ($user['role'] !== 'admin') {
        header('Location: index.php');
        exit;
    }
    $_SESSION['csrf_token'] ??= bin2hex(random_bytes(32));
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header('Content-Type: text/html; charset=utf-8');

    $html = file_get_contents(__DIR__ . DIRECTORY_SEPARATOR . 'admin.html');
    if (!is_string($html)) {
        throw new RuntimeException('Unable to read the administration page.');
    }
    $config = json_encode([
        'enabled' => true,
        'username' => $user['username'],
        'role' => $user['role'],
        'csrfToken' => $_SESSION['csrf_token'],
    ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
    $html = str_replace(
        '<script src="admin.js" defer></script>',
        '<script>window.BOHOL_ASF_BACKEND = ' . $config . ';</script>' . "\n    " .
        '<script src="admin.js?v=backend-1" defer></script>',
        $html
    );
    $html = str_replace('href="index.html"', 'href="index.php"', $html);
    $html = str_replace(
        'Browser-only administration',
        'Protected server administration',
        $html
    );
    $html = str_replace(
        'This page uses local browser storage and does not provide sign-in or account protection. Use the PHP server version for shared, role-protected administration.',
        'This page is available only to signed-in Admin accounts. Shared reports and account data are stored on the server.',
        $html
    );
    $html = str_replace(
        'Manage browser data, backups, sample records, and change history.',
        'Manage shared data, accounts, backups, and change history.',
        $html
    );
    $html = str_replace(
        'Create a backup before replacing browser records.',
        'Create a backup before replacing shared server records.',
        $html
    );
    $html = str_replace('Saved to this browser', 'Saved to the shared database', $html);
    echo $html;
} catch (Throwable $error) {
    error_log('Bohol ASF admin page error: ' . $error->getMessage());
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'The administration page could not start. Check that PHP PDO SQLite is enabled and the data directory is writable.';
}
