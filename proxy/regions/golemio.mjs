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
  const rail = new Map();
  const other = [];
  for (const feature of features ?? []) {
    const props = feature?.properties ?? {};
    const gtfs = props.trip?.gtfs ?? {};
    const tripId = gtfs.trip_id;
    const last = props.last_position ?? {};
    const stamp = Date.parse(last.origin_timestamp ?? '');
    if (Number.isFinite(stamp) && now - stamp > STALE_MS) {
      continue;
    }
    const coords = feature.geometry?.coordinates;
    const delay = Number(last.delay?.actual);
    const delaySec = Number.isFinite(delay) ? delay : 0;
    const lastSeq = Number.isFinite(Number(last.last_stop?.sequence)) ? Number(last.last_stop.sequence) : null;
    const key = tripId ? tripKey.get(tripId) : null;
    if (key) {
      rail.set(key, {
        delaySec,
        /** GTFS stop_sequence of the last stop it served, and whether it is standing there now. */
        lastSeq,
        atStop: last.state_position === 'at_stop',
        lat: Array.isArray(coords) ? Number(coords[1]) : undefined,
        lng: Array.isArray(coords) ? Number(coords[0]) : undefined,
        at: Number.isFinite(stamp) ? stamp : now,
      });
      continue;
    }
    // Buses, trams, metro, trolleybuses, ferries: shown from the live report alone.
    if (!tripId || !Array.isArray(coords) || !Number.isFinite(Number(coords[0]))) {
      continue;
    }
    other.push({
      tripId,
      routeId: gtfs.route_id,
      short: gtfs.route_short_name ?? '',
      type: Number(gtfs.route_type),
      headsign: gtfs.trip_headsign ?? '',
      agency: props.trip?.agency_name?.real ?? '',
      startTs: props.trip?.start_timestamp ?? '',
      lat: Number(coords[1]),
      lng: Number(coords[0]),
      bearing: Number(last.bearing),
      delaySec,
      lastStopId: last.last_stop?.id ?? '',
      nextStopId: last.next_stop?.id ?? '',
      lastTime: String(last.last_stop?.departure_time ?? last.last_stop?.arrival_time ?? '').slice(11, 16),
      nextTime: String(last.next_stop?.arrival_time ?? '').slice(11, 16),
      lastSeq,
      atStop: last.state_position === 'at_stop',
      at: Number.isFinite(stamp) ? stamp : now,
    });
  }
  return { rail, other };
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
      const { rail, other } = parseFeatures(body.features, tripKey);
      region.setLive(rail);
      region.setOthers(other);
      log(`Golemio: ${body.features?.length ?? 0} vehicles, ${rail.size} trains, ${other.length} buses, trams and metro`);
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
