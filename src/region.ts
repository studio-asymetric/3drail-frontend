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

export type RegionId = 'sk' | 'pid' | 'jmk';

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
  // Brno and the South Moravian Region (IDS JMK).
  jmk: {
    id: 'jmk',
    path: '/jmk',
    bounds: { minLat: 48.65, maxLat: 49.65, minLng: 15.95, maxLng: 17.65 },
  },
};

export function regionFromPath(pathname: string): RegionId {
  if (/^\/pid(\/|$)/i.test(pathname)) return 'pid';
  return /^\/jmk(\/|$)/i.test(pathname) ? 'jmk' : 'sk';
}

export const REGION_ID: RegionId = typeof window === 'undefined' ? 'sk' : regionFromPath(window.location.pathname);
export const REGION: RegionInfo = REGIONS[REGION_ID];

/** `&regions=pid&only=1` for the proxy's endpoints on a region page; empty for Slovakia. */
export const regionsQuery = (): string => (REGION_ID === 'sk' ? '' : `&regions=${REGION_ID}&only=1`);

/** What a vehicle is: trains are "rail"; the Prague and Brno feeds also have the others. */
export type VehicleMode = 'rail' | 'metro' | 'tram' | 'trolley' | 'bus';
export const VEHICLE_MODES: VehicleMode[] = ['rail', 'metro', 'tram', 'trolley', 'bus'];
/** The modes a region has (Brno has no metro). */
export const regionModes = (region: RegionId): VehicleMode[] =>
  region === 'jmk' ? VEHICLE_MODES.filter((mode) => mode !== 'metro') : VEHICLE_MODES;

const MODES_KEY = 'mojvlak-modes';
/** Buses are many and off until someone asks for them. */
const DEFAULT_MODES: VehicleMode[] = VEHICLE_MODES.filter((mode) => mode !== 'bus');

export function readStoredModes(): VehicleMode[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MODES_KEY) ?? 'null');
    if (Array.isArray(parsed)) {
      return VEHICLE_MODES.filter((mode) => parsed.includes(mode));
    }
  } catch {
    // private mode: use the default
  }
  return [...DEFAULT_MODES];
}

export function storeModes(modes: VehicleMode[]) {
  try {
    window.localStorage.setItem(MODES_KEY, JSON.stringify(modes));
  } catch {
    // ignore
  }
}

/** The mode a feed row belongs to; ferries and funiculars count with the buses. */
export function vehicleModeOf(mode?: string): VehicleMode {
  if (!mode) return 'rail';
  if (mode === 'metro' || mode === 'tram' || mode === 'trolley') return mode;
  return 'bus';
}
