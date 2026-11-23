/**
 * Brno + South Moravia: routes that correct themselves from the vehicles.
 *
 * The line of a train or tram is the shortest way along the tracks between its stops. Where the real
 * service takes a longer way (S6 and R8 into Brno hlavní nádraží come round the south, not by Židenice),
 * the shortest way is wrong. A vehicle's GPS shows where it really runs: when one keeps to a place
 * well off the drawn line, the place is remembered as a hint for that hop, the line is traced again
 * through it, and the better line replaces the old one at once. Hints are kept on disk, so the next
 * build of the timetable starts from them.
 *
 * Nothing here changes the pathfinder itself (the one that draws the Slovak trains): it is only asked
 * to pass one more place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildGraphs, hintsFileOf, loadOsm, patternKey, readHints, tracePattern } from './buildJmk.mjs';

/** A vehicle this far from its line (m) is off it; closer than ON_LINE it is on it again. */
export const OFF_LINE_METERS = 90;
const ON_LINE_METERS = 50;
/** It must stay off the line this long, and have travelled this far while off it, before the line is changed. */
const OFF_SECONDS = 25;
const OFF_TRAVEL_METERS = 150;
/** A new line must pass this close to the place the vehicle was seen, or it is thrown away. */
const ACCEPT_METERS = 40;
const COOLDOWN_MS = 10 * 60_000;
const MAX_HINTS_PER_PATTERN = 6;
/** Hints closer than this to an existing one of the same hop are the same hint. */
const SAME_HINT_METERS = 120;

const meters = (aLat, aLng, bLat, bLng) =>
  Math.hypot((bLat - aLat) * 110_574, (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180));

/** The most detour (m) a place may add to its hop: further than that it is not on this run's way at all. */
const MAX_HOP_DETOUR_METERS = 3500;

/** The hop between two stops a place lies on: the one it adds the least detour to (-1 when none is near). */
export function hopOf(stops, lat, lng) {
  let best = -1;
  let bestExtra = Infinity;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
    const extra = meters(a.lat, a.lng, lat, lng) + meters(lat, lng, b.lat, b.lng) - meters(a.lat, a.lng, b.lat, b.lng);
    if (extra < bestExtra) {
      bestExtra = extra;
      best = i;
    }
  }
  return bestExtra <= MAX_HOP_DETOUR_METERS ? best : -1;
}

export function createRerouter({ region, dataDir, log = () => undefined, now = () => Date.now(), graphs: given = null }) {
  let graphs = given;
  let loading = null;
  const hints = readHints(dataDir);
  const watch = new Map(); // vehicle key -> { since, lat, lng, travelled }
  const lastTry = new Map(); // shape id -> time

  async function ensureGraphs() {
    if (graphs) return graphs;
    loading ??= loadOsm(path.join(path.dirname(dataDir), 'jmk-osm-cache.json'), log)
      .then((osm) => {
        graphs = buildGraphs(osm);
        return graphs;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
    return loading;
  }

  function save() {
    try {
      fs.writeFileSync(hintsFileOf(dataDir), JSON.stringify(hints));
    } catch (error) {
      log(`route hints not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Looks at one vehicle: true when it was asked to change its line. */
  async function fix(trip, info, lat, lng, stopId, status) {
    // the stop it is heading to says which hop it is on; failing that, the hop the place adds least detour to
    const heading = status === 1 || !stopId ? -1 : info.stops.findIndex((s) => s.id === stopId);
    const hop = heading > 0 ? heading - 1 : hopOf(info.stops, lat, lng);
    if (hop < 0) return false;
    const from = info.stops[hop];
    const to = info.stops[hop + 1];
    const key = patternKey(info.type, info.stops.map((s) => s.id));
    const list = hints[key] ?? [];
    if (list.length >= MAX_HINTS_PER_PATTERN) return false;
    if (list.some((h) => h.from === from.id && h.to === to.id && meters(h.lat, h.lng, lat, lng) < SAME_HINT_METERS)) return false;
    const next = [...list, { from: from.id, to: to.id, fromName: from.name, toName: to.name, lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) }];
    const g = await ensureGraphs();
    const { line } = tracePattern(g, info.type, info.stops.filter((s) => Number.isFinite(s.lat)), next);
    // the new line must really go where the vehicle was; otherwise the hint was noise or off the tracks
    let near = Infinity;
    for (const [pLat, pLng] of line) near = Math.min(near, meters(pLat, pLng, lat, lng));
    if (near > ACCEPT_METERS) {
      log(`route hint at ${lat.toFixed(4)},${lng.toFixed(4)} not used: the tracks do not pass it (${Math.round(near)} m)`);
      return false;
    }
    hints[key] = next;
    region.setShape(info.shapeId, line);
    log(`route of ${from.id} → ${to.id} (${trip}) redrawn through ${lat.toFixed(4)},${lng.toFixed(4)}`);
    // every other line that runs the same hop takes the same way
    const hint = next[next.length - 1];
    let others = 0;
    for (const other of region.patterns()) {
      if (other.shapeId === info.shapeId || other.type !== info.type) continue;
      // the same hop, by the names of its stops (the platforms of one station have ids of their own)
      const at = other.stops.findIndex((s, i) => s.name === hint.fromName && other.stops[i + 1]?.name === hint.toName);
      if (at < 0 || !hint.fromName) continue;
      const mapped = { ...hint, from: other.stops[at].id, to: other.stops[at + 1].id };
      const otherKey = patternKey(other.type, other.stops.map((s) => s.id));
      const mine = hints[otherKey] ?? [];
      if (mine.some((h) => h.from === mapped.from && h.to === mapped.to && meters(h.lat, h.lng, hint.lat, hint.lng) < SAME_HINT_METERS)) continue;
      const withHint = [...mine, mapped];
      const traced = tracePattern(g, other.type, other.stops.filter((s) => Number.isFinite(s.lat)), withHint);
      let close = Infinity;
      for (const [pLat, pLng] of traced.line) close = Math.min(close, meters(pLat, pLng, hint.lat, hint.lng));
      if (close > ACCEPT_METERS) continue;
      hints[otherKey] = withHint;
      region.setShape(other.shapeId, traced.line);
      others += 1;
    }
    if (others > 0) log(`${others} other lines on the same hop redrawn too`);
    save();
    return true;
  }

  return {
    hints,
    /**
     * Called with the vehicles of every live update: `vehicles` is [{ key, tripId, lat, lng }] of trains and
     * trams matched to a timetable run.
     */
    observe(vehicles) {
      const t = now();
      const seen = new Set();
      for (const v of vehicles) {
        seen.add(v.key);
        const info = region.tripInfo(v.tripId);
        if (!info || info.stops.length < 2 || !info.shapeId) continue;
        const dev = region.shapeDeviation(info.shapeId, v.lat, v.lng);
        if (dev == null) continue;
        const state = watch.get(v.key);
        if (dev < ON_LINE_METERS) {
          if (state) watch.delete(v.key);
          continue;
        }
        if (dev < OFF_LINE_METERS && !state) continue;
        if (!state) {
          watch.set(v.key, { since: t, lat: v.lat, lng: v.lng, travelled: 0, last: [v.lat, v.lng] });
          continue;
        }
        state.travelled += meters(state.last[0], state.last[1], v.lat, v.lng);
        state.last = [v.lat, v.lng];
        if (t - state.since < OFF_SECONDS * 1000 || state.travelled < OFF_TRAVEL_METERS) continue;
        const tried = lastTry.get(info.shapeId);
        if (tried !== undefined && t - tried < COOLDOWN_MS) continue;
        lastTry.set(info.shapeId, t);
        watch.delete(v.key);
        fix(v.key, info, v.lat, v.lng, v.stopId, v.status).catch((error) =>
          log(`route fix failed: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
      for (const key of watch.keys()) if (!seen.has(key)) watch.delete(key);
    },
  };
}
