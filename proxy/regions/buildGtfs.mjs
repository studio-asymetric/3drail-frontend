/**
 * Cut a GTFS feed (PID, Prague) down to its rail trips: routes with route_type 2 and only the
 * trips, stop times, shapes and stops they use. The big files are streamed, so the 110 MB
 * stop_times.txt never sits in memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Bumped when the cut-down timetable gains files, so older copies are rebuilt. */
export const REGION_DATA_VERSION = 4;

/** GTFS route_type -> bit in stop_modes.txt. */
const TYPE_BIT = { 0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 7: 32, 11: 64 };

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
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Stream a GTFS file: calls onRow(rowObject, rawLine) for each row; returns the header line. */
let inDir = '';
let outDir = '';
async function stream(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(inDir, file), 'utf8'), crlfDelay: Infinity });
  let header = null;
  let headerLine = '';
  for await (const raw of rl) {
    const line = raw.replace(/^\uFEFF/, '');
    if (!line) continue;
    if (!header) {
      header = splitCsv(line);
      headerLine = line;
      continue;
    }
    const cells = splitCsv(line);
    const row = {};
    header.forEach((name, i) => (row[name] = cells[i] ?? ''));
    onRow(row, line);
  }
  return headerLine;
}

async function filterFile(file, keep) {
  const out = fs.createWriteStream(path.join(outDir, file));
  let count = 0;
  const header = await stream(file, (row, line) => {
    if (keep(row)) {
      out.write(`${line}\n`);
      count += 1;
    }
  });
  // header was only known after the pass: rewrite it in front
  out.end();
  await new Promise((resolve) => out.on('finish', resolve));
  const body = fs.readFileSync(path.join(outDir, file), 'utf8');
  fs.writeFileSync(path.join(outDir, file), `${header}\n${body}`);
  return count;
}

export async function buildRailSubset(inDirArg, outDirArg, log = console.log) {
  inDir = path.resolve(inDirArg);
  outDir = path.resolve(outDirArg);
  fs.mkdirSync(outDir, { recursive: true });
const railRoutes = new Set();
const otherRoutes = new Set();
const routeType = new Map();
const tripType = new Map();
const stopMask = new Map();
// every route is kept (names and colours of buses, trams and metro lines are needed)
await filterFile('routes.txt', (r) => {
  // trains, metro and trams run on tracks: their trips, shapes and stop times are kept in full
  routeType.set(r.route_id, Number(r.route_type));
  (r.route_type === '2' || r.route_type === '0' || r.route_type === '1' ? railRoutes : otherRoutes).add(r.route_id);
  return true;
}).then((n) => log(`routes: ${n}`));

const trips = new Set();
const otherTrips = new Set();
const services = new Set();
const shapes = new Set();
await filterFile('trips.txt', (r) => {
  tripType.set(r.trip_id, routeType.get(r.route_id));
  if (otherRoutes.has(r.route_id)) {
    // not written: buses, trams and metro are shown from the live feed; only their stop times are kept
    otherTrips.add(r.trip_id);
    return false;
  }
  if (!railRoutes.has(r.route_id)) return false;
  trips.add(r.trip_id);
  services.add(r.service_id);
  if (r.shape_id) shapes.add(r.shape_id);
  return true;
}).then((n) => log(`rail trips: ${n}; other trips: ${otherTrips.size}`));

const stopIds = new Set();
const toSec = (text) => {
  const m = String(text).match(/^(\d+):(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : '';
};
{
  const railOut = fs.createWriteStream(path.join(outDir, 'stop_times.txt'));
  const otherOut = fs.createWriteStream(path.join(outDir, 'other_stop_times.txt'));
  let railRows = 0;
  let otherRows = 0;
  const header = await stream('stop_times.txt', (r, line) => {
    const bit = TYPE_BIT[tripType.get(r.trip_id)] ?? 0;
    if (bit) stopMask.set(r.stop_id, (stopMask.get(r.stop_id) ?? 0) | bit);
    if (trips.has(r.trip_id)) {
      railOut.write(`${line}\n`);
      stopIds.add(r.stop_id);
      railRows += 1;
    } else if (otherTrips.has(r.trip_id)) {
      // compact: trip, arrival s, departure s, stop, sequence (no header; read back by offset)
      otherOut.write(`${r.trip_id},${toSec(r.arrival_time)},${toSec(r.departure_time)},${r.stop_id},${r.stop_sequence}\n`);
      stopIds.add(r.stop_id);
      otherRows += 1;
    }
  });
  railOut.end();
  otherOut.end();
  await Promise.all([
    new Promise((resolve) => railOut.on('finish', resolve)),
    new Promise((resolve) => otherOut.on('finish', resolve)),
  ]);
  const body = fs.readFileSync(path.join(outDir, 'stop_times.txt'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'stop_times.txt'), `${header}\n${body}`);
  log(`stop_times: ${railRows} rail rows, ${otherRows} other rows`);
}
await filterFile('shapes.txt', (r) => shapes.has(r.shape_id)).then((n) => log(`shape points: ${n}`));
await filterFile('stops.txt', (r) => stopIds.has(r.stop_id) || r.location_type === '1').then((n) => log(`stops: ${n}`));
await filterFile('calendar.txt', (r) => services.has(r.service_id)).then((n) => log(`calendar: ${n}`));
await filterFile('calendar_dates.txt', (r) => services.has(r.service_id)).then((n) => log(`calendar_dates: ${n}`));
for (const file of ['agency.txt', 'feed_info.txt']) {
  fs.copyFileSync(path.join(inDir, file), path.join(outDir, file));
}
fs.writeFileSync(
  path.join(outDir, 'stop_modes.txt'),
  `${[...stopMask.entries()].map(([id, mask]) => `${id},${mask}`).join('\n')}\n`
);
fs.writeFileSync(path.join(outDir, 'region.version'), String(REGION_DATA_VERSION));
log(`written to ${outDir}`);
}
