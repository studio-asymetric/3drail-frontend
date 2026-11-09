import { unpackRails } from './packRails';

// Service to fetch railway data from OpenStreetMap using Overpass API

export interface OSMNode {
  id: number;
  lat: number;
  lon: number;
}

export interface OSMWay {
  id: number;
  type: 'way';
  nodes: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags: {
    railway?: string;
    tunnel?: string;
    bridge?: string;
    name?: string;
    ref?: string; // Route/train number
    operator?: string;
    service?: string;
    station?: string;
    'railway:traffic_mode'?: string;
    gauge?: string;
    electrified?: string;
    frequency?: string;
    voltage?: string;
    'railway:maximum_current'?: string;
    rack?: string;
    highspeed?: string;
    maxspeed?: string;
    embankment?: string;
    cutting?: string;
    usage?: string;
  };
}

export interface OSMRelation {
  id: number;
  type: 'relation';
  members: Array<{ type: 'way'; ref: number; role: string }>;
  tags: {
    type?: string;
    route?: string;
    ref?: string; // Train number
    name?: string;
    operator?: string;
  };
}

export interface OSMResponse {
  elements: Array<OSMWay | OSMNode | OSMRelation>;
}

/**
 * Fetch railway lines within bounding box from OpenStreetMap
 */
export interface OsmProxyMeta {
  tileKey?: string;
  cacheAge?: number;
  status?: string;
}

const MAINLINE_RAILWAY = new Set([
  'rail',
  'light_rail',
  'subway',
  'tram',
  'narrow_gauge',
  'monorail',
  'funicular',
]);

const YARD_SERVICE = new Set(['spur', 'siding', 'yard', 'crossover', 'driveway']);
const NON_MAINLINE_USAGE = new Set(['industrial', 'military', 'test', 'tourism']);

/** Same cut as the geographic base map: through lines only, not sidings or yards. */
export function isMainlineWay(way: OSMWay): boolean {
  const railway = way.tags?.railway ?? '';
  if (!MAINLINE_RAILWAY.has(railway)) {
    return false;
  }
  if (isSideRailwayTrack(way)) {
    return false;
  }
  return true;
}

/** Station yards, sidings, spurs, and industrial tracks. */
export function isSideRailwayTrack(way: OSMWay): boolean {
  return YARD_SERVICE.has(way.tags?.service ?? '') || NON_MAINLINE_USAGE.has(way.tags?.usage ?? '');
}

export interface OsmFetchResult {
  ways: OSMWay[];
  meta?: OsmProxyMeta;
}

export async function fetchSimplifiedNetwork(): Promise<OsmFetchResult> {
  try {
    const response = await fetch('/proxy?mode=osm&level=network');
    if (!response.ok) {
      throw new Error(`Proxy network fetch failed: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const ways = (unpackRails(new Uint8Array(buffer)) as OSMWay[]).filter((way) =>
      isMainlineWay(way)
    );
    return {
      ways,
      meta: { status: 'network', cacheAge: 0 },
    };
  } catch (error) {
    console.error('Failed to fetch simplified railway network:', error);
    return { ways: [] };
  }
}

export async function fetchDisplayRailsInBounds(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): Promise<OsmFetchResult> {
  const query = new URLSearchParams({
    minLat: minLat.toString(),
    maxLat: maxLat.toString(),
    minLng: minLng.toString(),
    maxLng: maxLng.toString(),
    level: 'display',
  });
  try {
    const response = await fetch(`/proxy?mode=osm&${query.toString()}`);
    if (!response.ok) {
      throw new Error(`Proxy display rail fetch failed: ${response.status}`);
    }
    const data: OSMResponse = await response.json();
    const ways = data.elements.filter(
      (el): el is OSMWay =>
        el.type === 'way' && MAINLINE_RAILWAY.has(el.tags?.railway ?? '')
    );
    return { ways, meta: data.__proxy_meta };
  } catch (error) {
    console.error('Failed to fetch display rails:', error);
    return { ways: [] };
  }
}

export async function fetchRailwayLinesInBounds(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  level: string = 'tile'
): Promise<OsmFetchResult> {
  const query = new URLSearchParams({
    minLat: minLat.toString(),
    maxLat: maxLat.toString(),
    minLng: minLng.toString(),
    maxLng: maxLng.toString(),
    level,
  });

  try {
    const response = await fetch(`/proxy?mode=osm&${query.toString()}`);
    if (!response.ok) {
      throw new Error(`Proxy osm fetch failed: ${response.status} ${response.statusText}`);
    }

    const data: OSMResponse = await response.json();
    const ways = data.elements.filter(
      (el): el is OSMWay => el.type === 'way' && isMainlineWay(el)
    );
    return { ways, meta: data.__proxy_meta };
  } catch (error) {
    console.error('❌ Failed to fetch OSM rail data:', error);
    return { ways: [] };
  }
}

/**
 * Fetch railway lines for Slovakia (approximate bounds)
 */
export async function fetchSlovakiaRailways(): Promise<OSMWay[]> {
  // Slovakia bounds: ~48.0-49.5°N, 16.8-22.6°E
  return fetchRailwayLinesInBounds(48.0, 49.5, 16.8, 22.6);
}

/**
 * Fetch train route relation by train number
 */
export async function fetchTrainRouteRelation(trainNumber: string): Promise<OSMRelation | null> {
  const overpassQuery = `
    [out:json][timeout:30];
    (
      relation["route"="train"]["ref"="${trainNumber}"];
    );
    out geom;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: overpassQuery,
    });

    if (!response.ok) {
      return null;
    }

    const data: OSMResponse = await response.json();
    const relations = data.elements.filter((el): el is OSMRelation => 
      el.type === 'relation' && el.tags.route === 'train'
    );
    
    return relations.find(r => r.tags.ref === trainNumber) || null;
  } catch (error) {
    console.warn(`Failed to fetch route relation for train ${trainNumber}:`, error);
    return null;
  }
}

/**
 * Convert OSM way geometry to coordinate array
 */
export function osmWayToCoordinates(way: OSMWay): Array<[number, number]> {
  if (way.geometry && way.geometry.length > 0) {
    return way.geometry.map(node => [node.lat, node.lon] as [number, number]);
  }
  
  // Only warn if we expected geometry
  if (way.nodes && way.nodes.length > 0) {
    console.warn(`⚠️ OSM way ${way.id} has ${way.nodes.length} nodes but no geometry data`);
  }
  return [];
}

/**
 * Check if way is a tunnel
 */
export function isTunnel(way: OSMWay): boolean {
  return way.tags.tunnel === 'yes' || way.tags.tunnel === 'true';
}

/**
 * Check if way is a bridge
 */
export function isBridge(way: OSMWay): boolean {
  return way.tags.bridge === 'yes' || way.tags.bridge === 'true' || 
         way.tags.bridge === 'viaduct' || way.tags.bridge === '1';
}

