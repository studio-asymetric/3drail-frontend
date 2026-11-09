// Service to match trains from mapa.zsr.sk to OpenStreetMap railway routes

import type { TrainRenderState } from './trainService';
import type { OSMWay } from './osmRailService';
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

const NODE_KEY_PRECISION = 6;
const NODE_SNAP_TOLERANCE_METERS = 20;
const RELAXED_SEARCH_METERS = 100;
const ENDPOINT_BRIDGE_TOLERANCE_METERS = 60;
const NODE_GRID_LAT_DEG = NODE_SNAP_TOLERANCE_METERS / 111000;
const NODE_GRID_LNG_DEG = NODE_GRID_LAT_DEG;
const BRIDGE_TOLERANCE_METERS = 25;
const nodeGrid = new Map<string, Set<string>>();

function formatNodeKey(lat: number, lng: number): string {
  return `${lat.toFixed(NODE_KEY_PRECISION)}:${lng.toFixed(NODE_KEY_PRECISION)}`;
}

function snapLatLng(lat: number, lng: number): { lat: number; lng: number } {
  const latDelta = NODE_SNAP_TOLERANCE_METERS / 111000;
  const snappedLat = Math.round(lat / latDelta) * latDelta;
  const averageLatRad = snappedLat * Math.PI / 180;
  const lngScale = Math.abs(
    111412.84 * Math.cos(averageLatRad) -
      93.5 * Math.cos(3 * averageLatRad)
  );
  const lngDelta =
    lngScale === 0 ? NODE_SNAP_TOLERANCE_METERS / 111000 : NODE_SNAP_TOLERANCE_METERS / lngScale;
  const snappedLng = Math.round(lng / lngDelta) * lngDelta;
  return { lat: snappedLat, lng: snappedLng };
}

function cellKey(lat: number, lng: number): string {
  const row = Math.floor(lat / NODE_GRID_LAT_DEG);
  const col = Math.floor(lng / NODE_GRID_LNG_DEG);
  return `${row}:${col}`;
}

function registerNodeToGrid(node: OsmGraphNode): void {
  const key = cellKey(node.lat, node.lng);
  if (!nodeGrid.has(key)) {
    nodeGrid.set(key, new Set());
  }
  nodeGrid.get(key)!.add(node.key);
}

function getNearbyNodeKeys(lat: number, lng: number): Set<string> {
  const centerRow = Math.floor(lat / NODE_GRID_LAT_DEG);
  const centerCol = Math.floor(lng / NODE_GRID_LNG_DEG);
  const result = new Set<string>();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const key = `${centerRow + dr}:${centerCol + dc}`;
      const set = nodeGrid.get(key);
      if (set) {
        set.forEach((nodeKey) => result.add(nodeKey));
      }
    }
  }
  return result;
}

function connectNearbyNodes(graph: OsmGraph, node: OsmGraphNode): void {
  const neighbors = getNearbyNodeKeys(node.lat, node.lng);
  neighbors.forEach((neighborKey) => {
    if (neighborKey === node.key) {
      return;
    }
    const neighbor = graph.get(neighborKey);
    if (!neighbor) return;
    const distance = haversineDistance(
      { lat: node.lat, lng: node.lng },
      { lat: neighbor.lat, lng: neighbor.lng }
    );
    if (distance <= BRIDGE_TOLERANCE_METERS) {
      node.neighbors.set(neighbor.key, distance);
      neighbor.neighbors.set(node.key, distance);
    }
  });
}

function ensureEndpointBridge(graph: OsmGraph, node: OsmGraphNode): void {
  const neighbors = getNearbyNodeKeys(node.lat, node.lng);
  neighbors.forEach((neighborKey) => {
    if (neighborKey === node.key) {
      return;
    }
    const neighbor = graph.get(neighborKey);
    if (!neighbor) return;
    const distance = haversineDistance(
      { lat: node.lat, lng: node.lng },
      { lat: neighbor.lat, lng: neighbor.lng }
    );
    if (distance <= ENDPOINT_BRIDGE_TOLERANCE_METERS) {
      node.neighbors.set(neighbor.key, distance);
      neighbor.neighbors.set(node.key, distance);
    }
  });
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

export interface OsmGraphNode {
  key: string;
  lat: number;
  lng: number;
  neighbors: Map<string, number>;
}

export type OsmGraph = Map<string, OsmGraphNode>;

export function resetSpatialIndex() {
  nodeGrid.clear();
}

export function rebuildNodeGrid(graph: OsmGraph): void {
  resetSpatialIndex();
  graph.forEach((node) => registerNodeToGrid(node));
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
    connectNearbyNodes(graph, node);
  }
  return node;
}

export function extendOsmGraph(graph: OsmGraph, ways: OSMWay[]): void {
  const lines = ways.map((way) =>
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
      const segmentDistance = haversineDistance(start, end);
      startNode.neighbors.set(endNode.key, segmentDistance);
      endNode.neighbors.set(startNode.key, segmentDistance);
    }
    ensureEndpointBridge(graph, ensureGraphNode(graph, line[0].lat, line[0].lng));
    ensureEndpointBridge(
      graph,
      ensureGraphNode(graph, line[line.length - 1].lat, line[line.length - 1].lng)
    );
  });
}

export function findNearestGraphNode(
  graph: OsmGraph,
  point: { lat: number; lng: number },
  maxDistanceMeters = 5000
): string | null {
  if (graph.size === 0) return null;
  const cellMeters = NODE_SNAP_TOLERANCE_METERS;
  const radius = Math.max(1, Math.ceil(maxDistanceMeters / cellMeters));
  const centerRow = Math.floor(point.lat / NODE_GRID_LAT_DEG);
  const centerCol = Math.floor(point.lng / NODE_GRID_LNG_DEG);
  let bestKey: string | null = null;
  let bestDistance = maxDistanceMeters;
  for (let ring = 0; ring <= radius; ring += 1) {
    if (bestKey && ring * cellMeters > bestDistance) {
      break;
    }
    for (let rowOffset = -ring; rowOffset <= ring; rowOffset += 1) {
      for (let colOffset = -ring; colOffset <= ring; colOffset += 1) {
        if (ring > 0 && Math.abs(rowOffset) !== ring && Math.abs(colOffset) !== ring) {
          continue;
        }
        const bucket = nodeGrid.get(`${centerRow + rowOffset}:${centerCol + colOffset}`);
        if (!bucket) {
          continue;
        }
        bucket.forEach((nodeKey) => {
          const node = graph.get(nodeKey);
          if (!node) {
            return;
          }
          const distance = haversineDistance(point, { lat: node.lat, lng: node.lng });
          if (distance < bestDistance) {
            bestDistance = distance;
            bestKey = nodeKey;
          }
        });
      }
    }
  }
  return bestKey;
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

function shortestKeys(graph: OsmGraph, startKey: string, endKey: string, limitMeters: number): string[] | null {
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
      return null;
    }
    const node = graph.get(current.key);
    if (!node) {
      continue;
    }
    node.neighbors.forEach((edgeDistance, neighborKey) => {
      const nextDistance = current.distance + edgeDistance;
      if (nextDistance >= (distanceByKey.get(neighborKey) ?? Infinity)) {
        return;
      }
      distanceByKey.set(neighborKey, nextDistance);
      previous.set(neighborKey, current.key);
      pushHeap(heap, { key: neighborKey, distance: nextDistance });
    });
  }
  if ((distanceByKey.get(endKey) ?? Infinity) === Infinity) {
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
  return keys;
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

/** Follow the simplified rail graph through a train's waypoints. */
export function traceWaypoints(graph: OsmGraph, waypoints: Coordinate[]): Coordinate[] {
  if (graph.size === 0 || waypoints.length < 2) {
    return [];
  }
  const path: Coordinate[] = [];
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    const start = waypoints[index];
    const end = waypoints[index + 1];
    const straight = haversineDistance(start, end);
    const reach = Math.max(4000, straight);
    const startKey = findNearestGraphNode(graph, start, reach);
    const endKey = findNearestGraphNode(graph, end, reach);
    if (!startKey || !endKey) {
      path.push(start, end);
      continue;
    }
    if (startKey === endKey) {
      appendNode(path, graph, startKey);
      continue;
    }
    const keys = shortestKeys(graph, startKey, endKey, Math.max(straight * 4.5, 12000));
    if (!keys) {
      path.push(start, end);
      continue;
    }
    keys.forEach((key) => appendNode(path, graph, key));
  }
  return path;
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
  const startKey = findNearestGraphNode(
    graph,
    { lat: startPoint.lat, lng: startPoint.lng },
    maxSearchDistance
  );
  const endKey = findNearestGraphNode(
    graph,
    { lat: endPoint.lat, lng: endPoint.lng },
    maxSearchDistance
  );
  const alignedStart = alignToNode(graph, startKey, startPoint);
  const alignedEnd = alignToNode(graph, endKey, endPoint);
  const effectiveStart = alignedStart;
  const effectiveEnd = alignedEnd;
  if (!startKey || !endKey) {
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
  const limitMeters = Math.max(span * 8, maxSearchDistance * 8, 25000);
  const pathKeys = shortestKeys(graph, startKey, endKey, limitMeters);
  if (!pathKeys) {
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
    path: pathKeys.map((key) => {
      const node = graph.get(key)!;
      return { lat: node.lat, lng: node.lng, sequence: 0 };
    }),
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

