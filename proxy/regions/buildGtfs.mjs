/**
 * Cut a GTFS feed (PID, Prague) down to its rail trips: routes with route_type 2 and only the
 * trips, stop times, shapes and stops they use. The big files are streamed, so the 110 MB
 * stop_times.txt never sits in memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

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
await filterFile('routes.txt', (r) => (r.route_type === '2' ? (railRoutes.add(r.route_id), true) : false)).then((n) =>
  log(`routes: ${n}`)
);

const trips = new Set();
const services = new Set();
const shapes = new Set();
await filterFile('trips.txt', (r) => {
  if (!railRoutes.has(r.route_id)) return false;
  trips.add(r.trip_id);
  services.add(r.service_id);
  if (r.shape_id) shapes.add(r.shape_id);
  return true;
}).then((n) => log(`trips: ${n}`));

const stopIds = new Set();
await filterFile('stop_times.txt', (r) => (trips.has(r.trip_id) ? (stopIds.add(r.stop_id), true) : false)).then((n) =>
  log(`stop_times: ${n}`)
);
await filterFile('shapes.txt', (r) => shapes.has(r.shape_id)).then((n) => log(`shape points: ${n}`));
await filterFile('stops.txt', (r) => stopIds.has(r.stop_id) || r.location_type === '1').then((n) => log(`stops: ${n}`));
await filterFile('calendar.txt', (r) => services.has(r.service_id)).then((n) => log(`calendar: ${n}`));
await filterFile('calendar_dates.txt', (r) => services.has(r.service_id)).then((n) => log(`calendar_dates: ${n}`));
for (const file of ['agency.txt', 'feed_info.txt']) {
  fs.copyFileSync(path.join(inDir, file), path.join(outDir, file));
}
log(`written to ${outDir}`);
}
