import type { Coordinate } from '../data/gtfsParser';

const SLOVAKIA_BOUNDS = {
  minLat: 47.7311798,
  maxLat: 49.6138162,
  minLng: 16.8331891,
  maxLng: 22.5657103,
};

const LAT_SPAN_DEG = SLOVAKIA_BOUNDS.maxLat - SLOVAKIA_BOUNDS.minLat;
const LNG_SPAN_DEG = SLOVAKIA_BOUNDS.maxLng - SLOVAKIA_BOUNDS.minLng;
const LAT_SPAN_M = LAT_SPAN_DEG * 111000;
const LNG_SPAN_M = LNG_SPAN_DEG * 72000;
const DESIRED_X_WIDTH = 1000;
const X_SCALE_FACTOR = DESIRED_X_WIDTH / LNG_SPAN_M;
const CENTER_LAT = (SLOVAKIA_BOUNDS.minLat + SLOVAKIA_BOUNDS.maxLat) / 2;
const CENTER_LNG = (SLOVAKIA_BOUNDS.minLng + SLOVAKIA_BOUNDS.maxLng) / 2;
const SCALE_LAT = X_SCALE_FACTOR * 111000;
const SCALE_LNG = X_SCALE_FACTOR * 72000;

export function project(coord: Coordinate | { lat: number; lng: number }): [number, number, number] {
  const latMeters = (coord.lat - CENTER_LAT) * SCALE_LAT;
  const lngMeters = (coord.lng - CENTER_LNG) * SCALE_LNG;
  const x = lngMeters;
  const z = -latMeters;
  const y = 1.5;
  return [x, y, z];
}

export { SCALE_LAT, SCALE_LNG, CENTER_LAT, CENTER_LNG };




