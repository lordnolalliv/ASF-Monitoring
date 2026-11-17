<?php
declare(strict_types=1);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'backend.php';

asf_start_session();
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' ||
    !is_string($_POST['csrf'] ?? null) ||
    !is_string($_SESSION['csrf_token'] ?? null) ||
    !hash_equals($_SESSION['csrf_token'], $_POST['csrf'])) {
    http_response_code(403);
    exit('Invalid sign-out request. Reload the dashboard and try again.');
}
asf_check_origin();
$_SESSION = [];
$params = session_get_cookie_params();
setcookie(session_name(), '', [
    'expires' => time() - 42000,
    'path' => $params['path'],
    'domain' => $params['domain'],
    'secure' => $params['secure'],
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_destroy();
header('Location: login.php');
exit;
