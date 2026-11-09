import fs from 'node:fs';
import path from 'node:path';

// Trafimage Nachtmodus uses geOps Maps style `basemap_dark_ch.sbb.netzkarte`
// (vector tiles + Mapbox style from maps.geops.io). We copy the rasterized XYZ
// tiles. tiles.trafimage.ch TMS `base_dark_v2_webmercator` is Switzerland-only.
const TILE_URL = 'https://maps.geops.io/styles';
export const BASEMAP_STYLE = 'basemap_dark_ch.sbb.netzkarte';
export const BASEMAP_MIN_ZOOM = 6;
export const BASEMAP_MAX_ZOOM = 14;

const SLOVAKIA_BOUNDS = {
  minLat: 47.7311798,
  maxLat: 49.6138162,
  minLng: 16.8331891,
  maxLng: 22.5657103,
};

const MAPTILER_CONCURRENCY = 8;
const MEMORY_CACHE_MAX = 256;
const memoryCache = new Map();
let inFlight = 0;
const waiters = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeMaptilerSlot() {
  if (inFlight >= MAPTILER_CONCURRENCY) {
    await new Promise((resolve) => {
      waiters.push(resolve);
    });
  }
  inFlight += 1;
}

function releaseMaptilerSlot() {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) {
    next();
  }
}

function memoryKey(zoom, tileX, tileY) {
  return `${zoom}/${tileX}/${tileY}`;
}

function rememberTile(zoom, tileX, tileY, buffer) {
  const key = memoryKey(zoom, tileX, tileY);
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  }
  memoryCache.set(key, buffer);
  while (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    memoryCache.delete(oldest);
  }
}

function tileOverlapsSlovakia(zoom, tileX, tileY) {
  const n = 2 ** zoom;
  const west = (tileX / n) * 360 - 180;
  const east = ((tileX + 1) / n) * 360 - 180;
  const mercLat = (fraction) => {
    const merc = Math.PI * (1 - 2 * fraction);
    return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
  };
  const north = mercLat(tileY / n);
  const south = mercLat((tileY + 1) / n);
  return (
    east >= SLOVAKIA_BOUNDS.minLng &&
    west <= SLOVAKIA_BOUNDS.maxLng &&
    north >= SLOVAKIA_BOUNDS.minLat &&
    south <= SLOVAKIA_BOUNDS.maxLat
  );
}

export function cachePathForTile(cacheDir, zoom, tileX, tileY) {
  return path.join(cacheDir, 'basemap', BASEMAP_STYLE, String(zoom), String(tileX), `${tileY}.png`);
}

export async function fetchBasemapTile(cacheDir, apiKey, zoom, tileX, tileY) {
  const z = Number(zoom);
  const x = Number(tileX);
  const y = Number(tileY);
  const n = 2 ** z;
  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < BASEMAP_MIN_ZOOM ||
    z > BASEMAP_MAX_ZOOM ||
    x < 0 ||
    y < 0 ||
    x >= n ||
    y >= n
  ) {
    return null;
  }
  if (!tileOverlapsSlovakia(z, x, y)) {
    return null;
  }

  const key = memoryKey(z, x, y);
  const hot = memoryCache.get(key);
  if (hot) {
    memoryCache.delete(key);
    memoryCache.set(key, hot);
    return hot;
  }

  const file = cachePathForTile(cacheDir, z, x, y);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const buffer = fs.readFileSync(file);
    rememberTile(z, x, y, buffer);
    return buffer;
  }
  if (!apiKey) {
    return null;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await takeMaptilerSlot();
      try {
        const response = await fetch(
          `${TILE_URL}/${BASEMAP_STYLE}/${z}/${x}/${y}.png?key=${apiKey}`,
          {
            headers: { 'User-Agent': '3Drail-frontend/1.0 (railmap proxy)' },
            signal: AbortSignal.timeout(20000),
          }
        );
        if (response.status === 204 || response.status === 404) {
          return null;
        }
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Basemap tile ${z}/${x}/${y} HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new Error(`Basemap tile ${z}/${x}/${y} HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(file, buffer);
        rememberTile(z, x, y, buffer);
        return buffer;
      } finally {
        releaseMaptilerSlot();
      }
    } catch {
      await wait(Math.min(12000, 600 * 2 ** attempt));
    }
  }
  return null;
}

function latToTileY(lat, zoom) {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
}

export function slovakiaTilesAtZoom(zoom) {
  const n = 2 ** zoom;
  const xMin = Math.max(0, Math.floor(((SLOVAKIA_BOUNDS.minLng + 180) / 360) * n));
  const xMax = Math.min(n - 1, Math.floor(((SLOVAKIA_BOUNDS.maxLng + 180) / 360) * n));
  const yMin = Math.max(0, latToTileY(SLOVAKIA_BOUNDS.maxLat, zoom));
  const yMax = Math.min(n - 1, latToTileY(SLOVAKIA_BOUNDS.minLat, zoom));
  const tiles = [];
  for (let tileX = xMin; tileX <= xMax; tileX += 1) {
    for (let tileY = yMin; tileY <= yMax; tileY += 1) {
      if (tileOverlapsSlovakia(zoom, tileX, tileY)) {
        tiles.push({ zoom, tileX, tileY });
      }
    }
  }
  return tiles;
}

export async function prefetchBasemap(cacheDir, apiKey) {
  if (!apiKey) {
    return { tiles: 0 };
  }
  const wanted = [...slovakiaTilesAtZoom(7), ...slovakiaTilesAtZoom(8)];
  await Promise.all(
    wanted.map((tile) => fetchBasemapTile(cacheDir, apiKey, tile.zoom, tile.tileX, tile.tileY))
  );
  return { tiles: wanted.length };
}
