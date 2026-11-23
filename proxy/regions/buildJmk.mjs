/**
 * Brno + South Moravia (IDS JMK): download the open GTFS timetable and make it look like the PID
 * one the region code already reads. IDS JMK publishes no shapes.txt, so the line of every train
 * and tram run is traced here along the OpenStreetMap rails (trains) and tram tracks (trams), by
 * the same map matcher that draws Slovak trains. Buses and trolleybuses are shown from the live
 * feed alone, as in Prague.
 *
 *   data: https://kordis-jmk.cz/gtfs/gtfs.zip (CC BY 4.0)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRailSubset } from './buildGtfs.mjs';
import { buildRouteGraph, traceRoute } from '../railRoute.mjs';

export const JMK_FEED_URL = 'https://kordis-jmk.cz/gtfs/gtfs.zip';
/** Bumped when this build gains files or changes its output, so older copies are rebuilt. */
export const JMK_DATA_VERSION = 'jmk-2';
/** South Moravia and a margin (trains run on into the neighbouring regions). */
const BBOX = { minLat: 48.55, maxLat: 49.75, minLng: 15.85, maxLng: 17.75 };
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OSM_MAX_AGE_MS = 14 * 24 * 3_600_000;

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())));

/** Rewrite a text file as UTF-8 when it is not (the feed ships Windows-1250). */
function toUtf8(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  if (!text.includes('�')) return;
  fs.writeFileSync(file, new TextDecoder('windows-1250').decode(buf));
}

function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null;
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '');
    if (!line) continue;
    if (!header) {
      header = splitCsv(line);
      continue;
    }
    const cells = splitCsv(line);
    const row = {};
    header.forEach((name, i) => (row[name] = cells[i] ?? ''));
    onRow(row);
  }
}

const csvCell = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

/** OSM rails and tram tracks of South Moravia, as downloaded once and kept in the repository (Overpass is slow and often busy). */
const BUNDLED_OSM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jmk-osm.json');

/**
 * OSM rails and tram tracks of South Moravia: the copy kept in the repository, else a cached download,
 * else a fresh download. To refresh the copy, delete it and the cache and run a build once.
 */
export async function loadOsm(cacheFile, log) {
  try {
    return JSON.parse(fs.readFileSync(BUNDLED_OSM, 'utf8'));
  } catch {
    // not there: use the cache or download below
  }
  try {
    if (Date.now() - fs.statSync(cacheFile).mtimeMs < OSM_MAX_AGE_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch {
    // fetch below
  }
  const filters =
    '["service"!~"^(spur|siding|yard|crossover|driveway)$"]["usage"!~"^(industrial|military|test|tourism)$"]';
  const bbox = `${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng}`;
  const query = `[out:json][timeout:240];
(
  way["railway"~"^(rail|light_rail|narrow_gauge)$"]${filters}(${bbox});
  way["railway"="tram"]["service"!~"^(siding|yard|crossover|driveway)$"](${bbox});
);
out geom tags;`;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      log(`JMK: downloading OpenStreetMap rails from ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': '3Drail-frontend/1.0 (railmap proxy)' },
        body: query,
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const ways = (body.elements ?? [])
        .filter((el) => el.type === 'way' && Array.isArray(el.geometry))
        .map((el) => ({ tram: el.tags?.railway === 'tram', geometry: el.geometry.map((p) => ({ lat: p.lat, lon: p.lon })) }));
      if (ways.length < 100) throw new Error(`only ${ways.length} ways`);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(ways));
      try {
        fs.writeFileSync(BUNDLED_OSM, JSON.stringify(ways)); // so the next build (and a commit) has it
      } catch {
        // a read-only install: the cache is enough
      }
      return ways;
    } catch (error) {
      lastError = error;
      log(`JMK: OpenStreetMap download failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
  // an old copy beats none
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  throw lastError ?? new Error('OpenStreetMap download failed');
}

/** One polyline through a trace's pieces; a hop that could not be routed is bridged by a straight line. */
function joinPieces(result, waypoints) {
  const line = [];
  const push = (lat, lng) => {
    const last = line[line.length - 1];
    if (!last || last[0] !== lat || last[1] !== lng) line.push([lat, lng]);
  };
  if (result.segments.length === 0) {
    waypoints.forEach((w) => push(w.lat, w.lng));
    return { line, routed: false };
  }
  result.segments.forEach((piece) => piece.forEach(([lat, lng]) => push(lat, lng)));
  return { line, routed: result.stats.gaps === 0 };
}

/** The two routing graphs: trains on the rails, trams on the tram tracks. */
export function buildGraphs(osm) {
  return {
    2: buildRouteGraph(osm.filter((w) => !w.tram), { keepShort: true }),
    0: buildRouteGraph(osm.filter((w) => w.tram), { keepShort: true }),
  };
}

/** Where the corrections learned from live vehicles are kept: they survive a rebuild of the timetable. */
export const hintsFileOf = (dataDir) => path.join(path.dirname(dataDir), 'jmk-route-hints.json');

export function readHints(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(hintsFileOf(dataDir), 'utf8'));
  } catch {
    return {};
  }
}

/** The pattern key of a run: its kind (0 tram, 2 train) and stop ids. */
export const patternKey = (type, stopIds) => `${type}|${stopIds.join(',')}`;

/**
 * The line of one stop pattern along the tracks. `stops`: [{ id, lat, lng }] in order; `hints`: places
 * real vehicles were seen between two stops ({ from, to, lat, lng }): the route is made to pass them,
 * so a way round that really is used wins over a shorter one that is not.
 */
export function tracePattern(graphs, type, stops, hints = []) {
  const waypoints = [];
  stops.forEach((stop, i) => {
    waypoints.push({ lat: stop.lat, lng: stop.lng });
    const next = stops[i + 1];
    for (const hint of hints) {
      if (hint.from === stop.id && (!next || hint.to === next.id)) waypoints.push({ lat: hint.lat, lng: hint.lng });
    }
  });
  // trams run stop to stop along the street: a hop that needs a long way round is a gap, not a loop
  const result = traceRoute(graphs[type], waypoints, String(type) === '0' ? { detourRatio: 1.8, detourSlack: 800 } : undefined);
  return joinPieces(result, waypoints);
}

export async function buildJmkRegion(dataDir, log = () => undefined) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jmk-'));
  try {
    const zipPath = path.join(work, 'feed.zip');
    log(`JMK: downloading ${JMK_FEED_URL}`);
    const response = await fetch(JMK_FEED_URL, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    const raw = path.join(work, 'raw');
    fs.mkdirSync(raw);
    await run('unzip', ['-q', '-o', zipPath, '-d', raw]);
    for (const name of fs.readdirSync(raw)) {
      if (name.endsWith('.txt') && name !== 'stop_times.txt') toUtf8(path.join(raw, name));
    }

    // trolleybuses are route_type 800 here: the region code knows them as 11
    const routeType = new Map();
    {
      const file = path.join(raw, 'routes.txt');
      const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
      const header = splitCsv(lines[0]);
      const typeAt = header.indexOf('route_type');
      const idAt = header.indexOf('route_id');
      const out = [lines[0]];
      for (const line of lines.slice(1)) {
        const cells = splitCsv(line);
        if (cells[typeAt] === '800') cells[typeAt] = '11';
        routeType.set(cells[idAt], cells[typeAt]);
        out.push(cells.map(csvCell).join(','));
      }
      fs.writeFileSync(file, `${out.join('\n')}\n`);
    }

    if (!fs.existsSync(path.join(raw, 'feed_info.txt'))) fs.writeFileSync(path.join(raw, 'feed_info.txt'), 'feed_publisher_name\nKORDIS JMK\n');
    const stops = new Map();
    await eachRow(path.join(raw, 'stops.txt'), (r) => stops.set(r.stop_id, { lat: Number(r.stop_lat), lng: Number(r.stop_lon) }));

    // stop pattern of every train and tram trip
    const tripRows = [];
    const tripInfo = new Map(); // trip_id -> { type, stops: [] }
    await eachRow(path.join(raw, 'trips.txt'), (r) => {
      const type = routeType.get(r.route_id);
      if (type === '0' || type === '2') tripInfo.set(r.trip_id, { type, stops: [] });
    });
    await eachRow(path.join(raw, 'stop_times.txt'), (r) => {
      const trip = tripInfo.get(r.trip_id);
      if (trip) trip.stops.push([Number(r.stop_sequence), r.stop_id]);
    });
    const patterns = new Map(); // "type|stop,stop,..." -> shape_id
    tripInfo.forEach((trip) => {
      trip.stops.sort((a, b) => a[0] - b[0]);
      trip.key = `${trip.type}|${trip.stops.map((s) => s[1]).join(',')}`;
      if (!patterns.has(trip.key)) patterns.set(trip.key, `jmk${patterns.size}`);
    });
    log(`JMK: ${tripInfo.size} train and tram trips, ${patterns.size} different stop patterns`);

    const osm = await loadOsm(path.join(path.dirname(dataDir), 'jmk-osm-cache.json'), log);
    log(`JMK: ${osm.length} track pieces; building route graphs`);
    const graphs = buildGraphs(osm);
    const hints = readHints(dataDir);

    const shapeLines = [];
    let routed = 0;
    let partly = 0;
    const startedAt = Date.now();
    for (const [key, shapeId] of patterns) {
      const [type, list] = key.split('|');
      const waypoints = list
        .split(',')
        .map((id) => ({ id, ...stops.get(id) }))
        .filter((s) => Number.isFinite(s.lat));
      if (waypoints.length < 2) continue;
      const { line, routed: ok } = tracePattern(graphs, type, waypoints, hints[key] ?? []);
      if (ok) routed += 1;
      else partly += 1;
      let cum = 0;
      line.forEach(([lat, lng], i) => {
        if (i > 0) {
          const dy = (lat - line[i - 1][0]) * 110574;
          const dx = (lng - line[i - 1][1]) * 111320 * Math.cos((lat * Math.PI) / 180);
          cum += Math.hypot(dx, dy);
        }
        shapeLines.push(`${shapeId},${lat},${lng},${i + 1},${cum.toFixed(1)}`);
      });
    }
    log(`JMK: routed ${routed} patterns along the tracks, ${partly} partly or not (${Math.round((Date.now() - startedAt) / 1000)} s)`);
    fs.writeFileSync(path.join(raw, 'shapes.txt'), `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n${shapeLines.join('\n')}\n`);

    // trips.txt with a shape for the train and tram trips; the other trips' names go to a side file
    {
      const file = path.join(raw, 'trips.txt');
      const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
      const header = splitCsv(lines[0]);
      const idAt = header.indexOf('trip_id');
      const routeAt = header.indexOf('route_id');
      const headAt = header.indexOf('trip_headsign');
      let shapeAt = header.indexOf('shape_id');
      const outHeader = shapeAt >= 0 ? header : [...header, 'shape_id'];
      if (shapeAt < 0) shapeAt = header.length;
      const out = [outHeader.join(',')];
      const side = [];
      for (const line of lines.slice(1)) {
        const cells = splitCsv(line);
        const trip = tripInfo.get(cells[idAt]);
        cells[shapeAt] = trip ? patterns.get(trip.key) ?? '' : '';
        out.push(cells.map(csvCell).join(','));
        if (!trip) side.push(`${cells[idAt]},${cells[routeAt]},${csvCell(cells[headAt])}`);
      }
      fs.writeFileSync(file, `${out.join('\n')}\n`);
      fs.writeFileSync(path.join(work, 'other_trips.txt'), `${side.join('\n')}\n`);
    }

    const out = `${dataDir}.tmp`;
    fs.rmSync(out, { recursive: true, force: true });
    await buildRailSubset(raw, out, () => undefined);
    fs.copyFileSync(path.join(work, 'other_trips.txt'), path.join(out, 'other_trips.txt'));
    // Line/course -> trip id, for the live feed
    if (fs.existsSync(path.join(raw, 'api.txt'))) fs.copyFileSync(path.join(raw, 'api.txt'), path.join(out, 'api.txt'));
    fs.writeFileSync(path.join(out, 'region.version'), JMK_DATA_VERSION);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.renameSync(out, dataDir);
    log('JMK: timetable updated');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
