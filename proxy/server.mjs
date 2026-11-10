import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseTrainDetail } from './trainDetail.mjs';
import { simplifyOsmPayload } from './simplifyRail.mjs';
import {
  fetchMaptilerRails,
  fetchMaptilerRailsDisplay,
  RAIL_SHAPE_VERSION,
  stitchRailNetwork,
} from './maptilerRails.mjs';
import { closeRailHoles, repairCachedRailTiles } from './closeRailHoles.mjs';
import { fetchMaptilerLandcover, fetchMaptilerWater, WATER_ZOOM } from './maptilerWater.mjs';
import {
  fetchMaptilerAsset,
  maptilerPathFromRequest,
  railatlasStyle,
  withAbsoluteAssetUrls,
} from './maptilerStyle.mjs';
import { packRails } from './packRails.mjs';
import { fetchStationBoard } from './cpStationBoard.mjs';
import { ensureRailwayTunnels, mergeTunnelWays } from './osmTunnels.mjs';

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
  osmCacheDuration: Number(process.env.OSM_CACHE_DURATION ?? 30 * 24 * 60 * 60),
  maptilerKey: process.env.MAPTILER_KEY ?? '',
  maptilerZoom: Number(process.env.MAPTILER_ZOOM ?? 11),
  maptilerDisplayZoom: Number(process.env.MAPTILER_DISPLAY_ZOOM ?? 14),
};

const port = Number(process.env.PROXY_PORT ?? 3001);
const staticRoot = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : '';

const detailCache = new Map();
const DETAIL_CACHE_MS = 60_000;
const stationBoardCache = new Map();
const STATION_BOARD_CACHE_MS = 45_000;

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
  '.xml': 'application/xml; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const CANONICAL_ORIGINS = {
  'railatlas.eu': 'https://railatlas.eu',
  'www.railatlas.eu': 'https://railatlas.eu',
};

function hostnameOf(hostHeader) {
  return String(hostHeader ?? '')
    .split(':')[0]
    .trim()
    .toLowerCase();
}

function isLocalHostname(host) {
  return !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
}

function sendRedirect(res, location) {
  res.writeHead(301, {
    Location: location,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end();
}

function redirectIfNotCanonical(req, res, reqUrl) {
  const host = hostnameOf(req.headers.host);
  const proto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isIndexFile = reqUrl.pathname === '/index.html' || reqUrl.pathname === '/index.htm';
  const pathname = isIndexFile ? '/' : reqUrl.pathname;
  const origin = CANONICAL_ORIGINS[host];

  if (isLocalHostname(host)) {
    if (isIndexFile) {
      sendRedirect(res, `${pathname}${reqUrl.search}`);
      return true;
    }
    return false;
  }

  if (!origin) {
    if (isIndexFile) {
      sendRedirect(res, `${pathname}${reqUrl.search}`);
      return true;
    }
    return false;
  }

  const needsRedirect = host.startsWith('www.') || proto === 'http' || isIndexFile;
  if (!needsRedirect) {
    return false;
  }
  sendRedirect(res, `${origin}${pathname}${reqUrl.search}`);
  return true;
}

function logMessage(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(config.logFile, line);
  console.log(message);
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

const NETWORK_PACK_NAME = 'network_v11.rnet.gz';
const MIN_NETWORK_WAYS = 500;
const SLOVAKIA_NETWORK_BOUNDS = {
  minLat: 47.7311798,
  maxLat: 49.6138162,
  minLng: 16.8331891,
  maxLng: 22.5657103,
};
let networkPackBuild = null;

function acceptsGzip(res) {
  const accept = res.req?.headers?.['accept-encoding'] ?? '';
  return String(accept).includes('gzip');
}

function sendCompressed(res, statusCode, buffer, contentType, extraHeaders = {}) {
  const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const canGzip = acceptsGzip(res) && payload.length > 256;
  const compressed = canGzip ? zlib.gzipSync(payload, { level: 6 }) : payload;
  const useGzip = canGzip && compressed.length < payload.length;
  const body = useGzip ? compressed : payload;
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    ...(useGzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(res, statusCode, payload, meta) {
  const body = JSON.stringify(meta ? { ...payload, __proxy_meta: meta } : payload);
  sendCompressed(res, statusCode, body, 'application/json; charset=utf-8');
}

function collectCachedWays(prefix) {
  const byId = new Map();
  if (!fs.existsSync(config.osmCacheDir)) {
    return [];
  }
  const files = fs.readdirSync(config.osmCacheDir).filter(
    (file) => file.startsWith(prefix) && file.endsWith('.json')
  );
  files.forEach((file) => {
    const payload = readJson(path.join(config.osmCacheDir, file), null);
    if (!payload || !Array.isArray(payload.elements)) {
      return;
    }
    if (payload.shapeVersion !== RAIL_SHAPE_VERSION) {
      return;
    }
    payload.elements.forEach((way) => {
      const geometry = way?.geometry || [];
      if (geometry.length < 2) {
        return;
      }
      const existing = byId.get(way.id);
      if (!existing || geometry.length > (existing.geometry || []).length) {
        byId.set(way.id, way);
      }
    });
  });
  return Array.from(byId.values());
}

function collectCoarseWays() {
  return collectCachedWays('coarse_').filter((way) => {
    const railway = way.tags?.railway ?? 'rail';
    return railway === 'rail' || railway === 'narrow_gauge';
  });
}

function sealNetwork(ways) {
  const stitched = stitchRailNetwork(ways);
  return closeRailHoles(stitched, { skipEdges: false });
}

async function buildNetworkPack() {
  fs.mkdirSync(config.osmCacheDir, { recursive: true });
  logMessage('Building simplified network pack from OpenFreeMap tiles');
  const maptiler = await fetchMaptilerRails(
    SLOVAKIA_NETWORK_BOUNDS,
    config.osmCacheDir,
    config.maptilerKey,
    config.maptilerZoom,
    { skipSimplify: true }
  );
  const ways = maptiler.elements ?? [];
  logMessage(
    `Loaded ${ways.length} OpenFreeMap ways for network pack (${maptiler.maptilerTiles ?? 0} tiles, ${maptiler.missingTiles ?? 0} missing)`
  );
  if (ways.length < MIN_NETWORK_WAYS) {
    throw new Error(
      `OpenFreeMap rail pack too small (${ways.length} ways from ${maptiler.maptilerTiles ?? 0} tiles)`
    );
  }
  let tunnels = [];
  try {
    tunnels = await Promise.race([
      loadRailwayTunnels(),
      new Promise((resolve) => setTimeout(() => resolve([]), 8000)),
    ]);
  } catch (error) {
    logMessage(
      `Tunnel overlay skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const sealed = sealNetwork(mergeTunnelWays(ways, tunnels, SLOVAKIA_NETWORK_BOUNDS));
  const packed = packRails(sealed.elements);
  const gzipped = zlib.gzipSync(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength), {
    level: 9,
  });
  const packPath = path.join(config.osmCacheDir, NETWORK_PACK_NAME);
  fs.writeFileSync(packPath, gzipped);
  const pointCount = sealed.elements.reduce(
    (sum, way) => sum + (way.geometry?.length ?? 0),
    0
  );
  logMessage(
    `Packed simplified network: ${sealed.elements.length} ways, ${pointCount} points, holes ${sealed.found} found / ${sealed.closed} closed / ${sealed.remaining} left, ${gzipped.length} gzip bytes`
  );
  return { packPath, gzipped, wayCount: sealed.elements.length, pointsAfter: pointCount };
}

function networkPackPath() {
  return path.join(config.osmCacheDir, NETWORK_PACK_NAME);
}

function unpackNetworkWayCount(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 16) {
    return 0;
  }
  let raw = fs.readFileSync(filePath);
  try {
    raw = zlib.gunzipSync(raw);
  } catch {
    // already uncompressed
  }
  if (raw.length < 12 || raw.subarray(0, 4).toString('ascii') !== 'RNET') {
    return 0;
  }
  return raw.readUInt32LE(8);
}

function isHealthyNetworkPack(filePath) {
  return unpackNetworkWayCount(filePath) >= MIN_NETWORK_WAYS;
}

async function ensureNetworkPack() {
  const packPath = networkPackPath();
  if (isHealthyNetworkPack(packPath)) {
    return packPath;
  }
  if (!networkPackBuild) {
    networkPackBuild = buildNetworkPack()
      .then((built) => built.packPath)
      .finally(() => {
        networkPackBuild = null;
      });
  }
  const built = await Promise.race([
    networkPackBuild,
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ]);
  if (built && isHealthyNetworkPack(built)) {
    return built;
  }
  const error = new Error('Network pack is building');
  error.code = 'BUILDING';
  throw error;
}

function warmupNetworkPack() {
  ensureNetworkPack().catch((error) => {
    if (error?.code === 'BUILDING') {
      return;
    }
    logMessage(
      `Network pack warmup failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
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

function storedTile(cacheFile) {
  const payload = readJson(cacheFile, {});
  if (
    payload?.source === 'maptiler' &&
    payload.shapeVersion === RAIL_SHAPE_VERSION &&
    payload.collapsed === true &&
    payload.seamRepaired === true &&
    Array.isArray(payload.elements)
  ) {
    return payload;
  }
  return null;
}

function buildOsmTileKey(level, bounds) {
  const format = (value) => String(Number(value).toFixed(5)).replace(/-/g, 'm');
  const safeLevel = level.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `${safeLevel}_${format(bounds.minLat)}_${format(bounds.minLng)}_${format(bounds.maxLat)}_${format(bounds.maxLng)}`;
}

const pendingOsm = new Map();
const OVERPASS_STATE_FILE = path.join(config.osmCacheDir, '_overpass_state.json');

function overpassStatePath() {
  fs.mkdirSync(config.osmCacheDir, { recursive: true });
  return OVERPASS_STATE_FILE;
}

function overpassBlockedUntil() {
  const state = readJson(overpassStatePath(), {});
  return Number(state.blockedUntil) || 0;
}

function overpassAllowed() {
  return Date.now() >= overpassBlockedUntil();
}

function blockOverpass(status) {
  const waitMs = status === 429 ? 60 * 60 * 1000 : 15 * 60 * 1000;
  const blockedUntil = Date.now() + waitMs;
  writeJson(overpassStatePath(), { blockedUntil, status, at: Date.now() });
  logMessage(`Overpass paused for ${Math.round(waitMs / 60000)} min after HTTP ${status}`);
}

function loadRailwayTunnels() {
  return ensureRailwayTunnels({
    cacheDir: config.osmCacheDir,
    endpoint: config.osmEndpoint,
    timeout: Math.max(config.osmTimeout, 90),
    allowed: overpassAllowed,
    block: blockOverpass,
    log: logMessage,
  });
}

async function withRailwayTunnels(payload, bounds) {
  const tunnels = await loadRailwayTunnels();
  return {
    ...payload,
    elements: mergeTunnelWays(payload.elements ?? [], tunnels, bounds),
  };
}

function isUsableDisplayCache(cached) {
  if (!cached || !Array.isArray(cached.elements)) {
    return false;
  }
  if (cached.elements.length === 0) {
    return !config.maptilerKey;
  }
  if (cached.source === 'overpass-display') {
    return true;
  }
  return (
    cached.source === 'maptiler-display' &&
    Number(cached.maptilerZoom) >= config.maptilerDisplayZoom
  );
}

let displayIndexCache = null;

function parseDisplayCacheBounds(file) {
  const match = /^display_([^_]+)_([^_]+)_([^_]+)_([^_]+)\.json$/.exec(file);
  if (!match) {
    return null;
  }
  const num = (value) => Number(String(value).replace(/^m/, '-'));
  const minLat = num(match[1]);
  const minLng = num(match[2]);
  const maxLat = num(match[3]);
  const maxLng = num(match[4]);
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) {
    return null;
  }
  return { minLat, minLng, maxLat, maxLng };
}

function listDisplayIndex() {
  if (displayIndexCache) {
    return displayIndexCache;
  }
  if (!fs.existsSync(config.osmCacheDir)) {
    displayIndexCache = [];
    return displayIndexCache;
  }
  const tiles = [];
  for (const file of fs.readdirSync(config.osmCacheDir)) {
    if (!file.startsWith('display_') || !file.endsWith('.json')) {
      continue;
    }
    const bounds = parseDisplayCacheBounds(file);
    if (!bounds) {
      continue;
    }
    const cached = readJson(path.join(config.osmCacheDir, file), null);
    if (!isUsableDisplayCache(cached) || (cached.elements?.length ?? 0) === 0) {
      continue;
    }
    tiles.push(bounds);
  }
  displayIndexCache = tiles;
  return tiles;
}

function writeDisplayCache(cacheFile, payload) {
  displayIndexCache = null;
  fs.writeFileSync(cacheFile, JSON.stringify(payload));
}

function withOsmLock(key, run) {
  const existing = pendingOsm.get(key);
  if (existing) {
    return existing;
  }
  const pending = Promise.resolve()
    .then(run)
    .finally(() => {
      pendingOsm.delete(key);
    });
  pendingOsm.set(key, pending);
  return pending;
}

async function fetchOsmFromOverpass(bounds, tileKey, includeService = false) {
  if (!overpassAllowed()) {
    const waitMin = Math.ceil((overpassBlockedUntil() - Date.now()) / 60000);
    logMessage(`Skipping Overpass (${tileKey}): cooling down ${waitMin} min`);
    return null;
  }
  const extraFilters = includeService
    ? ''
    : '["service"!~"^(spur|siding|yard|crossover|driveway)$"]["usage"!~"^(industrial|military|test|tourism)$"]';
  const query = `[out:json][timeout:${config.osmTimeout}];
(
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]${extraFilters}(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng});
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
      if (response.status === 429 || response.status === 502 || response.status === 504) {
        blockOverpass(response.status);
      }
      return null;
    }

    const decoded = JSON.parse(result);
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Overpass fetch failed (${tileKey}): ${message}`);
    if (/429|502|504/.test(message)) {
      blockOverpass(502);
    }
    return null;
  }
}

async function handleOsm(reqUrl, res) {
  const level = reqUrl.searchParams.get('level') ?? 'tile';
  fs.mkdirSync(config.osmCacheDir, { recursive: true });

  if (level === 'network') {
    try {
      const packPath = await ensureNetworkPack();
      const gzipped = fs.readFileSync(packPath);
      let body = gzipped;
      try {
        body = zlib.gunzipSync(gzipped);
      } catch {
        // Serve the file as stored if it is already raw.
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(body);
      logMessage(`Serving packed simplified network ${gzipped.length} bytes`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error?.code === 'BUILDING' || message.includes('building')) {
        sendJson(res, 202, { status: 'building', retryMs: 4000, elements: [] });
        return;
      }
      logMessage(`Network pack failed: ${message}`);
      sendJson(res, 502, { error: message, elements: [] });
      return;
    }
  }

  if (level === 'display-index') {
    const tiles = listDisplayIndex();
    sendJson(res, 200, { tiles }, { status: 'index', count: tiles.length });
    return;
  }

  const minLat = Number(reqUrl.searchParams.get('minLat'));
  const maxLat = Number(reqUrl.searchParams.get('maxLat'));
  const minLng = Number(reqUrl.searchParams.get('minLng'));
  const maxLng = Number(reqUrl.searchParams.get('maxLng'));

  if ([minLat, maxLat, minLng, maxLng].some((value) => Number.isNaN(value))) {
    sendJson(res, 400, { error: 'Missing bounding box parameters' });
    return;
  }

  const bounds = { minLat, maxLat, minLng, maxLng };

  if (level === 'display') {
    const tileKey = buildOsmTileKey('display', bounds);
    const cacheFile = path.join(config.osmCacheDir, `${tileKey}.json`);
    const cached = readJson(cacheFile, null);
    const cacheOnly = reqUrl.searchParams.get('cacheOnly') === '1';
    if (isUsableDisplayCache(cached)) {
      const withTunnels = await withRailwayTunnels(cached, bounds);
      logMessage(
        `Serving cached display rails ${tileKey} (${cached.source}), ${withTunnels.elements.length} ways`
      );
      sendJson(res, 200, withTunnels, { tileKey, status: 'cached' });
      return;
    }
    if (cacheOnly) {
      sendJson(res, 200, { elements: [] }, { tileKey, status: 'miss' });
      return;
    }
    try {
      const display = await withOsmLock(tileKey, async () => {
        const latest = readJson(cacheFile, null);
        if (isUsableDisplayCache(latest)) {
          return latest;
        }
        if (!config.maptilerKey) {
          return {
            elements: [],
            source: 'maptiler-display',
            maptilerZoom: config.maptilerDisplayZoom,
            collapsed: false,
          };
        }
        const padded = {
          minLat: bounds.minLat - 0.012,
          maxLat: bounds.maxLat + 0.012,
          minLng: bounds.minLng - 0.012,
          maxLng: bounds.maxLng + 0.012,
        };
        const maptiler = await fetchMaptilerRailsDisplay(
          padded,
          config.osmCacheDir,
          config.maptilerKey,
          config.maptilerDisplayZoom
        );
        const payload = {
          ...maptiler,
          source: 'maptiler-display',
          collapsed: false,
          simplified: false,
        };
        if ((payload.elements?.length ?? 0) > 0) {
          writeDisplayCache(cacheFile, payload);
        }
        return payload;
      });
      const withTunnels = await withRailwayTunnels(display, bounds);
      logMessage(
        `Fetched display rails ${tileKey}: ${withTunnels.elements?.length ?? 0} ways (${display.source})`
      );
      sendJson(res, 200, withTunnels, { tileKey, status: 'display' });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMessage(`Display rail fetch failed (${tileKey}): ${message}`);
      sendJson(res, 502, { error: message, elements: [] });
      return;
    }
  }

  if (reqUrl.searchParams.has('purge')) {
    const files = fs.readdirSync(config.osmCacheDir).filter(
      (file) => file.endsWith('.json') || file.endsWith('.rnet.gz')
    );
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
    const payload = storedTile(cacheFile);
    if (payload) {
      logMessage(`Serving cached osm tile ${tileKey}, age ${cachedAge}s`);
      sendJson(res, 200, payload, {
        tileKey,
        cacheAge: cachedAge,
        status: 'cached',
      });
      return;
    }
    logMessage(`Rebuilding osm tile ${tileKey} for rail shape ${RAIL_SHAPE_VERSION}`);
  }

  if (config.maptilerKey) {
    try {
      const maptiler = await fetchMaptilerRails(
        bounds,
        config.osmCacheDir,
        config.maptilerKey,
        config.maptilerZoom
      );
      if (maptiler) {
        if (maptiler.complete) {
          fs.writeFileSync(cacheFile, JSON.stringify(maptiler));
          const holes = repairCachedRailTiles(config.osmCacheDir);
          logMessage(
            `Closed rail holes across ${holes.tiles} tiles: found ${holes.found}, closed ${holes.closed}, ${holes.remaining} termini left`
          );
        }
        logMessage(
          `Fetched osm tile ${tileKey} from MapTiler z${maptiler.maptilerZoom}, ${maptiler.collapsedFrom} lines to ${maptiler.collapsedTo}, ${maptiler.pointsBefore} points to ${maptiler.pointsAfter}, ${maptiler.maptilerTiles} tiles, missing ${maptiler.missingTiles ?? 0}`
        );
        const served = maptiler.complete ? storedTile(cacheFile) ?? maptiler : maptiler;
        sendJson(res, 200, served, {
          tileKey,
          cacheAge: 0,
          status: maptiler.complete ? 'maptiler' : 'partial',
        });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMessage(`MapTiler fetch failed (${tileKey}): ${message}`);
    }
  }

  const fetched = await fetchOsmFromOverpass(bounds, tileKey);
  if (fetched) {
    const payload = simplifyOsmPayload(fetched);
    fs.writeFileSync(cacheFile, JSON.stringify(payload));
    const points = payload.simplifiedPoints;
    logMessage(
      `Fetched osm tile ${tileKey} from Overpass, simplified ${points?.before ?? 0} points to ${points?.after ?? 0}`
    );
    sendJson(res, 200, payload, {
      tileKey,
      cacheAge: 0,
      status: 'fetched',
    });
    return;
  }

  if (cachedAge !== null) {
    const stalePayload = storedTile(cacheFile);
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

async function handleWater(res) {
  fs.mkdirSync(config.osmCacheDir, { recursive: true });
  if (!config.maptilerKey) {
    sendJson(res, 503, { error: 'MAPTILER_KEY missing', polygons: [] });
    return;
  }
  try {
    const payload = await fetchMaptilerWater(config.osmCacheDir, config.maptilerKey, WATER_ZOOM);
    logMessage(
      `Serving water z${payload.zoom}: ${payload.polygons?.length ?? 0} polygons from ${payload.tiles} tiles, missing ${payload.missing ?? 0}`
    );
    sendJson(res, 200, payload, { status: 'water', zoom: payload.zoom });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Water fetch failed: ${message}`);
    sendJson(res, 502, { error: message, polygons: [] });
  }
}

function requestOrigin(req) {
  const host = hostnameOf(req.headers.host);
  if (CANONICAL_ORIGINS[host]) {
    return CANONICAL_ORIGINS[host];
  }
  const proto =
    String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim()
      .toLowerCase() || 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

async function handleStyle(req, reqUrl, res) {
  const theme = reqUrl.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  sendJson(res, 200, withAbsoluteAssetUrls(railatlasStyle(theme), requestOrigin(req)));
}

async function handleMaptiler(reqUrl, res) {
  const pathname = maptilerPathFromRequest(reqUrl);
  const asset = await fetchMaptilerAsset(config.osmCacheDir, config.maptilerKey, pathname);
  if (!asset) {
    sendJson(res, 404, { error: 'MapTiler asset missing' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': asset.contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(asset.buffer);
}

async function handleLandcover(res) {
  fs.mkdirSync(config.osmCacheDir, { recursive: true });
  if (!config.maptilerKey) {
    sendJson(res, 503, { error: 'MAPTILER_KEY missing', polygons: [] });
    return;
  }
  try {
    const payload = await fetchMaptilerLandcover(config.osmCacheDir, config.maptilerKey, WATER_ZOOM);
    const forests = payload.polygons?.filter((polygon) => polygon.kind === 'forest').length ?? 0;
    const urban = payload.polygons?.filter((polygon) => polygon.kind === 'urban').length ?? 0;
    logMessage(
      `Serving landcover z${payload.zoom}: ${forests} forest / ${urban} urban from ${payload.tiles} tiles, missing ${payload.missing ?? 0}`
    );
    sendJson(res, 200, payload, { status: 'landcover', zoom: payload.zoom });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Landcover fetch failed: ${message}`);
    sendJson(res, 502, { error: message, polygons: [] });
  }
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

async function handleStationBoard(reqUrl, res) {
  const station = (reqUrl.searchParams.get('station') ?? reqUrl.searchParams.get('f') ?? '').trim();
  const arrivals = reqUrl.searchParams.get('byarr') === 'true' || reqUrl.searchParams.get('arrivals') === '1';
  if (!station || station.length > 120) {
    sendJson(res, 400, { error: 'Missing station', rows: [] });
    return;
  }
  const cacheKey = `${arrivals ? 'arr' : 'dep'}:${station.toLowerCase()}`;
  const cached = stationBoardCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STATION_BOARD_CACHE_MS) {
    sendJson(res, 200, { ...cached.payload, status: 'cached' });
    return;
  }
  try {
    const payload = await fetchStationBoard(station, arrivals);
    stationBoardCache.set(cacheKey, { at: Date.now(), payload });
    logMessage(`Station board ${arrivals ? 'arrivals' : 'departures'} for ${station}: ${payload.rows.length} rows`);
    sendJson(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`Station board failed for ${station}: ${message}`);
    sendJson(res, 502, { error: message, station, arrivals, rows: [] });
  }
}

function isProxyRequest(reqUrl) {
  if (!staticRoot) {
    return true;
  }
  if (reqUrl.searchParams.has('mode')) {
    return true;
  }
  return reqUrl.pathname === '/proxy' || reqUrl.pathname.startsWith('/proxy/');
}

function proxyModeFromRequest(reqUrl) {
  const queryMode = reqUrl.searchParams.get('mode');
  if (queryMode) {
    return queryMode;
  }
  const parts = reqUrl.pathname.replace(/^\/proxy\/?/, '').split('/').filter(Boolean);
  if (parts[0] && parts[0] !== 'maptiler') {
    return parts[0];
  }
  return 'gtall';
}

function applyProxyPathParams(reqUrl) {
  const parts = reqUrl.pathname.replace(/^\/proxy\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'osm' && parts[1] && !reqUrl.searchParams.get('level')) {
    reqUrl.searchParams.set('level', parts[1]);
  }
  if (parts[0] === 'detail' && parts[1] && !reqUrl.searchParams.get('train')) {
    reqUrl.searchParams.set('train', parts[1]);
  }
}

function serveStatic(reqUrl, res) {
  const requested = reqUrl.pathname === '/' ? '/index.html' : decodeURIComponent(reqUrl.pathname);
  if (requested === '/proxy' || requested.startsWith('/proxy/')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const filePath = path.normalize(path.join(staticRoot, requested));
  if (!filePath.startsWith(staticRoot)) {
    sendJson(res, 400, { error: 'Invalid path' });
    return;
  }

  const hasFile = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  const hasExtension = path.extname(requested) !== '';
  const candidate = hasFile
    ? filePath
    : hasExtension
      ? null
      : path.join(staticRoot, 'index.html');

  if (!candidate || !fs.existsSync(candidate)) {
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
    if (redirectIfNotCanonical(req, res, reqUrl)) {
      return;
    }

    if (!isProxyRequest(reqUrl)) {
      serveStatic(reqUrl, res);
      return;
    }

    applyProxyPathParams(reqUrl);
    const mode = proxyModeFromRequest(reqUrl);
    if (mode === 'osm') {
      await handleOsm(reqUrl, res);
      return;
    }
    if (mode === 'water') {
      await handleWater(res);
      return;
    }
    if (mode === 'landcover') {
      await handleLandcover(res);
      return;
    }
    if (mode === 'style') {
      await handleStyle(req, reqUrl, res);
      return;
    }
    if (maptilerPathFromRequest(reqUrl)) {
      await handleMaptiler(reqUrl, res);
      return;
    }
    if (mode === 'detail') {
      await handleDetail(reqUrl, res);
      return;
    }
    if (mode === 'station') {
      await handleStationBoard(reqUrl, res);
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
  warmupNetworkPack();
});
