/**
 * Live vehicle positions of Prague's PID from the Golemio open-data API (needs a free key).
 *
 *   GOLEMIO_API_KEY=... in the environment of the region proxy.
 *
 * Each feature of /v2/vehiclepositions carries the GTFS trip id, the last GPS point and the
 * delay in seconds. Those become `{ delaySec, lat, lng }` per running train, handed to the
 * region, which then shows the real position and delay instead of the timetable's.
 */

const URL_BASE = 'https://api.golemio.cz/v2/vehiclepositions';
const POLL_MS = 15_000;
/** A position older than this is ignored: the vehicle stopped reporting. */
const STALE_MS = 3 * 60_000;

export function parseFeatures(features, tripKey, now = Date.now()) {
  const out = new Map();
  for (const feature of features ?? []) {
    const props = feature?.properties ?? {};
    const tripId = props.trip?.gtfs?.trip_id;
    const key = tripId ? tripKey.get(tripId) : null;
    if (!key) {
      continue;
    }
    const last = props.last_position ?? {};
    const stamp = Date.parse(last.origin_timestamp ?? '');
    if (Number.isFinite(stamp) && now - stamp > STALE_MS) {
      continue;
    }
    const coords = feature.geometry?.coordinates;
    const delay = Number(last.delay?.actual);
    out.set(key, {
      delaySec: Number.isFinite(delay) ? delay : 0,
      /** GTFS stop_sequence of the last stop it served, and whether it is standing there now. */
      lastSeq: Number.isFinite(Number(last.last_stop?.sequence)) ? Number(last.last_stop.sequence) : null,
      atStop: last.state_position === 'at_stop',
      lat: Array.isArray(coords) ? Number(coords[1]) : undefined,
      lng: Array.isArray(coords) ? Number(coords[0]) : undefined,
      at: Number.isFinite(stamp) ? stamp : now,
    });
  }
  return out;
}

export function startGolemioPolling({ region, apiKey, log = () => undefined, fetchImpl = fetch }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) {
      return;
    }
    try {
      const response = await fetchImpl(`${URL_BASE}?limit=10000`, {
        headers: { 'X-Access-Token': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json();
      const tripKey = new Map(region.activeTrips().map((entry) => [entry.trip.id, entry.key]));
      const live = parseFeatures(body.features, tripKey);
      region.setLive(live);
      log(`Golemio: ${body.features?.length ?? 0} vehicles, ${live.size} matched to running trains`);
    } catch (error) {
      log(`Golemio poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) {
      setTimeout(tick, POLL_MS);
    }
  };
  tick();
  return () => {
    stopped = true;
  };
}
