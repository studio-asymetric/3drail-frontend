import { decodePolyline } from './routeService';

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
  /**
   * Runs between two places the train stands (departure, arrival in epoch s).
   * Within a run the train speeds up and slows down gently; passing points
   * inside it are rolled through.
   */
  runs: Array<[number, number]>;
  /** Metres along the line for every point ZSR lists (null when off the line). */
  at: Array<number | null>;
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
/** Gaps larger than this are jumped instead of eased (e.g. after a long pause). */
const SNAP_METERS = 6000;
/** A target this far behind the shown position is applied; smaller ones wait in place. */
const BACKTRACK_METERS = 4000;
/** Passenger stops timetabled with no dwell (arr = dep) still stand this long. */
const MIN_STOP_DWELL_SECONDS = 30;
/**
 * ZSR times are whole minutes; the event falls somewhere inside that minute.
 * Model it at the middle: a 20:46 departure (with delay) leaves at 20:46:30.
 */
const MID_MINUTE_SECONDS = 30;
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
  line: string;
  /** [metres along, arrival, departure, index in ZSR's list, kind code (0 pass, 1 stop, 2 wait)] */
  stops: Array<[number, number | null, number | null, number, number?]>;
  at?: Array<number | null>;
  ok: boolean;
};

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
  (raw.stops ?? []).forEach(([along, arrRaw, depRaw, , kindCode]) => {
    const arr = arrRaw ?? depRaw;
    const dep = depRaw ?? arrRaw;
    if (arr == null || dep == null) {
      return;
    }
    const last = stops[stops.length - 1];
    // Keep times and positions moving forward; drop stops that contradict them.
    if (last && (along < last.along - 50 || arr < last.dep)) {
      return;
    }
    stops.push({
      along,
      arr: arr + MID_MINUTE_SECONDS,
      dep: Math.max(dep, arr) + MID_MINUTE_SECONDS,
      kind: KIND_BY_CODE[kindCode ?? 1] ?? 'stop',
    });
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
  return { train: raw.n, sig: raw.sig, lat, lng, cum, stops, runs, at: raw.at ?? [], ok: raw.ok };
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

let lastJourneysEtag = '';

/** All running trains' journeys, or null when the list has not changed since the last call. */
export async function fetchJourneys(signal?: AbortSignal): Promise<Map<string, Journey> | null> {
  // no-cache: the browser revalidates with the ETag and gets a 304 when nothing changed.
  const response = await fetch('/proxy/journeys?mode=journeys&v=1', { signal, cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Journeys HTTP ${response.status}`);
  }
  const etag = response.headers.get('etag') ?? '';
  if (etag && etag === lastJourneysEtag) {
    return null;
  }
  const payload = (await response.json()) as { journeys?: RawJourney[] };
  const out = new Map<string, Journey>();
  (payload.journeys ?? []).forEach((raw) => {
    const journey = buildJourney(raw);
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
  /** Metres along the line of the last reported checkpoint. */
  floor: number;
  shownAlong: number | null;
  lastMs: number;
  active: boolean;
};

export interface LiveTrainInput {
  trainNumber: string;
  delayMinutes: number;
  position?: { lat: number; lng: number };
  rosterOrderCurrentStation?: number;
  /** ZSR's PotvrdenyOdj: false while the train has not left its reported station. */
  departureConfirmed?: boolean;
  /** Delay from ZSR's newer report at a later station; preferred over `delayMinutes`. */
  latestDelayMinutes?: number;
}

/**
 * Turns (timetable, live delay, last reported checkpoint) into a position on
 * the rails. Call `update()` on every live refresh and `position()` per frame.
 */
export class JourneyAnimator {
  private journeys = new Map<string, Journey>();
  private states = new Map<string, TrainModelState>();

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
      if (train.position) {
        const fix = projectOnJourney(journey, train.position.lat, train.position.lng);
        if (fix.off > OFF_LINE_METERS) {
          this.markInactive(train.trainNumber, journey.sig);
          return;
        }
        if (floor == null) {
          floor = fix.along;
          checkpoint = journey.at.findIndex((along) => along != null && along > fix.along + 30) - 1;
        }
      }
      if (floor == null) {
        this.markInactive(train.trainNumber, journey.sig);
        return;
      }
      // ZSR does not report at every stop, so between reports the train keeps
      // running on timetable + delay. An unconfirmed departure is not held
      // either: ZSR often confirms late, so the train leaves at departure +
      // delay and the next report pulls it back if it really was still standing.
      const previous = this.states.get(train.trainNumber);
      const reportedDelay = Math.max(0, (train.latestDelayMinutes ?? train.delayMinutes ?? 0) * 60);
      let delaySeconds = reportedDelay;
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
        const scheduled = alongAtTime(journey, nowSeconds - reportedDelay);
        if (scheduled != null && scheduled < floor - 50) {
          const passedAt = timeAtAlong(journey, floor, nowSeconds - reportedDelay);
          if (passedAt != null) {
            delaySeconds = Math.max(0, Math.min(reportedDelay, nowSeconds - passedAt));
          }
        }
      }
      this.states.set(train.trainNumber, {
        sig: journey.sig,
        delaySeconds,
        reportedDelay,
        floor,
        shownAlong: previous && previous.sig === journey.sig ? previous.shownAlong : null,
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
    const scheduled = alongAtTime(journey, nowMs / 1000 - state.delaySeconds);
    const along = scheduled ?? state.floor;
    return Math.max(state.floor, along);
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
    if (Math.abs(gap) > SNAP_METERS || gap < -BACKTRACK_METERS) {
      shown = target;
    } else if (gap > 0) {
      shown += gap * Math.min(1, dt / EASE_SECONDS);
    }
    state.shownAlong = shown;
    return pointAtAlong(journey, shown);
  }
}
