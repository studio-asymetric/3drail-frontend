// Service to match trains from mapa.zsr.sk to OpenStreetMap railway routes

import type { TrainRenderState } from './trainService';
import { isPathfindingWay, type OSMWay } from './osmRailService';
import type { Coordinate } from './gtfsParser';

export interface MatchedRoute {
  trainNumber: string;
  osmWays: OSMWay[];
  confidence: number; // 0-1
  matchMethod: 'exact_ref' | 'proximity' | 'shape_similarity' | 'none';
}

/**
 * Calculate distance between two coordinates using Haversine formula
 */
export function haversineDistance(
  coord1: { lat: number; lng: number },
  coord2: { lat: number; lng: number }
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((coord2.lat - coord1.lat) * Math.PI) / 180;
  const dLng = ((coord2.lng - coord1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((coord1.lat * Math.PI) / 180) *
      Math.cos((coord2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Find minimum distance from a point to a line segment
 */
function pointToLineDistance(
  point: { lat: number; lng: number },
  lineStart: { lat: number; lng: number },
  lineEnd: { lat: number; lng: number }
): number {
  const d = haversineDistance(lineStart, lineEnd);
  if (d === 0) return haversineDistance(point, lineStart);
  
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.lat - lineStart.lat) * (lineEnd.lat - lineStart.lat) +
        (point.lng - lineStart.lng) * (lineEnd.lng - lineStart.lng)) /
        (d * d)
    )
  );
  
  const projLat = lineStart.lat + t * (lineEnd.lat - lineStart.lat);
  const projLng = lineStart.lng + t * (lineEnd.lng - lineStart.lng);
  
  return haversineDistance(point, { lat: projLat, lng: projLng });
}

const NODE_KEY_PRECISION = 5;
const NODE_GRID_METERS = 50;
const EDGE_GRID_METERS = 140;
const RELAXED_SEARCH_METERS = 250;
const ENDPOINT_BRIDGE_TOLERANCE_METERS = 420;
const TINY_BRIDGE_METERS = 8;
const MAX_DETOUR_RATIO = 10;
const MIN_PATH_LIMIT_METERS = 400;
const nodeGrid = new Map<string, Set<string>>();
const edgeGrid = new Map<string, Set<string>>();

export interface OsmGraphNode {
  key: string;
  lat: number;
  lng: number;
  neighbors: Map<string, number>;
}

export type OsmGraph = Map<string, OsmGraphNode>;

type RailAnchor = {
  lat: number;
  lng: number;
  nodes: string[];
  distance: number;
};

function metersToLat(meters: number): number {
  return meters / 111320;
}

function metersToLng(meters: number, lat: number): number {
  return meters / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
}

function formatNodeKey(lat: number, lng: number): string {
  return `${lat.toFixed(NODE_KEY_PRECISION)}:${lng.toFixed(NODE_KEY_PRECISION)}`;
}

function snapLatLng(lat: number, lng: number): { lat: number; lng: number } {
  return {
    lat: Number(lat.toFixed(NODE_KEY_PRECISION)),
    lng: Number(lng.toFixed(NODE_KEY_PRECISION)),
  };
}

function cellKey(lat: number, lng: number, meters: number): string {
  const row = Math.floor(lat / metersToLat(meters));
  const col = Math.floor(lng / metersToLng(meters, lat));
  return `${row}:${col}`;
}

function edgeId(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function registerNodeToGrid(node: OsmGraphNode): void {
  const key = cellKey(node.lat, node.lng, NODE_GRID_METERS);
  const bucket = nodeGrid.get(key) ?? new Set<string>();
  bucket.add(node.key);
  nodeGrid.set(key, bucket);
}

function registerEdgeToGrid(left: OsmGraphNode, right: OsmGraphNode): void {
  const id = edgeId(left.key, right.key);
  const length = haversineDistance(left, right);
  const steps = Math.max(1, Math.ceil(length / EDGE_GRID_METERS));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const lat = left.lat + (right.lat - left.lat) * t;
    const lng = left.lng + (right.lng - left.lng) * t;
    const key = cellKey(lat, lng, EDGE_GRID_METERS);
    const bucket = edgeGrid.get(key) ?? new Set<string>();
    bucket.add(id);
    edgeGrid.set(key, bucket);
  }
}

function getNearbyKeys(
  grid: Map<string, Set<string>>,
  lat: number,
  lng: number,
  meters: number,
  radius: number
): Set<string> {
  const center = cellKey(lat, lng, meters);
  const [centerRow, centerCol] = center.split(':').map(Number);
  const result = new Set<string>();
  for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
    for (let colOffset = -radius; colOffset <= radius; colOffset += 1) {
      const bucket = grid.get(`${centerRow + rowOffset}:${centerCol + colOffset}`);
      bucket?.forEach((value) => result.add(value));
    }
  }
  return result;
}

function projectToSegment(
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  end: { lat: number; lng: number }
): { lat: number; lng: number; t: number; distance: number } {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((point.lat * Math.PI) / 180);
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const lat = start.lat + (end.lat - start.lat) * t;
  const lng = start.lng + (end.lng - start.lng) * t;
  return {
    lat,
    lng,
    t,
    distance: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)),
  };
}

const DEFAULT_SIMPLIFY_TOLERANCE_METERS = 10;
let simplifyToleranceMeters = DEFAULT_SIMPLIFY_TOLERANCE_METERS;

export function getSimplifyToleranceMeters(): number {
  return simplifyToleranceMeters;
}

export function setSimplifyToleranceMeters(meters: number): void {
  simplifyToleranceMeters = Math.max(0, meters);
}

function pickLongitude(coord: { lng?: number; lon?: number }): number {
  return coord.lng ?? coord.lon ?? 0;
}

const DEG_TO_RAD = Math.PI / 180;

function perpendicularDistance<T extends { lat: number; lng: number }>(
  point: T,
  start: T,
  end: T
): number {
  const averageLatRad = ((start.lat + end.lat) / 2) * DEG_TO_RAD;
  const cosLat = Math.cos(averageLatRad);
  const latScale = 111132.92; // meters per degree latitude
  const lngScale = Math.abs(
    111412.84 * cosLat -
      93.5 * Math.cos(3 * averageLatRad)
  );

  const toXY = (coord: T) => ({
    x: (coord.lng - start.lng) * lngScale,
    y: (coord.lat - start.lat) * latScale,
  });

  const startXY = toXY(start);
  const endXY = toXY(end);
  const pointXY = toXY(point);

  const dx = endXY.x - startXY.x;
  const dy = endXY.y - startXY.y;
  if (dx === 0 && dy === 0) {
    const deltaX = pointXY.x - startXY.x;
    const deltaY = pointXY.y - startXY.y;
    return Math.hypot(deltaX, deltaY);
  }

  const projection =
    ((pointXY.x - startXY.x) * dx + (pointXY.y - startXY.y) * dy) /
    (dx * dx + dy * dy);
  const clampProjection = Math.max(0, Math.min(1, projection));
  const projX = startXY.x + clampProjection * dx;
  const projY = startXY.y + clampProjection * dy;
  const diffX = pointXY.x - projX;
  const diffY = pointXY.y - projY;
  return Math.hypot(diffX, diffY);
}

function douglasPeucker<T extends { lat: number; lng: number }>(
  geometry: T[],
  epsilon: number
): T[] {
  if (geometry.length <= 2 || epsilon <= 0) {
    return geometry.slice();
  }

  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  let index = -1;
  let maxDistance = 0;

  for (let i = 1; i < geometry.length - 1; i++) {
    const distance = perpendicularDistance(geometry[i], first, last);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }

  if (maxDistance > epsilon && index !== -1) {
    const left = douglasPeucker(geometry.slice(0, index + 1), epsilon);
    const right = douglasPeucker(geometry.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

export function simplifyGeometryNodes<
  T extends { lat: number; lon?: number; lng?: number }
>(geometry: T[], tolerance = simplifyToleranceMeters): T[] {
  if (!geometry || geometry.length === 0) {
    return [];
  }
  const cleanTolerance = Math.max(0, tolerance);
  if (cleanTolerance === 0 || geometry.length <= 2) {
    return geometry.slice();
  }
  const normalized = geometry.map((coord) => ({
    lat: coord.lat,
    lng: pickLongitude(coord),
  }));
  const simplified = douglasPeucker(normalized, cleanTolerance);

  const keys = simplified.map((point) => `${point.lat.toFixed(9)}:${point.lng.toFixed(9)}`);
  keys.push(
    `${geometry[0].lat.toFixed(9)}:${pickLongitude(geometry[0]).toFixed(9)}`
  );
  keys.push(
    `${geometry[geometry.length - 1].lat.toFixed(9)}:${pickLongitude(geometry[geometry.length - 1]).toFixed(9)}`
  );
  const keySet = new Set(keys);
  return geometry.filter((coord) => {
    const key = `${coord.lat.toFixed(9)}:${pickLongitude(coord).toFixed(9)}`;
    return keySet.has(key);
  });
}

export function resetSpatialIndex() {
  nodeGrid.clear();
  edgeGrid.clear();
}

export function rebuildNodeGrid(graph: OsmGraph): void {
  resetSpatialIndex();
  const seen = new Set<string>();
  graph.forEach((node) => {
    registerNodeToGrid(node);
    node.neighbors.forEach((_distance, neighborKey) => {
      const neighbor = graph.get(neighborKey);
      if (!neighbor) {
        return;
      }
      const id = edgeId(node.key, neighbor.key);
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      registerEdgeToGrid(node, neighbor);
    });
  });
}

function linkNodes(left: OsmGraphNode, right: OsmGraphNode, distance: number): void {
  if (left.key === right.key) {
    return;
  }
  const existing = left.neighbors.get(right.key);
  if (existing !== undefined && existing <= distance) {
    return;
  }
  left.neighbors.set(right.key, distance);
  right.neighbors.set(left.key, distance);
  registerEdgeToGrid(left, right);
}

function ensureGraphNode(graph: OsmGraph, lat: number, lng: number): OsmGraphNode {
  const snapped = snapLatLng(lat, lng);
  const key = formatNodeKey(snapped.lat, snapped.lng);
  let node = graph.get(key);
  if (!node) {
    node = {
      key,
      lat: snapped.lat,
      lng: snapped.lng,
      neighbors: new Map(),
    };
    graph.set(key, node);
    registerNodeToGrid(node);
  }
  return node;
}

function headingDegrees(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  const lat = (to.lat - from.lat) * 111320;
  const lng = (to.lng - from.lng) * 111320 * Math.cos(((from.lat + to.lat) / 2) * (Math.PI / 180));
  return (Math.atan2(lng, lat) * 180) / Math.PI;
}

function headingDelta(left: number, right: number): number {
  let delta = Math.abs(left - right) % 360;
  if (delta > 180) {
    delta = 360 - delta;
  }
  return delta;
}

function firstNeighbor(graph: OsmGraph, node: OsmGraphNode): OsmGraphNode | null {
  for (const key of node.neighbors.keys()) {
    const neighbor = graph.get(key);
    if (neighbor) {
      return neighbor;
    }
  }
  return null;
}

function shouldBridgeDangling(
  graph: OsmGraph,
  node: OsmGraphNode,
  other: OsmGraphNode,
  distance: number
): boolean {
  if (distance <= TINY_BRIDGE_METERS) {
    return true;
  }
  const from = firstNeighbor(graph, node);
  const toward = firstNeighbor(graph, other);
  if (!from || !toward) {
    return distance <= 80;
  }
  const outward = headingDegrees(from, node);
  const otherOut = headingDegrees(toward, other);
  const across = headingDegrees(node, other);
  const sideways = headingDelta(outward, across) > 48 && headingDelta(outward, across) < 132;
  const parallel =
    headingDelta(outward, otherOut) <= 32 || headingDelta(outward, otherOut) >= 148;
  if (sideways && parallel) {
    return false;
  }
  const continuation = headingDelta(outward, otherOut) >= 120;
  const along = headingDelta(outward, across) <= 48 || headingDelta(outward, across) >= 132;
  return continuation || along;
}

function bridgeDanglingEnds(graph: OsmGraph): void {
  const dangling: OsmGraphNode[] = [];
  graph.forEach((node) => {
    if (node.neighbors.size <= 1) {
      dangling.push(node);
    }
  });
  const radius = Math.max(2, Math.ceil(ENDPOINT_BRIDGE_TOLERANCE_METERS / NODE_GRID_METERS));
  dangling.forEach((node) => {
    const nearby = getNearbyKeys(nodeGrid, node.lat, node.lng, NODE_GRID_METERS, radius);
    let best: OsmGraphNode | null = null;
    let bestDistance = ENDPOINT_BRIDGE_TOLERANCE_METERS;
    nearby.forEach((key) => {
      if (key === node.key || node.neighbors.has(key)) {
        return;
      }
      const other = graph.get(key);
      if (!other) {
        return;
      }
      const distance = haversineDistance(node, other);
      if (distance >= bestDistance) {
        return;
      }
      if (other.neighbors.size > 2 && node.neighbors.size > 1) {
        return;
      }
      if (!shouldBridgeDangling(graph, node, other, distance)) {
        return;
      }
      best = other;
      bestDistance = distance;
    });
    const match: OsmGraphNode | null = best;
    if (match) {
      linkNodes(node, match, bestDistance);
    }
  });
}

export function extendOsmGraph(graph: OsmGraph, ways: OSMWay[]): void {
  const lines = ways.filter(isPathfindingWay).map((way) =>
    (way.geometry || []).map((node) => ({ lat: node.lat, lng: node.lon }))
  );
  lines.forEach((line) => {
    if (line.length < 2) {
      return;
    }
    for (let i = 0; i < line.length - 1; i++) {
      const start = line[i];
      const end = line[i + 1];
      const startNode = ensureGraphNode(graph, start.lat, start.lng);
      const endNode = ensureGraphNode(graph, end.lat, end.lng);
      linkNodes(startNode, endNode, haversineDistance(start, end));
    }
  });
  bridgeDanglingEnds(graph);
}

function edgeAlignment(
  point: { lat: number; lng: number },
  toward: { lat: number; lng: number } | undefined,
  left: { lat: number; lng: number },
  right: { lat: number; lng: number }
): number {
  if (!toward) {
    return 0;
  }
  const hx = toward.lng - point.lng;
  const hy = toward.lat - point.lat;
  const ex = right.lng - left.lng;
  const ey = right.lat - left.lat;
  const hop = Math.hypot(hx, hy);
  const edge = Math.hypot(ex, ey);
  if (hop === 0 || edge === 0) {
    return 0;
  }
  return Math.abs((hx * ex + hy * ey) / (hop * edge));
}

function findNearestRailAnchor(
  graph: OsmGraph,
  point: { lat: number; lng: number },
  maxDistanceMeters = 5000,
  toward?: { lat: number; lng: number }
): RailAnchor | null {
  if (graph.size === 0) {
    return null;
  }
  const radius = Math.max(1, Math.ceil(maxDistanceMeters / EDGE_GRID_METERS));
  const edgeIds = getNearbyKeys(edgeGrid, point.lat, point.lng, EDGE_GRID_METERS, radius);
  const candidates: Array<RailAnchor & { score: number }> = [];
  edgeIds.forEach((id) => {
    const [leftKey, rightKey] = id.split('|');
    const left = graph.get(leftKey);
    const right = graph.get(rightKey);
    if (!left || !right) {
      return;
    }
    const projected = projectToSegment(point, left, right);
    if (projected.distance > maxDistanceMeters) {
      return;
    }
    const atVertex = projected.t <= 0.02 || projected.t >= 0.98;
    const alignment = edgeAlignment(point, toward, left, right);
    candidates.push({
      lat: projected.lat,
      lng: projected.lng,
      distance: projected.distance,
      nodes: atVertex ? [projected.t < 0.5 ? left.key : right.key] : [left.key, right.key],
      score: projected.distance - alignment * 90,
    });
  });
  if (candidates.length > 0) {
    const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
    const slack = Math.max(70, nearest * 1.8);
    let best = candidates[0];
    candidates.forEach((candidate) => {
      if (candidate.distance > slack) {
        return;
      }
      if (candidate.score < best.score) {
        best = candidate;
      }
    });
    return { lat: best.lat, lng: best.lng, distance: best.distance, nodes: best.nodes };
  }
  const nodeKeys = getNearbyKeys(
    nodeGrid,
    point.lat,
    point.lng,
    NODE_GRID_METERS,
    Math.max(1, Math.ceil(maxDistanceMeters / NODE_GRID_METERS))
  );
  let bestNode: RailAnchor | null = null;
  nodeKeys.forEach((key) => {
    const node = graph.get(key);
    if (!node) {
      return;
    }
    const distance = haversineDistance(point, node);
    if (distance > maxDistanceMeters || (bestNode && distance >= bestNode.distance)) {
      return;
    }
    bestNode = { lat: node.lat, lng: node.lng, distance, nodes: [node.key] };
  });
  return bestNode;
}

export function findNearestGraphNode(
  graph: OsmGraph,
  point: { lat: number; lng: number },
  maxDistanceMeters = 5000
): string | null {
  const anchor = findNearestRailAnchor(graph, point, maxDistanceMeters);
  return anchor?.nodes[0] ?? null;
}

function pushHeap(heap: Array<{ key: string; distance: number }>, item: { key: string; distance: number }) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].distance <= heap[index].distance) {
      break;
    }
    const swap = heap[parent];
    heap[parent] = heap[index];
    heap[index] = swap;
    index = parent;
  }
}

function popHeap(heap: Array<{ key: string; distance: number }>) {
  const top = heap[0];
  const last = heap.pop();
  if (!last || heap.length === 0) {
    return top;
  }
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && heap[left].distance < heap[smallest].distance) {
      smallest = left;
    }
    if (right < heap.length && heap[right].distance < heap[smallest].distance) {
      smallest = right;
    }
    if (smallest === index) {
      break;
    }
    const swap = heap[index];
    heap[index] = heap[smallest];
    heap[smallest] = swap;
    index = smallest;
  }
  return top;
}

function shortestKeys(
  graph: OsmGraph,
  startKey: string,
  endKey: string,
  limitMeters: number
): { keys: string[]; cost: number } | null {
  if (startKey === endKey) {
    return { keys: [startKey], cost: 0 };
  }
  const distanceByKey = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, string>();
  const heap: Array<{ key: string; distance: number }> = [{ key: startKey, distance: 0 }];
  while (heap.length > 0) {
    const current = popHeap(heap);
    if (!current) {
      break;
    }
    if (current.distance !== distanceByKey.get(current.key)) {
      continue;
    }
    if (current.key === endKey) {
      break;
    }
    if (current.distance > limitMeters) {
      continue;
    }
    const node = graph.get(current.key);
    if (!node) {
      continue;
    }
    node.neighbors.forEach((edgeDistance, neighborKey) => {
      const nextDistance = current.distance + edgeDistance;
      if (nextDistance >= (distanceByKey.get(neighborKey) ?? Infinity) || nextDistance > limitMeters) {
        return;
      }
      distanceByKey.set(neighborKey, nextDistance);
      previous.set(neighborKey, current.key);
      pushHeap(heap, { key: neighborKey, distance: nextDistance });
    });
  }
  const cost = distanceByKey.get(endKey);
  if (cost === undefined) {
    return null;
  }
  const keys: string[] = [];
  let cursor: string | undefined = endKey;
  while (cursor) {
    keys.push(cursor);
    if (cursor === startKey) {
      break;
    }
    cursor = previous.get(cursor);
  }
  if (keys[keys.length - 1] !== startKey) {
    return null;
  }
  keys.reverse();
  return { keys, cost };
}

function sharesRailEdge(start: RailAnchor, end: RailAnchor): boolean {
  if (start.nodes.length === 1 && end.nodes.length === 1) {
    return start.nodes[0] === end.nodes[0];
  }
  const startSet = new Set(start.nodes);
  return end.nodes.some((key) => startSet.has(key)) && (
    start.nodes.length + end.nodes.length <= 3 ||
    end.nodes.every((key) => startSet.has(key))
  );
}

function pathBetweenAnchors(
  graph: OsmGraph,
  start: RailAnchor,
  end: RailAnchor,
  limitMeters: number
): Coordinate[] | null {
  if (sharesRailEdge(start, end)) {
    if (start.lat === end.lat && start.lng === end.lng) {
      return [{ lat: start.lat, lng: start.lng, sequence: 1 }];
    }
    return [
      { lat: start.lat, lng: start.lng, sequence: 1 },
      { lat: end.lat, lng: end.lng, sequence: 2 },
    ];
  }

  const endKeys = new Set(end.nodes);
  const distanceByKey = new Map<string, number>();
  const previous = new Map<string, string | null>();
  const heap: Array<{ key: string; distance: number }> = [];
  start.nodes.forEach((key) => {
    const node = graph.get(key);
    if (!node) {
      return;
    }
    const distance = haversineDistance(start, node);
    if (distance > limitMeters) {
      return;
    }
    distanceByKey.set(key, distance);
    previous.set(key, null);
    pushHeap(heap, { key, distance });
  });

  let bestEndKey: string | null = null;
  let bestCost = Infinity;
  while (heap.length > 0) {
    const current = popHeap(heap);
    if (!current) {
      break;
    }
    if (current.distance !== distanceByKey.get(current.key)) {
      continue;
    }
    if (current.distance > limitMeters || current.distance > bestCost) {
      continue;
    }
    if (endKeys.has(current.key)) {
      const endNode = graph.get(current.key);
      if (endNode) {
        const cost = current.distance + haversineDistance(end, endNode);
        if (cost < bestCost) {
          bestCost = cost;
          bestEndKey = current.key;
        }
      }
    }
    const node = graph.get(current.key);
    if (!node) {
      continue;
    }
    node.neighbors.forEach((edgeDistance, neighborKey) => {
      const nextDistance = current.distance + edgeDistance;
      if (nextDistance >= (distanceByKey.get(neighborKey) ?? Infinity) || nextDistance > limitMeters) {
        return;
      }
      distanceByKey.set(neighborKey, nextDistance);
      previous.set(neighborKey, current.key);
      pushHeap(heap, { key: neighborKey, distance: nextDistance });
    });
  }

  if (!bestEndKey) {
    return null;
  }
  const keys: string[] = [];
  let cursor: string | null | undefined = bestEndKey;
  while (cursor) {
    keys.push(cursor);
    cursor = previous.get(cursor);
  }
  keys.reverse();
  const path: Coordinate[] = [{ lat: start.lat, lng: start.lng, sequence: 1 }];
  keys.forEach((key) => appendNode(path, graph, key));
  const last = path[path.length - 1];
  if (!last || last.lat !== end.lat || last.lng !== end.lng) {
    path.push({ lat: end.lat, lng: end.lng, sequence: path.length + 1 });
  }
  return path.length >= 2 ? path : null;
}

function appendNode(path: Coordinate[], graph: OsmGraph, key: string) {
  const node = graph.get(key);
  if (!node) {
    return;
  }
  const last = path[path.length - 1];
  if (last && last.lat === node.lat && last.lng === node.lng) {
    return;
  }
  path.push({ lat: node.lat, lng: node.lng, sequence: path.length + 1 });
}

function pathLengthMeters(path: Coordinate[]): number {
  let length = 0;
  for (let index = 1; index < path.length; index += 1) {
    length += haversineDistance(path[index - 1], path[index]);
  }
  return length;
}

function maxPathMeters(straight: number): number {
  return Math.max(straight * MAX_DETOUR_RATIO, MIN_PATH_LIMIT_METERS);
}

function straightJump(start: Coordinate, end: Coordinate): Coordinate[] {
  return [
    { lat: start.lat, lng: start.lng, sequence: 1 },
    { lat: end.lat, lng: end.lng, sequence: 2 },
  ];
}

function isReasonableHop(path: Coordinate[] | null, limitMeters: number): path is Coordinate[] {
  return !!path && path.length >= 2 && pathLengthMeters(path) <= limitMeters;
}

function appendHop(segment: Coordinate[], hop: Coordinate[]): void {
  hop.forEach((point) => {
    const last = segment[segment.length - 1];
    if (last && last.lat === point.lat && last.lng === point.lng) {
      return;
    }
    segment.push({ ...point, sequence: segment.length + 1 });
  });
}

function sliceFallbackLine(
  line: Coordinate[] | undefined,
  start: Coordinate,
  end: Coordinate
): Coordinate[] | null {
  if (!line || line.length < 2) {
    return null;
  }
  let startIndex = 0;
  let endIndex = 0;
  let startDistance = Infinity;
  let endDistance = Infinity;
  line.forEach((point, index) => {
    const fromStart = haversineDistance(point, start);
    const fromEnd = haversineDistance(point, end);
    if (fromStart < startDistance) {
      startDistance = fromStart;
      startIndex = index;
    }
    if (fromEnd < endDistance) {
      endDistance = fromEnd;
      endIndex = index;
    }
  });
  if (startDistance > 8000 || endDistance > 8000 || startIndex === endIndex) {
    return null;
  }
  const forward = startIndex < endIndex;
  const from = forward ? startIndex : endIndex;
  const to = forward ? endIndex : startIndex;
  const slice = line.slice(from, to + 1);
  if (!forward) {
    slice.reverse();
  }
  const hop: Coordinate[] = [{ lat: start.lat, lng: start.lng, sequence: 1 }];
  slice.forEach((point) => {
    const last = hop[hop.length - 1];
    if (last && last.lat === point.lat && last.lng === point.lng) {
      return;
    }
    hop.push({ lat: point.lat, lng: point.lng, sequence: hop.length + 1 });
  });
  const last = hop[hop.length - 1];
  if (!last || last.lat !== end.lat || last.lng !== end.lng) {
    hop.push({ lat: end.lat, lng: end.lng, sequence: hop.length + 1 });
  }
  return hop.length >= 2 ? hop : null;
}

function hopAlongRails(
  graph: OsmGraph,
  start: Coordinate,
  end: Coordinate,
  fallbackLine?: Coordinate[]
): Coordinate[] | null {
  const straight = haversineDistance(start, end);
  const limit = maxPathMeters(straight);
  const reach = Math.max(2500, Math.min(12000, straight * 0.4 + 1000));
  const startAnchor = findNearestRailAnchor(graph, start, reach, end);
  const endAnchor = findNearestRailAnchor(graph, end, reach, start);
  if (startAnchor && endAnchor) {
    const hop = pathBetweenAnchors(graph, startAnchor, endAnchor, limit);
    if (isReasonableHop(hop, limit)) {
      return hop;
    }
  }
  const fallback = sliceFallbackLine(fallbackLine, start, end);
  if (isReasonableHop(fallback, limit)) {
    return fallback;
  }
  return straightJump(start, end);
}

/** Follow the simplified rail graph through a train's waypoints. */
export function traceWaypointSegments(
  graph: OsmGraph,
  waypoints: Coordinate[],
  fallbackLine?: Coordinate[]
): Coordinate[][] {
  if (graph.size === 0 || waypoints.length < 2) {
    return [];
  }
  const segments: Coordinate[][] = [];
  let current: Coordinate[] = [];
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    const hop = hopAlongRails(graph, waypoints[index], waypoints[index + 1], fallbackLine);
    if (!hop) {
      if (current.length >= 2) {
        segments.push(current);
      }
      current = [];
      continue;
    }
    if (current.length === 0) {
      current = hop.map((point, sequence) => ({ ...point, sequence: sequence + 1 }));
      continue;
    }
    appendHop(current, hop);
  }
  if (current.length >= 2) {
    segments.push(current);
  }
  return mergeNearbySegments(segments);
}

function mergeNearbySegments(segments: Coordinate[][]): Coordinate[][] {
  if (segments.length < 2) {
    return segments;
  }
  const merged: Coordinate[][] = [segments[0].slice()];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = merged[merged.length - 1];
    const next = segments[index];
    const gap = haversineDistance(previous[previous.length - 1], next[0]);
    if (gap <= 800) {
      appendHop(previous, next);
      continue;
    }
    merged.push(next.slice());
  }
  return merged;
}

export function traceWaypoints(
  graph: OsmGraph,
  waypoints: Coordinate[],
  fallbackLine?: Coordinate[]
): Coordinate[] {
  return traceWaypointSegments(graph, waypoints, fallbackLine)[0] ?? [];
}

export interface LatLngBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  margin?: number;
}

export interface OsmPathResult {
  path: Coordinate[];
  paths?: Coordinate[][];
  reason?: string;
}

function expandBounds(bounds: LatLngBounds, slackMeters: number): LatLngBounds {
  const marginLat = slackMeters / 111000;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const lngScale = 111000 * Math.cos(centerLat * Math.PI / 180);
  const marginLng =
    lngScale === 0 ? slackMeters / 111000 : slackMeters / lngScale;
  return {
    minLat: bounds.minLat - marginLat,
    maxLat: bounds.maxLat + marginLat,
    minLng: bounds.minLng - marginLng,
    maxLng: bounds.maxLng + marginLng,
    margin: Math.max(bounds.margin ?? 0, marginLat),
  };
}

function tryRelaxedPath(
  graph: OsmGraph,
  startPoint: Coordinate,
  endPoint: Coordinate,
  latLngBounds: LatLngBounds | undefined,
  maxSearchDistance: number,
  reason: string
): OsmPathResult {
  const relaxedBounds = latLngBounds
    ? expandBounds(latLngBounds, RELAXED_SEARCH_METERS)
    : undefined;
  const result = findOsmPath(
    graph,
    startPoint,
    endPoint,
    relaxedBounds,
    maxSearchDistance + RELAXED_SEARCH_METERS,
    false
  );
  if (result.path.length > 0) {
    return {
      path: result.path,
      reason: `relaxed_${result.reason ?? reason}`,
    };
  }
  return { path: [], reason };
}

function alignToNode(
  graph: OsmGraph,
  key: string | null,
  fallback: Coordinate
): Coordinate {
  if (!key) {
    return fallback;
  }
  const node = graph.get(key);
  if (!node) {
    return fallback;
  }
  return {
    lat: node.lat,
    lng: node.lng,
    sequence: fallback.sequence ?? 0,
  };
}

export function findOsmPath(
  graph: OsmGraph,
  startPoint: Coordinate,
  endPoint: Coordinate,
  latLngBounds?: LatLngBounds,
  maxSearchDistance = 5000,
  allowRelaxed = true
): OsmPathResult {
  const startAnchor = findNearestRailAnchor(
    graph,
    { lat: startPoint.lat, lng: startPoint.lng },
    maxSearchDistance
  );
  const endAnchor = findNearestRailAnchor(
    graph,
    { lat: endPoint.lat, lng: endPoint.lng },
    maxSearchDistance
  );
  const startKey = startAnchor?.nodes[0] ?? null;
  const endKey = endAnchor?.nodes[0] ?? null;
  const alignedStart = startAnchor
    ? { lat: startAnchor.lat, lng: startAnchor.lng, sequence: startPoint.sequence ?? 0 }
    : alignToNode(graph, startKey, startPoint);
  const alignedEnd = endAnchor
    ? { lat: endAnchor.lat, lng: endAnchor.lng, sequence: endPoint.sequence ?? 0 }
    : alignToNode(graph, endKey, endPoint);
  const effectiveStart = alignedStart;
  const effectiveEnd = alignedEnd;
  if (!startAnchor || !endAnchor || !startKey || !endKey) {
    if (!allowRelaxed) {
      if (!startKey && !endKey) {
        return { path: [], reason: 'start_and_end_not_found' };
      }
      if (!startKey) {
        return { path: [], reason: 'start_not_found' };
      }
      return { path: [], reason: 'end_not_found' };
    }
    if (!startKey && !endKey) {
      return tryRelaxedPath(
        graph,
        startPoint,
        endPoint,
        latLngBounds,
        maxSearchDistance,
        'start_and_end_not_found'
      );
    }
    if (!startKey) {
      return tryRelaxedPath(
        graph,
        startPoint,
        endPoint,
        latLngBounds,
        maxSearchDistance,
        'start_not_found'
      );
    }
    return tryRelaxedPath(
      graph,
      startPoint,
      endPoint,
      latLngBounds,
      maxSearchDistance,
      'end_not_found'
    );
  }

  const span = haversineDistance(effectiveStart, effectiveEnd);
  const limitMeters = maxPathMeters(span);
  const routed = pathBetweenAnchors(graph, startAnchor, endAnchor, limitMeters);
  if (!routed || !isReasonableHop(routed, limitMeters)) {
    if (!allowRelaxed) {
      return { path: [], reason: 'no_route_found' };
    }
    return tryRelaxedPath(
      graph,
      startPoint,
      endPoint,
      latLngBounds,
      maxSearchDistance,
      'no_route_found'
    );
  }

  return {
    path: routed,
  };
}

/**
 * Calculate shape similarity between two routes
 */
function calculateShapeSimilarity(
  route1: Coordinate[],
  route2: Array<[number, number]>
): number {
  if (route1.length === 0 || route2.length === 0) return 0;
  
  let totalDistance = 0;
  let matchedPoints = 0;
  
  // For each point in route1, find closest point in route2
  for (const point1 of route1) {
    let minDist = Infinity;
    for (const point2 of route2) {
      const dist = haversineDistance(
        { lat: point1.lat, lng: point1.lng },
        { lat: point2[0], lng: point2[1] }
      );
      minDist = Math.min(minDist, dist);
    }
    
    if (minDist < 500) { // Within 500m
      matchedPoints++;
      totalDistance += minDist;
    }
  }
  
  if (matchedPoints === 0) return 0;
  
  const avgDistance = totalDistance / matchedPoints;
  // Similarity score: 1.0 if avg distance is 0, decreases as distance increases
  return Math.max(0, 1 - avgDistance / 1000);
}

/**
 * Match a train to OSM railway routes using multiple strategies
 */
export function matchTrainToOSMRoute(
  train: TrainRenderState,
  osmWays: OSMWay[]
): MatchedRoute | null {
  // Strategy 1: Match by train number in OSM ref tag (exact match)
  const exactMatches = osmWays.filter(way => 
    way.tags.ref === train.trainNumber || 
    way.tags.ref === train.trainNumber.replace(/^0+/, '') // Remove leading zeros
  );
  
  if (exactMatches.length > 0) {
    return {
      trainNumber: train.trainNumber,
      osmWays: exactMatches,
      confidence: 1.0,
      matchMethod: 'exact_ref',
    };
  }
  
  // Strategy 2: Match by proximity to train's current position
  if (train.position) {
    const proximityThreshold = 2000; // 2km
    const nearbyWays: Array<{ way: OSMWay; distance: number }> = [];
    
    for (const way of osmWays) {
      if (!way.geometry || way.geometry.length === 0) continue;
      
      let minDistance = Infinity;
      for (let i = 0; i < way.geometry.length - 1; i++) {
        const dist = pointToLineDistance(
          { lat: train.position.lat, lng: train.position.lng },
          { lat: way.geometry[i].lat, lng: way.geometry[i].lon },
          { lat: way.geometry[i + 1].lat, lng: way.geometry[i + 1].lon }
        );
        minDistance = Math.min(minDistance, dist);
      }
      
      if (minDistance < proximityThreshold) {
        nearbyWays.push({ way, distance: minDistance });
      }
    }
    
    if (nearbyWays.length > 0) {
      // Sort by distance and take closest
      nearbyWays.sort((a, b) => a.distance - b.distance);
      const confidence = Math.max(0.5, 1 - nearbyWays[0].distance / proximityThreshold);
      
      return {
        trainNumber: train.trainNumber,
        osmWays: nearbyWays.slice(0, 5).map(n => n.way), // Top 5 closest
        confidence,
        matchMethod: 'proximity',
      };
    }
  }
  
  // Strategy 3: Match by route shape similarity
  if (train.shapePath && train.shapePath.length > 0) {
    const similarWays: Array<{ way: OSMWay; similarity: number }> = [];
    
    for (const way of osmWays) {
      if (!way.geometry || way.geometry.length < 2) continue;
      
      const wayCoords = way.geometry.map(n => [n.lat, n.lon] as [number, number]);
      const similarity = calculateShapeSimilarity(train.shapePath, wayCoords);
      
      if (similarity > 0.3) { // At least 30% similarity
        similarWays.push({ way, similarity });
      }
    }
    
    if (similarWays.length > 0) {
      // Sort by similarity and take best matches
      similarWays.sort((a, b) => b.similarity - a.similarity);
      
      return {
        trainNumber: train.trainNumber,
        osmWays: similarWays.slice(0, 3).map(s => s.way), // Top 3 most similar
        confidence: similarWays[0].similarity,
        matchMethod: 'shape_similarity',
      };
    }
  }
  
  return {
    trainNumber: train.trainNumber,
    osmWays: [],
    confidence: 0,
    matchMethod: 'none',
  };
}

/**
 * Match all trains to OSM routes
 */
export function matchAllTrainsToOSM(
  trains: TrainRenderState[],
  osmWays: OSMWay[]
): Map<string, MatchedRoute> {
  const matches = new Map<string, MatchedRoute>();
  
  for (const train of trains) {
    const match = matchTrainToOSMRoute(train, osmWays);
    if (match) {
      matches.set(train.trainNumber, match);
    }
  }
  
  return matches;
}

