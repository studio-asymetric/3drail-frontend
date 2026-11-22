import type { Feature, Point, Polygon } from 'geojson';

export interface StationPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  color: string;
  rank?: number;
  /** Set by groupStations: the group this dot belongs to, whether it is drawn in a pill, whether its label is left to a neighbour. */
  group?: string;
  pill?: boolean;
  hideLabel?: boolean;
}

/** Names that differ only by a number, case or accents are one station: "Bratislava-Vinohrady 2". */
export function baseStationName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*\(?\d+\)?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dots of one name join only when they are this close in a chain, and the whole group no wider than the maximum. */
const GROUP_LINK_METERS = 300;
const GROUP_MAX_SPREAD_METERS = 700;
const SAME_SPOT_METERS = 3;

const meters = (a: StationPoint, b: StationPoint) =>
  Math.hypot((a.lat - b.lat) * 111_000, (a.lng - b.lng) * 111_000 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180));

/** How far the shape reaches beyond the outermost dots. */
const SHAPE_MARGIN_METERS = 26;

const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (monotone chain) of [x, y] points. */
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const half = (list: Array<[number, number]>) => {
    const chain: Array<[number, number]> = [];
    list.forEach((point) => {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    });
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** A closed ring [lng, lat] round all the dots, rounded: their hull grown by SHAPE_MARGIN_METERS. */
function hullAround(dots: StationPoint[]): Array<[number, number]> {
  const lat0 = dots[0].lat;
  const kx = 111_000 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111_000;
  const ring: Array<[number, number]> = [];
  dots.forEach((dot) => {
    for (let step = 0; step < 20; step += 1) {
      const angle = (step / 20) * Math.PI * 2;
      ring.push([dot.lng + (Math.cos(angle) * SHAPE_MARGIN_METERS) / kx, dot.lat + (Math.sin(angle) * SHAPE_MARGIN_METERS) / ky]);
    }
  });
  const hull = convexHull(ring);
  return [...hull, hull[0]];
}

/**
 * Stops of one name that lie apart (the two platforms of a tram stop, "Bratislava-Vinohrady" and
 * "Bratislava-Vinohrady 2") are one place: they keep a dot each and share one light shape drawn behind
 * them (their rounded outline), and one label. A group
 * wider than GROUP_MAX_SPREAD_METERS is not joined. Returns the points (with group, pill and
 * hideLabel set) and the pill lines.
 */
export function groupStations<T extends StationPoint>(points: T[]): { points: T[]; pills: Array<Feature<Polygon>>; spots: Array<Feature<Point>> } {
  const out: T[] = points.map((point) => ({ ...point }));
  const buckets = new Map<string, number[]>();
  out.forEach((point, index) => {
    const key = baseStationName(point.name);
    if (!key) return;
    const list = buckets.get(key);
    if (list) list.push(index);
    else buckets.set(key, [index]);
  });

  const pills: Array<Feature<Polygon>> = [];
  buckets.forEach((indexes, key) => {
    if (indexes.length < 2) return;
    // single linkage within the radius
    const parent = indexes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < indexes.length; i += 1) {
      for (let j = i + 1; j < indexes.length; j += 1) {
        if (meters(out[indexes[i]], out[indexes[j]]) <= GROUP_LINK_METERS) {
          parent[find(i)] = find(j);
        }
      }
    }
    const clusters = new Map<number, number[]>();
    indexes.forEach((index, i) => {
      const root = find(i);
      const list = clusters.get(root);
      if (list) list.push(index);
      else clusters.set(root, [index]);
    });
    clusters.forEach((members) => {
      // distinct spots only
      const spots = members.filter(
        (index, i) => members.findIndex((other) => meters(out[other], out[index]) <= SAME_SPOT_METERS) === i
      );
      if (spots.length < 2) return;
      const wide = spots.some((a) => spots.some((b) => meters(out[a], out[b]) > GROUP_MAX_SPREAD_METERS));
      if (wide) return;
      const group = `g:${key}:${out[spots[0]].id}`;
      // the label sits on the dot whose name has no number, else the most important one
      const labelIndex = [...members].sort((a, b) => {
        const plainA = baseStationName(out[a].name) === out[a].name.toLowerCase() ? 0 : 1;
        const plainB = baseStationName(out[b].name) === out[b].name.toLowerCase() ? 0 : 1;
        return plainA - plainB || (out[b].rank ?? 1) - (out[a].rank ?? 1);
      })[0];
      members.forEach((index) => {
        out[index].group = group;
        out[index].pill = true;
        out[index].hideLabel = index !== labelIndex;
      });
      pills.push({
        type: 'Feature',
        id: group,
        properties: { group },
        geometry: { type: 'Polygon', coordinates: [hullAround(spots.map((index) => out[index]))] },
      });
    });
  });
  // Platforms of one stop (all sharing an id) are drawn as one dot in the middle of the shape, and a small dot where each platform was (spots).
  const dropped = new Set<number>();
  const spots: Array<Feature<Point>> = [];
  buckets.forEach((indexes) => {
    const byGroup = new Map<string, number[]>();
    indexes.forEach((index) => {
      const group = out[index].group;
      if (group) byGroup.set(group, [...(byGroup.get(group) ?? []), index]);
    });
    byGroup.forEach((members) => {
      if (new Set(members.map((index) => out[index].id)).size !== 1) return;
      const keep = members[0];
      members.forEach((index) =>
        spots.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [out[index].lng, out[index].lat] } })
      );
      out[keep].lat = members.reduce((sum, index) => sum + out[index].lat, 0) / members.length;
      out[keep].lng = members.reduce((sum, index) => sum + out[index].lng, 0) / members.length;
      out[keep].hideLabel = false;
      members.slice(1).forEach((index) => dropped.add(index));
    });
  });
  return { points: out.filter((_, index) => !dropped.has(index)), pills, spots };
}
