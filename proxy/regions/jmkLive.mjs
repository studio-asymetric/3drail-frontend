/**
 * Live vehicles of Brno and South Moravia (IDS JMK) from KORDIS' open ArcGIS stream.
 *
 *   wss://gis.brno.cz/geoevent/ws/services/Kordis_stream/StreamServer/subscribe
 *
 * Every vehicle sends its position (about a second old), line, delay in minutes and type every
 * ~10 s. Which timetable trip a train or tram is on comes from KORDIS' GTFS-Realtime file (trip id
 * and position of every vehicle): the two are joined by line name and nearest position. Trains and
 * trams of the timetable are handed to the region like Golemio ones, `{ delaySec, lat, lng }` per
 * run; the rest (buses, trolleybuses) as plain records.
 */
import fs from 'node:fs';
import path from 'node:path';

const STREAM_URL = 'wss://gis.brno.cz/geoevent/ws/services/Kordis_stream/StreamServer/subscribe';
const RT_URL = 'https://kordis-jmk.cz/gtfs/gtfsReal.dat';
const PUSH_MS = 4_000;
const POSITIONS_MS = 15_000;
const STALE_MS = 3 * 60_000;
/** Stream VType -> GTFS route type, for vehicles whose trip is not in the timetable. */
const TYPE_OF_VTYPE = { 0: 0, 1: 11, 2: 3, 4: 3, 5: 2 };

function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (quoted) {
      if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = splitCsv(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    const row = {};
    header.forEach((name, i) => (row[name] = cells[i] ?? ''));
    return row;
  });
}

// --- GTFS-Realtime vehicle positions (protobuf), decoded by hand: only a few fields are needed ---

function readVarint(buf, at) {
  let result = 0;
  let shift = 0;
  let pos = at;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

/** Every field of one message: [{ field, wire, value }]; value is a number or, for length-delimited fields, a Buffer. */
function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      out.push({ field, wire, value });
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.readDoubleLE(pos) });
      pos += 8;
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      out.push({ field, wire, value: buf.subarray(pos, pos + length) });
      pos += length;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.readFloatLE(pos) });
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

const first = (fields, field) => fields.find((f) => f.field === field)?.value;

/** Vehicle positions of a GTFS-Realtime FeedMessage: [{ tripId, lat, lng, at (epoch ms) }]. */
export function decodeVehiclePositions(buffer) {
  const out = [];
  for (const entity of readFields(buffer)) {
    if (entity.field !== 2) continue;
    const vehicleBuf = first(readFields(entity.value), 4);
    if (!vehicleBuf) continue;
    const vehicle = readFields(vehicleBuf);
    const tripBuf = first(vehicle, 1);
    const positionBuf = first(vehicle, 2);
    if (!tripBuf || !positionBuf) continue;
    const tripId = first(readFields(tripBuf), 1)?.toString('utf8');
    const position = readFields(positionBuf);
    const lat = first(position, 1);
    const lng = first(position, 2);
    const stamp = first(vehicle, 5);
    if (!tripId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ tripId, lat, lng, at: Number.isFinite(stamp) ? stamp * 1000 : Date.now() });
  }
  return out;
}

const metersBetween = (latA, lngA, latB, lngB) =>
  Math.hypot((latB - latA) * 110574, (lngB - lngA) * 111320 * Math.cos((latA * Math.PI) / 180));
const MATCH_METERS = 450;

/**
 * Turn the stream's vehicles and the timetable trips of the realtime feed into what the region wants.
 * The stream knows the delay, line and a position a second old; the realtime feed knows the trip.
 * They are joined by line name and nearest position. `tripKey`: trip_id -> region key of a running
 * train or tram.
 */
export function convertRecords(records, { positions, tripKey, tripInfo, routes, shortOfTrip, now = Date.now() }) {
  const rail = new Map();
  const other = [];
  const byLine = new Map(); // line short name -> [position records]
  for (const p of positions) {
    const short = shortOfTrip(p.tripId);
    if (!short) continue;
    if (!byLine.has(short)) byLine.set(short, []);
    byLine.get(short).push(p);
  }
  const taken = new Set();
  const nearest = (a, wantRunning) => {
    let best = null;
    let bestD = MATCH_METERS;
    for (const p of byLine.get(String(a.LineName)) ?? []) {
      if (taken.has(p) || (wantRunning && !tripKey.has(p.tripId))) continue;
      const d = metersBetween(a.Lat, a.Lng, p.lat, p.lng);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };
  const live = [];
  for (const a of records) {
    if (!a || a.IsInactive === 'true' || a.IsInactive === true) continue;
    if (!Number.isFinite(a.Lat) || !Number.isFinite(a.Lng)) continue;
    const stamp = Number(a.TimeUpdated);
    if (Number.isFinite(stamp) && now - stamp > STALE_MS) continue;
    live.push(a);
  }
  // trains and trams first: they must find their timetable run
  const rails = live.filter((a) => a.VType === 0 || a.VType === 5);
  const matched = new Set();
  for (const a of rails) {
    const p = nearest(a, true);
    if (!p) continue;
    taken.add(p);
    matched.add(a);
    const stamp = Number(a.TimeUpdated);
    // the stream's delay is whole minutes: the browser follows the GPS rather than placing it by the timetable
    rail.set(tripKey.get(p.tripId), {
      delaySec: Math.round((Number(a.Delay) || 0) * 60),
      exactDelay: false,
      lastSeq: null,
      atStop: false,
      lat: a.Lat,
      lng: a.Lng,
      at: Number.isFinite(stamp) ? stamp : now,
    });
  }
  for (const a of live) {
    if (matched.has(a)) continue;
    if (a.VType === 5) continue; // a train without a run of today's timetable cannot be placed on a line
    const p = nearest(a, false);
    if (p) taken.add(p);
    const info = p ? tripInfo.get(p.tripId) : undefined;
    const route = info ? routes.get(info.routeId) : undefined;
    const type = route?.type ?? TYPE_OF_VTYPE[a.VType];
    if (type == null || type === 2 || type === 1) continue;
    const stamp = Number(a.TimeUpdated);
    other.push({
      tripId: p?.tripId ?? `v${a.ID}`,
      routeId: info?.routeId ?? '',
      short: route?.short || a.LineName || '',
      type,
      headsign: info?.headsign ?? '',
      agency: 'IDS JMK',
      startTs: '',
      lat: a.Lat,
      lng: a.Lng,
      bearing: Number.isFinite(Number(a.Bearing)) ? Number(a.Bearing) : undefined,
      delaySec: Math.round((Number(a.Delay) || 0) * 60),
      lastStopId: '',
      nextStopId: '',
      lastTime: '',
      nextTime: '',
      lastSeq: null,
      atStop: false,
      at: Number.isFinite(stamp) ? stamp : now,
    });
  }
  return { rail, other };
}

export function startJmkLive({ region, dataDir, log = () => undefined }) {
  const routes = new Map();
  readRows(path.join(dataDir, 'routes.txt')).forEach((r) =>
    routes.set(r.route_id, { short: r.route_short_name, color: r.route_color, type: Number(r.route_type) })
  );
  const tripInfo = new Map();
  // other_trips.txt has no header: trip_id,route_id,headsign
  if (fs.existsSync(path.join(dataDir, 'other_trips.txt'))) {
    for (const line of fs.readFileSync(path.join(dataDir, 'other_trips.txt'), 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const [tripId, routeId, headsign] = splitCsv(line);
      tripInfo.set(tripId, { routeId, headsign });
    }
  }
  log(`JMK live: ${tripInfo.size} bus trips known`);

  const vehicles = new Map(); // ID -> latest attributes
  let positions = []; // GTFS-Realtime vehicle positions: which timetable trip is where
  const pollPositions = async () => {
    try {
      const response = await fetch(RT_URL, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      positions = decodeVehiclePositions(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      log(`JMK live: realtime feed failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let stopped = false;
  let socket = null;
  let retry = 0;
  let timer = null;

  const connect = async () => {
    if (stopped) return;
    try {
      // Node 22 has WebSocket built in; older Node falls back to the `ws` package when it is there
      const Socket = globalThis.WebSocket ?? (await import('ws')).default;
      const ws = new Socket(STREAM_URL);
      socket = ws;
      const onText = (data) => {
        try {
          const a = JSON.parse(String(data)).attributes;
          if (a && a.ID != null) vehicles.set(a.ID, a);
        } catch {
          // a malformed message is skipped
        }
      };
      const reconnect = () => {
        if (socket !== ws) return;
        socket = null;
        if (stopped) return;
        retry += 1;
        setTimeout(connect, Math.min(60_000, 2_000 * retry));
      };
      const opened = () => {
        retry = 0;
        log('JMK live: stream connected');
      };
      if (typeof ws.on === 'function') {
        ws.on('open', opened);
        ws.on('message', onText);
        ws.on('close', reconnect);
        ws.on('error', (error) => log(`JMK live: stream error: ${error.message}`));
      } else {
        ws.onopen = opened;
        ws.onmessage = (event) => onText(event.data);
        ws.onclose = reconnect;
        ws.onerror = () => log('JMK live: stream error');
      }
    } catch (error) {
      log(`JMK live: cannot start the stream: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const push = () => {
    const active = region.activeTrips();
    const tripKey = new Map(active.map((entry) => [entry.trip.id, entry.key]));
    const routeOfTrip = new Map(active.map((entry) => [entry.trip.id, entry.trip.routeId]));
    const shortOfTrip = (tripId) => {
      const routeId = routeOfTrip.get(tripId) ?? tripInfo.get(tripId)?.routeId;
      return routeId ? routes.get(routeId)?.short : undefined;
    };
    const now = Date.now();
    for (const [id, a] of vehicles) {
      if (now - Number(a.TimeUpdated) > 10 * 60_000) vehicles.delete(id);
    }
    const { rail, other } = convertRecords([...vehicles.values()], { positions, tripKey, tripInfo, routes, shortOfTrip });
    region.setLive(rail);
    region.setOthers(other);
  };

  connect();
  pollPositions();
  timer = setInterval(() => {
    push();
  }, PUSH_MS);
  const positionTimer = setInterval(pollPositions, POSITIONS_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(positionTimer);
    socket?.close();
    vehicles.clear();
  };
}
