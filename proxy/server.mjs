import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseTrainDetail } from './trainDetail.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  cookies: process.env.PROXY_COOKIES ?? '',
  endpoint: process.env.PROXY_ENDPOINT ?? 'https://mapa.zsr.sk/api/action',
  action: process.env.PROXY_ACTION ?? 'gtall',
  args: process.env.PROXY_ARGS ?? '{}',
  cacheFile: process.env.PROXY_CACHE_FILE ?? path.join(__dirname, 'cache.json'),
  logFile: process.env.PROXY_LOG_FILE ?? path.join(__dirname, 'proxy.log'),
  osmEndpoint: process.env.OSM_ENDPOINT ?? 'https://overpass-api.de/api/interpreter',
  osmTimeout: Number(process.env.OSM_TIMEOUT ?? 60),
  osmCacheDir: process.env.OSM_CACHE_DIR ?? path.join(__dirname, 'osm-cache'),
  osmCacheDuration: Number(process.env.OSM_CACHE_DURATION ?? 604800),
};

const port = Number(process.env.PROXY_PORT ?? 3001);
const staticRoot = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : '';

const detailCache = new Map();
const DETAIL_CACHE_MS = 60_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function logMessage(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(config.logFile, line);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function sendJson(res, statusCode, payload, meta) {
  const body = meta ? { ...payload, __proxy_meta: meta } : payload;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function parseCookies(headers) {
  const setCookies = headers.getSetCookie?.() ?? [];
  const cookies = setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean);
  return cookies.length > 0 ? cookies.join('; ') : null;
}

async function performHandshake(state) {
  const response = await fetch('https://mapa.zsr.sk/index.aspx', {
    method: 'HEAD',
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    redirect: 'manual',
  });

  const cookie = parseCookies(response.headers);
  if (!cookie) {
    logMessage('Handshake produced no cookies');
    return false;
  }

  state.cookies = cookie;
  state.cookieUpdated = Math.floor(Date.now() / 1000);
  logMessage('Handshake succeeded, cookies refreshed');
  return true;
}

async function handleGtall(reqUrl, res) {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    lastFetch: 0,
    lastPing: 0,
    data: null,
    status: 'idle',
    error: null,
    raw: null,
    cookies: null,
    cookieUpdated: 0,
    ...readJson(config.cacheFile, {}),
  };

  state.lastPing = now;
  const force = reqUrl.searchParams.has('refresh');
  const handshakeNeeded = !state.cookies || now - (state.cookieUpdated ?? 0) >= 1800;
  const shouldFetch = force || now - (state.lastFetch ?? 0) >= 30;

  if (shouldFetch) {
    if (handshakeNeeded) {
      const handshakeOk = await performHandshake(state);
      if (!handshakeOk) {
        sendJson(res, 200, {
          source: 'proxy',
          status: state.status,
          lastFetch: state.lastFetch,
          error: state.error,
          cookies: Boolean(state.cookies),
          data: state.data ?? [],
        });
        return;
      }
    }

    const cookie = state.cookies || config.cookies;
    const postFields = new URLSearchParams({
      action: config.action,
      args: config.args,
    });

    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: 'https://mapa.zsr.sk',
          Referer: 'https://mapa.zsr.sk/index.aspx',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: postFields.toString(),
      });

      const result = await response.text();
      if (!response.ok || !result) {
        state.status = 'error';
        state.error = `HTTP ${response.status}`;
        logMessage(`Fetch failed: ${state.error}`);
      } else {
        state.data = JSON.parse(result);
        state.lastFetch = now;
        state.status = 'fresh';
        state.error = null;
        state.raw = result;
        logMessage(`Fetched gtall at ${now}, {httpCode:${response.status}}`);
      }
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      logMessage(`Fetch failed: ${state.error}`);
    }
  }

  writeJson(config.cacheFile, state);
  sendJson(res, 200, {
    source: 'proxy',
    lastFetch: state.lastFetch,
    idleSeconds: now - state.lastPing,
    status: state.status,
    error: state.error,
    data: state.data ?? [],
  });
}

function buildOsmTileKey(level, bounds) {
  const format = (value) => String(Number(value).toFixed(5)).replace(/-/g, 'm');
  const safeLevel = level.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `${safeLevel}_${format(bounds.minLat)}_${format(bounds.minLng)}_${format(bounds.maxLat)}_${format(bounds.maxLng)}`;
}

async function fetchOsmFromOverpass(bounds, tileKey) {
  const query = `[out:json][timeout:${config.osmTimeout}];
(
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"](${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng});
);
out geom;`;

  try {
    const response = await fetch(config.osmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': '3Drail-frontend/1.0 (railmap proxy)',
      },
      body: query,
      signal: AbortSignal.timeout(config.osmTimeout * 1000),
    });

    const result = await response.text();
    if (!response.ok || !result) {
      logMessage(`Overpass fetch failed (${tileKey}): HTTP ${response.status}`);
      return null;
    }

    const decoded = JSON.parse(result);
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Overpass fetch failed (${tileKey}): ${message}`);
    return null;
  }
}

async function handleOsm(reqUrl, res) {
  const minLat = Number(reqUrl.searchParams.get('minLat'));
  const maxLat = Number(reqUrl.searchParams.get('maxLat'));
  const minLng = Number(reqUrl.searchParams.get('minLng'));
  const maxLng = Number(reqUrl.searchParams.get('maxLng'));

  if ([minLat, maxLat, minLng, maxLng].some((value) => Number.isNaN(value))) {
    sendJson(res, 400, { error: 'Missing bounding box parameters' });
    return;
  }

  const bounds = { minLat, maxLat, minLng, maxLng };
  const level = reqUrl.searchParams.get('level') ?? 'tile';
  fs.mkdirSync(config.osmCacheDir, { recursive: true });

  if (reqUrl.searchParams.has('purge')) {
    const files = fs.readdirSync(config.osmCacheDir).filter((file) => file.endsWith('.json'));
    for (const file of files) {
      fs.unlinkSync(path.join(config.osmCacheDir, file));
    }
    logMessage('Purged osm cache');
    sendJson(res, 200, { purged: true }, { status: 'purged' });
    return;
  }

  const tileKey = buildOsmTileKey(level, bounds);
  const cacheFile = path.join(config.osmCacheDir, `${tileKey}.json`);
  const now = Math.floor(Date.now() / 1000);
  const forceRefresh = reqUrl.searchParams.has('refresh');
  const cachedAge = fs.existsSync(cacheFile)
    ? now - Math.floor(fs.statSync(cacheFile).mtimeMs / 1000)
    : null;
  const shouldUseCache =
    !forceRefresh && cachedAge !== null && cachedAge <= config.osmCacheDuration;

  if (shouldUseCache) {
    const payload = readJson(cacheFile, {});
    logMessage(`Serving cached osm tile ${tileKey}, age ${cachedAge}s`);
    sendJson(res, 200, payload, {
      tileKey,
      cacheAge: cachedAge,
      status: 'cached',
    });
    return;
  }

  const payload = await fetchOsmFromOverpass(bounds, tileKey);
  if (payload) {
    fs.writeFileSync(cacheFile, JSON.stringify(payload));
    logMessage(`Fetched osm tile ${tileKey} from Overpass`);
    sendJson(res, 200, payload, {
      tileKey,
      cacheAge: 0,
      status: 'fetched',
    });
    return;
  }

  if (cachedAge !== null) {
    const stalePayload = readJson(cacheFile, {});
    logMessage(`Returning stale osm tile ${tileKey} after fetch failure`);
    sendJson(res, 200, stalePayload, {
      tileKey,
      cacheAge: cachedAge,
      status: 'stale',
    });
    return;
  }

  sendJson(res, 502, { error: 'Failed to fetch osm tile', tileKey });
}

function readTrainState() {
  return {
    lastFetch: 0,
    lastPing: 0,
    data: null,
    status: 'idle',
    error: null,
    raw: null,
    cookies: null,
    cookieUpdated: 0,
    ...readJson(config.cacheFile, {}),
  };
}

async function ensureCookies(state) {
  const now = Math.floor(Date.now() / 1000);
  const handshakeNeeded = !state.cookies || now - (state.cookieUpdated ?? 0) >= 1800;
  if (!handshakeNeeded) {
    return state.cookies || config.cookies;
  }
  const handshakeOk = await performHandshake(state);
  if (!handshakeOk) {
    return '';
  }
  writeJson(config.cacheFile, state);
  return state.cookies || config.cookies;
}

async function handleDetail(reqUrl, res) {
  const train = reqUrl.searchParams.get('train') ?? '';
  if (!/^[0-9A-Za-z]{1,12}$/.test(train)) {
    sendJson(res, 400, { error: 'Missing train number' });
    return;
  }

  const cached = detailCache.get(train);
  if (cached && Date.now() - cached.at < DETAIL_CACHE_MS) {
    sendJson(res, 200, {
      source: 'proxy',
      train,
      status: 'cached',
      stops: cached.stops,
    });
    return;
  }

  const state = readTrainState();
  const cookie = await ensureCookies(state);
  if (!cookie) {
    sendJson(res, 200, {
      source: 'proxy',
      train,
      status: 'error',
      error: 'Handshake produced no cookies',
      stops: [],
    });
    return;
  }

  try {
    const response = await fetch('https://mapa.zsr.sk/Start/TrainDetail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://mapa.zsr.sk',
        Referer: 'https://mapa.zsr.sk/index.aspx',
        Cookie: cookie,
      },
      body: new URLSearchParams({ cisloVlaku: train }).toString(),
    });
    const html = await response.text();
    const looksLikeErrorPage =
      html.trim().startsWith('<!DOCTYPE') && !html.includes('timeline__list');
    if (!response.ok || !html || looksLikeErrorPage) {
      logMessage(`Train detail failed for ${train}: HTTP ${response.status}`);
      sendJson(res, 502, { error: `Train detail HTTP ${response.status}`, train, stops: [] });
      return;
    }
    const stops = parseTrainDetail(html);
    detailCache.set(train, { at: Date.now(), stops });
    logMessage(`Fetched train detail ${train}, ${stops.length} stops`);
    sendJson(res, 200, {
      source: 'proxy',
      train,
      status: 'fetched',
      stops,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Train detail failed for ${train}: ${message}`);
    sendJson(res, 502, { error: message, train, stops: [] });
  }
}

function isProxyRequest(reqUrl) {
  if (!staticRoot) {
    return true;
  }
  return reqUrl.pathname === '/proxy' || reqUrl.pathname.startsWith('/proxy/');
}

function serveStatic(reqUrl, res) {
  const requested = reqUrl.pathname === '/' ? '/index.html' : decodeURIComponent(reqUrl.pathname);
  const filePath = path.normalize(path.join(staticRoot, requested));
  if (!filePath.startsWith(staticRoot)) {
    sendJson(res, 400, { error: 'Invalid path' });
    return;
  }

  const candidate = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(staticRoot, 'index.html');

  if (!fs.existsSync(candidate)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const type = MIME_TYPES[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(candidate).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (!isProxyRequest(reqUrl)) {
      serveStatic(reqUrl, res);
      return;
    }

    const mode = reqUrl.searchParams.get('mode') ?? 'gtall';
    if (mode === 'osm') {
      await handleOsm(reqUrl, res);
      return;
    }
    if (mode === 'detail') {
      await handleDetail(reqUrl, res);
      return;
    }

    await handleGtall(reqUrl, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Unhandled proxy error: ${message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    }
  }
});

server.listen(port, '0.0.0.0', () => {
  fs.mkdirSync(config.osmCacheDir, { recursive: true });
  console.log(`3D Railmap proxy listening on http://0.0.0.0:${port}`);
});
