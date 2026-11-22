import type { Feature, LineString } from 'geojson';

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
const GROUP_LINK_METERS = 250;
const GROUP_MAX_SPREAD_METERS = 300;
const SAME_SPOT_METERS = 3;

const meters = (a: StationPoint, b: StationPoint) =>
  Math.hypot((a.lat - b.lat) * 111_000, (a.lng - b.lng) * 111_000 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180));

/**
 * Stops of one name that lie apart (the two platforms of a tram stop, "Bratislava-Vinohrady" and
 * "Bratislava-Vinohrady 2") are one place: they keep a dot each and share one light pill drawn behind
 * them (a big circle when they are close, longer when they are further apart), and one label. A group
 * wider than GROUP_MAX_SPREAD_METERS is not joined. Returns the points (with group, pill and
 * hideLabel set) and the pill lines.
 */
export function groupStations<T extends StationPoint>(points: T[]): { points: T[]; pills: Array<Feature<LineString>> } {
  const out: T[] = points.map((point) => ({ ...point }));
  const buckets = new Map<string, number[]>();
  out.forEach((point, index) => {
    const key = baseStationName(point.name);
    if (!key) return;
    const list = buckets.get(key);
    if (list) list.push(index);
    else buckets.set(key, [index]);
  });

  const pills: Array<Feature<LineString>> = [];
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
      // the pill runs along the dots: ordered by the longer direction of their spread
      const lats = spots.map((index) => out[index].lat);
      const lngs = spots.map((index) => out[index].lng);
      const latSpan = (Math.max(...lats) - Math.min(...lats)) * 111_000;
      const lngSpan = (Math.max(...lngs) - Math.min(...lngs)) * 111_000 * Math.cos((out[spots[0]].lat * Math.PI) / 180);
      const ordered = [...spots].sort((a, b) => (lngSpan >= latSpan ? out[a].lng - out[b].lng : out[a].lat - out[b].lat));
      pills.push({
        type: 'Feature',
        id: group,
        properties: { group },
        geometry: { type: 'LineString', coordinates: ordered.map((index) => [out[index].lng, out[index].lat]) },
      });
    });
  });
  return { points: out, pills };
}
