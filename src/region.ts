/**
 * Extra regions the map can show next to Slovakia. Prague (PID) is loaded on demand: nothing about
 * it is downloaded until the visitor moves the map there, so Slovak visitors pay nothing for it.
 */
export interface RegionBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export type RegionId = 'pid';

/** Rail stops of the PID feed: Prague and Central Bohemia. */
export const PID_BOUNDS: RegionBounds = { minLat: 49.353622, maxLat: 50.588305, minLng: 13.159661, maxLng: 15.576266 };

/** The map centre has to be this close to a region (degrees) to load it. */
const ACTIVATE_MARGIN = 0.25;

const active = new Set<RegionId>();
const listeners = new Set<(ids: RegionId[]) => void>();

export const activeRegions = (): RegionId[] => [...active];

/** `&regions=pid` for the proxy's endpoints, empty while no extra region is on. */
export const regionsQuery = (): string => (active.size > 0 ? `&regions=${[...active].join(',')}` : '');

export function activateRegion(id: RegionId) {
  if (active.has(id)) {
    return;
  }
  active.add(id);
  const ids = activeRegions();
  listeners.forEach((listener) => listener(ids));
}

export function subscribeRegions(listener: (ids: RegionId[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Turn a region on when the map centre is in (or right next to) it. */
export function activateRegionAt(lat: number, lng: number) {
  const b = PID_BOUNDS;
  if (
    lat >= b.minLat - ACTIVATE_MARGIN &&
    lat <= b.maxLat + ACTIVATE_MARGIN &&
    lng >= b.minLng - ACTIVATE_MARGIN &&
    lng <= b.maxLng + ACTIVATE_MARGIN
  ) {
    activateRegion('pid');
  }
}
