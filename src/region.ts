/**
 * Which region the page shows. It follows the address: "/" is Slovakia, "/pid" is Prague and its
 * surroundings (PID). A page loads only the data of its own region; the menu switches by opening
 * the other address.
 */
export interface RegionBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export type RegionId = 'sk' | 'pid';

export interface RegionInfo {
  id: RegionId;
  /** Address path of the region. */
  path: string;
  /** Where the map opens and how far it may pan. */
  bounds: RegionBounds;
}

export const REGIONS: Record<RegionId, RegionInfo> = {
  sk: {
    id: 'sk',
    path: '/',
    bounds: { minLat: 47.7311798, maxLat: 49.6138162, minLng: 16.8331891, maxLng: 22.5657103 },
  },
  // Rail stops of the PID feed: Prague and Central Bohemia.
  pid: {
    id: 'pid',
    path: '/pid',
    bounds: { minLat: 49.353622, maxLat: 50.588305, minLng: 13.159661, maxLng: 15.576266 },
  },
};

export function regionFromPath(pathname: string): RegionId {
  return /^\/pid(\/|$)/i.test(pathname) ? 'pid' : 'sk';
}

export const REGION_ID: RegionId = typeof window === 'undefined' ? 'sk' : regionFromPath(window.location.pathname);
export const REGION: RegionInfo = REGIONS[REGION_ID];

/** `&regions=pid&only=1` for the proxy's endpoints on a region page; empty for Slovakia. */
export const regionsQuery = (): string => (REGION_ID === 'sk' ? '' : `&regions=${REGION_ID}&only=1`);
