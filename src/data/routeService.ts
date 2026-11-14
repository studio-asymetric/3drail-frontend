import type { Coordinate } from './gtfsParser';

/**
 * Server-traced train routes.
 *
 * The proxy holds the national rail graph and traces a journey on it, so the
 * browser only sends its stations and gets back the finished line (a few KB),
 * instead of building and shipping the whole graph to a worker.
 */

const ROUTE_API_VERSION = 1;
const ROUTE_TIMEOUT_MS = 8000;

export interface TrainRouteResult {
  segments: Coordinate[][];
  /** Per hop between consecutive waypoints: 1 routed, 0 gap, -1 station off the network. */
  hops: number[];
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let chunk = '';
  while (v >= 0x20) {
    chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return chunk + String.fromCharCode(v + 63);
}

/** Google encoded polyline, precision 5 (≈1 m, same as the rail pack). */
export function encodePolyline(points: Array<{ lat: number; lng: number }>): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  points.forEach((point) => {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);
    out += encodeValue(lat - lastLat) + encodeValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  });
  return out;
}

export function decodePolyline(encoded: string): Coordinate[] {
  const points: Coordinate[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5, sequence: points.length + 1 });
  }
  return points;
}

export async function fetchTrainRoute(
  waypoints: Array<{ lat: number; lng: number }>,
  signal?: AbortSignal
): Promise<TrainRouteResult> {
  const query = new URLSearchParams({
    mode: 'route',
    v: String(ROUTE_API_VERSION),
    w: encodePolyline(waypoints),
  });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  try {
    const response = await fetch(`/proxy/route?${query.toString()}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Route HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { segments?: string[]; hops?: number[] };
    const segments = (payload.segments ?? [])
      .map((line) => decodePolyline(line))
      .filter((line) => line.length >= 2);
    return { segments, hops: payload.hops ?? [] };
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
