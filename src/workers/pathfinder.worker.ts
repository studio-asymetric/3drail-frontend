import {
  findOsmPath,
  rebuildNodeGrid,
  traceWaypoints,
  type LatLngBounds,
  type OsmGraph,
  type OsmGraphNode,
} from '../data/trainOsmMapper';
import type { Coordinate } from '../data/gtfsParser';

type SerializedOsmGraphNode = {
  lat: number;
  lng: number;
  neighbors: [string, number][];
};

type SerializedOsmGraph = Record<string, SerializedOsmGraphNode>;

type PathfinderWorkerRequest =
  | { type: 'initGraph'; graph: SerializedOsmGraph }
  | {
      type: 'search';
      requestId: string;
      start: Coordinate;
      end: Coordinate;
      bounds?: LatLngBounds;
    }
  | {
      type: 'trace';
      requestId: string;
      waypoints: Coordinate[];
    };

type PathfinderWorkerResponse =
  | {
      type: 'result';
      requestId: string;
      path: Coordinate[];
      durationMs: number;
      reason?: string;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'graphReady'; nodeCount: number };

let osmGraph: OsmGraph = new Map();

function buildGraph(payload: SerializedOsmGraph): OsmGraph {
  const graph: OsmGraph = new Map();
  Object.entries(payload).forEach(([key, node]) => {
    const neighborMap = new Map<string, number>(node.neighbors);
    const graphNode: OsmGraphNode = {
      key,
      lat: node.lat,
      lng: node.lng,
      neighbors: neighborMap,
    };
    graph.set(key, graphNode);
  });
  rebuildNodeGrid(graph);
  return graph;
}

self.addEventListener('message', (event: MessageEvent<PathfinderWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'initGraph') {
    osmGraph = buildGraph(message.graph);
    self.postMessage({
      type: 'graphReady',
      nodeCount: osmGraph.size,
    } satisfies PathfinderWorkerResponse);
    return;
  }

  if (message.type === 'search') {
    if (osmGraph.size === 0) {
      self.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: 'Graph not initialized',
      } satisfies PathfinderWorkerResponse);
      return;
    }

    const startTime = performance.now();
    try {
      const { path, reason } = findOsmPath(
        osmGraph,
        message.start,
        message.end,
        message.bounds
      );
      const durationMs = performance.now() - startTime;
      self.postMessage({
        type: 'result',
        requestId: message.requestId,
        path,
        durationMs,
        reason,
      } satisfies PathfinderWorkerResponse);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : 'Unknown path search error';
      self.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: messageText,
      } satisfies PathfinderWorkerResponse);
    }
  }

  if (message.type === 'trace') {
    if (osmGraph.size === 0) {
      self.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: 'Graph not initialized',
      } satisfies PathfinderWorkerResponse);
      return;
    }
    const startTime = performance.now();
    try {
      const path = traceWaypoints(osmGraph, message.waypoints);
      self.postMessage({
        type: 'result',
        requestId: message.requestId,
        path,
        durationMs: performance.now() - startTime,
      } satisfies PathfinderWorkerResponse);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : 'Unknown path trace error';
      self.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: messageText,
      } satisfies PathfinderWorkerResponse);
    }
  }
});
