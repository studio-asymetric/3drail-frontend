import { findOsmPath, type LatLngBounds, type OsmGraph, type OsmGraphNode } from '../data/trainOsmMapper';
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
    };

type PathfinderWorkerResponse =
  | { type: 'result'; requestId: string; path: Coordinate[]; durationMs: number }
  | { type: 'error'; requestId: string; message: string };

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
  return graph;
}

self.addEventListener('message', (event: MessageEvent<PathfinderWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'initGraph') {
    osmGraph = buildGraph(message.graph);
    return;
  }

  if (message.type === 'search') {
    if (osmGraph.size === 0) {
      self.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: 'Graph not initialized',
      });
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
      });
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : 'Unknown path search error';
      self.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: messageText,
      });
    }
  }
});

