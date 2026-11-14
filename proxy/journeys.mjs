/**
 * Journey store: one traced route and timetable per running train.
 *
 * Every gtall fetch is passed to `observe()`. A train's journey is keyed by a
 * signature of the points mapa.zsr.sk lists for it (`Trasa`). If the points are
 * unchanged the stored route is reused; if they changed (new train, diversion)
 * the route is traced again. Timetables come from TrainDetail, fetched in a slow
 * background queue only for journeys that do not have one yet.
 *
 * The browser gets everything in one response (`payload()`), so trains can be
 * placed on the rails from the timetable plus live delay as soon as the page
 * loads, and the highlighted route is ready before anyone clicks a train.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { encodePolyline, traceRoute } from './railRoute.mjs';

const LAT_METERS = 110_574;
const LNG_METERS_AT_EQUATOR = 111_320;
const STOP_LOCATE_METERS = 1200;
const DETAIL_INTERVAL_MS = 1500;
const TIMETABLE_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const FORGET_AFTER_MS = 36 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 5000;
const TIME_ZONE = 'Europe/Bratislava';

export const JOURNEY_FORMAT_VERSION = 1;

function distanceMeters(latA, lngA, latB, lngB) {
  const dy = (latB - latA) * LAT_METERS;
  const dx = (lngB - lngA) * LNG_METERS_AT_EQUATOR * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Flatten gtall `Trasa` (array or JSON string of { Key, Value: [[lat, lng]] }). */
export function trasaPoints(trasa) {
  let groups = trasa;
  if (typeof groups === 'string') {
    try {
      groups = JSON.parse(groups);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(groups)) {
    return [];
  }
  const points = [];
  groups.forEach((group) => {
    (Array.isArray(group?.Value) ? group.Value : []).forEach((value) => {
      const lat = Number(value?.[0]);
      const lng = Number(value?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }
      const last = points[points.length - 1];
      if (last && Math.abs(last.lat - lat) < 1e-6 && Math.abs(last.lng - lng) < 1e-6) {
        return;
      }
      points.push({ lat, lng });
    });
  });
  return points;
}

export function journeySignature(points) {
  const text = points.map((point) => `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`).join(';');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** Cumulative distances along a polyline of [lat, lng]. */
function cumulative(line) {
  const out = new Float64Array(line.length);
  for (let index = 1; index < line.length; index += 1) {
    out[index] =
      out[index - 1] + distanceMeters(line[index - 1][0], line[index - 1][1], line[index][0], line[index][1]);
  }
  return out;
}

/**
 * Place each stop on the line, in order: the nearest projection that does not
 * go backwards. Returns metres along the line, or null when a stop is too far.
 */
export function locateStops(line, cum, points) {
  const located = [];
  let segmentFrom = 0;
  points.forEach((point) => {
    let best = null;
    for (let index = segmentFrom; index < line.length - 1; index += 1) {
      const [latA, lngA] = line[index];
      const [latB, lngB] = line[index + 1];
      const scale = LNG_METERS_AT_EQUATOR * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
      const ax = lngA * scale;
      const ay = latA * LAT_METERS;
      const dx = lngB * scale - ax;
      const dy = latB * LAT_METERS - ay;
      const px = point.lng * scale - ax;
      const py = point.lat * LAT_METERS - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSq));
      const off = Math.hypot(px - dx * t, py - dy * t);
      if (off <= STOP_LOCATE_METERS && (!best || off < best.off - 0.5)) {
        best = { off, index, along: cum[index] + Math.sqrt(lengthSq) * t };
      }
      // Stop scanning once we are far past the best match.
      if (best && cum[index] - best.along > 25_000) {
        break;
      }
    }
    if (best) {
      segmentFrom = best.index;
      located.push(Math.round(best.along));
    } else {
      located.push(null);
    }
  });
  return located;
}

// --- Time handling ------------------------------------------------------

function zoneOffsetMs(epochMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - epochMs;
}

/** Epoch ms for a wall-clock time in Bratislava. */
function zonedEpoch(year, month, day, minutes) {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  let epoch = guess - zoneOffsetMs(guess);
  epoch = guess - zoneOffsetMs(epoch);
  return epoch;
}

function localDate(epochMs) {
  const shifted = new Date(epochMs + zoneOffsetMs(epochMs));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function clockMinutes(text) {
  const match = /(\d{1,2}):(\d{2})/.exec(String(text ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** "14.11.2026 14:50" -> { year, month, day, minutes } */
function parseZsrDateTime(text) {
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(text ?? ''));
  if (!match) {
    return null;
  }
  return {
    day: Number(match[1]),
    month: Number(match[2]),
    year: Number(match[3]),
    minutes: Number(match[4]) * 60 + Number(match[5]),
  };
}

/**
 * Turn scheduled clock times into epoch seconds. The anchor is the planned time
 * at the train's current stop (gtall CasPlan + OrderCurrentStation); days roll
 * over whenever the clock goes backwards by more than six hours.
 */
export function scheduleEpochs(stops, anchorIndex, anchorText, nowMs = Date.now()) {
  const minutes = stops.map((stop) => ({
    arr: clockMinutes(stop.scheduledArrival),
    dep: clockMinutes(stop.scheduledDeparture),
  }));
  const anchorStamp = parseZsrDateTime(anchorText);
  const base = anchorStamp ?? { ...localDate(nowMs), minutes: null };
  let anchor = Number.isInteger(anchorIndex) && anchorIndex >= 0 && anchorIndex < stops.length ? anchorIndex : -1;
  if (anchor < 0 || (minutes[anchor].arr == null && minutes[anchor].dep == null)) {
    anchor = minutes.findIndex((item) => item.arr != null || item.dep != null);
  }
  if (anchor < 0) {
    return stops.map(() => ({ arr: null, dep: null }));
  }
  let anchorDayOffset = 0;
  const anchorMinute = minutes[anchor].arr ?? minutes[anchor].dep;
  if (base.minutes != null) {
    const delta = anchorMinute - base.minutes;
    if (delta > 720) {
      anchorDayOffset = -1;
    } else if (delta < -720) {
      anchorDayOffset = 1;
    }
  } else {
    // No anchor stamp: pick the day that puts the anchor closest to now.
    const nowMinutes = Math.round((nowMs + zoneOffsetMs(nowMs)) / 60000) % 1440;
    const delta = anchorMinute - nowMinutes;
    if (delta > 720) {
      anchorDayOffset = -1;
    } else if (delta < -720) {
      anchorDayOffset = 1;
    }
  }

  // Walk the sequence of clock values, tracking day offsets in both directions.
  const flat = [];
  minutes.forEach((item, index) => {
    if (item.arr != null) flat.push({ index, key: 'arr', value: item.arr });
    if (item.dep != null) flat.push({ index, key: 'dep', value: item.dep });
  });
  const anchorFlat = flat.findIndex((item) => item.index === anchor);
  const days = new Array(flat.length).fill(0);
  days[anchorFlat] = anchorDayOffset;
  for (let index = anchorFlat + 1; index < flat.length; index += 1) {
    days[index] = days[index - 1] + (flat[index].value < flat[index - 1].value - 360 ? 1 : 0);
  }
  for (let index = anchorFlat - 1; index >= 0; index -= 1) {
    days[index] = days[index + 1] - (flat[index].value > flat[index + 1].value + 360 ? 1 : 0);
  }
  const out = stops.map(() => ({ arr: null, dep: null }));
  flat.forEach((item, index) => {
    const epoch = zonedEpoch(base.year, base.month, base.day + days[index], item.value);
    out[item.index][item.key] = Math.round(epoch / 1000);
  });
  return out;
}

// --- Store ----------------------------------------------------------------

export function createJourneyStore({ file, log = () => undefined, fetchDetail }) {
  let graph = null;
  /** sig -> { line: [[lat,lng]], encoded, cum, located: (number|null)[], hops, tracedAt } */
  const routes = new Map();
  /** trainNumber -> { sig, stops, fetchedAt } */
  const timetables = new Map();
  /** trainNumber -> { sig, points, seenAt, anchorIndex, anchorText, delay, position } */
  const live = new Map();
  const detailQueue = [];
  const queued = new Set();
  let detailTimer = null;
  let saveTimer = null;
  let payloadCache = null;

  const load = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.v !== JOURNEY_FORMAT_VERSION) {
        return;
      }
      (saved.routes ?? []).forEach((route) => routes.set(route.sig, { ...route, line: null, cum: null }));
      (saved.timetables ?? []).forEach((entry) => timetables.set(entry.train, entry));
      log(`Journey store loaded: ${routes.size} routes, ${timetables.size} timetables`);
    } catch {
      // first start or unreadable file: start empty
    }
  };

  const save = () => {
    if (saveTimer) {
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const body = JSON.stringify({
        v: JOURNEY_FORMAT_VERSION,
        routes: Array.from(routes.entries()).map(([sig, route]) => ({
          sig,
          encoded: route.encoded,
          located: route.located,
          hops: route.hops,
          tracedAt: route.tracedAt,
        })),
        timetables: Array.from(timetables.values()),
      });
      try {
        fs.writeFileSync(`${file}.tmp`, body);
        fs.renameSync(`${file}.tmp`, file);
      } catch (error) {
        log(`Journey store save failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, SAVE_DELAY_MS);
  };

  const decodeLine = (encoded) => {
    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    const next = () => {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index <= encoded.length);
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    while (index < encoded.length) {
      lat += next();
      lng += next();
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  };

  const traceJourney = (sig, points) => {
    const result = traceRoute(graph, points);
    // Keep the longest traced piece; stops outside it are left unplaced.
    let line = [];
    result.segments.forEach((segment) => {
      if (segment.length > line.length) {
        line = segment;
      }
    });
    const cum = cumulative(line);
    const located = line.length >= 2 ? locateStops(line, cum, points) : points.map(() => null);
    const route = {
      encoded: encodePolyline(line),
      line,
      cum,
      located,
      hops: result.hops.map((hop) => (hop === 'ok' ? 1 : hop === 'gap' ? 0 : -1)),
      tracedAt: Date.now(),
    };
    routes.set(sig, route);
    return route;
  };

  const routeFor = (sig) => {
    const route = routes.get(sig);
    if (route && !route.line) {
      route.line = decodeLine(route.encoded);
      route.cum = cumulative(route.line);
    }
    return route;
  };

  const pumpDetails = () => {
    if (detailTimer || detailQueue.length === 0 || !fetchDetail) {
      return;
    }
    detailTimer = setTimeout(async () => {
      detailTimer = null;
      const train = detailQueue.shift();
      queued.delete(train);
      const current = live.get(train);
      if (current) {
        try {
          const stops = await fetchDetail(train);
          if (Array.isArray(stops) && stops.length > 0) {
            if (stops.length !== current.points.length) {
              log(`Timetable ${train}: ${stops.length} stops vs ${current.points.length} route points`);
            }
            timetables.set(train, { train, sig: current.sig, stops, fetchedAt: Date.now() });
            payloadCache = null;
            save();
          }
        } catch (error) {
          log(`Timetable ${train} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      pumpDetails();
    }, DETAIL_INTERVAL_MS);
  };

  const needsTimetable = (train, sig) => {
    const entry = timetables.get(train);
    return !entry || entry.sig !== sig || Date.now() - entry.fetchedAt > TIMETABLE_MAX_AGE_MS;
  };

  return {
    load,

    setGraph(nextGraph) {
      if (graph === nextGraph) {
        return;
      }
      const firstGraph = graph === null;
      graph = nextGraph;
      if (!firstGraph) {
        routes.clear();
      }
      payloadCache = null;
      // Trace anything already seen while the graph was building.
      live.forEach((entry) => {
        if (!routes.has(entry.sig)) {
          traceJourney(entry.sig, entry.points);
        }
      });
    },

    /** Feed one gtall payload (array of trains). Cheap when nothing changed. */
    observe(trains) {
      if (!Array.isArray(trains)) {
        return { traced: 0, trains: 0 };
      }
      const now = Date.now();
      let traced = 0;
      const startedAt = now;
      trains.forEach((item) => {
        const train = String(item?.CisloVlaku ?? '').trim();
        if (!train) {
          return;
        }
        const points = trasaPoints(item.Trasa);
        if (points.length < 2) {
          return;
        }
        const sig = journeySignature(points);
        const order = Number(item.OrderCurrentStation);
        live.set(train, {
          sig,
          points,
          seenAt: now,
          anchorIndex: Number.isFinite(order) ? order : -1,
          anchorText: item.CasPlan ?? '',
          delay: Number(item.Meska) || 0,
        });
        if (graph && !routes.has(sig)) {
          traceJourney(sig, points);
          traced += 1;
        }
        if (needsTimetable(train, sig) && !queued.has(train)) {
          queued.add(train);
          detailQueue.push(train);
        }
      });
      live.forEach((entry, train) => {
        if (now - entry.seenAt > FORGET_AFTER_MS) {
          live.delete(train);
        }
      });
      payloadCache = null;
      if (traced > 0) {
        log(`Journeys: traced ${traced} new routes in ${Date.now() - startedAt} ms (${routes.size} stored)`);
        save();
      }
      pumpDetails();
      return { traced, trains: live.size };
    },

    /** One JSON body with every live train's route and timed stops. */
    payload(nowMs = Date.now()) {
      if (payloadCache && nowMs - payloadCache.at < 15_000) {
        return payloadCache.body;
      }
      const journeys = [];
      live.forEach((entry, train) => {
        const route = routeFor(entry.sig);
        if (!route || !route.encoded || route.line.length < 2) {
          return;
        }
        const timetable = timetables.get(train);
        const usable = timetable && timetable.sig === entry.sig;
        let stops = [];
        if (usable) {
          const epochs = scheduleEpochs(timetable.stops, entry.anchorIndex, entry.anchorText, nowMs);
          stops = timetable.stops
            .map((stop, index) => [route.located[index], epochs[index].arr, epochs[index].dep, index])
            .filter(([along, arr, dep]) => along != null && (arr != null || dep != null));
        }
        journeys.push({
          n: train,
          sig: entry.sig,
          line: route.encoded,
          // [metres along line, scheduled arrival (epoch s), scheduled departure, stop index]
          stops,
          // Metres along the line for every listed point (null when off it); the
          // train's reported checkpoint (OrderCurrentStation) indexes this list.
          at: route.located,
          ok: route.hops.every((hop) => hop === 1),
        });
      });
      const body = JSON.stringify({ v: JOURNEY_FORMAT_VERSION, generatedAt: Math.round(nowMs / 1000), journeys });
      payloadCache = { at: nowMs, body };
      return body;
    },

    stats() {
      return { routes: routes.size, timetables: timetables.size, live: live.size, queue: detailQueue.length };
    },
  };
}
