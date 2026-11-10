import type { Coordinate } from './gtfsParser';
import { haversineDistance } from './trainOsmMapper';

export const TRAIN_MOVE_MIN_METERS = 14;

export function pathLengthMeters(path: Coordinate[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += haversineDistance(path[index - 1], path[index]);
  }
  return total;
}

export function positionAlongPath(path: Coordinate[], progress: number): Coordinate {
  if (path.length === 0) {
    return { lat: 0, lng: 0, sequence: 0 };
  }
  if (path.length === 1 || progress <= 0) {
    return path[0];
  }
  if (progress >= 1) {
    return path[path.length - 1];
  }
  const total = pathLengthMeters(path);
  if (total <= 0) {
    return path[path.length - 1];
  }
  const target = total * progress;
  let walked = 0;
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    const segment = haversineDistance(from, to);
    if (walked + segment >= target) {
      const segmentT = segment > 0 ? (target - walked) / segment : 0;
      return {
        lat: from.lat + (to.lat - from.lat) * segmentT,
        lng: from.lng + (to.lng - from.lng) * segmentT,
        sequence: to.sequence ?? 0,
      };
    }
    walked += segment;
  }
  return path[path.length - 1];
}

export function motionDurationMs(path: Coordinate[]): number {
  const meters = pathLengthMeters(path);
  if (meters < TRAIN_MOVE_MIN_METERS) {
    return 0;
  }
  return Math.min(38_000, Math.max(2_400, (meters / 17.5) * 1000));
}

export function readPrefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
