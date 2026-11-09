<?php
$config = require __DIR__ . '/config.php';
$mode = $_GET['mode'] ?? 'gtall';
if ($mode === 'osm') {
    handleOsmProxy($config);
    exit;
}
$cacheFile = $config['cache_file'];
$logFile = $config['log_file'];

$now = time();
$state = [
    'lastFetch' => 0,
    'lastPing' => 0,
    'data' => null,
    'status' => 'idle',
    'error' => null,
    'raw' => null,
    'cookies' => null,
    'cookieUpdated' => 0,
];
if (file_exists($cacheFile)) {
    $loaded = json_decode(file_get_contents($cacheFile), true);
    if (is_array($loaded)) {
        $state = array_merge($state, $loaded);
    }
}

$state['lastPing'] = $now;
$force = isset($_GET['refresh']) || isset($_POST['refresh']);
$handshakeNeeded = !$state['cookies'] || ($now - $state['cookieUpdated'] >= 1800);
 $shouldFetch = $force || ($now - $state['lastFetch'] >= 30);

if ($shouldFetch) {
    if ($handshakeNeeded) {
        $handshake = performHandshake($config['endpoint'], $state, $logFile);
        if (!$handshake) {
            outputState($state);
            exit;
        }
    }
    $ch = curl_init($config['endpoint']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    $postFields = http_build_query(['action' => $config['action'], 'args' => $config['args']]);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
        'Origin: https://mapa.zsr.sk',
        'Referer: https://mapa.zsr.sk/index.aspx',
    ]);
    curl_setopt($ch, CURLOPT_ENCODING, 'gzip, deflate, br');
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    $cookie = $state['cookies'] ?? $config['cookies'];
    $headers = [
        'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
        'Origin: https://mapa.zsr.sk',
        'Referer: https://mapa.zsr.sk/index.aspx',
    ];
    if ($cookie) {
        $headers[] = 'Cookie: ' . $cookie;
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    $result = curl_exec($ch);
    $errno = curl_errno($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($errno || $httpCode !== 200 || !$result) {
        $state['status'] = 'error';
        $state['error'] = curl_error($ch) ?: "HTTP $httpCode";
        logMessage($logFile, "Fetch failed: {$state['error']}");
    } else {
$state['data'] = json_decode($result, true);
        $state['lastFetch'] = $now;
        $state['status'] = 'fresh';
        $state['error'] = null;
        $state['raw'] = $result;
        logMessage($logFile, "Fetched gtall at $now, {httpCode:$httpCode}");
    }
}

file_put_contents($cacheFile, json_encode($state));

header('Content-Type: application/json');
echo json_encode([
    'source' => 'proxy',
    'lastFetch' => $state['lastFetch'],
    'idleSeconds' => $now - $state['lastPing'],
    'status' => $state['status'],
    'error' => $state['error'],
    'data' => $state['data'] ?? [],
]);

function logMessage($file, $message) {
    $line = sprintf("[%s] %s\n", date('c'), $message);
    file_put_contents($file, $line, FILE_APPEND);
}

function performHandshake($endpoint, &$state, $logFile) {
    $ch = curl_init('https://mapa.zsr.sk/index.aspx');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_NOBODY, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Accept: text/html',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    ]);
    $result = curl_exec($ch);
    $errno = curl_errno($ch);
    if ($errno) {
        logMessage($logFile, 'Handshake failed: ' . curl_error($ch));
        return false;
    }
    $headers = substr($result, 0, curl_getinfo($ch, CURLINFO_HEADER_SIZE));
    $cookie = parseCookies($headers);
    if (!$cookie) {
        logMessage($logFile, 'Handshake produced no cookies');
        return false;
    }
    $state['cookies'] = $cookie;
    $state['cookieUpdated'] = time();
    logMessage($logFile, 'Handshake succeeded, cookies refreshed');
    return true;
}

function parseCookies($headers) {
    preg_match_all('/Set-Cookie: ([^=]+=[^;]+);?/i', $headers, $matches);
    if (empty($matches[1])) {
        return null;
    }
    return implode('; ', $matches[1]);
}

function outputState($state) {
    header('Content-Type: application/json');
    echo json_encode([
        'source' => 'proxy',
        'status' => $state['status'],
        'lastFetch' => $state['lastFetch'],
        'error' => $state['error'],
        'cookies' => $state['cookies'] ? true : false,
        'data' => $state['data'] ?? [],
    ]);
}

function handleOsmProxy($config) {
    $bounds = [
        'minLat' => filter_var($_GET['minLat'] ?? null, FILTER_VALIDATE_FLOAT),
        'maxLat' => filter_var($_GET['maxLat'] ?? null, FILTER_VALIDATE_FLOAT),
        'minLng' => filter_var($_GET['minLng'] ?? null, FILTER_VALIDATE_FLOAT),
        'maxLng' => filter_var($_GET['maxLng'] ?? null, FILTER_VALIDATE_FLOAT),
    ];

    if (in_array(null, $bounds, true)) {
        http_response_code(400);
        sendJsonResponse(['error' => 'Missing bounding box parameters']);
        return;
    }

    $level = $_GET['level'] ?? 'tile';
    $cacheDir = $config['osm_cache_dir'] ?? __DIR__ . '/osm-cache';
    if (!is_dir($cacheDir)) {
        mkdir($cacheDir, 0755, true);
    }

    if (isset($_GET['purge'])) {
        $files = glob($cacheDir . '/*.json') ?: [];
        foreach ($files as $file) {
            @unlink($file);
        }
        logMessage($config['log_file'], 'Purged osm cache');
        sendJsonResponse(['purged' => true], ['status' => 'purged']);
        return;
    }

    $tileKey = buildOsmTileKey($level, $bounds);
    $cacheFile = $cacheDir . '/' . $tileKey . '.json';
    $cacheDuration = $config['osm_cache_duration'] ?? 604800;
    $now = time();
    $forceRefresh = isset($_GET['refresh']);
    $cachedAge = null;

    if (file_exists($cacheFile)) {
        $cachedAge = $now - filemtime($cacheFile);
    }

    $shouldUseCache = !$forceRefresh && $cachedAge !== null && $cachedAge <= $cacheDuration;

    if ($shouldUseCache) {
        $payload = json_decode(file_get_contents($cacheFile), true) ?? [];
        logMessage($config['log_file'], "Serving cached osm tile {$tileKey}, age {$cachedAge}s");
        sendJsonResponse($payload, [
            'tileKey' => $tileKey,
            'cacheAge' => $cachedAge,
            'status' => 'cached',
        ]);
        return;
    }

    $payload = fetchOsmFromOverpass($bounds, $config, $tileKey);

    if ($payload) {
        file_put_contents($cacheFile, json_encode($payload), LOCK_EX);
        logMessage($config['log_file'], "Fetched osm tile {$tileKey} from Overpass");
        sendJsonResponse($payload, [
            'tileKey' => $tileKey,
            'cacheAge' => 0,
            'status' => 'fetched',
        ]);
        return;
    }

    if ($cachedAge !== null) {
        $payload = json_decode(file_get_contents($cacheFile), true) ?? [];
        logMessage($config['log_file'], "Returning stale osm tile {$tileKey} after fetch failure");
        sendJsonResponse($payload, [
            'tileKey' => $tileKey,
            'cacheAge' => $cachedAge,
            'status' => 'stale',
        ]);
        return;
    }

    http_response_code(502);
    sendJsonResponse(['error' => 'Failed to fetch osm tile', 'tileKey' => $tileKey]);
}

function fetchOsmFromOverpass(array $bounds, $config, string $tileKey) {
    $endpoint = $config['osm_endpoint'] ?? 'https://overpass-api.de/api/interpreter';
    $timeout = $config['osm_timeout'] ?? 60;
    $query = sprintf(
        '[out:json][timeout:%d];
(
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]["service"!~"^(spur|siding|yard|crossover|driveway)$"]["usage"!~"^(industrial|military|test|tourism)$"](%f,%f,%f,%f);
);
out geom;',
        $timeout,
        $bounds['minLat'],
        $bounds['minLng'],
        $bounds['maxLat'],
        $bounds['maxLng']
    );

    $ch = curl_init($endpoint);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $query);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: text/plain',
    ]);
    curl_setopt($ch, CURLOPT_ENCODING, 'gzip, deflate, br');
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
    $result = curl_exec($ch);
    $errno = curl_errno($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);

    if ($errno || $httpCode !== 200 || !$result) {
        logMessage(
            $config['log_file'],
            sprintf('Overpass fetch failed (%s): %s', $tileKey, $errno ? $curlError : "HTTP $httpCode")
        );
        return null;
    }

    $decoded = json_decode($result, true);
    return is_array($decoded) ? $decoded : null;
}

function buildOsmTileKey(string $level, array $bounds): string {
    $format = function ($value) {
        return str_replace('-', 'm', number_format($value, 5, '.', ''));
    };

    return sprintf(
        '%s_%s_%s_%s_%s',
        preg_replace('/[^a-z0-9_-]/i', '', strtolower($level)),
        $format($bounds['minLat']),
        $format($bounds['minLng']),
        $format($bounds['maxLat']),
        $format($bounds['maxLng'])
    );
}

function sendJsonResponse(array $payload, array $meta = []) {
    header('Content-Type: application/json');
    if (!empty($meta)) {
        $payload['__proxy_meta'] = $meta;
    }
    echo json_encode($payload);
}

