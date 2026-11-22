import type { FeatureCollection, Point } from 'geojson';
import { REGION_ID, type VehicleMode } from '../region';

/** Bits of a stop row: which kinds of vehicle call there. */
export const STOP_TRAM = 1;
export const STOP_METRO = 2;
export const STOP_BUS = 4;

/** The stop kinds that go with the vehicle kinds switched on (trolleybuses stop with the buses). */
export function stopKindsOf(modes: VehicleMode[]): number {
  return (modes.includes('tram') ? STOP_TRAM : 0) | (modes.includes('metro') ? STOP_METRO : 0) | (modes.includes('bus') || modes.includes('trolley') ? STOP_BUS : 0);
}

/** Tram, metro and bus stops of the region as points (properties: name, tram, metro, bus). */
export async function fetchTransitStops(kinds: number, signal?: AbortSignal): Promise<FeatureCollection<Point> | null> {
  if (REGION_ID === 'sk' || kinds === 0) {
    return null;
  }
  try {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const response = await fetch(`/proxy/stops?mode=stops&regions=${REGION_ID}&only=1&kinds=${kinds}`, { signal });
      if (response.status === 202) {
        await new Promise((resolve) => window.setTimeout(resolve, 4000));
        continue;
      }
      if (!response.ok) {
        return null;
      }
      const { stops } = (await response.json()) as { stops: Array<[string, number, number, number]> };
      return {
        type: 'FeatureCollection',
        features: stops.map(([name, lat, lng, mask]) => ({
          type: 'Feature',
          properties: { name, tram: Boolean(mask & STOP_TRAM), metro: Boolean(mask & STOP_METRO), bus: Boolean(mask & STOP_BUS) },
          geometry: { type: 'Point', coordinates: [lng, lat] },
        })),
      };
    }
  } catch {
    // no stops: the map is just without them
  }
  return null;
}
