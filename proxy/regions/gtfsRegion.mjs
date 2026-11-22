/**
 * A region served from a plain GTFS timetable (spike: Prague / PID).
 *
 * It answers the same questions the Slovak proxy answers from mapa.zsr.sk, so the unchanged
 * browser app can draw another country: which trains run now (gtall shape), each train's traced
 * line and timed stops (journeys payload v2), the stop list of one train, the station list and the
 * simplified rail network. Without live data every train runs on its timetable; `setLive()` lets a
 * live feed (Golemio vehicle positions, GTFS-RT) correct delay and position on top.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { encodePolyline } from '../railRoute.mjs';
import { locateStops } from '../journeys.mjs';
import { packRails } from '../packRails.mjs';

const LAT_METERS = 110_574;
const LNG_METERS_AT_EQUATOR = 111_320;
const EDGE_MS = 5 * 60_000;

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

function readCsv(file, onRow) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let start = 0;
  let header = null;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (!line) continue;
    const cells = splitCsv(line);
    if (!header) {
      header = cells;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? '';
    onRow(row);
  }
}

const meters = (latA, lngA, latB, lngB) =>
  Math.hypot(
    (lngB - lngA) * LNG_METERS_AT_EQUATOR * Math.cos((((latA + latB) / 2) * Math.PI) / 180),
    (latB - latA) * LAT_METERS
  );

function clock(sec) {
  const s = ((Math.round(sec) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

const timeToSec = (text) => {
  const m = String(text).match(/^(\d+):(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/** Epoch ms of local midnight of `ymd` (YYYYMMDD) in `tz`: noon local minus twelve hours. */
function localMidnight(ymd, tz) {
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const noonUtc = Date.UTC(y, mo - 1, d, 12);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(noonUtc));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const localMinutes = get('hour') * 60 + get('minute');
  // local noon happens (localMinutes - 720) minutes after the UTC noon guess
  return noonUtc - (localMinutes - 12 * 60) * 60_000 - 12 * 3_600_000;
}

function ymdOf(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
    .replaceAll('-', '');
}


/** Douglas-Peucker on [lat, lng] points: drops vertices closer than `eps` metres to the straight line. */
function simplifyLine(line, eps = 3) {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const kx = LNG_METERS_AT_EQUATOR * Math.cos((line[a][0] * Math.PI) / 180);
    const ax = line[a][1] * kx;
    const ay = line[a][0] * LAT_METERS;
    const dx = line[b][1] * kx - ax;
    const dy = line[b][0] * LAT_METERS - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i += 1) {
      const px = line[i][1] * kx - ax;
      const py = line[i][0] * LAT_METERS - ay;
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
  return line.filter((_, i) => keep[i]);
}

const MODE_BY_TYPE = { 0: 'tram', 1: 'metro', 3: 'bus', 4: 'ferry', 7: 'funicular', 11: 'trolley' };
const MODE_CODE = { tram: 't', metro: 'm', bus: 'b', ferry: 'f', funicular: 'n', trolley: 'u' };

export function createGtfsRegion({ dir, tz = 'Europe/Prague', log = () => undefined }) {
  const stops = new Map(); // stop_id -> { name, lat, lng }
  const routes = new Map(); // route_id -> { short, long, color }
  const services = new Map(); // service_id -> { days[7 mon..sun], start, end }
  const added = new Map(); // service_id -> Set(ymd)
  const removed = new Map();
  const trips = new Map(); // trip_id -> { id, routeId, serviceId, head, shapeId, stops: [] }
  const shapesRaw = new Map(); // shape_id -> [[lat,lng,seq]]

  readCsv(path.join(dir, 'stops.txt'), (r) =>
    stops.set(r.stop_id, { name: r.stop_name, lat: Number(r.stop_lat), lng: Number(r.stop_lon) })
  );
  readCsv(path.join(dir, 'routes.txt'), (r) =>
    routes.set(r.route_id, {
      short: r.route_short_name,
      long: r.route_long_name,
      color: r.route_color,
      type: Number(r.route_type),
    })
  );
  readCsv(path.join(dir, 'calendar.txt'), (r) =>
    services.set(r.service_id, {
      days: [r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday, r.sunday].map((v) => v === '1'),
      start: r.start_date,
      end: r.end_date,
    })
  );
  readCsv(path.join(dir, 'calendar_dates.txt'), (r) => {
    const book = r.exception_type === '1' ? added : removed;
    if (!book.has(r.service_id)) book.set(r.service_id, new Set());
    book.get(r.service_id).add(r.date);
  });
  readCsv(path.join(dir, 'trips.txt'), (r) =>
    trips.set(r.trip_id, {
      id: r.trip_id,
      routeId: r.route_id,
      serviceId: r.service_id,
      head: r.trip_headsign,
      shapeId: r.shape_id,
      stops: [],
    })
  );
  readCsv(path.join(dir, 'stop_times.txt'), (r) => {
    const trip = trips.get(r.trip_id);
    if (!trip) return;
    trip.stops.push({
      seq: Number(r.stop_sequence),
      stopId: r.stop_id,
      arr: timeToSec(r.arrival_time),
      dep: timeToSec(r.departure_time),
    });
  });
  readCsv(path.join(dir, 'shapes.txt'), (r) => {
    let list = shapesRaw.get(r.shape_id);
    if (!list) shapesRaw.set(r.shape_id, (list = []));
    list.push([Number(r.shape_pt_lat), Number(r.shape_pt_lon), Number(r.shape_pt_sequence)]);
  });
  trips.forEach((trip) => trip.stops.sort((a, b) => a.seq - b.seq));
  log(`GTFS region: ${trips.size} trips, ${stops.size} stops, ${shapesRaw.size} shapes`);

  /** shape_id -> { line [[lat,lng]], cum, encoded } */
  const shapeCache = new Map();
  function shapeOf(id) {
    let shape = shapeCache.get(id);
    if (shape === undefined) {
      const raw = shapesRaw.get(id);
      if (!raw || raw.length < 2) {
        shape = null;
      } else {
        raw.sort((a, b) => a[2] - b[2]);
        const line = simplifyLine(raw.map(([lat, lng]) => [lat, lng]));
        const cum = new Float64Array(line.length);
        for (let i = 1; i < line.length; i += 1) {
          cum[i] = cum[i - 1] + meters(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
        }
        shape = { line, cum, encoded: encodePolyline(line) };
      }
      shapeCache.set(id, shape);
    }
    return shape;
  }

  /** trip_id -> stops located along its shape (computed once). */
  const locatedCache = new Map();
  function locatedOf(trip) {
    if (locatedCache.has(trip.id)) return locatedCache.get(trip.id);
    const shape = shapeOf(trip.shapeId);
    let result = null;
    if (shape) {
      const points = trip.stops.map((s) => stops.get(s.stopId) ?? { lat: NaN, lng: NaN });
      result = locateStops(shape.line, shape.cum, points);
    }
    locatedCache.set(trip.id, result);
    return result;
  }

  function serviceRuns(serviceId, ymd, weekday) {
    if (removed.get(serviceId)?.has(ymd)) return false;
    if (added.get(serviceId)?.has(ymd)) return true;
    const svc = services.get(serviceId);
    return Boolean(svc && svc.days[weekday] && ymd >= svc.start && ymd <= svc.end);
  }

  /** Browser-safe unique id of one run: middle part of the trip id plus the service day. */
  const typeOf = (trip) => routes.get(trip.routeId)?.type ?? 2;
  function keyOf(trip, ymd) {
    const mid = trip.id.split('_')[1] ?? trip.id.replace(/\W/g, '').slice(-6);
    const type = typeOf(trip);
    // trams and metro get a letter, so their numbers cannot meet a train's
    const code = type === 2 ? '' : MODE_CODE[MODE_BY_TYPE[type]] ?? '';
    return `p${mid}${ymd.slice(6)}${code}`.slice(0, 12);
  }

  let activeCache = { at: 0, list: [] };
  /**
   * What is shown: the trips of the timetable that are running, but trams and metro only while the
   * live feed reports them (a timetable-only tram would be a ghost; trains are shown either way).
   */
  function active(nowMs = Date.now()) {
    return scheduled(nowMs).filter((entry) => typeOf(entry.trip) === 2 || live.has(entry.key));
  }

  /** Every trip running at `nowMs` by the timetable: { trip, key, midnight (epoch ms of local midnight), ymd }. */
  function scheduled(nowMs = Date.now()) {
    if (nowMs - activeCache.at < 10_000) return activeCache.list;
    const list = [];
    for (const dayShift of [-1, 0]) {
      const ymd = ymdOf(nowMs + dayShift * 86_400_000, tz);
      const midnight = localMidnight(ymd, tz);
      const weekday = (new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay() + 6) % 7;
      trips.forEach((trip) => {
        if (trip.stops.length < 2 || !serviceRuns(trip.serviceId, ymd, weekday)) return;
        const first = trip.stops[0].dep ?? trip.stops[0].arr;
        const last = trip.stops[trip.stops.length - 1].arr ?? trip.stops[trip.stops.length - 1].dep;
        if (first == null || last == null) return;
        if (nowMs < midnight + first * 1000 - EDGE_MS || nowMs > midnight + last * 1000 + EDGE_MS) return;
        list.push({ trip, key: keyOf(trip, ymd), midnight, ymd });
      });
    }
    activeCache = { at: nowMs, list };
    return list;
  }

  /** Position and last-passed stop index of one active run from the timetable (+ delay seconds). */
  function simulate(entry, nowMs, delaySec = 0) {
    const { trip, midnight } = entry;
    const shape = shapeOf(trip.shapeId);
    const located = locatedOf(trip);
    if (!shape || !located) return null;
    const t = (nowMs - delaySec * 1000 - midnight) / 1000;
    let lastIdx = 0;
    let along = null;
    const pts = [];
    trip.stops.forEach((s, i) => {
      const at = located[i];
      if (at != null) pts.push({ i, at, arr: s.arr ?? s.dep, dep: s.dep ?? s.arr });
    });
    if (pts.length < 2) return null;
    if (t <= pts[0].dep) {
      along = pts[0].at;
      lastIdx = pts[0].i;
    } else if (t >= pts[pts.length - 1].arr) {
      along = pts[pts.length - 1].at;
      lastIdx = pts[pts.length - 1].i;
    } else {
      for (let k = 0; k < pts.length - 1; k += 1) {
        const a = pts[k];
        const b = pts[k + 1];
        if (t < a.dep) {
          along = a.at;
          lastIdx = a.i;
          break;
        }
        if (t <= b.arr) {
          const f = b.arr > a.dep ? (t - a.dep) / (b.arr - a.dep) : 1;
          along = a.at + (b.at - a.at) * f;
          lastIdx = a.i;
          break;
        }
      }
    }
    if (along == null) return null;
    const { line, cum } = shape;
    let lo = 0;
    let hi = line.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= along) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1;
    const f = Math.min(1, Math.max(0, (along - cum[lo]) / span));
    const lat = line[lo][0] + (line[hi][0] - line[lo][0]) * f;
    const lng = line[lo][1] + (line[hi][1] - line[lo][1]) * f;
    const heading =
      (Math.atan2((line[hi][1] - line[lo][1]) * Math.cos((lat * Math.PI) / 180), line[hi][0] - line[lo][0]) * 180) /
      Math.PI;
    return { lat, lng, heading: (heading + 360) % 360, lastIdx, t, along };
  }

  let live = new Map(); // key -> { delaySec, lat, lng }

  // Buses, trams, metro and the like: only what the live feed says about them.
  let others = new Map(); // key -> { v: live record, row: gtall row }
  const stopName = (id) => stops.get(id)?.name ?? '';

  function otherRow(v) {
    const mode = MODE_BY_TYPE[v.type] ?? 'bus';
    const mid = v.tripId.split('_')[1] ?? v.tripId.replace(/\W/g, '').slice(-6);
    const day = v.startTs.slice(8, 10) || '00';
    const key = `p${mid}${day}${MODE_CODE[mode]}`.slice(0, 12);
    const delayMin = Math.round(v.delaySec / 60);
    return [
      key,
      {
        CisloVlaku: key,
        TypVlaku: v.short,
        NazovVlaku: v.short,
        Nazov: v.headsign,
        Popis: `${v.short} → ${v.headsign}`,
        Position: [v.lat, v.lng],
        Trasa: [],
        Meska: delayMin,
        MeskaSkutocne: delayMin,
        MeskaColor: delayMin > 5 ? 'red' : delayMin > 1 ? 'orange' : 'green',
        InfoZoStanice: stopName(v.lastStopId),
        NextStation: stopName(v.nextStopId),
        Cas: '',
        CasPlan: '',
        Dopravca: v.agency,
        Angle: Number.isFinite(v.bearing) ? v.bearing : undefined,
        Narusenie: false,
        PotvrdenyOdj: !v.atStop,
        PositionLive: true,
        Rezim: mode,
        Farba: routes.get(v.routeId)?.color || '',
      },
    ];
  }

  // stop times of the other trips, read from disk by offset when a vehicle is opened
  let otherIndex = null;
  let otherFd = null;
  function ensureOtherIndex() {
    if (otherIndex) return otherIndex;
    otherIndex = new Map();
    const file = path.join(dir, 'other_stop_times.txt');
    if (!fs.existsSync(file)) return otherIndex;
    const buf = fs.readFileSync(file);
    let start = 0;
    let current = null;
    let currentStart = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== 10) continue;
      let c = start;
      while (c < i && buf[c] !== 44) c += 1;
      const id = buf.toString('latin1', start, c);
      if (id !== current) {
        if (current !== null) otherIndex.set(current, [currentStart, start]);
        current = id;
        currentStart = start;
      }
      start = i + 1;
    }
    if (current !== null) otherIndex.set(current, [currentStart, start]);
    otherFd = fs.openSync(file, 'r');
    log(`GTFS region: ${otherIndex.size} other trips indexed`);
    return otherIndex;
  }

  function otherDetail(key) {
    const entry = others.get(key);
    if (!entry) return null;
    const { v } = entry;
    const span = ensureOtherIndex().get(v.tripId);
    let rows = [];
    if (span && otherFd != null) {
      const chunk = Buffer.alloc(span[1] - span[0]);
      fs.readSync(otherFd, chunk, 0, chunk.length, span[0]);
      rows = chunk
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(','))
        .map(([, arr, dep, stopId, seq]) => ({ arr: Number(arr), dep: Number(dep), stopId, seq: Number(seq) }))
        .sort((a, b) => a.seq - b.seq);
    }
    const delay = v.delaySec;
    let stopsOut;
    if (rows.length > 0) {
      stopsOut = rows.map((row) => {
        const state = v.lastSeq == null ? 'ahead' : row.seq < v.lastSeq ? 'passed' : row.seq === v.lastSeq ? 'current' : 'ahead';
        const arr = Number.isFinite(row.arr) ? row.arr : row.dep;
        const dep = Number.isFinite(row.dep) ? row.dep : row.arr;
        return {
          name: stopName(row.stopId) || row.stopId,
          arrival: clock(arr + delay),
          departure: clock(dep + delay),
          scheduledArrival: clock(arr),
          scheduledDeparture: clock(dep),
          state,
          kind: 'stop',
        };
      });
    } else {
      // this trip is not in our copy of the timetable (a newer one): at least the last and next stop
      stopsOut = [
        { name: stopName(v.lastStopId), time: v.lastTime, state: 'current' },
        { name: stopName(v.nextStopId), time: v.nextTime, state: 'ahead' },
      ]
        .filter((row) => row.name)
        .map((row) => ({
          name: row.name,
          arrival: row.time,
          departure: row.time,
          scheduledArrival: row.time,
          scheduledDeparture: row.time,
          state: row.state,
          kind: 'stop',
        }));
    }
    return { source: 'gtfs-region', train: key, status: 'live', stops: stopsOut };
  }
  return {
    /** Live feed hook: Map(key -> { delaySec, lat, lng }), replaces the previous snapshot. */
    setLive(next) {
      live = next;
    },
    /** Live buses, trams, metro...: array of records from the live feed (replaces the previous list). */
    setOthers(list) {
      others = new Map(list.map(otherRow).map(([key, row], i) => [key, { v: list[i], row }]));
    },
    activeTrips(nowMs = Date.now()) {
      return scheduled(nowMs);
    },
    hasKey(key, nowMs = Date.now()) {
      return active(nowMs).some((e) => e.key === key);
    },

    /** gtall-shaped rows. */
    trains(nowMs = Date.now()) {
      const rows = [];
      for (const entry of active(nowMs)) {
        const lv = live.get(entry.key);
        const delaySec = lv?.delaySec ?? 0;
        const sim = simulate(entry, nowMs, delaySec);
        if (!sim) continue;
        // With a live report the vehicle's own last stop and "standing at it" decide, not the clock.
        const liveIdx = lv?.lastSeq != null ? entry.trip.stops.findIndex((stop) => stop.seq === lv.lastSeq) : -1;
        const lastIdx = liveIdx >= 0 ? liveIdx : sim.lastIdx;
        const departed = liveIdx >= 0 ? !lv.atStop : sim.t >= (entry.trip.stops[lastIdx].dep ?? 0);
        const route = routes.get(entry.trip.routeId);
        const first = entry.trip.stops[0];
        const last = entry.trip.stops[entry.trip.stops.length - 1];
        const name = (id) => stops.get(id)?.name ?? '';
        const next = entry.trip.stops[Math.min(lastIdx + 1, entry.trip.stops.length - 1)];
        const delayMin = Math.round(delaySec / 60);
        rows.push({
          CisloVlaku: entry.key,
          TypVlaku: route?.short ?? 'S',
          ...(typeOf(entry.trip) === 2
            ? {}
            : { Rezim: MODE_BY_TYPE[typeOf(entry.trip)] ?? 'tram', Farba: route?.color ? `#${route.color}` : '' }),
          NazovVlaku: route?.short ?? "S",
          Nazov: `${name(first.stopId)} – ${name(last.stopId)}`,
          Popis: `${name(first.stopId)} – ${name(last.stopId)}`,
          Position: lv?.lat != null ? [lv.lat, lv.lng] : [sim.lat, sim.lng],
          Trasa: [],
          Meska: delayMin,
          MeskaSkutocne: delayMin,
          MeskaColor: delayMin > 5 ? 'red' : delayMin > 1 ? 'orange' : 'green',
          InfoZoStanice: name(entry.trip.stops[lastIdx].stopId),
          NextStation: name(next.stopId),
          Cas: '',
          CasPlan: '',
          Dopravca: route?.long ?? 'PID',
          Angle: sim.heading,
          Narusenie: false,
          OrderCurrentStation: lastIdx,
          PotvrdenyOdj: departed,
          // the position is a real GPS fix, not the last station: the browser never draws behind it
          PositionLive: lv?.lat != null,
          PositionAt: lv?.lat != null ? lv.at : undefined,
        });
      }
      others.forEach((entry) => rows.push(entry.row));
      return rows;
    },

    /** Journeys payload v2 (JSON string) + etag. */
    journeys(nowMs = Date.now()) {
      const routesOut = {};
      const journeys = [];
      for (const entry of active(nowMs)) {
        const shape = shapeOf(entry.trip.shapeId);
        const located = locatedOf(entry.trip);
        if (!shape || !located) continue;
        // one route entry per (shape, stop pattern): `at` is indexed by the trip's own stops
        const sig = `${entry.trip.shapeId}:${entry.trip.stops.length}:${entry.trip.stops[0].stopId}`;
        if (!routesOut[sig]) {
          routesOut[sig] = { line: shape.encoded, at: located, ok: true };
        }
        const timed = [];
        entry.trip.stops.forEach((s, i) => {
          if (located[i] == null) return;
          timed.push([
            Math.round(located[i]),
            s.arr == null ? null : s.arr,
            s.dep == null ? null : s.dep,
            i,
            1,
          ]);
        });
        journeys.push({ n: entry.key, sig, t0: Math.round(entry.midnight / 1000), stops: timed });
      }
      journeys.sort((a, b) => (a.n < b.n ? -1 : 1));
      const list = JSON.stringify(journeys);
      const routeList = JSON.stringify(routesOut);
      const etag = `"${crypto.createHash('sha1').update(routeList).update(list).digest('hex').slice(0, 20)}"`;
      return { body: `{"v":2,"routes":${routeList},"journeys":${list}}`, etag };
    },

    /** Stop rows for the side panel. */
    detail(key, nowMs = Date.now()) {
      const entry = active(nowMs).find((e) => e.key === key);
      if (!entry) return otherDetail(key);
      const lv = live.get(key);
      const delay = lv?.delaySec ?? 0;
      const sim = simulate(entry, nowMs, delay);
      const rows = entry.trip.stops.map((s, i) => {
        const dep = s.dep ?? s.arr;
        const arr = s.arr ?? s.dep;
        const state = !sim ? 'ahead' : i < sim.lastIdx ? 'passed' : i === sim.lastIdx ? 'current' : 'ahead';
        return {
          name: stops.get(s.stopId)?.name ?? s.stopId,
          arrival: clock(arr + delay),
          departure: clock(dep + delay),
          scheduledArrival: clock(arr),
          scheduledDeparture: clock(dep),
          state,
          kind: 'stop',
        };
      });
      return { source: 'gtfs-region', train: key, status: lv ? 'live' : 'timetable', stops: rows };
    },

    /** [[id, name, lat, lng, tripCount]], one entry per station name. */
    stations() {
      const byName = new Map();
      trips.forEach((trip) => {
        if (typeOf(trip) !== 2) return; // stations are the railway's
        const seen = new Set();
        trip.stops.forEach((s) => {
          const stop = stops.get(s.stopId);
          if (!stop || seen.has(stop.name)) return;
          seen.add(stop.name);
          let st = byName.get(stop.name);
          if (!st) byName.set(stop.name, (st = { id: s.stopId, name: stop.name, lat: 0, lng: 0, n: 0 }));
          st.lat += stop.lat;
          st.lng += stop.lng;
          st.n += 1;
        });
      });
      return [...byName.values()].map((st) => [st.id, st.name, st.lat / st.n, st.lng / st.n, st.n]);
    },

    /** Tram and metro tracks as a GeoJSON FeatureCollection (each stretch once, metro in its line colours). */
    transitLines() {
      const q = (v) => Math.round(v * 1e4);
      const seen = { tram: new Set(), metro: new Set() };
      const groups = new Map(); // "mode|color" -> [[lng,lat]...][]
      const doneShapes = new Set();
      trips.forEach((trip) => {
        const type = typeOf(trip);
        if ((type !== 0 && type !== 1) || !trip.shapeId || doneShapes.has(trip.shapeId)) return;
        doneShapes.add(trip.shapeId);
        const shape = shapeOf(trip.shapeId);
        if (!shape) return;
        const mode = type === 1 ? 'metro' : 'tram';
        const color = mode === 'metro' ? `#${routes.get(trip.routeId)?.color || '888888'}` : '#d9a441';
        const key = `${mode}|${color}`;
        if (!groups.has(key)) groups.set(key, []);
        const lines = groups.get(key);
        let chain = [];
        const flush = () => {
          if (chain.length >= 2) lines.push(chain);
          chain = [];
        };
        for (let i = 0; i < shape.line.length - 1; i += 1) {
          const a = shape.line[i];
          const b = shape.line[i + 1];
          const ka = `${q(a[0])},${q(a[1])}`;
          const kb = `${q(b[0])},${q(b[1])}`;
          const segment = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          if (seen[mode].has(segment)) {
            flush();
            continue;
          }
          seen[mode].add(segment);
          if (chain.length === 0) chain.push([Number(a[1].toFixed(5)), Number(a[0].toFixed(5))]);
          chain.push([Number(b[1].toFixed(5)), Number(b[0].toFixed(5))]);
        }
        flush();
      });
      return {
        type: 'FeatureCollection',
        features: [...groups.entries()].map(([key, lines]) => {
          const [mode, color] = key.split('|');
          return { type: 'Feature', properties: { mode, color }, geometry: { type: 'MultiLineString', coordinates: lines } };
        }),
      };
    },

    /** Gzipped RNET pack of every shape (the "simplified network" the app expects). */
    networkPack() {
      // Shapes run once per direction and share their trunk lines: keep each stretch of track once.
      const seen = new Set();
      const q = (v) => Math.round(v * 1e4);
      const ways = [];
      const railShapes = new Set();
      trips.forEach((trip) => {
        if (typeOf(trip) === 2 && trip.shapeId) railShapes.add(trip.shapeId);
      });
      shapesRaw.forEach((_, id) => {
        if (!railShapes.has(id)) return; // the rail network is not the tram lines
        const shape = shapeOf(id);
        if (!shape) return;
        let chain = [];
        const flush = () => {
          if (chain.length >= 2) {
            ways.push({ tags: { railway: 'rail' }, geometry: chain.map(([lat, lon]) => ({ lat, lon })) });
          }
          chain = [];
        };
        for (let i = 0; i < shape.line.length - 1; i += 1) {
          const a = shape.line[i];
          const b = shape.line[i + 1];
          const ka = `${q(a[0])},${q(a[1])}`;
          const kb = `${q(b[0])},${q(b[1])}`;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          if (seen.has(key)) {
            flush();
            continue;
          }
          seen.add(key);
          if (chain.length === 0) chain.push(a);
          chain.push(b);
        }
        flush();
      });
      return zlib.gzipSync(Buffer.from(packRails(ways)));
    },

    bounds() {
      let minLat = 90;
      let maxLat = -90;
      let minLng = 180;
      let maxLng = -180;
      stops.forEach((s) => {
        minLat = Math.min(minLat, s.lat);
        maxLat = Math.max(maxLat, s.lat);
        minLng = Math.min(minLng, s.lng);
        maxLng = Math.max(maxLng, s.lng);
      });
      return { minLat, maxLat, minLng, maxLng };
    },
  };
}
