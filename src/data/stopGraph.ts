import type { GtfsDataset } from './gtfsParser';

const LATITUDE_METERS = 111000;
const LONGITUDE_METERS = 72000;
const SNAPPED_ANGLE_INCREMENT = 45;
const DEGREE_FULL_CIRCLE = 360;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export interface StopGraphNode {
  stopId: string;
  lat: number;
  lng: number;
  snappedAngle?: number;
  averageAngle?: number;
  snappedVector?: { x: number; y: number };
}

export interface StopGraphEdge {
  from: string;
  to: string;
  distanceMeters: number;
  direction: { x: number; y: number };
}

export interface StopGraph {
  nodes: Record<string, StopGraphNode>;
  edges: StopGraphEdge[];
  canonicalRoutes?: Record<string, [number, number][]>;
}

type DirectionAccumulator = {
  sumX: number;
  sumY: number;
  count: number;
};

export interface ProxyTrack {
  Key?: string;
  Value?: [number, number][];
}

export interface ProxyTrainEntry {
  Trasa?: ProxyTrack[];
  CisloVlaku?: string;
}

export interface ProxyCache {
  data?: ProxyTrainEntry[];
}

function normalizeVector(dx: number, dy: number) {
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  return { x: dx / length, y: dy / length };
}

function snapToIncrement(angle: number, increment: number) {
  const snapped = Math.round(angle / increment) * increment;
  return ((snapped % DEGREE_FULL_CIRCLE) + DEGREE_FULL_CIRCLE) % DEGREE_FULL_CIRCLE;
}

function toDegrees(dx: number, dy: number) {
  const degrees = Math.atan2(dy, dx) * RAD_TO_DEG;
  return ((degrees % DEGREE_FULL_CIRCLE) + DEGREE_FULL_CIRCLE) % DEGREE_FULL_CIRCLE;
}

function calculateDistanceMeters(latFrom: number, lngFrom: number, latTo: number, lngTo: number) {
  const latMeters = (latTo - latFrom) * LATITUDE_METERS;
  const lngMeters = (lngTo - lngFrom) * LONGITUDE_METERS;
  return Math.hypot(latMeters, lngMeters);
}

export function buildStopGraph(dataset: GtfsDataset): StopGraph {
  const directionAccumulator: Record<string, DirectionAccumulator> = {};
  const stopEntries = Object.entries(dataset.stops);
  const edges: StopGraphEdge[] = [];
  const edgeSet = new Set<string>();

  stopEntries.forEach(([stopId]) => {
    directionAccumulator[stopId] = { sumX: 0, sumY: 0, count: 0 };
  });

  Object.values(dataset.stopTimes).forEach((stopTimes) => {
    for (let i = 0; i < stopTimes.length - 1; i += 1) {
      const fromStop = dataset.stops[stopTimes[i].stopId];
      const toStop = dataset.stops[stopTimes[i + 1].stopId];
      if (!fromStop || !toStop) {
        continue;
      }
      const edgeKey = `${fromStop.stopId}:${toStop.stopId}`;
      if (edgeSet.has(edgeKey)) {
        continue;
      }
      edgeSet.add(edgeKey);
      const normalized = normalizeVector(toStop.lng - fromStop.lng, toStop.lat - fromStop.lat);
      const distanceMeters = calculateDistanceMeters(
        fromStop.lat,
        fromStop.lng,
        toStop.lat,
        toStop.lng
      );
      edges.push({
        from: fromStop.stopId,
        to: toStop.stopId,
        distanceMeters,
        direction: normalized,
      });

      const fromAccumulator = directionAccumulator[fromStop.stopId];
      if (fromAccumulator) {
        fromAccumulator.sumX += normalized.x;
        fromAccumulator.sumY += normalized.y;
        fromAccumulator.count += 1;
      }
      const toAccumulator = directionAccumulator[toStop.stopId];
      if (toAccumulator) {
        toAccumulator.sumX -= normalized.x;
        toAccumulator.sumY -= normalized.y;
        toAccumulator.count += 1;
      }
    }
  });

  const nodes: Record<string, StopGraphNode> = {};
  stopEntries.forEach(([stopId, stop]) => {
    const accumulator = directionAccumulator[stopId];
    if (accumulator && (accumulator.sumX !== 0 || accumulator.sumY !== 0)) {
      const averageAngle = toDegrees(accumulator.sumX, accumulator.sumY);
      const snappedAngle = snapToIncrement(averageAngle, SNAPPED_ANGLE_INCREMENT);
      const snappedVector = {
        x: Math.cos(snappedAngle * DEG_TO_RAD),
        y: Math.sin(snappedAngle * DEG_TO_RAD),
      };
      nodes[stopId] = {
        stopId,
        lat: stop.lat,
        lng: stop.lng,
        averageAngle,
        snappedAngle,
        snappedVector,
      };
      return;
    }
    nodes[stopId] = {
      stopId,
      lat: stop.lat,
      lng: stop.lng,
    };
  });

  return { nodes, edges, canonicalRoutes: {} };
}

export function formatProxyNodeId(lat: number, lng: number) {
  return `${lat.toFixed(5)}_${lng.toFixed(5)}`;
}

function ensureProxyNode(
  nodes: Record<string, StopGraphNode>,
  lat: number,
  lng: number
): { key: string; node: StopGraphNode } {
  const key = formatProxyNodeId(lat, lng);
  if (!nodes[key]) {
    nodes[key] = { stopId: key, lat, lng };
  }
  return { key, node: nodes[key] };
}

export function buildGraphFromCache(cache: ProxyCache): StopGraph {
  const nodes: Record<string, StopGraphNode> = {};
  const trains = cache.data ?? [];
  const routeCandidates: {
    startKey: string;
    endKey: string;
    points: [number, number][];
    priority: number;
  }[] = [];

  const toNumber = (value?: string): number => {
    if (!value) return Number.NEGATIVE_INFINITY;
    const numeric = parseInt(value.replace(/\D/g, ''), 10);
    return Number.isFinite(numeric) ? numeric : Number.NEGATIVE_INFINITY;
  };

  trains.forEach((train, trainIndex) => {
    const priority = toNumber(train.CisloVlaku) ?? trainIndex;
    (train.Trasa ?? []).forEach((track) => {
      const points = track.Value ?? [];
      if (points.length < 2) {
        return;
      }
      const startKey = formatProxyNodeId(points[0][0], points[0][1]);
      const endKey = formatProxyNodeId(points[points.length - 1][0], points[points.length - 1][1]);
      routeCandidates.push({
        startKey,
        endKey,
        points,
        priority: Number.isFinite(priority) ? priority : Number.NEGATIVE_INFINITY,
      });
    });
  });

  routeCandidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return b.points.length - a.points.length;
  });

  type CanonicalRoute = {
    key: string;
    points: [number, number][];
  };
  const canonicalLookup = new Map<string, CanonicalRoute>();
  const canonicalEntries = new Map<string, CanonicalRoute>();
  const canonicalRoutes: Record<string, [number, number][]> = {};

  const preferredVector = { x: 1, y: 1 };
  const scoreFor = (dx: number, dy: number) => dx * preferredVector.x + dy * preferredVector.y;
  routeCandidates.forEach((candidate) => {
    const dx = candidate.points[candidate.points.length - 1][1] - candidate.points[0][1];
    const dy = candidate.points[candidate.points.length - 1][0] - candidate.points[0][0];
    const forwardScore = scoreFor(dx, dy);
    const normalizedPoints = forwardScore >= 0 ? candidate.points : [...candidate.points].reverse();
    const canonicalStart = formatProxyNodeId(normalizedPoints[0][0], normalizedPoints[0][1]);
    const canonicalEnd = formatProxyNodeId(
      normalizedPoints[normalizedPoints.length - 1][0],
      normalizedPoints[normalizedPoints.length - 1][1]
    );
    const canonicalKey = `${canonicalStart}:${canonicalEnd}`;
    const existing = canonicalLookup.get(canonicalKey);
    if (existing) {
      if (normalizedPoints.length > existing.points.length) {
        existing.points = normalizedPoints;
      }
      return;
    }
    const entry: CanonicalRoute = { key: canonicalKey, points: normalizedPoints };
    canonicalEntries.set(canonicalKey, entry);
    canonicalLookup.set(canonicalKey, entry);
    canonicalLookup.set(`${canonicalEnd}:${canonicalStart}`, entry);
  });

  const edges: StopGraphEdge[] = [];
  const undirectedEdgeSet = new Set<string>();

  canonicalEntries.forEach((entry) => {
    canonicalRoutes[entry.key] = entry.points;
    const [startKey, endKey] = entry.key.split(':');
    canonicalRoutes[`${endKey}:${startKey}`] = [...entry.points].reverse();
    const points = entry.points;
    for (let i = 0; i < points.length - 1; i += 1) {
      const [latFrom, lngFrom] = points[i];
      const [latTo, lngTo] = points[i + 1];
      const from = ensureProxyNode(nodes, latFrom, lngFrom);
      const to = ensureProxyNode(nodes, latTo, lngTo);
      if (from.key === to.key) {
        continue;
      }
      const undirectedKey =
        from.key < to.key ? `${from.key}:${to.key}` : `${to.key}:${from.key}`;
      if (undirectedEdgeSet.has(undirectedKey)) {
        continue;
      }
      undirectedEdgeSet.add(undirectedKey);
      const normalizedDirection = normalizeVector(lngTo - lngFrom, latTo - latFrom);
      const distanceMeters = calculateDistanceMeters(latFrom, lngFrom, latTo, lngTo);
      edges.push({
        from: from.key,
        to: to.key,
        distanceMeters,
        direction: normalizedDirection,
      });
    }
  });

  return { nodes, edges, canonicalRoutes };
}

