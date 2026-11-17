<?php
declare(strict_types=1);

header('Content-Type: application/manifest+json; charset=utf-8');
header('Cache-Control: no-cache');

$manifest = json_decode(
    file_get_contents(__DIR__ . DIRECTORY_SEPARATOR . 'manifest.json') ?: '',
    true,
    32,
    JSON_THROW_ON_ERROR
);
$manifest['start_url'] = './index.php';
echo json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
