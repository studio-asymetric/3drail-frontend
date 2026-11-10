import type { OSMWay } from './osmRailService';

export type LatLngPoint = { lat: number; lng: number };
export type LatLngPolygon = LatLngPoint[];

export function pointInPolygon(point: LatLngPoint, polygon: LatLngPolygon): boolean {
  if (polygon.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

export function simplifyRing(points: LatLngPoint[], maxPoints = 120): LatLngPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const step = Math.ceil(points.length / maxPoints);
  const simplified = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  const tail = simplified[simplified.length - 1];
  if (!tail || tail.lat !== last.lat || tail.lng !== last.lng) {
    simplified.push(last);
  }
  return simplified;
}

export function isCoordinateInsideOutline(coord: LatLngPoint, polygons: LatLngPolygon[]): boolean {
  if (!polygons || polygons.length === 0) {
    return true;
  }
  return polygons.some((polygon) => pointInPolygon(coord, polygon));
}

function lerpLatLng(a: LatLngPoint, b: LatLngPoint, t: number): LatLngPoint {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

function segmentEdgeT(a: LatLngPoint, b: LatLngPoint, c: LatLngPoint, d: LatLngPoint): number | null {
  const rLng = b.lng - a.lng;
  const rLat = b.lat - a.lat;
  const sLng = d.lng - c.lng;
  const sLat = d.lat - c.lat;
  const denom = rLng * sLat - rLat * sLng;
  if (Math.abs(denom) < 1e-18) {
    return null;
  }
  const t = ((c.lng - a.lng) * sLat - (c.lat - a.lat) * sLng) / denom;
  const u = ((c.lng - a.lng) * rLat - (c.lat - a.lat) * rLng) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u < 0 || u > 1) {
    return null;
  }
  return t;
}

export function clipPolylineToOutline(points: LatLngPoint[], polygons: LatLngPolygon[]): LatLngPoint[][] {
  if (points.length < 2) {
    return [];
  }
  if (polygons.length === 0) {
    return [points];
  }
  const chains: LatLngPoint[][] = [];
  let current: LatLngPoint[] = [];
  const push = (point: LatLngPoint) => {
    const last = current[current.length - 1];
    if (last && Math.abs(last.lat - point.lat) < 1e-10 && Math.abs(last.lng - point.lng) < 1e-10) {
      return;
    }
    current.push(point);
  };
  const flush = () => {
    if (current.length >= 2) {
      chains.push(current);
    }
    current = [];
  };

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const crossings = polygons
      .flatMap((polygon) => {
        const hits: number[] = [];
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const t = segmentEdgeT(start, end, polygon[j], polygon[i]);
          if (t != null) {
            hits.push(t);
          }
        }
        return hits;
      })
      .sort((a, b) => a - b)
      .filter((t, i, list) => i === 0 || t - list[i - 1] > 1e-6);
    let inside = isCoordinateInsideOutline(start, polygons);
    if (inside) {
      push(start);
    }
    crossings.forEach((t) => {
      const hit = lerpLatLng(start, end, t);
      push(hit);
      if (inside) {
        flush();
      }
      inside = !inside;
    });
    if (inside) {
      push(end);
    } else {
      flush();
    }
  }
  flush();
  return chains;
}

export function clipWaysToOutline(ways: OSMWay[], polygons: LatLngPolygon[]): OSMWay[] {
  if (polygons.length === 0) {
    return ways;
  }
  const clipped: OSMWay[] = [];
  ways.forEach((way) => {
    const points = (way.geometry || []).map((node) => ({
      lat: node.lat,
      lng: node.lon,
    }));
    clipPolylineToOutline(points, polygons).forEach((chain, chainIndex) => {
      clipped.push({
        ...way,
        id: way.id * 100 + chainIndex,
        geometry: chain.map((point) => ({ lat: point.lat, lon: point.lng })),
      });
    });
  });
  return clipped;
}
