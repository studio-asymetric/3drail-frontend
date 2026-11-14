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
 * that point, and never lets it run past the next timetabled stop before ZSR
 * confirms it; it waits there until the next report moves the checkpoint on.
 */

export interface Journey {
  train: string;
  sig: string;
  lat: Float64Array;
  lng: Float64Array;
  /** Metres from the start of the line to each vertex. */
  cum: Float64Array;
  /** Timed stops: metres along the line, arrival and departure in epoch seconds. */
  stops: Array<{ along: number; arr: number; dep: number }>;
  /** Metres along the line for every point ZSR lists (null when off the line). */
  at: Array<number | null>;
  ok: boolean;
}

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
/** A target this far behind the shown position is applied; smaller ones wait. */
const BACKTRACK_METERS = 1500;

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
  stops: Array<[number, number | null, number | null, number]>;
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
  (raw.stops ?? []).forEach(([along, arrRaw, depRaw]) => {
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
    stops.push({ along, arr, dep: Math.max(dep, arr) });
  });
  return { train: raw.n, sig: raw.sig, lat, lng, cum, stops, at: raw.at ?? [], ok: raw.ok };
}

export async function fetchJourneys(signal?: AbortSignal): Promise<Map<string, Journey>> {
  const response = await fetch('/proxy/journeys?mode=journeys&v=1', { signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Journeys HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { journeys?: RawJourney[] };
  const out = new Map<string, Journey>();
  (payload.journeys ?? []).forEach((raw) => {
    const journey = buildJourney(raw);
    if (journey) {
      out.set(journey.train, journey);
    }
  });
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
  if (t < first.dep - EDGE_SECONDS || t > last.arr + EDGE_SECONDS) {
    return null;
  }
  if (t <= first.dep) {
    return first.along;
  }
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
  delaySeconds: number;
  /** Metres along the line of the last reported checkpoint. */
  floor: number;
  /** Metres along the line of the next timetabled stop; the train waits here. */
  ceiling: number;
  shownAlong: number | null;
  lastMs: number;
  active: boolean;
};

export interface LiveTrainInput {
  trainNumber: string;
  delayMinutes: number;
  position?: { lat: number; lng: number };
  rosterOrderCurrentStation?: number;
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
      // Wait at the next timetabled stop until ZSR reports the train past it.
      // (Untimed passing points are not used: not all of them send reports.)
      const nextStop = journey.stops.find((stop) => stop.along > floor! + 1);
      const ceiling = nextStop ? nextStop.along : Infinity;
      const previous = this.states.get(train.trainNumber);
      this.states.set(train.trainNumber, {
        sig: journey.sig,
        delaySeconds: Math.max(0, (train.delayMinutes || 0) * 60),
        floor,
        ceiling,
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
      floor: 0,
      ceiling: Infinity,
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
    return Math.min(state.ceiling, Math.max(state.floor, along));
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
