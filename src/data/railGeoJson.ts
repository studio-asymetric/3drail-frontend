import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { isSideRailwayTrack, isTransitRailway, type OSMWay } from './osmRailService';
import type { Coordinate } from './gtfsParser';

export const EMPTY_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

export type RailKind = 'main' | 'branch' | 'side';

export function isMainRailway(way: OSMWay): boolean {
  const railway = way.tags?.railway ?? 'rail';
  return railway === 'rail' || railway === 'narrow_gauge';
}

export function railKind(way: OSMWay): RailKind {
  if (isSideRailwayTrack(way)) {
    return 'side';
  }
  if (isTransitRailway(way)) {
    return 'branch';
  }
  return isMainRailway(way) ? 'main' : 'branch';
}

function wayLengthMeters(way: OSMWay): number {
  const geometry = way.geometry || [];
  let length = 0;
  for (let index = 1; index < geometry.length; index += 1) {
    const previous = geometry[index - 1];
    const point = geometry[index];
    const dlat = (point.lat - previous.lat) * 111320;
    const dlng =
      (point.lon - previous.lon) * 111320 * Math.cos(((point.lat + previous.lat) / 2) * (Math.PI / 180));
    length += Math.hypot(dlat, dlng);
  }
  return length;
}

function wayHeading(way: OSMWay): number {
  const geometry = way.geometry || [];
  if (geometry.length < 2) {
    return 0;
  }
  const start = geometry[0];
  const end = geometry[geometry.length - 1];
  const lat = (end.lat - start.lat) * 111320;
  const lng = (end.lon - start.lon) * 111320 * Math.cos(((start.lat + end.lat) / 2) * (Math.PI / 180));
  return (Math.atan2(lng, lat) * 180) / Math.PI;
}

function headingDelta(left: number, right: number): number {
  let delta = Math.abs(left - right) % 360;
  if (delta > 180) {
    delta = 360 - delta;
  }
  return delta;
}

function samplePoint(way: OSMWay): { lat: number; lon: number } | null {
  const geometry = way.geometry || [];
  if (geometry.length === 0) {
    return null;
  }
  return geometry[Math.floor(geometry.length / 2)];
}

/** Mark shorter parallel tracks as sidings for display only. */
export function classifyDisplayRails(ways: OSMWay[]): OSMWay[] {
  const rails = ways
    .map((way, index) => ({
      way,
      index,
      length: wayLengthMeters(way),
      heading: wayHeading(way),
      sample: samplePoint(way),
    }))
    .filter((item) => item.sample && isMainRailway(item.way) && !isTransitRailway(item.way));
  const grid = new Map<string, number[]>();
  const cellSize = 0.002;
  rails.forEach((item, railIndex) => {
    const sample = item.sample;
    if (!sample) {
      return;
    }
    const key = `${Math.floor(sample.lat / cellSize)}:${Math.floor(sample.lon / cellSize)}`;
    const bucket = grid.get(key) ?? [];
    bucket.push(railIndex);
    grid.set(key, bucket);
  });
  const side = new Set<number>();
  rails.forEach((item, railIndex) => {
    const sample = item.sample;
    if (!sample || item.length < 40) {
      return;
    }
    const row = Math.floor(sample.lat / cellSize);
    const col = Math.floor(sample.lon / cellSize);
    let bestLonger = 0;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
        (grid.get(`${row + rowOffset}:${col + colOffset}`) ?? []).forEach((otherIndex) => {
          if (otherIndex === railIndex) {
            return;
          }
          const other = rails[otherIndex];
          const otherSample = other.sample;
          if (!otherSample) {
            return;
          }
          const parallel =
            headingDelta(item.heading, other.heading) <= 18 ||
            headingDelta(item.heading, other.heading) >= 162;
          if (!parallel) {
            return;
          }
          const dlat = (otherSample.lat - sample.lat) * 111320;
          const dlng =
            (otherSample.lon - sample.lon) *
            111320 *
            Math.cos(((otherSample.lat + sample.lat) / 2) * (Math.PI / 180));
          if (Math.hypot(dlat, dlng) > 32) {
            return;
          }
          if (other.length > bestLonger) {
            bestLonger = other.length;
          }
        });
      }
    }
    if (bestLonger > 0 && item.length < bestLonger * 0.62) {
      side.add(item.way.id);
    }
  });
  if (side.size === 0) {
    return ways;
  }
  return ways.map((way) => {
    if (!side.has(way.id) || isSideRailwayTrack(way) || isTransitRailway(way)) {
      return way;
    }
    return {
      ...way,
      tags: { ...way.tags, service: 'siding' },
    };
  });
}

function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function perpendicularMeters(
  point: [number, number],
  start: [number, number],
  end: [number, number]
): number {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos(((start[1] + end[1]) / 2) * (Math.PI / 180));
  const ax = start[0] * lngScale;
  const ay = start[1] * latScale;
  const bx = end[0] * lngScale;
  const by = end[1] * latScale;
  const px = point[0] * lngScale;
  const py = point[1] * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function douglasPeucker(coordinates: [number, number][], epsilon: number): [number, number][] {
  if (coordinates.length <= 2 || epsilon <= 0) {
    return coordinates.slice();
  }
  let index = -1;
  let maxDistance = 0;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  for (let cursor = 1; cursor < coordinates.length - 1; cursor += 1) {
    const distance = perpendicularMeters(coordinates[cursor], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = cursor;
    }
  }
  if (maxDistance > epsilon && index > 0) {
    const left = douglasPeucker(coordinates.slice(0, index + 1), epsilon);
    const right = douglasPeucker(coordinates.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function simplifyLine(coordinates: [number, number][], toleranceMeters: number): [number, number][] {
  const simplified = douglasPeucker(coordinates, toleranceMeters).map(
    ([lng, lat]) => [roundCoord(lng), roundCoord(lat)] as [number, number]
  );
  if (simplified.length <= 400) {
    return simplified;
  }
  return douglasPeucker(simplified, toleranceMeters * 1.25).map(
    ([lng, lat]) => [roundCoord(lng), roundCoord(lat)] as [number, number]
  );
}

export function waysToLineCollection(
  ways: OSMWay[],
  kind?: RailKind,
  toleranceMeters = 0
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  ways.forEach((way) => {
    const nextKind = kind ?? railKind(way);
    const raw = (way.geometry || []).map((node) => [node.lon, node.lat] as [number, number]);
    const coordinates =
      toleranceMeters > 0
        ? simplifyLine(raw, toleranceMeters)
        : raw.map(([lng, lat]) => [roundCoord(lng), roundCoord(lat)] as [number, number]);
    if (coordinates.length < 2) {
      return;
    }
    features.push({
      type: 'Feature',
      id: way.id,
      properties: {
        id: way.id,
        kind: nextKind,
        railway: way.tags?.railway ?? 'rail',
        tunnel: 'no',
      },
      geometry: {
        type: 'LineString',
        coordinates,
      },
    });
  });
  return { type: 'FeatureCollection', features };
}

export function mergeLineCollections(
  collections: FeatureCollection<LineString>[]
): FeatureCollection<LineString> {
  if (collections.length === 0) {
    return EMPTY_COLLECTION;
  }
  if (collections.length === 1) {
    return collections[0];
  }
  const features: Feature<LineString>[] = [];
  collections.forEach((collection) => {
    if (collection.features.length > 0) {
      features.push(...collection.features);
    }
  });
  return { type: 'FeatureCollection', features };
}

export type TileBounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

function pointInTile(lat: number, lng: number, tile: TileBounds): boolean {
  return lat >= tile.minLat && lat <= tile.maxLat && lng >= tile.minLng && lng <= tile.maxLng;
}

export function insetTile(tile: TileBounds, margin: number): TileBounds | null {
  const next = {
    minLat: tile.minLat + margin,
    maxLat: tile.maxLat - margin,
    minLng: tile.minLng + margin,
    maxLng: tile.maxLng - margin,
  };
  if (next.minLat >= next.maxLat || next.minLng >= next.maxLng) {
    return null;
  }
  return next;
}

export function omitWaysInTiles(ways: OSMWay[], tiles: TileBounds[]): OSMWay[] {
  if (tiles.length === 0) {
    return ways;
  }
  return ways.filter((way) => {
    const geometry = way.geometry || [];
    return !geometry.some((node) =>
      tiles.some((tile) => pointInTile(node.lat, node.lon, tile))
    );
  });
}

function coverageCell(lat: number, lng: number, cell: number): string {
  return `${Math.round(lat / cell)}_${Math.round(lng / cell)}`;
}

function metersBetweenLatLng(
  lat: number,
  lng: number,
  otherLat: number,
  otherLng: number
): number {
  const dlat = (otherLat - lat) * 111320;
  const dlng =
    (otherLng - lng) * 111320 * Math.cos(((lat + otherLat) / 2) * (Math.PI / 180));
  return Math.hypot(dlat, dlng);
}

/** Keep simplified rails wherever detailed tiles do not actually cover them. */
export function omitWaysCoveredBy(
  ways: OSMWay[],
  coverage: OSMWay[],
  meters = 48
): OSMWay[] {
  if (coverage.length === 0) {
    return ways;
  }
  const cell = Math.max(0.00025, meters / 111320);
  const grid = new Map<string, Array<{ lat: number; lon: number }>>();
  coverage.forEach((way) => {
    (way.geometry || []).forEach((point) => {
      const key = coverageCell(point.lat, point.lon, cell);
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push({ lat: point.lat, lon: point.lon });
      } else {
        grid.set(key, [{ lat: point.lat, lon: point.lon }]);
      }
    });
  });
  const isCovered = (lat: number, lon: number) => {
    const gi = Math.round(lat / cell);
    const gj = Math.round(lon / cell);
    for (let dlat = -1; dlat <= 1; dlat += 1) {
      for (let dlng = -1; dlng <= 1; dlng += 1) {
        const bucket = grid.get(`${gi + dlat}_${gj + dlng}`);
        if (!bucket) {
          continue;
        }
        if (bucket.some((point) => metersBetweenLatLng(lat, lon, point.lat, point.lon) <= meters)) {
          return true;
        }
      }
    }
    return false;
  };
  return ways.filter((way) => {
    const geometry = way.geometry || [];
    if (geometry.length === 0) {
      return true;
    }
    let covered = 0;
    geometry.forEach((point) => {
      if (isCovered(point.lat, point.lon)) {
        covered += 1;
      }
    });
    return covered / geometry.length < 0.55;
  });
}

export function coordinatesToLine(path: Coordinate[]): FeatureCollection<LineString> {
  return pathsToLineCollection(path.length >= 2 ? [path] : []);
}

export function pathsToLineCollection(paths: Coordinate[][]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = paths
    .filter((path) => path.length >= 2)
    .map((path) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: path.map((coord) => [coord.lng, coord.lat] as [number, number]),
      },
    }));
  if (features.length === 0) {
    return EMPTY_COLLECTION as FeatureCollection<LineString>;
  }
  return { type: 'FeatureCollection', features };
}

export const TRAIN_BUBBLE_RADIUS_PX = 7;
export const TRAIN_BUBBLE_SELECTED_RADIUS_PX = 10;
export const TRAIN_BUBBLE_GAP_PX = 4;

type ScreenPoint = { x: number; y: number };
type LngLatPoint = { lng: number; lat: number };

type TrainBubblePoint = {
  id: string;
  lat: number;
  lng: number;
  selected?: boolean;
  radius?: number;
};

function bubbleRadius(
  point: TrainBubblePoint,
  radius: number,
  selectedRadius: number
): number {
  if (typeof point.radius === 'number' && Number.isFinite(point.radius)) {
    return point.radius;
  }
  return point.selected ? selectedRadius : radius;
}

function gridCellKey(x: number, y: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
}

function buildBubbleGrid(
  nodes: Array<{ x: number; y: number }>,
  cellSize: number
): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const key = gridCellKey(node.x, node.y, cellSize);
    const bucket = grid.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      grid.set(key, [index]);
    }
  });
  return grid;
}

function forEachNearbyBubblePair(
  nodes: Array<{ x: number; y: number }>,
  grid: Map<string, number[]>,
  cellSize: number,
  visit: (left: number, right: number) => void
) {
  nodes.forEach((node, left) => {
    const cx = Math.floor(node.x / cellSize);
    const cy = Math.floor(node.y / cellSize);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const bucket = grid.get(`${cx + ox},${cy + oy}`);
        if (!bucket) {
          continue;
        }
        for (let i = 0; i < bucket.length; i += 1) {
          const right = bucket[i];
          if (right <= left) {
            continue;
          }
          visit(left, right);
        }
      }
    }
  });
}

/**
 * Pack overlapping train dots like bubbles at the current zoom.
 * True positions are used as homes; only screen overlaps get pushed apart.
 */
export function spreadOverlappingTrainPoints<T extends TrainBubblePoint>(
  points: T[],
  project: (lng: number, lat: number) => ScreenPoint,
  unproject: (x: number, y: number) => LngLatPoint,
  options: {
    radius?: number;
    selectedRadius?: number;
    gap?: number;
    iterations?: number;
  } = {}
): T[] {
  if (points.length < 2) {
    return points;
  }
  const radius = options.radius ?? TRAIN_BUBBLE_RADIUS_PX;
  const selectedRadius = options.selectedRadius ?? TRAIN_BUBBLE_SELECTED_RADIUS_PX;
  const gap = options.gap ?? TRAIN_BUBBLE_GAP_PX;
  const iterations = options.iterations ?? 6;
  const nodes = points.map((point) => {
    const screen = project(point.lng, point.lat);
    const size = bubbleRadius(point, radius, selectedRadius);
    return {
      point,
      homeX: screen.x,
      homeY: screen.y,
      x: screen.x,
      y: screen.y,
      r: size,
      moved: false,
    };
  });
  const cellSize =
    nodes.reduce((max, node) => Math.max(max, node.r * 2 + gap), gap + 8);

  const parent = nodes.map((_, index) => index);
  const find = (index: number) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  const homeGrid = buildBubbleGrid(nodes, cellSize);
  forEachNearbyBubblePair(nodes, homeGrid, cellSize, (left, right) => {
    const node = nodes[left];
    const other = nodes[right];
    const dx = other.x - node.x;
    const dy = other.y - node.y;
    const minDist = node.r + other.r + gap;
    if (dx * dx + dy * dy <= minDist * minDist) {
      parent[find(right)] = find(left);
    }
  });
  const groups = new Map<number, number[]>();
  nodes.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });
  let clustered = false;
  groups.forEach((members) => {
    if (members.length < 2) {
      return;
    }
    clustered = true;
    members.sort((left, right) => nodes[left].point.id.localeCompare(nodes[right].point.id));
    members.forEach((index, slot) => {
      const angle = (Math.PI * 2 * slot) / members.length;
      nodes[index].x += Math.cos(angle) * 0.35;
      nodes[index].y += Math.sin(angle) * 0.35;
      nodes[index].moved = true;
    });
  });
  if (!clustered) {
    return points;
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const settle = iteration >= iterations - 5;
    const grid = buildBubbleGrid(nodes, cellSize);
    forEachNearbyBubblePair(nodes, grid, cellSize, (left, right) => {
      const a = nodes[left];
      const b = nodes[right];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const minDist = a.r + b.r + gap;
      if (dist < 1e-5) {
        dx = 1;
        dy = 0;
        dist = 1e-5;
      }
      if (dist >= minDist) {
        return;
      }
      const push = (minDist - dist) / 2;
      const nx = dx / dist;
      const ny = dy / dist;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      a.moved = true;
      b.moved = true;
    });
    if (settle) {
      continue;
    }
    nodes.forEach((node) => {
      if (!node.moved) {
        return;
      }
      node.x += (node.homeX - node.x) * 0.12;
      node.y += (node.homeY - node.y) * 0.12;
    });
  }

  return nodes.map((node) => {
    if (!node.moved) {
      return node.point;
    }
    const shifted = unproject(node.x, node.y);
    return { ...node.point, lat: shifted.lat, lng: shifted.lng };
  });
}

/** 3 = hubs, 2 = towns, 1 = halts. Used for modest station-name zoom rules. */
export function stationLabelRank(name: string, tripCount = 0): 1 | 2 | 3 {
  const folded = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const halt =
    /\bzastavka\b|\bodb\.?\b|\bnakladn|\bpredmestie\b|\bvyh\.|\bvyhyb|\bah /.test(folded);
  const hub =
    /\bhlavn|\bhl\.?\s*st/.test(folded) ||
    /^(bratislava|kosice|zilina|presov|trnava|nitra|banska bystrica|trencin|poprad-tatry|poprad|zvolen|martin|prievidza|komarno|nove zamky|levice|liptovsky mikulas|ruzomberok|cadca|humenne|michalovce|spisska nova ves)(\b|$)/.test(
      folded
    );
  if (hub || tripCount >= 90) {
    return 3;
  }
  if (!halt && tripCount >= 16) {
    return 2;
  }
  return 1;
}

export function pointsToCollection(
  points: Array<{
    id: string;
    lat: number;
    lng: number;
    color: string;
    selected?: boolean;
    name?: string;
    rank?: number;
  }>
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((point) => ({
      type: 'Feature',
      id: point.id,
      properties: {
        id: point.id,
        name: point.name ?? '',
        color: point.color,
        selected: Boolean(point.selected),
        rank: point.rank ?? 1,
      },
      geometry: {
        type: 'Point',
        coordinates: [point.lng, point.lat],
      },
    })),
  };
}
