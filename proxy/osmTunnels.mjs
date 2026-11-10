import fs from 'node:fs';
import path from 'node:path';

const TUNNEL_FILE = 'tunnels_sk.json';
const TUNNEL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COVER_METERS = 50;
const SLOVAKIA_BOUNDS = {
  minLat: 47.7311798,
  maxLat: 49.6138162,
  minLng: 16.8331891,
  maxLng: 22.5657103,
};

let inflight = null;

function lonOf(point) {
  return point?.lon ?? point?.lng ?? 0;
}

function distMeters(a, b) {
  const lat = (b.lat - a.lat) * 111320;
  const lng = (lonOf(b) - lonOf(a)) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(lat, lng);
}

function cellKey(point, meters) {
  const row = Math.floor(point.lat / (meters / 111320));
  const col = Math.floor(lonOf(point) / (meters / 111320));
  return `${row}:${col}`;
}

function buildPointGrid(ways, meters = COVER_METERS) {
  const grid = new Map();
  ways.forEach((way) => {
    (way.geometry || []).forEach((point) => {
      const key = cellKey(point, meters);
      const bucket = grid.get(key) ?? [];
      bucket.push(point);
      grid.set(key, bucket);
    });
  });
  return grid;
}

function nearExisting(grid, point, meters = COVER_METERS) {
  const row = Math.floor(point.lat / (meters / 111320));
  const col = Math.floor(lonOf(point) / (meters / 111320));
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      const bucket = grid.get(`${row + rowOffset}:${col + colOffset}`);
      if (!bucket) {
        continue;
      }
      if (bucket.some((other) => distMeters(point, other) <= meters)) {
        return true;
      }
    }
  }
  return false;
}

export function wayTouchesBounds(way, bounds) {
  if (!bounds) {
    return true;
  }
  return (way.geometry || []).some((point) => {
    const lng = lonOf(point);
    return (
      point.lat >= bounds.minLat &&
      point.lat <= bounds.maxLat &&
      lng >= bounds.minLng &&
      lng <= bounds.maxLng
    );
  });
}

function sampleGeometry(geometry) {
  if (geometry.length <= 3) {
    return geometry;
  }
  return [0, 0.25, 0.5, 0.75, 1].map((t) => geometry[Math.min(geometry.length - 1, Math.round((geometry.length - 1) * t))]);
}

function tunnelCovered(tunnel, grid) {
  const geometry = tunnel.geometry || [];
  if (geometry.length < 2) {
    return true;
  }
  const samples = sampleGeometry(geometry);
  const hits = samples.filter((point) => nearExisting(grid, point)).length;
  return hits / samples.length >= 0.7;
}

export function mergeTunnelWays(ways, tunnels, bounds) {
  const existing = Array.isArray(ways) ? ways.slice() : [];
  const grid = buildPointGrid(existing);
  const extras = [];
  (tunnels || []).forEach((tunnel) => {
    if (bounds && !wayTouchesBounds(tunnel, bounds)) {
      return;
    }
    if (tunnelCovered(tunnel, grid)) {
      return;
    }
    extras.push(tunnel);
    (tunnel.geometry || []).forEach((point) => {
      const key = cellKey(point, COVER_METERS);
      const bucket = grid.get(key) ?? [];
      bucket.push(point);
      grid.set(key, bucket);
    });
  });
  if (extras.length === 0) {
    return existing;
  }
  return existing.concat(extras);
}

function readCachedTunnels(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - Number(payload.fetchedAt || 0);
    if (!Array.isArray(payload.elements) || age > TUNNEL_TTL_MS) {
      return Array.isArray(payload.elements) ? payload : null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function fetchTunnelsFromOverpass(endpoint, timeout) {
  const query = `[out:json][timeout:${timeout}];
(
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]["tunnel"~"^(yes|true|1)$"](${SLOVAKIA_BOUNDS.minLat},${SLOVAKIA_BOUNDS.minLng},${SLOVAKIA_BOUNDS.maxLat},${SLOVAKIA_BOUNDS.maxLng});
);
out geom;`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': '3Drail-frontend/1.0 (railmap proxy)',
    },
    body: query,
    signal: AbortSignal.timeout(timeout * 1000),
  });
  const text = await response.text();
  if (!response.ok || !text) {
    const error = new Error(`Overpass tunnels HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const payload = JSON.parse(text);
  return (payload.elements || [])
    .filter((element) => element?.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
    .map((element) => ({
      type: 'way',
      id: element.id,
      nodes: element.nodes ?? [],
      tags: {
        railway: element.tags?.railway ?? 'rail',
        tunnel: 'yes',
      },
      geometry: element.geometry.map((point) => ({ lat: point.lat, lon: point.lon })),
    }));
}

export async function ensureRailwayTunnels({
  cacheDir,
  endpoint,
  timeout = 90,
  allowed = () => true,
  block = () => {},
  log = () => {},
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, TUNNEL_FILE);
  const cached = readCachedTunnels(file);
  const fresh = cached && Date.now() - Number(cached.fetchedAt || 0) <= TUNNEL_TTL_MS;
  if (fresh) {
    return cached.elements;
  }
  if (!allowed()) {
    log('Skipping railway tunnel fetch: Overpass cooling down');
    return cached?.elements ?? [];
  }
  if (!inflight) {
    inflight = (async () => {
      try {
        const elements = await fetchTunnelsFromOverpass(endpoint, timeout);
        const payload = { fetchedAt: Date.now(), elements };
        fs.writeFileSync(file, JSON.stringify(payload));
        log(`Cached ${elements.length} OSM railway tunnels`);
        return elements;
      } catch (error) {
        if (error.status === 429 || error.status === 502 || error.status === 504) {
          block(error.status);
        }
        log(`Railway tunnel fetch failed: ${error.message ?? error}`);
        return cached?.elements ?? [];
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}
