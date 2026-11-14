/**
 * Server-side train route tracing on the national rail pack.
 *
 * The graph is built once from the same RNET pack the client draws, so the
 * highlighted route sits exactly on the drawn rails. Each journey is traced by
 * map-matching its stations onto the network (Viterbi over a few snap
 * candidates per station) instead of snapping each station greedily. A hop that
 * cannot be routed leaves a gap; it is never drawn as a straight chord.
 */

const KEY_SCALE = 1e5;
const CELL_METERS = 200;
const LAT_METERS = 110_574;
const LNG_METERS_AT_EQUATOR = 111_320;

// Connectivity repair (run once at build time).
const T_JOIN_METERS = 60;
const T_JOIN_HEADING = 65;
const END_BRIDGE_METERS = 450;
const END_BRIDGE_HEADING = 32;
const AHEAD_BRIDGE_METERS = 220;
const AHEAD_BRIDGE_HEADING = 22;
const BRIDGE_PENALTY = 1.35;

// Map matching.
const SNAP_RADIUS_METERS = 450;
const SNAP_RADIUS_WIDE_METERS = 1500;
const SNAP_CANDIDATES = 5;
const SNAP_SPACING_METERS = 15;
const SNAP_WEIGHT = 1.6;
const MIN_COMPONENT_NODES = 40;
const DETOUR_RATIO = 2;
const DETOUR_SLACK_METERS = 3500;

export const ROUTE_ALGORITHM_VERSION = 1;

function metersPerLng(lat) {
  return LNG_METERS_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

function distanceMeters(latA, lngA, latB, lngB) {
  const dy = (latB - latA) * LAT_METERS;
  const dx = (lngB - lngA) * metersPerLng((latA + latB) / 2);
  return Math.hypot(dx, dy);
}

function bearing(latA, lngA, latB, lngB) {
  const dy = (latB - latA) * LAT_METERS;
  const dx = (lngB - lngA) * metersPerLng((latA + latB) / 2);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function angleBetween(left, right) {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function cellOf(lat, lng) {
  return [Math.floor((lat * LAT_METERS) / CELL_METERS), Math.floor((lng * metersPerLng(48.7)) / CELL_METERS)];
}

/** Project a point onto segment a-b. Returns t in [0,1], the point and the distance. */
function project(lat, lng, latA, lngA, latB, lngB) {
  const scale = metersPerLng((latA + latB) / 2);
  const ax = lngA * scale;
  const ay = latA * LAT_METERS;
  const bx = lngB * scale;
  const by = latB * LAT_METERS;
  const px = lng * scale;
  const py = lat * LAT_METERS;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const qLat = latA + (latB - latA) * t;
  const qLng = lngA + (lngB - lngA) * t;
  return { t, lat: qLat, lng: qLng, distance: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) };
}


const SPIKE_METERS = 6;
const DEGENERATE_METERS = 12;
const WELD_METERS = 4;
const WELD_ANGLE = 25;

/** Drop repeated points and a spike folded back at either end; [] for tiny loops. */
function cleanWayGeometry(geometry) {
  let out = [];
  geometry.forEach((raw) => {
    const point = { lat: raw.lat, lng: raw.lon ?? raw.lng };
    const last = out[out.length - 1];
    if (!last || distanceMeters(last.lat, last.lng, point.lat, point.lng) >= 0.5) {
      out.push(point);
    }
  });
  const near = (a, b) => distanceMeters(a.lat, a.lng, b.lat, b.lng) < SPIKE_METERS;
  while (out.length >= 3 && near(out[0], out[2])) {
    out = out.slice(1);
  }
  while (out.length >= 3 && near(out[out.length - 1], out[out.length - 3])) {
    out = out.slice(0, -1);
  }
  if (out.length < 2) {
    return [];
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  out.forEach((point) => {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  });
  if (distanceMeters(minLat, minLng, maxLat, maxLng) < DEGENERATE_METERS) {
    return [];
  }
  return out;
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, value) {
    const keys = this.keys;
    const values = this.values;
    let index = keys.length;
    keys.push(key);
    values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (keys[parent] <= key) {
        break;
      }
      keys[index] = keys[parent];
      values[index] = values[parent];
      index = parent;
    }
    keys[index] = key;
    values[index] = value;
  }
  pop() {
    const keys = this.keys;
    const values = this.values;
    const topValue = values[0];
    this.topKey = keys[0];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length > 0) {
      let index = 0;
      const length = keys.length;
      while (true) {
        const left = index * 2 + 1;
        if (left >= length) {
          break;
        }
        const right = left + 1;
        const child = right < length && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) {
          break;
        }
        keys[index] = keys[child];
        values[index] = values[child];
        index = child;
      }
      keys[index] = lastKey;
      values[index] = lastValue;
    }
    return topValue;
  }
}

/**
 * Build the routing graph from pack ways ({ geometry: [{lat, lon}] }).
 * Shared endpoints in the pack are exact at 1e-5 degrees, so nodes are keyed by
 * those integers. Geometry is never moved to a grid.
 */
export function buildRouteGraph(ways) {
  const startedAt = Date.now();
  const lat = [];
  const lng = [];
  const adjacency = [];
  const nodeByKey = new Map();
  const segments = [];

  const nodeFor = (pointLat, pointLng) => {
    const key = `${Math.round(pointLat * KEY_SCALE)}:${Math.round(pointLng * KEY_SCALE)}`;
    let index = nodeByKey.get(key);
    if (index === undefined) {
      index = lat.length;
      nodeByKey.set(key, index);
      lat.push(Math.round(pointLat * KEY_SCALE) / KEY_SCALE);
      lng.push(Math.round(pointLng * KEY_SCALE) / KEY_SCALE);
      adjacency.push([]);
    }
    return index;
  };

  const link = (left, right, weight, bridge = false) => {
    if (left === right) {
      return;
    }
    const existing = adjacency[left].find((edge) => edge.to === right);
    if (existing) {
      if (weight < existing.weight) {
        existing.weight = weight;
        adjacency[right].find((edge) => edge.to === left).weight = weight;
      }
      return;
    }
    adjacency[left].push({ to: right, weight, bridge });
    adjacency[right].push({ to: left, weight, bridge });
  };

  const unlink = (left, right) => {
    adjacency[left] = adjacency[left].filter((edge) => edge.to !== right);
    adjacency[right] = adjacency[right].filter((edge) => edge.to !== left);
  };

  const cleaned = ways.map((way) => cleanWayGeometry(way.geometry ?? [])).filter((line) => line.length >= 2);
  cleaned.forEach((geometry) => {
    let previous = -1;
    geometry.forEach((point) => {
      const current = nodeFor(point.lat, point.lng);
      if (previous >= 0 && previous !== current) {
        link(previous, current, distanceMeters(lat[previous], lng[previous], lat[current], lng[current]));
        segments.push({ a: previous, b: current, alive: true });
      }
      previous = current;
    });
  });

  // Segment grid. Long segments cover every cell their bounding box touches.
  const grid = new Map();
  const indexSegment = (segmentIndex) => {
    const { a, b } = segments[segmentIndex];
    const [rowA, colA] = cellOf(lat[a], lng[a]);
    const [rowB, colB] = cellOf(lat[b], lng[b]);
    for (let row = Math.min(rowA, rowB); row <= Math.max(rowA, rowB); row += 1) {
      for (let col = Math.min(colA, colB); col <= Math.max(colA, colB); col += 1) {
        const key = `${row}:${col}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(segmentIndex);
      }
    }
  };
  segments.forEach((_, index) => indexSegment(index));

  const segmentsNear = (pointLat, pointLng, meters) => {
    const [row, col] = cellOf(pointLat, pointLng);
    const radius = Math.ceil(meters / CELL_METERS);
    const found = new Set();
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        const bucket = grid.get(`${row + dr}:${col + dc}`);
        if (bucket) {
          bucket.forEach((segmentIndex) => {
            if (segments[segmentIndex].alive) {
              found.add(segmentIndex);
            }
          });
        }
      }
    }
    return found;
  };

  // Weld vertices lying a few metres from another line that runs alongside at a
  // shallow angle (junctions whose vertices never coincided). Steep crossings are
  // left alone: those are usually bridges over the other line.
  let welds = 0;
  const splits = new Map(); // segmentIndex -> [{ from, hit, bridge }]
  const edgeHeadings = (node) =>
    adjacency[node].map(({ to }) => bearing(lat[node], lng[node], lat[to], lng[to]));
  const shallow = (headings, segmentHeading) =>
    headings.some((heading) => {
      const delta = angleBetween(heading, segmentHeading);
      return delta <= WELD_ANGLE || delta >= 180 - WELD_ANGLE;
    });
  const nodeCount = lat.length;
  for (let node = 0; node < nodeCount; node += 1) {
    let best = null;
    segmentsNear(lat[node], lng[node], WELD_METERS).forEach((segmentIndex) => {
      const { a, b } = segments[segmentIndex];
      if (a === node || b === node) {
        return;
      }
      if (adjacency[node].some((edge) => edge.to === a || edge.to === b)) {
        return;
      }
      const hit = project(lat[node], lng[node], lat[a], lng[a], lat[b], lng[b]);
      if (hit.distance > WELD_METERS || (best && hit.distance >= best.hit.distance)) {
        return;
      }
      if (!shallow(edgeHeadings(node), bearing(lat[a], lng[a], lat[b], lng[b]))) {
        return;
      }
      best = { segmentIndex, hit };
    });
    if (!best) {
      continue;
    }
    const { a, b } = segments[best.segmentIndex];
    if (best.hit.t <= 0.02 || best.hit.t >= 0.98) {
      const other = best.hit.t <= 0.02 ? a : b;
      link(node, other, distanceMeters(lat[node], lng[node], lat[other], lng[other]));
    } else {
      const list = splits.get(best.segmentIndex) ?? [];
      list.push({ from: node, hit: best.hit, bridge: false });
      splits.set(best.segmentIndex, list);
    }
    welds += 1;
  }

  // --- Connectivity repair at dead ends ---------------------------------
  const outwardHeading = (node) => {
    const neighbor = adjacency[node][0]?.to;
    if (neighbor === undefined) {
      return null;
    }
    return bearing(lat[neighbor], lng[neighbor], lat[node], lng[node]);
  };

  const deadEnds = [];
  adjacency.forEach((edges, node) => {
    if (edges.length === 1) {
      deadEnds.push(node);
    }
  });

  const stats = { welds, deadEnds: deadEnds.length, tJoins: 0, endBridges: 0, aheadBridges: 0 };
  const deadEndSet = new Set(deadEnds);

  deadEnds.forEach((node) => {
    const heading = outwardHeading(node);
    if (heading === null) {
      return;
    }
    const ownNeighbor = adjacency[node][0].to;
    let best = null;

    // 1. T-join: the dead end stops just short of (or just past) another line.
    segmentsNear(lat[node], lng[node], T_JOIN_METERS).forEach((segmentIndex) => {
      const { a, b } = segments[segmentIndex];
      if (a === node || b === node || a === ownNeighbor || b === ownNeighbor) {
        return;
      }
      const hit = project(lat[node], lng[node], lat[a], lng[a], lat[b], lng[b]);
      if (hit.distance > T_JOIN_METERS) {
        return;
      }
      const toward = bearing(lat[node], lng[node], hit.lat, hit.lng);
      if (hit.distance > 15 && angleBetween(heading, toward) > T_JOIN_HEADING) {
        return;
      }
      const score = hit.distance;
      if (!best || score < best.score) {
        best = { kind: 't', score, segmentIndex, hit };
      }
    });

    // 2. End-to-end continuation across a gap (tile seams, collapsed doubles).
    if (!best) {
      segmentsNear(lat[node], lng[node], END_BRIDGE_METERS).forEach((segmentIndex) => {
        const { a, b } = segments[segmentIndex];
        [a, b].forEach((other) => {
          if (other === node || other === ownNeighbor || !deadEndSet.has(other)) {
            return;
          }
          const distance = distanceMeters(lat[node], lng[node], lat[other], lng[other]);
          if (distance > END_BRIDGE_METERS) {
            return;
          }
          const otherHeading = outwardHeading(other);
          const across = bearing(lat[node], lng[node], lat[other], lng[other]);
          if (
            otherHeading === null ||
            angleBetween(heading, across) > END_BRIDGE_HEADING ||
            angleBetween(otherHeading, (across + 180) % 360) > END_BRIDGE_HEADING
          ) {
            return;
          }
          const score = distance * BRIDGE_PENALTY;
          if (!best || score < best.score) {
            best = { kind: 'end', score, other, distance };
          }
        });
      });
    }

    // 3. Dead end pointing straight at the middle of another line.
    if (!best) {
      segmentsNear(lat[node], lng[node], AHEAD_BRIDGE_METERS).forEach((segmentIndex) => {
        const { a, b } = segments[segmentIndex];
        if (a === node || b === node || a === ownNeighbor || b === ownNeighbor) {
          return;
        }
        const hit = project(lat[node], lng[node], lat[a], lng[a], lat[b], lng[b]);
        if (hit.distance > AHEAD_BRIDGE_METERS) {
          return;
        }
        const toward = bearing(lat[node], lng[node], hit.lat, hit.lng);
        if (angleBetween(heading, toward) > AHEAD_BRIDGE_HEADING) {
          return;
        }
        const score = hit.distance * BRIDGE_PENALTY + 20;
        if (!best || score < best.score) {
          best = { kind: 'ahead', score, segmentIndex, hit };
        }
      });
    }

    if (!best) {
      return;
    }
    if (best.kind === 'end') {
      link(node, best.other, best.distance * BRIDGE_PENALTY, true);
      stats.endBridges += 1;
      return;
    }
    const list = splits.get(best.segmentIndex) ?? [];
    list.push({ from: node, hit: best.hit, bridge: best.kind === 'ahead' });
    splits.set(best.segmentIndex, list);
    if (best.kind === 't') {
      stats.tJoins += 1;
    } else {
      stats.aheadBridges += 1;
    }
  });

  // Apply mid-segment joins: split the target segment at each projection.
  splits.forEach((list, segmentIndex) => {
    const segment = segments[segmentIndex];
    const { a, b } = segment;
    const points = list
      .map((item) => {
        let target;
        if (item.hit.t <= 0.0001) {
          target = a;
        } else if (item.hit.t >= 0.9999) {
          target = b;
        } else {
          target = nodeFor(item.hit.lat, item.hit.lng);
        }
        return { ...item, target };
      })
      .sort((left, right) => left.hit.t - right.hit.t);
    const chain = [a, ...points.map((item) => item.target), b].filter(
      (node, index, all) => index === 0 || node !== all[index - 1]
    );
    if (chain.length > 2) {
      unlink(a, b);
      segment.alive = false;
      for (let index = 1; index < chain.length; index += 1) {
        const left = chain[index - 1];
        const right = chain[index];
        link(left, right, distanceMeters(lat[left], lng[left], lat[right], lng[right]));
        segments.push({ a: left, b: right, alive: true });
        indexSegment(segments.length - 1);
      }
    }
    points.forEach((item) => {
      const distance = distanceMeters(lat[item.from], lng[item.from], lat[item.target], lng[item.target]);
      link(item.from, item.target, item.bridge ? distance * BRIDGE_PENALTY : distance, item.bridge);
      if (item.from !== item.target) {
        segments.push({ a: item.from, b: item.target, alive: true, bridge: true });
        indexSegment(segments.length - 1);
      }
    });
  });

  // Components, so snapping can ignore stray fragments.
  const component = new Int32Array(lat.length).fill(-1);
  const componentSize = [];
  for (let start = 0; start < lat.length; start += 1) {
    if (component[start] >= 0) {
      continue;
    }
    const id = componentSize.length;
    let size = 0;
    const stack = [start];
    component[start] = id;
    while (stack.length > 0) {
      const node = stack.pop();
      size += 1;
      adjacency[node].forEach(({ to }) => {
        if (component[to] < 0) {
          component[to] = id;
          stack.push(to);
        }
      });
    }
    componentSize.push(size);
  }

  let remainingDeadEnds = 0;
  adjacency.forEach((edges) => {
    if (edges.length === 1) {
      remainingDeadEnds += 1;
    }
  });

  return {
    lat,
    lng,
    adjacency,
    segments,
    segmentsNear,
    component,
    componentSize,
    stats: {
      ...stats,
      remainingDeadEnds,
      nodes: lat.length,
      components: componentSize.length,
      largestComponent: Math.max(0, ...componentSize),
      buildMs: Date.now() - startedAt,
    },
  };
}

/** Up to N snap candidates on distinct tracks near a station. */
function snapCandidates(graph, point) {
  const collect = (radius) => {
    const hits = [];
    graph.segmentsNear(point.lat, point.lng, radius).forEach((segmentIndex) => {
      const { a, b, bridge } = graph.segments[segmentIndex];
      if (bridge || graph.componentSize[graph.component[a]] < MIN_COMPONENT_NODES) {
        return;
      }
      const hit = project(point.lat, point.lng, graph.lat[a], graph.lng[a], graph.lat[b], graph.lng[b]);
      if (hit.distance <= radius) {
        hits.push({ a, b, t: hit.t, lat: hit.lat, lng: hit.lng, snap: hit.distance });
      }
    });
    return hits;
  };
  let hits = collect(SNAP_RADIUS_METERS);
  if (hits.length === 0) {
    hits = collect(SNAP_RADIUS_WIDE_METERS);
  }
  hits.sort((left, right) => left.snap - right.snap);
  const chosen = [];
  for (const hit of hits) {
    if (
      chosen.every(
        (other) => distanceMeters(other.lat, other.lng, hit.lat, hit.lng) >= SNAP_SPACING_METERS
      )
    ) {
      chosen.push(hit);
      if (chosen.length >= SNAP_CANDIDATES) {
        break;
      }
    }
  }
  return chosen;
}

/**
 * Dijkstra from a point on a segment to several target points on segments.
 * Returns, for each target, { cost, nodes } or null when out of reach.
 */
function routeFrom(graph, source, targets, limitMeters, scratch) {
  const { lat, lng, adjacency } = graph;
  const { dist, prev, touched } = scratch;
  const heap = new MinHeap();
  const results = targets.map(() => null);

  const seed = (node, cost) => {
    if (cost < dist[node]) {
      if (dist[node] === Infinity) {
        touched.push(node);
      }
      dist[node] = cost;
      prev[node] = -1;
      heap.push(cost, node);
    }
  };
  seed(source.a, distanceMeters(source.lat, source.lng, lat[source.a], lng[source.a]));
  seed(source.b, distanceMeters(source.lat, source.lng, lat[source.b], lng[source.b]));

  // Targets on the same segment can be reached directly along it.
  targets.forEach((target, index) => {
    const sameSegment =
      (target.a === source.a && target.b === source.b) || (target.a === source.b && target.b === source.a);
    if (sameSegment) {
      results[index] = {
        cost: distanceMeters(source.lat, source.lng, target.lat, target.lng),
        nodes: [],
        direct: true,
      };
    }
  });

  const endpointTargets = new Map();
  targets.forEach((target, index) => {
    [target.a, target.b].forEach((node) => {
      const list = endpointTargets.get(node) ?? [];
      list.push(index);
      endpointTargets.set(node, list);
    });
  });
  let pendingEndpoints = endpointTargets.size;

  while (heap.size > 0 && pendingEndpoints > 0) {
    const node = heap.pop();
    const cost = dist[node];
    if (heap.topKey > cost) {
      continue;
    }
    if (cost > limitMeters) {
      break;
    }
    if (endpointTargets.has(node)) {
      pendingEndpoints -= 1;
    }
    const edges = adjacency[node];
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      const next = cost + edge.weight;
      if (next < dist[edge.to]) {
        if (dist[edge.to] === Infinity) {
          touched.push(edge.to);
        }
        dist[edge.to] = next;
        prev[edge.to] = node;
        heap.push(next, edge.to);
      }
    }
  }

  const trace = (node) => {
    const nodes = [];
    let cursor = node;
    let guard = 0;
    while (cursor !== -1 && guard < 200_000) {
      nodes.push(cursor);
      cursor = prev[cursor];
      guard += 1;
    }
    return nodes.reverse();
  };

  targets.forEach((target, index) => {
    let best = results[index];
    [target.a, target.b].forEach((node) => {
      if (dist[node] === Infinity) {
        return;
      }
      const cost = dist[node] + distanceMeters(lat[node], lng[node], target.lat, target.lng);
      if (cost <= limitMeters && (!best || cost < best.cost)) {
        best = { cost, endNode: node };
      }
    });
    if (best && best.endNode !== undefined) {
      best.nodes = trace(best.endNode);
    }
    results[index] = best;
  });

  touched.forEach((node) => {
    dist[node] = Infinity;
    prev[node] = -1;
  });
  touched.length = 0;
  return results;
}

function makeScratch(graph) {
  return {
    dist: new Float64Array(graph.lat.length).fill(Infinity),
    prev: new Int32Array(graph.lat.length).fill(-1),
    touched: [],
  };
}

/** Remove there-and-back excursions (A → … → A) left at snap points. */
function despike(points) {
  const out = [];
  points.forEach((point) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-6 && Math.abs(last[1] - point[1]) < 1e-6) {
      return;
    }
    const beforeLast = out[out.length - 2];
    if (
      beforeLast &&
      distanceMeters(beforeLast[0], beforeLast[1], point[0], point[1]) < 1.5
    ) {
      out.pop();
      return;
    }
    out.push(point);
  });
  return out;
}

/**
 * Trace a train through its stations.
 * @param waypoints [{lat, lng}] in travel order
 * @returns {{ segments: number[][][], hops: string[], stats: object }}
 *   segments: polylines of [lat, lng]; hops: per input hop 'ok' | 'gap' | 'skip'
 */
export function traceRoute(graph, waypoints) {
  const scratch = graph.scratch ?? (graph.scratch = makeScratch(graph));
  const stops = waypoints.map((point) => ({ point, candidates: snapCandidates(graph, point) }));
  const hops = new Array(Math.max(0, waypoints.length - 1)).fill('gap');
  const segments = [];

  // Viterbi over runs of stations; a hop with no feasible transition ends the run.
  let run = null; // { layers: [{ stopIndex, states: [{ cand, score, back, path }] }] }

  const closeRun = () => {
    if (!run || run.layers.length < 2) {
      run = null;
      return;
    }
    const lastLayer = run.layers[run.layers.length - 1];
    let stateIndex = 0;
    lastLayer.states.forEach((state, index) => {
      if (state.score < lastLayer.states[stateIndex].score) {
        stateIndex = index;
      }
    });
    const pieces = [];
    for (let layerIndex = run.layers.length - 1; layerIndex > 0; layerIndex -= 1) {
      const state = run.layers[layerIndex].states[stateIndex];
      pieces.push(state.path);
      const previousStop = run.layers[layerIndex - 1].stopIndex;
      for (let hop = previousStop; hop < run.layers[layerIndex].stopIndex; hop += 1) {
        hops[hop] = 'ok';
      }
      stateIndex = state.back;
    }
    pieces.reverse();
    const line = despike(pieces.flat());
    if (line.length >= 2) {
      segments.push(line);
    }
    run = null;
  };

  stops.forEach((stop, stopIndex) => {
    if (stop.candidates.length === 0) {
      if (stopIndex > 0) {
        hops[stopIndex - 1] = 'skip';
      }
      if (stopIndex < hops.length) {
        hops[stopIndex] = 'skip';
      }
      return;
    }
    const emissions = stop.candidates.map((cand) => cand.snap * SNAP_WEIGHT);
    if (!run) {
      run = {
        layers: [
          {
            stopIndex,
            states: stop.candidates.map((cand, index) => ({ cand, score: emissions[index], back: -1, path: [] })),
          },
        ],
      };
      return;
    }
    const previous = run.layers[run.layers.length - 1];
    const straight = distanceMeters(
      stops[previous.stopIndex].point.lat,
      stops[previous.stopIndex].point.lng,
      stop.point.lat,
      stop.point.lng
    );
    const limit = straight * DETOUR_RATIO + DETOUR_SLACK_METERS;
    const states = stop.candidates.map((cand) => ({ cand, score: Infinity, back: -1, path: null }));
    previous.states.forEach((from, fromIndex) => {
      const routes = routeFrom(graph, from.cand, stop.candidates, limit, scratch);
      routes.forEach((route, toIndex) => {
        if (!route) {
          return;
        }
        const score = from.score + route.cost + emissions[toIndex];
        if (score < states[toIndex].score) {
          const path = [[from.cand.lat, from.cand.lng]];
          route.nodes.forEach((node) => path.push([graph.lat[node], graph.lng[node]]));
          path.push([states[toIndex].cand.lat, states[toIndex].cand.lng]);
          states[toIndex] = { cand: states[toIndex].cand, score, back: fromIndex, path };
        }
      });
    });
    const reachable = states.some((state) => state.score < Infinity);
    if (!reachable) {
      closeRun();
      run = {
        layers: [
          {
            stopIndex,
            states: stop.candidates.map((cand, index) => ({ cand, score: emissions[index], back: -1, path: [] })),
          },
        ],
      };
      return;
    }
    // Keep only reachable states, remapping nothing: unreachable ones get Infinity and are never chosen.
    run.layers.push({ stopIndex, states });
  });
  closeRun();

  // A skipped stop between two routed ones may still have been routed across.
  return {
    segments,
    hops,
    stats: {
      stops: waypoints.length,
      unsnapped: stops.filter((stop) => stop.candidates.length === 0).length,
      gaps: hops.filter((hop) => hop === 'gap').length,
    },
  };
}

// --- Google encoded polyline (precision 5 matches the pack) -------------

export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return chunk + String.fromCharCode(v + 63);
  };
  points.forEach(([pointLat, pointLng]) => {
    const latInt = Math.round(pointLat * factor);
    const lngInt = Math.round(pointLng * factor);
    out += encodeValue(latInt - lastLat) + encodeValue(lngInt - lastLng);
    lastLat = latInt;
    lastLng = lngInt;
  });
  return out;
}

export function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let pointLat = 0;
  let pointLng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length + 1);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    pointLat += next();
    pointLng += next();
    points.push([pointLat / factor, pointLng / factor]);
  }
  return points;
}
