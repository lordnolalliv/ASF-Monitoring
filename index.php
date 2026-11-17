<?php
declare(strict_types=1);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'backend.php';

try {
    $user = asf_current_user();
    if (!$user) {
        header('Location: login.php');
        exit;
    }
    $_SESSION['csrf_token'] ??= bin2hex(random_bytes(32));
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header('Content-Type: text/html; charset=utf-8');

    $html = file_get_contents(__DIR__ . DIRECTORY_SEPARATOR . 'index.html');
    if (!is_string($html)) {
        throw new RuntimeException('Unable to read the dashboard page.');
    }
    $config = json_encode([
        'enabled' => true,
        'username' => $user['username'],
        'role' => $user['role'],
        'csrfToken' => $_SESSION['csrf_token'],
    ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
    $html = str_replace(
        '<script src="app.js" defer></script>',
        '<script>window.BOHOL_ASF_BACKEND = ' . $config . ';</script>' . "\n    " .
        '<script src="app.js?v=backend-1" defer></script>',
        $html
    );
    if ($user['role'] === 'admin') {
        $html = str_replace('href="admin.html"', 'href="admin.php"', $html);
    } else {
        $html = str_replace(
            '<a class="button button-secondary admin-nav" href="admin.html">Admin</a>',
            '',
            $html
        );
        $html = str_replace('<a href="admin.html">Admin</a>', '', $html);
    }
    $html = str_replace(
        '<link rel="manifest" href="manifest.json">',
        '<link rel="manifest" href="manifest.php">',
        $html
    );
    $html = str_replace('Browser-based records', 'Shared server records', $html);
    $html = str_replace(
        'Local African swine fever surveillance reporting for Bohol municipalities and barangays.',
        'Shared African swine fever surveillance reporting for Bohol municipalities and barangays.',
        $html
    );
    $html = str_replace('Local browser storage', 'Shared server database', $html);
    $html = str_replace(
        '<button class="button button-secondary" id="install-app" type="button" hidden>Install app</button>',
        '<span class="signed-in-user">' . htmlspecialchars($user['username'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') .
        ' · ' . htmlspecialchars(ucfirst($user['role']), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</span>' .
        '<form class="logout-form" action="logout.php" method="post"><input type="hidden" name="csrf" value="' .
        htmlspecialchars($_SESSION['csrf_token'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') .
        '"><button class="button button-secondary" type="submit">Sign out</button></form>',
        $html
    );
    echo $html;
} catch (Throwable $error) {
    error_log('Bohol ASF dashboard error: ' . $error->getMessage());
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'The dashboard could not start. Check that PHP PDO SQLite is enabled and the data directory is writable.';
}
