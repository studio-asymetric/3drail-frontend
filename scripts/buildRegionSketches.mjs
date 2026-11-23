/**
 * Draws each region as a tiny SVG for the menu's region cards: its outline and the lines
 * passenger trains run on.
 *
 *   node scripts/buildRegionSketches.mjs [proxy = http://127.0.0.1:3001] [only = jmk,pid]
 *
 * The outline comes from OpenStreetMap (Nominatim, once), the lines from the proxy's journeys
 * (the routes of the trains running right now, so run it by day). Writes src/data/regionSketch.ts.
 */
import fs from 'node:fs';
import { decodePolyline } from '../proxy/railRoute.mjs';

const proxy = process.argv[2] ?? 'http://127.0.0.1:3001';
// regions to redraw (the others keep their sketch from the file)
const only = (process.argv[3] ?? '').split(',').filter(Boolean);
const W = 200;
const H = 120;
const PAD = 6;
const UA = 'region-sketch-script/1.0';

const REGIONS = {
  sk: { journeys: '', outlines: ['country=Slovakia'] },
  pid: {
    journeys: '&regions=pid&only=1',
    outlines: ['state=Středočeský kraj&country=Czechia', 'city=Praha&country=Czechia'],
  },
  jmk: {
    journeys: '&regions=jmk&only=1',
    outlines: ['state=Jihomoravský kraj&country=Czechia'],
  },
};

/** Douglas-Peucker on [x, y]. */
function rdp(points, eps) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const dx = points[b][0] - ax;
    const dy = points[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i += 1) {
      const px = points[i][0] - ax;
      const py = points[i][1] - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d = Math.hypot(px - dx * t, py - dy * t);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

async function outlineRings(query) {
  const url = `https://nominatim.openstreetmap.org/search?${query}&format=jsonv2&polygon_geojson=1&polygon_threshold=0.004&limit=1`;
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`Nominatim ${query}: HTTP ${response.status}`);
  const [hit] = await response.json();
  const geo = hit?.geojson;
  if (!geo) throw new Error(`No outline for ${query}`);
  // [lng, lat] rings: outer rings of every polygon, holes dropped
  const polygons = geo.type === 'MultiPolygon' ? geo.coordinates : geo.type === 'Polygon' ? [geo.coordinates] : [];
  return polygons.map((polygon) => polygon[0]);
}

async function routeLines(query) {
  const response = await fetch(`${proxy}/proxy/journeys?mode=journeys&v=2${query}`);
  if (!response.ok) throw new Error(`journeys: HTTP ${response.status}`);
  const payload = await response.json();
  const lines = [];
  for (const route of Object.values(payload.routes ?? {})) {
    // decodePolyline gives [lat, lng]
    lines.push(decodePolyline(route.line).map(([lat, lng]) => [lng, lat]));
  }
  return lines;
}

const file = new URL('../src/data/regionSketch.ts', import.meta.url);
const existing = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8').match(/REGION_SKETCH:[^=]*=\s*(\{[\s\S]*\});/)?.[1] ?? '{}')
  : {};
const out = { ...existing };
for (const [id, region] of Object.entries(REGIONS)) {
  if (only.length > 0 && !only.includes(id)) continue;
  const rings = [];
  for (const query of region.outlines) {
    rings.push(...(await outlineRings(query)));
    await new Promise((resolve) => setTimeout(resolve, 1200)); // Nominatim: one request a second
  }
  const lines = await routeLines(region.journeys);

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = (maxLng - minLng) * k;
  const spanY = maxLat - minLat;
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const project = ([lng, lat]) => [offX + (lng - minLng) * k * scale, H - offY - (lat - minLat) * scale];
  const fmt = (points) => points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L');

  const outline = rings
    .map((ring) => rdp(ring.map(project), 0.5))
    .filter((ring) => ring.length > 3)
    .map((ring) => `M${fmt(ring)}Z`)
    .join('');

  // Each stretch of track once: trains of many routes share it. Cells of ~1.4 sketch units.
  const seen = new Set();
  const cell = (p) => `${Math.round(p[0] / 1.4)},${Math.round(p[1] / 1.4)}`;
  let rails = '';
  for (const line of lines) {
    const points = rdp(line.map(project), 0.45);
    let chain = [];
    const flush = () => {
      if (chain.length >= 2) rails += `M${fmt(chain)}`;
      chain = [];
    };
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = cell(points[i]);
      const b = cell(points[i + 1]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) {
        flush();
        continue;
      }
      seen.add(key);
      if (chain.length === 0) chain.push(points[i]);
      chain.push(points[i + 1]);
    }
    flush();
  }
  out[id] = { outline, rails };
  console.log(id, `${rings.length} rings, ${lines.length} routes: outline ${outline.length} + rails ${rails.length} chars`);
}

fs.writeFileSync(
  file,
  `/** Outline and train lines of each region as small SVG paths (200 x 120), made by scripts/buildRegionSketches.mjs. */
export const REGION_SKETCH_SIZE = { width: ${W}, height: ${H} };

export const REGION_SKETCH: Record<'sk' | 'pid' | 'jmk', { outline: string; rails: string }> = ${JSON.stringify(out, null, 2)};
`
);
