<?php
return [
    // Provide the cookies that mapa.zsr.sk sets when you log into the site (copy from devtools).
    'cookies' => 'MapaZsr_TechnicalCookieName=1; ASP.NET_SessionId=PUT_YOURS_HERE; AVI_COOKIE=PUT_YOURS_HERE',
    'endpoint' => 'https://mapa.zsr.sk/api/action',
    'action' => 'gtall',
    'args' => '{}',
    'cache_file' => __DIR__ . '/cache.json',
    'log_file' => __DIR__ . '/proxy.log',
    'osm_endpoint' => 'https://overpass-api.de/api/interpreter',
    'osm_timeout' => 60,
    'osm_cache_dir' => __DIR__ . '/osm-cache',
    'osm_cache_duration' => 604800, // 7 days
];


