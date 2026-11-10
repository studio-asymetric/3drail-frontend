export function normalizeHeading(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return ((value % 360) + 360) % 360;
}

export function headingFromPoints(
  from?: { lat: number; lng: number } | null,
  to?: { lat: number; lng: number } | null
): number | null {
  if (!from || !to) {
    return null;
  }
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) {
    return null;
  }
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

export function headingFromPath(
  path: Array<{ lat: number; lng: number }> | undefined,
  position?: { lat: number; lng: number } | null
): number | null {
  if (!path || path.length < 2) {
    return null;
  }
  let index = 0;
  if (position) {
    let best = Infinity;
    path.forEach((point, i) => {
      const distance =
        (point.lat - position.lat) * (point.lat - position.lat) +
        (point.lng - position.lng) * (point.lng - position.lng);
      if (distance < best) {
        best = distance;
        index = i;
      }
    });
  }
  const next = path[index + 1];
  if (next) {
    return headingFromPoints(path[index], next);
  }
  return headingFromPoints(path[index - 1], path[index]);
}

export function resolveTrainHeading(train: {
  heading?: number;
  position?: { lat: number; lng: number } | null;
  liveRoute?: Array<{ lat: number; lng: number }>;
  shapePath?: Array<{ lat: number; lng: number }>;
}): number | null {
  const liveHeading = normalizeHeading(train.heading);
  if (liveHeading != null) {
    return liveHeading;
  }
  return (
    headingFromPath(train.liveRoute, train.position) ??
    headingFromPath(train.shapePath, train.position)
  );
}

/** Pull the triangle base under the pill so the bottom corners are hidden. */
export const TRAIN_ARROW_INSET_PX = 4;

/**
 * Point on the stadium outline whose outward normal matches `headingDeg`.
 * The arrow base sits there, tangent to the border. 0deg = north.
 */
export function stadiumEdgePoint(
  width: number,
  height: number,
  headingDeg: number,
  inset = TRAIN_ARROW_INSET_PX
): { x: number; y: number } {
  const w = Math.max(width, 8);
  const h = Math.max(height, 8);
  const radius = h / 2;
  const flat = Math.max(0, w / 2 - radius);
  const rad = (headingDeg * Math.PI) / 180;
  const nx = Math.sin(rad);
  const ny = -Math.cos(rad);
  let x: number;
  let y: number;
  if (Math.abs(nx) < 1e-9) {
    x = 0;
    y = ny < 0 ? -radius : radius;
  } else {
    const capX = nx > 0 ? flat : -flat;
    x = capX + nx * radius;
    y = ny * radius;
  }
  if (inset !== 0) {
    x -= nx * inset;
    y -= ny * inset;
  }
  return { x, y };
}
