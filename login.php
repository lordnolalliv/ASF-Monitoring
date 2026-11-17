<?php
declare(strict_types=1);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'backend.php';

try {
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    if (asf_current_user()) {
        header('Location: index.php');
        exit;
    }
    asf_start_session();
    $_SESSION['csrf_token'] ??= bin2hex(random_bytes(32));
    $csrf = htmlspecialchars($_SESSION['csrf_token'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
} catch (Throwable $error) {
    error_log('Bohol ASF login page error: ' . $error->getMessage());
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit('PHP PDO SQLite must be enabled and the server data directory must be writable.');
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f7f4">
  <title>Sign in · Bohol ASF Watch</title>
  <link rel="icon" href="app-icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
  <style>
    body { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .login-card { width: min(440px, 100%); padding: 30px; border: 1px solid var(--line); border-radius: 14px; background: #fff; box-shadow: 0 16px 48px #24372d18; }
    .login-brand { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
    .login-brand img { width: 58px; height: 58px; object-fit: contain; }
    .login-brand strong, .login-brand small { display: block; }
    .login-brand strong { font-size: 19px; }
    .login-brand small { color: var(--muted); font-size: 13px; }
    .login-card h1 { margin: 0 0 6px; font-size: 25px; }
    .login-card > p { margin: 0 0 22px; color: var(--muted); }
    .login-field { display: grid; gap: 6px; margin: 14px 0; color: #48564d; font-size: 13px; font-weight: 650; }
    .login-field input { width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid #dfe6e1; border-radius: 8px; font: inherit; font-weight: 400; }
    .login-field input:focus { outline: 2px solid #88b69a; outline-offset: 1px; }
    .login-card .button { width: 100%; height: 46px; margin-top: 8px; }
    .login-error { padding: 10px 12px; border-radius: 7px; color: #8c342e; background: #fff0ef; font-size: 13px; }
    .login-error:empty { display: none; }
    .login-note { margin-top: 18px !important; font-size: 12px; line-height: 1.55; }
  </style>
</head>
<body>
  <main class="login-card">
    <div class="login-brand">
      <img src="bohol-province-seal.png" alt="">
      <span><strong>Bohol ASF Watch</strong><small>Shared provincial dashboard</small></span>
    </div>
    <h1>Sign in</h1>
    <p>Use your dashboard account to continue.</p>
    <form id="login-form">
      <label class="login-field">Username
        <input name="username" autocomplete="username" maxlength="64" required autofocus>
      </label>
      <label class="login-field">Password
        <input name="password" type="password" autocomplete="current-password" maxlength="1024" required>
      </label>
      <p class="login-error" id="login-error" role="alert"></p>
      <button class="button button-primary" type="submit">Sign in</button>
    </form>
    <p class="login-note">Accounts are provisioned by a system administrator. Contact your administrator if you need access.</p>
  </main>
  <script>
    (() => {
      const form = document.querySelector('#login-form');
      const error = document.querySelector('#login-error');
      const token = <?= json_encode($_SESSION['csrf_token'], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR) ?>;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        const values = new FormData(form);
        try {
          const response = await fetch('api.php?action=login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ username: values.get('username'), password: values.get('password') })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Sign in failed.');
          window.location.assign('index.php');
        } catch (loginError) {
          error.textContent = loginError instanceof Error ? loginError.message : 'Sign in failed. Try again.';
        }
      });
    })();
  </script>
</body>
</html>
