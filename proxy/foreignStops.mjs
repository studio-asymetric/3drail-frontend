import { normalizeStationName } from './trainDetail.mjs';

/** "24:11:00" -> "00:11"; empty when the value is missing. */
function clockText(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return '';
  }
  return `${String(Number(match[1]) % 24).padStart(2, '0')}:${match[2]}`;
}

/**
 * The stops a train makes outside the area mapa.zsr.sk lists, taken from the GTFS timetable.
 *
 * mapa.zsr.sk only knows the Slovak part of a journey (the first row of EC 270 is
 * "Štúrovo št. hr."). The GTFS trip of the same number also lists Budapest, Szob,
 * Břeclav, Brno... Everything before the first stop ZSR knows and after the last one
 * is foreign. Times are the plain timetable: no delay is known there.
 *
 * `trips` are that train number's GTFS trips: `{ stops: [{ name, arr, dep }] }`.
 * Returns the ZSR rows with the foreign ones added at either end, each marked
 * `foreign: true`, or the rows untouched when nothing matches.
 */
export function withForeignStops(rows, trips) {
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(trips) || trips.length === 0) {
    return rows;
  }
  const known = new Set(rows.map((row) => normalizeStationName(row.name)));
  let best = null;
  trips.forEach((trip) => {
    const names = trip.stops.map((stop) => normalizeStationName(stop.name));
    const matches = names.filter((name) => known.has(name)).length;
    if (matches >= 2 && (!best || matches > best.matches)) {
      best = { trip, names, matches };
    }
  });
  if (!best) {
    return rows;
  }
  const first = best.names.findIndex((name) => known.has(name));
  const last = best.names.length - 1 - [...best.names].reverse().findIndex((name) => known.has(name));
  const make = (stop, state, isFirst, isLast) => ({
    name: stop.name,
    arrival: '',
    departure: '',
    scheduledArrival: isFirst ? '' : clockText(stop.arr),
    scheduledDeparture: isLast ? '' : clockText(stop.dep ?? stop.arr),
    state,
    kind: 'stop',
    foreign: true,
  });
  const before = best.trip.stops.slice(0, first);
  const after = best.trip.stops.slice(last + 1);
  return [
    ...before.map((stop, index) => make(stop, 'passed', index === 0, false)),
    ...rows,
    ...after.map((stop, index) => make(stop, 'ahead', false, index === after.length - 1)),
  ];
}
