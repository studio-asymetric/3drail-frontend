import { decodePolyline } from './routeService';
import { regionsQuery } from '../region';

/**
 * Timetable-driven train positions.
 *
 * The proxy ships, for every running train, its traced route and the scheduled
 * times at the stops it can place on that route. Between two timed stops the
 * train moves along the rails at a steady pace, shifted by its live delay.
 *
 * mapa.zsr.sk does not send live GPS: `Position` is the last point the train
 * reported at (`OrderCurrentStation`). So the model never shows a train behind
 * that point, and otherwise runs it on timetable + delay (leaving each station at
 * its departure time + delay, confirmed or not) until the next report corrects it.
 */

export interface Journey {
  train: string;
  sig: string;
  lat: Float64Array;
  lng: Float64Array;
  /** Metres from the start of the line to each vertex. */
  cum: Float64Array;
  /**
   * Timed points: metres along the line, arrival and departure in epoch seconds,
   * and what happens there: 'stop' (passengers), 'wait' (operational, e.g. a
   * crossing at a passing loop) or 'pass' (the train runs through).
   */
  stops: Array<{ along: number; arr: number; dep: number; kind: StopKind }>;
  /** The timetable's own times at the same points, before any stand was added (tram and metro model). */
  sched?: Array<{ along: number; arr: number; dep: number }>;
  /**
   * Runs between two places the train stands (departure, arrival in epoch s).
   * Within a run the train speeds up and slows down gently; passing points
   * inside it are rolled through.
   */
  runs: Array<[number, number]>;
  /** Metres along the line for every point ZSR lists (null when off the line). */
  at: Array<number | null>;
  /** Stretches run by replacement bus: metres along the line, start to end. */
  bus: Array<[number, number]>;
  ok: boolean;
}

export type StopKind = 'stop' | 'wait' | 'pass';

const KIND_BY_CODE: Record<number, StopKind> = { 0: 'pass', 1: 'stop', 2: 'wait' };

export interface JourneyPosition {
  lat: number;
  lng: number;
  heading: number | null;
  along: number;
}

const LAT_METERS = 110_574;
const LNG_METERS_AT_EQUATOR = 111_320;
/** Show a modelled position this long before the first departure and after the last arrival. */
const EDGE_SECONDS = 5 * 60;
/** A reported checkpoint further than this from the line means the model does not fit. */
const OFF_LINE_METERS = 900;
/** Seconds for the shown position to close most of the gap to a new target. */
const EASE_SECONDS = 2.5;
/** The fastest (m/s) a drawn train closes a gap on the timetable. */
const EASE_MAX_SPEED = 45;
/** Gaps larger than this are jumped instead of eased (e.g. after a long pause). */
const SNAP_METERS = 6000;
/** A target this far behind the shown position is applied; smaller ones wait in place. */
const BACKTRACK_METERS = 4000;
/** With live GPS a train drawn this far ahead of its fix is pulled back, and may run no further ahead of it. */
const LIVE_BACKTRACK_METERS = 150;
const LIVE_MAX_LEAD_METERS = 900;
/** Only a train this far ahead of where it should be slides back; nearer ones stand and wait. */
const LIVE_REVERSE_METERS = 900;
const LIVE_SNAP_BACK_METERS = 3000;
/** A live fix this far behind the vehicle's reported stop: the stop is wrong, not the GPS. */
const LIVE_STATION_MISMATCH_METERS = 1500;
/** A live train runs on at the speed its last two fixes show for at most this long (s) before the next one. */
const LIVE_EXTRAPOLATE_SECONDS = 30;
/** A stop this close ahead of the last fix is the one the train is standing at, not the next. */
const STOP_AHEAD_METERS = 40;
/** Seconds for a live train's drawn spot to close most of the gap to where it should be (forward / back). */
const LIVE_CHASE_SECONDS = 4;
/** How much faster than its own speed a drawn train may run to catch up with where it should be. */
const LIVE_CATCH_UP = 1.2;
/** Below this speed (m/s) the fixes show a vehicle standing. */
const LIVE_MOVING_SPEED = 1.5;
/** A drawn vehicle that is far behind may run up to this much faster than its own speed (m/s per metre of gap). */
const LIVE_CATCH_UP_PER_METER = 0.015;
const LIVE_CATCH_UP_MAX = 4;
/** Acceleration and braking of a drawn live vehicle (m/s per second). */
const LIVE_ACCEL = 2.2;
/** No drawn live vehicle runs faster than this (m/s), whatever it has to catch up. */
const LIVE_MAX_SHOWN_SPEED = 32;
const LIVE_DECEL = 3.5;
const LIVE_CHASE_BACK_SECONDS = 3;
/** Seconds a train shown too far on takes to slide back to where ZSR puts it. */
const EASE_BACK_SECONDS = 4;
/**
 * A train ZSR still lists as waiting leaves this long after departure + delay. None: ZSR
 * often confirms a departure a minute or two late (R 10720 left Leopoldov at 14:18 and was
 * confirmed after 14:19), and a map that holds the train meanwhile runs behind the real one.
 * Better to leave on time and be eased back if the train really is still standing.
 */
const UNCONFIRMED_GRACE_SECONDS = 0;
/** Margin taken off a delay read from ZSR's estimated station times (minute-rounded). */
const ESTIMATE_OPTIMISM_SECONDS = 40;
/**
 * A train standing at a station (departure not confirmed) leaves no sooner than its real
 * arrival (timetable arrival + the reported delay) plus this short stay. ZSR sometimes keeps
 * an on-time departure estimate for a train that arrived late; the arrival tells better.
 */
const MIN_STAY_AFTER_ARRIVAL_SECONDS = 20;
/** Bratislava hlavná stanica: long platforms and a bigger crowd, so a longer stay. */
const MAIN_STATION_STAY_SECONDS = 60;

const isBratislavaMain = (name?: string) =>
  String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .includes('bratislava hlavna');

const clockMinutes = (text?: string): number | null => {
  const match = String(text ?? '').match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * The delay ZSR itself expects at the train's current or next timed station (estimated vs
 * scheduled departure, as the side panel shows it), in seconds; null when there is none.
 */
export function estimatedDelaySeconds(
  rows: Array<{ state: string; scheduledDeparture: string; departure: string; foreign?: boolean }>
): number | null {
  for (const row of rows) {
    if (row.state === 'passed' || row.foreign) {
      continue;
    }
    const planned = clockMinutes(row.scheduledDeparture);
    const expected = clockMinutes(row.departure);
    if (planned == null || expected == null) {
      continue;
    }
    let diff = expected - planned;
    if (diff < -720) {
      diff += 1440;
    }
    return diff > 0 && diff < 600 ? diff * 60 : 0;
  }
  return null;
}
/**
 * A passenger stop with only one time (a departure; arr = dep) is taken to have arrived
 * this long before it leaves, so the pill stands at the station for that long.
 */
const MIN_STOP_DWELL_SECONDS = 50;
/**
 * ZSR times are whole minutes. A map that runs behind the real train is a problem for the
 * user, one that runs a little ahead is not, so every time is placed early in its minute:
 * an arrival at the start of it, a departure just after (14:05 leaves at 14:05:05).
 */
const ARRIVE_AFTER_SECONDS = 0;
const DEPART_AFTER_SECONDS = 5;
/**
 * ZSR's delay is rounded up to whole minutes and was measured at the last station, while
 * trains tend to win some of it back. The model runs on this much less delay (never below
 * zero), so it errs towards being early rather than late.
 */
const DELAY_OPTIMISM_SECONDS = 60;
/** Seconds a train takes to reach cruising pace after a stand, and to brake into the next. */
const ACCEL_SECONDS = 45;

function meters(latA: number, lngA: number, latB: number, lngB: number): number {
  const dy = (latB - latA) * LAT_METERS;
  const dx = (lngB - lngA) * LNG_METERS_AT_EQUATOR * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function bearing(latA: number, lngA: number, latB: number, lngB: number): number | null {
  const dy = (latB - latA) * LAT_METERS;
  const dx = (lngB - lngA) * LNG_METERS_AT_EQUATOR * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return null;
  }
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

type RawJourney = {
  n: string;
  sig: string;
  /** Seconds the stop times are counted from (payload v2). */
  t0?: number;
  /** Replacement-bus stretches, metres along the line. */
  bus?: Array<[number, number]>;
  line: string;
  /** [metres along, arrival, departure, index in ZSR's list, kind code (0 pass, 1 stop, 2 wait)] */
  stops: Array<[number, number | null, number | null, number, number?]>;
  at?: Array<number | null>;
  ok: boolean;
};

type RawRoute = { line: string; at?: Array<number | null>; ok: boolean };

/** Turn a payload entry (shared route, times relative to t0) into the plain shape `buildJourney` reads. */
export function expandJourney(
  entry: Omit<RawJourney, 'line' | 'ok'> & Partial<Pick<RawJourney, 'line' | 'ok'>>,
  routes: Record<string, RawRoute> | undefined
): RawJourney | null {
  const route = routes?.[entry.sig];
  const line = entry.line ?? route?.line;
  if (!line) {
    return null;
  }
  const base = entry.t0 ?? 0;
  return {
    ...entry,
    line,
    at: entry.at ?? route?.at,
    ok: entry.ok ?? route?.ok ?? true,
    stops: (entry.stops ?? []).map(([along, arr, dep, index, kind]) => [
      along,
      arr == null ? null : arr + base,
      dep == null ? null : dep + base,
      index,
      kind,
    ]),
  };
}

export function buildJourney(raw: RawJourney): Journey | null {
  const points = decodePolyline(raw.line);
  if (points.length < 2) {
    return null;
  }
  const lat = new Float64Array(points.length);
  const lng = new Float64Array(points.length);
  const cum = new Float64Array(points.length);
  points.forEach((point, index) => {
    lat[index] = point.lat;
    lng[index] = point.lng;
    if (index > 0) {
      cum[index] = cum[index - 1] + meters(lat[index - 1], lng[index - 1], point.lat, point.lng);
    }
  });
  const stops: Journey['stops'] = [];
  const sched: NonNullable<Journey['sched']> = [];
  (raw.stops ?? []).forEach(([along, arrRaw, depRaw, , kindCode]) => {
    const arr = arrRaw ?? depRaw;
    const dep = depRaw ?? arrRaw;
    if (arr == null || dep == null) {
      return;
    }
    const kind = KIND_BY_CODE[kindCode ?? 1] ?? 'stop';
    const arrival = arr + ARRIVE_AFTER_SECONDS;
    // Only a train that calls leaves "after" the minute; one running through is just there.
    const departure = Math.max(dep, arr) + (kind === 'pass' ? ARRIVE_AFTER_SECONDS : DEPART_AFTER_SECONDS);
    const last = stops[stops.length - 1];
    // Keep times and positions moving forward; drop stops that contradict them.
    if (last && (along < last.along - 50 || arrival < last.dep - 10)) {
      return;
    }
    const arrives = last ? Math.max(arrival, last.dep) : arrival;
    stops.push({ along, arr: arrives, dep: Math.max(departure, arrives), kind });
    sched.push({ along, arr: arrives, dep: Math.max(dep, arrives) });
  });
  // A halt reads arr = dep. Give such passenger stops a short stand that ends
  // at the (mid-minute) departure, taken from the run before, so the pill
  // visibly stops there and rolls through passing points.
  for (let index = 1; index < stops.length - 1; index += 1) {
    const stop = stops[index];
    const extra = MIN_STOP_DWELL_SECONDS - (stop.dep - stop.arr);
    if (stop.kind !== 'stop' || extra <= 0) {
      continue;
    }
    const before = stops[index - 1];
    if (stop.arr - extra > before.dep + MIN_STOP_DWELL_SECONDS) {
      stop.arr -= extra;
    }
  }
  const runs: Journey['runs'] = [];
  let runStart = stops.length > 0 ? stops[0].dep : 0;
  for (let index = 1; index < stops.length; index += 1) {
    const stop = stops[index];
    const stands = index === stops.length - 1 || stop.dep > stop.arr;
    if (stands) {
      if (stop.arr > runStart) {
        runs.push([runStart, stop.arr]);
      }
      runStart = stop.dep;
    }
  }
  return { train: raw.n, sig: raw.sig, lat, lng, cum, stops, sched, runs, at: raw.at ?? [], bus: raw.bus ?? [], ok: raw.ok };
}

/**
 * Time along the timetable for clock time `t` inside a run, so the train
 * speeds up for ACCEL_SECONDS after leaving, cruises, and brakes for the same
 * time before the next stand, still leaving and arriving on time.
 */
function easedRunTime(runs: Journey['runs'], t: number): number {
  for (const [start, end] of runs) {
    if (t <= start || t >= end) {
      continue;
    }
    const total = end - start;
    const ramp = Math.min(ACCEL_SECONDS, total / 2);
    if (ramp <= 0) {
      return t;
    }
    const pace = total / (total - ramp);
    const s = t - start;
    if (s < ramp) {
      return start + (pace * s * s) / (2 * ramp);
    }
    if (s > total - ramp) {
      const left = total - s;
      return end - (pace * left * left) / (2 * ramp);
    }
    return start + pace * (s - ramp / 2);
  }
  return t;
}

/** Seconds a tram / metro stands at a stop (Prague): it arrives at the timetable time and leaves this much later. */
const SCHED_DWELL_SECONDS: Record<string, number> = { tram: 10, metro: 20 };
/** Seconds a tram or metro takes to get up to speed after a stop and to brake into the next. */
const SCHED_RAMP_SECONDS = 8;
/** A tram or metro is placed at most this early (s). */
const SCHED_MAX_EARLY_SECONDS = 60;

const dwellCache = new WeakMap<Journey, Map<number, Array<{ along: number; arr: number; dep: number }>>>();

function dwellStops(journey: Journey, dwell: number) {
  let byDwell = dwellCache.get(journey);
  if (!byDwell) {
    byDwell = new Map();
    dwellCache.set(journey, byDwell);
  }
  let out = byDwell.get(dwell);
  if (!out) {
    out = (journey.sched ?? journey.stops).map((s) => ({ along: s.along, arr: s.arr, dep: s.dep }));
    // Every stop in the middle: arrives on the timetable minute, leaves `dwell` seconds later
    // (never after the next arrival).
    for (let index = 1; index < out.length - 1; index += 1) {
      const stop = out[index];
      stop.dep = Math.max(stop.arr, Math.min(Math.max(stop.dep, stop.arr + dwell), out[index + 1].arr));
    }
    byDwell.set(dwell, out);
  }
  return out;
}

/**
 * Metres along the line of a tram or metro at timetable time `t` (epoch s): it arrives at each
 * stop at its timetable time, stands `dwell` seconds, and runs to the next one.
 */
export function scheduledAlong(journey: Journey, t: number, dwell: number): number | null {
  const stops = dwellStops(journey, dwell);
  if (stops.length < 2) {
    return null;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t < first.dep - EDGE_SECONDS) {
    return null;
  }
  if (t >= last.arr) {
    return last.along;
  }
  if (t <= first.dep) {
    return first.along;
  }
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if (t < from.dep) {
      return from.along;
    }
    if (t <= to.arr) {
      const total = to.arr - from.dep;
      if (total <= 0) {
        return to.along;
      }
      const s = t - from.dep;
      const ramp = Math.min(SCHED_RAMP_SECONDS, total / 2);
      const pace = total / (total - ramp);
      const done =
        s < ramp
          ? (pace * s * s) / (2 * ramp)
          : s > total - ramp
            ? total - (pace * (total - s) * (total - s)) / (2 * ramp)
            : pace * (s - ramp / 2);
      return from.along + (to.along - from.along) * Math.max(0, Math.min(1, done / total));
    }
  }
  return last.along;
}

let lastJourneysEtag = '';

/** All running trains' journeys, or null when the list has not changed since the last call. */
export async function fetchJourneys(signal?: AbortSignal): Promise<Map<string, Journey> | null> {
  // no-cache: the browser revalidates with the ETag and gets a 304 when nothing changed.
  const response = await fetch(`/proxy/journeys?mode=journeys&v=2${regionsQuery()}`, { signal, cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Journeys HTTP ${response.status}`);
  }
  const etag = response.headers.get('etag') ?? '';
  if (etag && etag === lastJourneysEtag) {
    return null;
  }
  const payload = (await response.json()) as {
    routes?: Record<string, RawRoute>;
    journeys?: Array<Parameters<typeof expandJourney>[0]>;
  };
  const out = new Map<string, Journey>();
  (payload.journeys ?? []).forEach((entry) => {
    const raw = expandJourney(entry, payload.routes);
    const journey = raw ? buildJourney(raw) : null;
    if (journey) {
      out.set(journey.train, journey);
    }
  });
  lastJourneysEtag = etag;
  return out;
}

/** Metres along the line at model time `t` (epoch s), or null outside the journey. */
export function alongAtTime(journey: Journey, t: number): number | null {
  const { stops } = journey;
  if (stops.length < 2) {
    return null;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t < first.dep - EDGE_SECONDS) {
    return null;
  }
  // Past the scheduled arrival but still listed by ZSR (late beyond the reported
  // delay): wait at the terminus instead of falling back to the last report.
  if (t >= last.arr) {
    return last.along;
  }
  if (t <= first.dep) {
    return first.along;
  }
  t = easedRunTime(journey.runs ?? [], t);
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if (t < from.dep) {
      return from.along; // dwelling
    }
    if (t <= to.arr) {
      const span = to.arr - from.dep;
      const fraction = span > 0 ? (t - from.dep) / span : 1;
      return from.along + (to.along - from.along) * fraction;
    }
  }
  return last.along;
}

/** Model time at which the train passes `along`; near `hint` when it dwells. */
export function timeAtAlong(journey: Journey, along: number, hint: number): number | null {
  const { stops } = journey;
  if (stops.length < 2 || along < stops[0].along - 200 || along > stops[stops.length - 1].along + 200) {
    return null;
  }
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (Math.abs(along - stop.along) <= 120) {
      return Math.min(stop.dep, Math.max(stop.arr, hint));
    }
    const next = stops[index + 1];
    if (next && along > stop.along && along < next.along) {
      const fraction = (along - stop.along) / Math.max(1, next.along - stop.along);
      return stop.dep + (next.arr - stop.dep) * fraction;
    }
  }
  return null;
}

/**
 * Where a train is on the stop list: the stop it last reached and how far it
 * is toward the next one (0..1). `stops` is the passenger-stop list the panel
 * shows; each carries `index`, its place in the full list the journey's `at` uses.
 */
export function timelineProgress(
  journey: Journey,
  stops: Array<{ index?: number }>,
  along: number
): { from: number; fraction: number } | null {
  const located: Array<{ k: number; at: number }> = [];
  stops.forEach((stop, k) => {
    const at = stop.index != null ? journey.at[stop.index] : null;
    if (at != null && (located.length === 0 || at >= located[located.length - 1].at - 50)) {
      located.push({ k, at });
    }
  });
  if (located.length < 2) {
    return null;
  }
  const slack = 40;
  if (along <= located[0].at + slack) {
    return { from: located[0].k, fraction: 0 };
  }
  const end = located[located.length - 1];
  if (along >= end.at - slack) {
    // Past the last stop we can place: the journey is over only if the list ends there too
    // (stops abroad follow otherwise, and the train is just leaving for them).
    return { from: end.k, fraction: end.k >= stops.length - 1 ? 1 : 0 };
  }
  for (let index = 0; index < located.length - 1; index += 1) {
    const a = located[index];
    const b = located[index + 1];
    if (along >= a.at - slack && along < b.at - slack) {
      const span = Math.max(1, b.at - a.at);
      return { from: a.k, fraction: Math.min(1, Math.max(0, (along - a.at) / span)) };
    }
  }
  return null;
}

/** Whether a point `along` the line is on a replacement-bus stretch. */
export function isOnBus(journey: Journey, along: number): boolean {
  return journey.bus.some(([from, to]) => along >= from - 30 && along <= to + 30);
}

export function pointAtAlong(journey: Journey, along: number): JourneyPosition {
  const { lat, lng, cum } = journey;
  const target = Math.max(0, Math.min(cum[cum.length - 1], along));
  let low = 0;
  let high = cum.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cum[mid] <= target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const span = cum[high] - cum[low];
  const fraction = span > 0 ? (target - cum[low]) / span : 0;
  return {
    lat: lat[low] + (lat[high] - lat[low]) * fraction,
    lng: lng[low] + (lng[high] - lng[low]) * fraction,
    heading: bearing(lat[low], lng[low], lat[high], lng[high]),
    along: target,
  };
}

/** Nearest point on the line to a GPS fix: metres along, and metres off the line. */
export function projectOnJourney(journey: Journey, pointLat: number, pointLng: number) {
  const { lat, lng, cum } = journey;
  let best = { along: 0, off: Infinity };
  for (let index = 0; index < lat.length - 1; index += 1) {
    const scale = LNG_METERS_AT_EQUATOR * Math.cos((((lat[index] + lat[index + 1]) / 2) * Math.PI) / 180);
    const ax = lng[index] * scale;
    const ay = lat[index] * LAT_METERS;
    const dx = lng[index + 1] * scale - ax;
    const dy = lat[index + 1] * LAT_METERS - ay;
    const px = pointLng * scale - ax;
    const py = pointLat * LAT_METERS - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSq));
    const off = Math.hypot(px - dx * t, py - dy * t);
    if (off < best.off) {
      best = { along: cum[index] + Math.sqrt(lengthSq) * t, off };
    }
  }
  return best;
}

type TrainModelState = {
  sig: string;
  /** Delay the model runs on: the reported one, or lower if the train made up time. */
  delaySeconds: number;
  /** Delay as ZSR reported it, to tell when a new report arrives. */
  reportedDelay: number;
  /** ZSR lists the train as not yet departed from its reported station. */
  unconfirmed: boolean;
  /** A live GPS report says the train is still standing at its station: keep it there. */
  hold?: boolean;
  /** The reports are live GPS fixes (a region feed): the model stays close to them. */
  live?: boolean;
  /** Tram or metro: placed from timetable + delay alone (this is the stand in seconds per stop). */
  sched?: number;
  /** Live fixes: when the newest one was taken, where it put the train, and the speed the last two imply (m/s). */
  fixMs?: number;
  fixFloor?: number;
  speed?: number;
  /** Metres along the line of the last reported checkpoint. */
  floor: number;
  shownAlong: number | null;
  /** How fast the drawn live vehicle is going (m/s); it speeds up and slows down gently. */
  shownSpeed?: number;
  lastMs: number;
  active: boolean;
};

export interface LiveTrainInput {
  trainNumber: string;
  delayMinutes: number;
  /** 'tram', 'metro', 'bus'...; absent for trains. */
  mode?: string;
  /** Exact delay in seconds (region feeds). */
  delaySeconds?: number;
  position?: { lat: number; lng: number };
  rosterOrderCurrentStation?: number;
  /** The position is a live GPS fix: the train is never shown behind it. */
  rosterLiveGps?: boolean;
  /** When that fix was taken (epoch ms). */
  rosterLiveAt?: number;
  /** ZSR's PotvrdenyOdj: false while the train has not left its reported station. */
  departureConfirmed?: boolean;
  /** Delay from ZSR's newer report at a later station; preferred over `delayMinutes`. */
  latestDelayMinutes?: number;
  /** Name of the station ZSR last reported the train at. */
  currentStation?: string;
}

/**
 * Turns (timetable, live delay, last reported checkpoint) into a position on
 * the rails. Call `update()` on every live refresh and `position()` per frame.
 */
export class JourneyAnimator {
  private journeys = new Map<string, Journey>();
  private states = new Map<string, TrainModelState>();
  /** Delay (s) read off ZSR's own estimated times for a train's next station: beats the feed's delay. */
  private estimates = new Map<string, number>();

  setEstimate(train: string, delaySeconds: number | null) {
    if (delaySeconds == null) {
      this.estimates.delete(train);
    } else {
      this.estimates.set(train, Math.max(0, delaySeconds));
    }
  }

  setJourneys(journeys: Map<string, Journey>) {
    this.journeys = journeys;
    this.states.forEach((state, train) => {
      const journey = journeys.get(train);
      if (!journey || journey.sig !== state.sig) {
        this.states.delete(train);
      }
    });
  }

  journey(train: string): Journey | undefined {
    return this.journeys.get(train);
  }

  has(train: string): boolean {
    return this.journeys.has(train);
  }

  /** True when this train's position currently comes from the model. */
  isActive(train: string): boolean {
    return Boolean(this.states.get(train)?.active && this.journeys.get(train)?.stops.length);
  }

  update(trains: LiveTrainInput[]) {
    trains.forEach((train) => {
      const journey = this.journeys.get(train.trainNumber);
      if (!journey || journey.stops.length < 2) {
        this.states.delete(train.trainNumber);
        return;
      }
      let checkpoint = Number.isInteger(train.rosterOrderCurrentStation)
        ? (train.rosterOrderCurrentStation as number)
        : -1;
      let floor: number | null = checkpoint >= 0 ? journey.at[checkpoint] ?? null : null;
      // Prague trams and metro: no GPS, just the delay and the stops (see scheduledAlong).
      const schedDwell =
        train.rosterLiveGps && Number.isFinite(train.delaySeconds) ? SCHED_DWELL_SECONDS[train.mode ?? ''] : undefined;
      if (train.position) {
        const fix = projectOnJourney(journey, train.position.lat, train.position.lng);
        if (fix.off > OFF_LINE_METERS) {
          this.markInactive(train.trainNumber, journey.sig);
          return;
        }
        if (floor == null) {
          floor = fix.along;
          checkpoint = journey.at.findIndex((along) => along != null && along > fix.along + 30) - 1;
        } else if (train.rosterLiveGps && schedDwell == null && (fix.along > floor || fix.along < floor - LIVE_STATION_MISMATCH_METERS)) {
          // A real fix ahead of the last stop: the train has moved on, so draw it at least there.
          // One far behind it means the stop number does not fit the line: the GPS wins.
          floor = fix.along;
        }
      }
      if (floor == null) {
        this.markInactive(train.trainNumber, journey.sig);
        return;
      }
      if (schedDwell != null) {
        const before = this.states.get(train.trainNumber);
        const same = before && before.sig === journey.sig ? before : null;
        const delay = train.delaySeconds as number;
        this.states.set(train.trainNumber, {
          sig: journey.sig,
          delaySeconds: Math.max(-SCHED_MAX_EARLY_SECONDS, delay),
          reportedDelay: delay,
          unconfirmed: false,
          live: true,
          sched: schedDwell,
          floor,
          shownAlong: same ? same.shownAlong : null,
          shownSpeed: same?.shownSpeed,
          lastMs: before?.lastMs ?? 0,
          active: true,
        });
        return;
      }
      // ZSR does not report at every stop, so between reports the train keeps
      // running on timetable + delay. An unconfirmed departure is not held
      // either: ZSR often confirms late, so the train leaves at departure +
      // delay and the next report pulls it back if it really was still standing.
      const previous = this.states.get(train.trainNumber);
      const estimate = this.estimates.get(train.trainNumber);
      const reportedDelay =
        estimate ?? Math.max(0, (train.latestDelayMinutes ?? train.delayMinutes ?? 0) * 60);
      // What the model runs on: the reported delay less a little (see DELAY_OPTIMISM_SECONDS).
      // ZSR's own estimated time is minute-rounded and current, so it only needs a small margin.
      let modelDelay = Math.max(
        0,
        reportedDelay - (estimate != null ? ESTIMATE_OPTIMISM_SECONDS : DELAY_OPTIMISM_SECONDS)
      );
      // Standing at a station it arrived at late: count from the arrival, whatever the departure
      // estimate says (see MIN_STAY_AFTER_ARRIVAL_SECONDS).
      if (train.departureConfirmed === false) {
        const feedDelay = Math.max(0, (train.latestDelayMinutes ?? train.delayMinutes ?? 0) * 60);
        const index = journey.stops.findIndex(
          (stop, at) => at > 0 && stop.kind !== 'pass' && Math.abs(stop.along - floor) < 150
        );
        if (index > 0 && feedDelay > 0) {
          const stop = journey.stops[index];
          const stay = isBratislavaMain(train.currentStation)
            ? MAIN_STATION_STAY_SECONDS
            : MIN_STAY_AFTER_ARRIVAL_SECONDS;
          modelDelay = Math.max(modelDelay, feedDelay + stay - (stop.dep - stop.arr));
        }
      }
      // Live GPS: remember when the fix was taken and how fast the train went between the last two.
      let fixMs: number | undefined;
      let fixFloor: number | undefined;
      let speed: number | undefined;
      if (train.rosterLiveGps) {
        const prior = this.states.get(train.trainNumber);
        const prev = prior && prior.sig === journey.sig ? prior : null;
        const takenAt = train.rosterLiveAt ?? Date.now();
        if (prev?.fixMs != null && takenAt > prev.fixMs + 1500) {
          const seconds = (takenAt - prev.fixMs) / 1000;
          const v = seconds < 120 ? Math.max(0, Math.min(28, (floor - (prev.fixFloor ?? floor)) / seconds)) : 0;
          speed = prev.speed != null ? prev.speed * 0.4 + v * 0.6 : v;
          fixMs = takenAt;
          fixFloor = floor;
        } else if (prev?.fixMs != null) {
          fixMs = prev.fixMs;
          fixFloor = prev.fixFloor;
          speed = prev.speed;
        } else {
          fixMs = takenAt;
          fixFloor = floor;
        }
      }
      let delaySeconds = modelDelay;
      const sameReport =
        previous?.active &&
        previous.sig === journey.sig &&
        previous.floor === floor &&
        previous.reportedDelay === reportedDelay;
      if (sameReport) {
        // Keep the delay chosen when this report arrived, so a lowered one
        // (below) is not recomputed against the clock and dragged back.
        delaySeconds = previous.delaySeconds;
      } else {
        // Reported further on than timetable + delay allows: the train has made
        // up time. Lower the delay so it runs on from the reported point now
        // instead of waiting there for the timetable to catch up.
        const nowSeconds = Date.now() / 1000;
        const scheduled = alongAtTime(journey, nowSeconds - modelDelay);
        if (scheduled != null && scheduled < floor - 50) {
          const passedAt = timeAtAlong(journey, floor, nowSeconds - modelDelay);
          if (passedAt != null) {
            delaySeconds = Math.max(0, Math.min(modelDelay, nowSeconds - passedAt));
          }
        }
      }
      this.states.set(train.trainNumber, {
        sig: journey.sig,
        delaySeconds,
        reportedDelay,
        unconfirmed: train.departureConfirmed === false,
        // Standing at a station: held there, unless the fixes show it moving (the flag lags behind).
        hold: Boolean(train.rosterLiveGps && train.departureConfirmed === false && (speed ?? 0) < LIVE_MOVING_SPEED),
        live: Boolean(train.rosterLiveGps),
        fixMs,
        fixFloor,
        speed,
        floor,
        shownAlong: previous && previous.sig === journey.sig ? previous.shownAlong : null,
        shownSpeed: previous && previous.sig === journey.sig ? previous.shownSpeed : undefined,
        lastMs: previous?.lastMs ?? 0,
        active: true,
      });
    });
  }

  private markInactive(train: string, sig: string) {
    const previous = this.states.get(train);
    this.states.set(train, {
      sig,
      delaySeconds: 0,
      reportedDelay: 0,
      unconfirmed: false,
      floor: 0,
      shownAlong: null,
      lastMs: previous?.lastMs ?? 0,
      active: false,
    });
  }

  /** Where the model puts the train right now (before easing). */
  target(train: string, nowMs = Date.now()): number | null {
    const journey = this.journeys.get(train);
    const state = this.states.get(train);
    if (!journey || !state || !state.active) {
      return null;
    }
    // ZSR often raises the delay of a train it still lists as waiting: give it a
    // short grace after departure + delay before the pill leaves the station.
    const grace = state.unconfirmed ? UNCONFIRMED_GRACE_SECONDS : 0;
    if (state.sched != null) {
      // Where the timetable puts it, shifted by the delay; never behind the last stop it served.
      const along = scheduledAlong(journey, nowMs / 1000 - state.delaySeconds, state.sched);
      return Math.max(state.floor, along ?? state.floor);
    }
    if (state.hold) {
      return state.floor;
    }
    if (state.live && state.speed != null && state.fixMs != null) {
      // Between two live fixes: carry on at the speed the train was going, instead of the timetable
      // (which a tram held at a signal soon disagrees with).
      const age = Math.min(LIVE_EXTRAPOLATE_SECONDS, Math.max(0, (nowMs - state.fixMs) / 1000));
      const run = Math.min(state.floor + state.speed * age, state.floor + LIVE_MAX_LEAD_METERS);
      // A train that stops at the next station does not run through it: it waits there for the next fix.
      const next = journey.stops.find((stop) => stop.kind !== 'pass' && stop.along > state.floor + STOP_AHEAD_METERS);
      return next ? Math.min(run, next.along) : run;
    }
    const scheduled = alongAtTime(journey, nowMs / 1000 - state.delaySeconds - grace);
    const along = scheduled ?? state.floor;
    const target = Math.max(state.floor, along);
    return state.live ? Math.min(target, state.floor + LIVE_MAX_LEAD_METERS) : target;
  }

  /** Metres along its line where the timetable model puts the train now (not the eased drawn spot). */
  modelAlong(train: string, nowMs = Date.now()): number | null {
    return this.target(train, nowMs);
  }

  /** Where the train is drawn right now, without advancing the animation. */
  peek(train: string, nowMs = Date.now()): JourneyPosition | null {
    const journey = this.journeys.get(train);
    const state = this.states.get(train);
    const target = this.target(train, nowMs);
    if (!journey || !state || target == null) {
      return null;
    }
    return pointAtAlong(journey, state.shownAlong ?? target);
  }

  private corrections: Array<{ train: string; meters: number }> = [];
  private lastCorrection = new Map<string, number>();

  /** A report moved the train far from where it was shown (once per jump, not per frame). */
  private noteCorrection(train: string, gap: number) {
    const now = Date.now();
    if (now - (this.lastCorrection.get(train) ?? 0) < 20_000) {
      return;
    }
    this.lastCorrection.set(train, now);
    this.corrections.push({ train, meters: gap });
  }

  /** Corrections since the last call: positive metres = the train jumped ahead, negative = back. */
  takeCorrections(): Array<{ train: string; meters: number }> {
    if (this.corrections.length === 0) {
      return this.corrections;
    }
    const out = this.corrections;
    this.corrections = [];
    return out;
  }

  /** Where the drawn train will be in `seconds`, without advancing the animation. */
  lookahead(train: string, seconds: number, nowMs = Date.now()): JourneyPosition | null {
    const journey = this.journeys.get(train);
    const state = this.states.get(train);
    const target = this.target(train, nowMs);
    if (!journey || !state || target == null) {
      return null;
    }
    const ahead = this.target(train, nowMs + seconds * 1000) ?? target;
    return pointAtAlong(journey, (state.shownAlong ?? target) + Math.max(0, ahead - target));
  }

  /** Position on the rails for this frame, or null when the reported point should be shown instead. */
  position(train: string, nowMs = Date.now()): JourneyPosition | null {
    const journey = this.journeys.get(train);
    const state = this.states.get(train);
    const target = this.target(train, nowMs);
    if (!journey || !state || target == null) {
      return null;
    }
    const dt = state.lastMs > 0 ? Math.min(5, Math.max(0, (nowMs - state.lastMs) / 1000)) : 0;
    state.lastMs = nowMs;
    let shown = state.shownAlong ?? target;
    const gap = target - shown;
    if (state.live && gap <= SNAP_METERS) {
      // Never pinging: a new fix shows how far off the guess was; the drawn vehicle speeds up or slows
      // down toward the speed that closes the gap (gently: a bus does not lurch), and stands when it
      // is ahead of where it should be.
      const pace =
        state.sched != null ? Math.max(0, (this.target(train, nowMs + 1000) ?? target) - target) : state.speed ?? 8;
      let wanted: number;
      if (gap >= 0) {
        wanted = Math.min(pace * LIVE_CATCH_UP + 2 + Math.min(LIVE_CATCH_UP_MAX, gap * LIVE_CATCH_UP_PER_METER), Math.max(pace, gap / LIVE_CHASE_SECONDS + pace * 0.5));
      } else {
        wanted = pace * Math.max(0, 1 + gap / LIVE_BACKTRACK_METERS);
      }
      wanted = Math.min(wanted, LIVE_MAX_SHOWN_SPEED);
      let speed = state.shownSpeed ?? Math.min(pace, wanted);
      speed += Math.max(-LIVE_DECEL * dt, Math.min(LIVE_ACCEL * dt, wanted - speed));
      speed = Math.max(0, speed);
      state.shownSpeed = speed;
      shown += speed * dt;
      if (gap < -LIVE_SNAP_BACK_METERS) {
        // a long way ahead of where its reports put it (a glitch): not a minute of reversing
        shown = target;
        state.shownSpeed = 0;
        this.noteCorrection(train, gap);
      } else if (gap < -LIVE_REVERSE_METERS) {
        shown -= Math.min(-gap * (1 - Math.exp(-dt / LIVE_CHASE_BACK_SECONDS)), 15 * dt);
        this.noteCorrection(train, gap);
      }
    } else if (gap < -(state.live ? LIVE_BACKTRACK_METERS : BACKTRACK_METERS)) {
      // The train was shown further on than ZSR says it can be: slide it back
      // instead of teleporting it.
      shown += gap * Math.min(1, dt / EASE_BACK_SECONDS);
      this.noteCorrection(train, gap);
    } else if (gap > SNAP_METERS) {
      shown = target;
      this.noteCorrection(train, gap);
    } else if (gap > 0) {
      // closing a gap on the timetable: quickly, but never faster than a train can run
      shown += Math.min(gap * Math.min(1, dt / EASE_SECONDS), EASE_MAX_SPEED * dt);
    }
    state.shownAlong = shown;
    return pointAtAlong(journey, shown);
  }
}
