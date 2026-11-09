import fs from 'node:fs';
import path from 'node:path';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const TILE_URL = 'https://api.maptiler.com/tiles/v3';
export const WATER_ZOOM = 8;
export const WATER_CACHE_NAME = `water_z${WATER_ZOOM}_v2.json`;

const SLOVAKIA_BOUNDS = {
  minLat: 47.7311798,
  maxLat: 49.6138162,
  minLng: 16.8331891,
  maxLng: 22.5657103,
};

const KEEP_WATER = new Set(['lake', 'river', 'reservoir', 'water']);
const KEEP_FOREST = new Set(['wood']);
const KEEP_URBAN = new Set([
  'residential',
  'suburb',
  'neighbourhood',
  'commercial',
  'industrial',
  'retail',
]);
export const LANDCOVER_CACHE_NAME = `landcover_z${WATER_ZOOM}_v5.json`;

function tileRange(bounds, zoom) {
  const n = 2 ** zoom;
  const xMin = Math.max(0, Math.floor(((bounds.minLng + 180) / 360) * n));
  const xMax = Math.min(n - 1, Math.floor(((bounds.maxLng + 180) / 360) * n));
  const yOf = (lat) => {
    const rad = (lat * Math.PI) / 180;
    const merc = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
    return Math.floor(((1 - merc / Math.PI) / 2) * n);
  };
  const yNorth = yOf(bounds.maxLat);
  const ySouth = yOf(bounds.minLat);
  return {
    xMin,
    xMax,
    yMin: Math.max(0, Math.min(yNorth, ySouth)),
    yMax: Math.min(n - 1, Math.max(yNorth, ySouth)),
  };
}

function pointToLatLng(zoom, tileX, tileY, extent, point) {
  const n = 2 ** zoom;
  const lon = ((tileX + point.x / extent) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + point.y / extent) / n))) * 180) / Math.PI;
  return { lat, lng: lon };
}

function unclose(ring) {
  if (ring.length < 2) {
    return ring;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.abs(first.lat - last.lat) < 1e-12 && Math.abs(first.lng - last.lng) < 1e-12) {
    return ring.slice(0, -1);
  }
  return ring;
}

function ringArea(ring) {
  let area = 0;
  const points = unclose(ring);
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.lng * b.lat - b.lng * a.lat;
  }
  return area / 2;
}

function roundPoint(point) {
  return {
    lat: Math.round(point.lat * 1e4) / 1e4,
    lng: Math.round(point.lng * 1e4) / 1e4,
  };
}

function pointSegDist(point, start, end) {
  const dx = end.lng - start.lng;
  const dy = end.lat - start.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) {
    const x = point.lng - start.lng;
    const y = point.lat - start.lat;
    return Math.sqrt(x * x + y * y);
  }
  let t = ((point.lng - start.lng) * dx + (point.lat - start.lat) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = point.lng - (start.lng + t * dx);
  const y = point.lat - (start.lat + t * dy);
  return Math.sqrt(x * x + y * y);
}

function simplifyRingOnce(points, epsilon) {
  if (points.length <= 4) {
    return points.map(roundPoint);
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let maxIdx = start;
    for (let i = start + 1; i < end; i += 1) {
      const dist = pointSegDist(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  const output = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) {
      output.push(roundPoint(points[i]));
    }
  }
  return output.length >= 3 ? output : points.slice(0, 3).map(roundPoint);
}

function simplifyRing(ring, epsilon, maxPoints = 80) {
  const points = unclose(ring);
  let current = epsilon;
  let output = simplifyRingOnce(points, current);
  while (output.length > maxPoints && current < 0.08) {
    current *= 1.7;
    output = simplifyRingOnce(points, current);
  }
  return output;
}

function mercatorLat(nFraction) {
  const merc = Math.PI * (1 - 2 * nFraction);
  return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
}

function latLngTileBounds(zoom, tileX, tileY) {
  const n = 2 ** zoom;
  const pad = 1e-6;
  return {
    minLng: (tileX / n) * 360 - 180 + pad,
    maxLng: ((tileX + 1) / n) * 360 - 180 - pad,
    maxLat: mercatorLat(tileY / n) - pad,
    minLat: mercatorLat((tileY + 1) / n) + pad,
  };
}

function interpolateLatLng(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

function clipRingToBBox(ring, bbox) {
  const edges = [
    {
      inside: (p) => p.lng >= bbox.minLng,
      hit: (a, b) => interpolateLatLng(a, b, (bbox.minLng - a.lng) / (b.lng - a.lng || 1e-12)),
    },
    {
      inside: (p) => p.lng <= bbox.maxLng,
      hit: (a, b) => interpolateLatLng(a, b, (bbox.maxLng - a.lng) / (b.lng - a.lng || 1e-12)),
    },
    {
      inside: (p) => p.lat >= bbox.minLat,
      hit: (a, b) => interpolateLatLng(a, b, (bbox.minLat - a.lat) / (b.lat - a.lat || 1e-12)),
    },
    {
      inside: (p) => p.lat <= bbox.maxLat,
      hit: (a, b) => interpolateLatLng(a, b, (bbox.maxLat - a.lat) / (b.lat - a.lat || 1e-12)),
    },
  ];
  let output = unclose(ring);
  edges.forEach((edge) => {
    const input = output;
    output = [];
    if (input.length === 0) {
      return;
    }
    let prev = input[input.length - 1];
    input.forEach((curr) => {
      const currIn = edge.inside(curr);
      const prevIn = edge.inside(prev);
      if (currIn) {
        if (!prevIn) {
          output.push(edge.hit(prev, curr));
        }
        output.push(curr);
      } else if (prevIn) {
        output.push(edge.hit(prev, curr));
      }
      prev = curr;
    });
  });
  return unclose(output);
}

function ringFromPoints(zoom, tileX, tileY, extent, points) {
  return unclose(points.map((point) => pointToLatLng(zoom, tileX, tileY, extent, point)));
}

function polygonsFromLayer(layer, zoom, tileX, tileY, allowed) {
  if (!layer) {
    return [];
  }
  const bbox = latLngTileBounds(zoom, tileX, tileY);
  const polygons = [];
  for (let index = 0; index < layer.length; index += 1) {
    const feature = layer.feature(index);
    const kind = feature.properties.class ?? feature.properties.subclass ?? '';
    if (allowed && !allowed.has(kind)) {
      continue;
    }
    if (kind === 'ocean' || kind === 'sea' || kind === 'pond') {
      continue;
    }
    const rings = feature.loadGeometry();
    if (!rings.length) {
      continue;
    }
    const outer = clipRingToBBox(ringFromPoints(zoom, tileX, tileY, layer.extent, rings[0]), bbox);
    if (outer.length < 3) {
      continue;
    }
    const holes = rings
      .slice(1)
      .map((ring) => clipRingToBBox(ringFromPoints(zoom, tileX, tileY, layer.extent, ring), bbox))
      .filter((ring) => ring.length >= 3);
    polygons.push({
      outer,
      holes,
      class: kind || 'water',
    });
  }
  return polygons;
}

let nextRequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeRequestSlot() {
  const now = Date.now();
  const delay = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + 300;
  if (delay > 0) {
    await wait(delay);
  }
}

async function loadPbf(cacheDir, zoom, tileX, tileY, apiKey) {
  const file = path.join(cacheDir, `pbf_${zoom}_${tileX}_${tileY}.pbf`);
  if (fs.existsSync(file)) {
    const buffer = fs.readFileSync(file);
    return buffer.length === 0 ? null : buffer;
  }
  if (!apiKey) {
    return null;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await takeRequestSlot();
      const response = await fetch(`${TILE_URL}/${zoom}/${tileX}/${tileY}.pbf?key=${apiKey}`, {
        headers: { 'User-Agent': '3Drail-frontend/1.0 (railmap proxy)' },
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 204 || response.status === 404) {
        fs.writeFileSync(file, Buffer.alloc(0));
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const pause = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 20000)
          : Math.min(16000, 800 * 2 ** attempt);
        await wait(pause);
        continue;
      }
      if (!response.ok) {
        throw new Error(`MapTiler water tile ${zoom}/${tileX}/${tileY} HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(file, buffer);
      return buffer;
    } catch {
      await wait(Math.min(16000, 800 * 2 ** attempt));
    }
  }
  return null;
}

export async function fetchMaptilerWater(cacheDir, apiKey, zoom = WATER_ZOOM) {
  const cacheFile = path.join(cacheDir, WATER_CACHE_NAME);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      fs.unlinkSync(cacheFile);
    }
  }

  const range = tileRange(SLOVAKIA_BOUNDS, zoom);
  const polygons = [];
  let tiles = 0;
  let missing = 0;
  for (let tileX = range.xMin; tileX <= range.xMax; tileX += 1) {
    for (let tileY = range.yMin; tileY <= range.yMax; tileY += 1) {
      const buffer = await loadPbf(cacheDir, zoom, tileX, tileY, apiKey);
      tiles += 1;
      if (!buffer) {
        missing += 1;
        continue;
      }
      const tile = new VectorTile(new PbfReader(buffer));
      polygonsFromLayer(tile.layers.water, zoom, tileX, tileY, KEEP_WATER).forEach((polygon) => {
        polygons.push(polygon);
      });
    }
  }

  const simplified = polygons.filter((polygon) => {
    if (polygon.outer.length < 3) {
      return false;
    }
    return Math.abs(ringArea(polygon.outer)) >= 0.000004;
  });

  const payload = {
    source: 'maptiler',
    zoom,
    tiles,
    missing,
    polygons: simplified,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload));
  return payload;
}

export async function fetchMaptilerLandcover(cacheDir, apiKey, zoom = WATER_ZOOM) {
  const cacheFile = path.join(cacheDir, LANDCOVER_CACHE_NAME);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      fs.unlinkSync(cacheFile);
    }
  }

  const range = tileRange(SLOVAKIA_BOUNDS, zoom);
  const polygons = [];
  let tiles = 0;
  let missing = 0;
  for (let tileX = range.xMin; tileX <= range.xMax; tileX += 1) {
    for (let tileY = range.yMin; tileY <= range.yMax; tileY += 1) {
      const buffer = await loadPbf(cacheDir, zoom, tileX, tileY, apiKey);
      tiles += 1;
      if (!buffer) {
        missing += 1;
        continue;
      }
      const tile = new VectorTile(new PbfReader(buffer));
      polygonsFromLayer(tile.layers.landcover, zoom, tileX, tileY, KEEP_FOREST).forEach((polygon) => {
        const outer = clipRingToBBox(polygon.outer, SLOVAKIA_BOUNDS);
        if (outer.length >= 3) {
          polygons.push({ ...polygon, outer, holes: [], kind: 'forest' });
        }
      });
      polygonsFromLayer(tile.layers.landuse, zoom, tileX, tileY, KEEP_URBAN).forEach((polygon) => {
        const outer = clipRingToBBox(polygon.outer, SLOVAKIA_BOUNDS);
        if (outer.length >= 3) {
          polygons.push({ ...polygon, outer, holes: [], kind: 'urban' });
        }
      });
    }
  }

  const simplified = polygons
    .map((polygon) => {
      const epsilon = polygon.class === 'forest' ? 0.008 : 0.002;
      return {
        ...polygon,
        outer: simplifyRing(polygon.outer, epsilon),
        holes: [],
      };
    })
    .filter((polygon) => {
      if (polygon.outer.length < 3) {
        return false;
      }
      const minArea = polygon.kind === 'urban' ? 0.000002 : 0.0000008;
      return Math.abs(ringArea(polygon.outer)) >= minArea;
    });

  const payload = {
    source: 'maptiler',
    zoom,
    tiles,
    missing,
    polygons: simplified,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload));
  return payload;
}
