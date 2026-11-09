const SNAP_METERS = 20;
const RELAXED_METERS = 250;
const ENDPOINT_BRIDGE_METERS = 140;
const BRIDGE_METERS = 40;
const WELD_METERS = 280;
const COMPONENT_BRIDGE_METERS = 250;
const GRID_LAT = SNAP_METERS / 111000;
const GRID_LNG = GRID_LAT;

function haversine(a, b) {
  const earth = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLng * sinLng;
  return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function snapLatLng(lat, lng) {
  const latDelta = SNAP_METERS / 111000;
  const snappedLat = Math.round(lat / latDelta) * latDelta;
  const rad = (snappedLat * Math.PI) / 180;
  const lngScale = Math.abs(111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad));
  const lngDelta = lngScale === 0 ? latDelta : SNAP_METERS / lngScale;
  return {
    lat: snappedLat,
    lng: Math.round(lng / lngDelta) * lngDelta,
  };
}

function formatKey(lat, lng) {
  return `${lat.toFixed(6)}:${lng.toFixed(6)}`;
}

function cellKey(lat, lng) {
  return `${Math.floor(lat / GRID_LAT)}:${Math.floor(lng / GRID_LNG)}`;
}

function pushHeap(heap, item) {
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

function popHeap(heap) {
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

export function buildRailGraph(ways) {
  const graph = new Map();
  const grid = new Map();

  const nearbyKeys = (lat, lng, meters = BRIDGE_METERS) => {
    const row = Math.floor(lat / GRID_LAT);
    const col = Math.floor(lng / GRID_LNG);
    const latMeters = SNAP_METERS;
    const lngMeters = SNAP_METERS * Math.max(0.35, Math.cos((lat * Math.PI) / 180));
    const rowRadius = Math.max(1, Math.ceil(meters / latMeters));
    const colRadius = Math.max(1, Math.ceil(meters / lngMeters));
    const keys = [];
    for (let rowOffset = -rowRadius; rowOffset <= rowRadius; rowOffset += 1) {
      for (let colOffset = -colRadius; colOffset <= colRadius; colOffset += 1) {
        const bucket = grid.get(`${row + rowOffset}:${col + colOffset}`);
        if (bucket) {
          bucket.forEach((key) => keys.push(key));
        }
      }
    }
    return keys;
  };

  const ensure = (lat, lng) => {
    const snapped = snapLatLng(lat, lng);
    const key = formatKey(snapped.lat, snapped.lng);
    let node = graph.get(key);
    if (!node) {
      node = { key, lat: snapped.lat, lng: snapped.lng, neighbors: new Map() };
      graph.set(key, node);
      const bucketKey = cellKey(node.lat, node.lng);
      const bucket = grid.get(bucketKey) ?? new Set();
      bucket.add(node.key);
      grid.set(bucketKey, bucket);
      nearbyKeys(node.lat, node.lng, BRIDGE_METERS).forEach((neighborKey) => {
        if (neighborKey === node.key) {
          return;
        }
        const neighbor = graph.get(neighborKey);
        if (!neighbor) {
          return;
        }
        const distance = haversine(node, neighbor);
        if (distance <= BRIDGE_METERS) {
          node.neighbors.set(neighbor.key, distance);
          neighbor.neighbors.set(node.key, distance);
        }
      });
    }
    return node;
  };

  const bridgeEnds = (node, meters) => {
    nearbyKeys(node.lat, node.lng, meters).forEach((neighborKey) => {
      if (neighborKey === node.key) {
        return;
      }
      const neighbor = graph.get(neighborKey);
      if (!neighbor) {
        return;
      }
      const distance = haversine(node, neighbor);
      if (distance <= meters) {
        node.neighbors.set(neighbor.key, distance);
        neighbor.neighbors.set(node.key, distance);
      }
    });
  };

  ways.forEach((way) => {
    const line = (way.geometry || []).map((point) => ({
      lat: point.lat,
      lng: point.lon ?? point.lng,
    }));
    if (line.length < 2) {
      return;
    }
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = ensure(line[index].lat, line[index].lng);
      const end = ensure(line[index + 1].lat, line[index + 1].lng);
      const distance = haversine(line[index], line[index + 1]);
      start.neighbors.set(end.key, distance);
      end.neighbors.set(start.key, distance);
    }
    bridgeEnds(ensure(line[0].lat, line[0].lng), ENDPOINT_BRIDGE_METERS);
    bridgeEnds(ensure(line[line.length - 1].lat, line[line.length - 1].lng), ENDPOINT_BRIDGE_METERS);
  });

  graph.forEach((node) => {
    if (node.neighbors.size > 1) {
      return;
    }
    let best = null;
    let bestDistance = WELD_METERS;
    nearbyKeys(node.lat, node.lng, WELD_METERS).forEach((neighborKey) => {
      if (neighborKey === node.key) {
        return;
      }
      const neighbor = graph.get(neighborKey);
      if (!neighbor) {
        return;
      }
      const distance = haversine(node, neighbor);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = neighbor;
      }
    });
    if (best) {
      node.neighbors.set(best.key, bestDistance);
      best.neighbors.set(node.key, bestDistance);
    }
  });

  const link = (left, right, distance) => {
    if (!left || !right || left.key === right.key) {
      return;
    }
    const current = left.neighbors.get(right.key);
    if (current == null || distance < current) {
      left.neighbors.set(right.key, distance);
      right.neighbors.set(left.key, distance);
    }
  };

  for (let pass = 0; pass < 3; pass += 1) {
    const remaining = new Set(graph.keys());
    const componentOf = new Map();
    let componentIndex = 0;
    while (remaining.size > 0) {
      const startKey = remaining.values().next().value;
      const queue = [startKey];
      remaining.delete(startKey);
      componentOf.set(startKey, componentIndex);
      while (queue.length > 0) {
        const key = queue.pop();
        const node = graph.get(key);
        if (!node) {
          continue;
        }
        node.neighbors.forEach((_, neighborKey) => {
          if (remaining.has(neighborKey)) {
            remaining.delete(neighborKey);
            componentOf.set(neighborKey, componentIndex);
            queue.push(neighborKey);
          }
        });
      }
      componentIndex += 1;
    }
    const bestPair = new Map();
    graph.forEach((node) => {
      const from = componentOf.get(node.key);
      nearbyKeys(node.lat, node.lng, COMPONENT_BRIDGE_METERS).forEach((neighborKey) => {
        const to = componentOf.get(neighborKey);
        if (to == null || to === from) {
          return;
        }
        const neighbor = graph.get(neighborKey);
        if (!neighbor) {
          return;
        }
        const distance = haversine(node, neighbor);
        if (distance > COMPONENT_BRIDGE_METERS) {
          return;
        }
        const mark = from < to ? `${from}:${to}` : `${to}:${from}`;
        const current = bestPair.get(mark);
        if (!current || distance < current.distance) {
          bestPair.set(mark, { distance, left: node, right: neighbor });
        }
      });
    });
    if (bestPair.size === 0) {
      break;
    }
    bestPair.forEach((pair) => link(pair.left, pair.right, pair.distance));
  }

  graph.forEach((node) => {
    node.component = -1;
    node.componentSize = 0;
  });
  let componentIndex = 0;
  graph.forEach((start) => {
    if (start.component >= 0) {
      return;
    }
    const members = [];
    const stack = [start.key];
    start.component = componentIndex;
    while (stack.length > 0) {
      const key = stack.pop();
      const node = graph.get(key);
      if (!node) {
        continue;
      }
      members.push(node);
      node.neighbors.forEach((_, neighborKey) => {
        const neighbor = graph.get(neighborKey);
        if (neighbor && neighbor.component < 0) {
          neighbor.component = componentIndex;
          stack.push(neighborKey);
        }
      });
    }
    members.forEach((node) => {
      node.componentSize = members.length;
    });
    componentIndex += 1;
  });

  graph.grid = grid;
  graph.pathCache = new Map();
  return graph;
}

function searchRadii(lat, maxMeters) {
  const latMeters = SNAP_METERS;
  const lngMeters = SNAP_METERS * Math.max(0.35, Math.cos((lat * Math.PI) / 180));
  return {
    rowRadius: Math.max(1, Math.ceil(maxMeters / latMeters)),
    colRadius: Math.max(1, Math.ceil(maxMeters / lngMeters)),
  };
}

function nearestNode(graph, point, maxMeters) {
  const grid = graph.grid;
  if (!grid || graph.size === 0) {
    return null;
  }
  const { rowRadius, colRadius } = searchRadii(point.lat, maxMeters);
  const centerRow = Math.floor(point.lat / GRID_LAT);
  const centerCol = Math.floor(point.lng / GRID_LNG);
  let bestKey = null;
  let bestDistance = maxMeters;
  for (let rowOffset = -rowRadius; rowOffset <= rowRadius; rowOffset += 1) {
    for (let colOffset = -colRadius; colOffset <= colRadius; colOffset += 1) {
      const bucket = grid.get(`${centerRow + rowOffset}:${centerCol + colOffset}`);
      if (!bucket) {
        continue;
      }
      bucket.forEach((key) => {
        const node = graph.get(key);
        if (!node) {
          return;
        }
        const distance = haversine(point, node);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestKey = key;
        }
      });
    }
  }
  return bestKey;
}

const ANCHOR_METERS = 600;

function collectNearby(graph, point, maxMeters, limit = 16) {
  const grid = graph.grid;
  if (!grid || graph.size === 0) {
    return [];
  }
  const { rowRadius, colRadius } = searchRadii(point.lat, maxMeters);
  const centerRow = Math.floor(point.lat / GRID_LAT);
  const centerCol = Math.floor(point.lng / GRID_LNG);
  const found = [];
  for (let rowOffset = -rowRadius; rowOffset <= rowRadius; rowOffset += 1) {
    for (let colOffset = -colRadius; colOffset <= colRadius; colOffset += 1) {
      const bucket = grid.get(`${centerRow + rowOffset}:${centerCol + colOffset}`);
      if (!bucket) {
        continue;
      }
      bucket.forEach((key) => {
        const node = graph.get(key);
        if (!node) {
          return;
        }
        const distance = haversine(point, node);
        if (distance <= maxMeters) {
          found.push({
            key,
            distance,
            degree: node.neighbors.size,
            componentSize: node.componentSize ?? 0,
            component: node.component,
          });
        }
      });
    }
  }
  found.sort((left, right) => {
    const sizeDelta = (right.componentSize ?? 0) - (left.componentSize ?? 0);
    if (sizeDelta !== 0) {
      return sizeDelta;
    }
    return left.distance - right.distance;
  });
  return found.slice(0, limit);
}

function bestAnchor(graph, point, maxMeters) {
  const nearby = collectNearby(graph, point, Math.min(maxMeters, ANCHOR_METERS), 16);
  if (nearby.length === 0) {
    return nearestNode(graph, point, Math.max(maxMeters, ANCHOR_METERS));
  }
  let best = nearby[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  nearby.forEach((item) => {
    const score = (item.componentSize ?? 0) * 12 - item.distance + item.degree * 4;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  });
  return best?.key ?? null;
}

function outOfBounds(node, bounds) {
  if (!bounds) {
    return false;
  }
  const margin = bounds.margin ?? 0.0005;
  return (
    node.lat < bounds.minLat - margin ||
    node.lat > bounds.maxLat + margin ||
    node.lng < bounds.minLng - margin ||
    node.lng > bounds.maxLng + margin
  );
}

function shortestKeys(graph, startKey, endKey, limitMeters, bounds) {
  const endNode = graph.get(endKey);
  if (!endNode) {
    return null;
  }
  const gScore = new Map([[startKey, 0]]);
  const previous = new Map();
  const startNode = graph.get(startKey);
  const heap = [
    {
      key: startKey,
      g: 0,
      distance: startNode ? haversine(startNode, endNode) : 0,
    },
  ];
  while (heap.length > 0) {
    const current = popHeap(heap);
    if (!current || current.g !== gScore.get(current.key)) {
      continue;
    }
    if (current.key === endKey) {
      break;
    }
    if (current.g > limitMeters) {
      return null;
    }
    const node = graph.get(current.key);
    if (!node) {
      continue;
    }
    node.neighbors.forEach((edge, neighborKey) => {
      const neighbor = graph.get(neighborKey);
      if (!neighbor) {
        return;
      }
      if (neighborKey !== endKey && outOfBounds(neighbor, bounds)) {
        return;
      }
      const nextG = current.g + edge;
      if (nextG >= (gScore.get(neighborKey) ?? Infinity)) {
        return;
      }
      gScore.set(neighborKey, nextG);
      previous.set(neighborKey, current.key);
      pushHeap(heap, {
        key: neighborKey,
        g: nextG,
        distance: nextG + haversine(neighbor, endNode),
      });
    });
  }
  if ((gScore.get(endKey) ?? Infinity) === Infinity) {
    return null;
  }
  const keys = [];
  let cursor = endKey;
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

function keysToPath(graph, keys) {
  return keys.map((key, index) => {
    const node = graph.get(key);
    return { lat: node.lat, lng: node.lng, sequence: index + 1 };
  });
}

function compatibleAnchors(graph, startPoint, endPoint, snapMeters) {
  const startPool = collectNearby(graph, startPoint, snapMeters, 16);
  const endPool = collectNearby(graph, endPoint, snapMeters, 16);
  if (startPool.length === 0 || endPool.length === 0) {
    return {
      startKey: startPool[0]?.key ?? nearestNode(graph, startPoint, snapMeters + RELAXED_METERS),
      endKey: endPool[0]?.key ?? nearestNode(graph, endPoint, snapMeters + RELAXED_METERS),
    };
  }
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  startPool.forEach((startItem) => {
    endPool.forEach((endItem) => {
      if (startItem.component !== endItem.component) {
        return;
      }
      const score =
        (startItem.componentSize ?? 0) * 12 - startItem.distance - endItem.distance;
      if (score > bestScore) {
        bestScore = score;
        best = { startKey: startItem.key, endKey: endItem.key };
      }
    });
  });
  if (best) {
    return best;
  }
  return {
    startKey: bestAnchor(graph, startPoint, snapMeters),
    endKey: bestAnchor(graph, endPoint, snapMeters),
  };
}

export function findRailPath(graph, start, end, bounds, maxSearch = 5000) {
  const startPoint = { lat: start.lat, lng: start.lng ?? start.lon };
  const endPoint = { lat: end.lat, lng: end.lng ?? end.lon };
  const snapMeters = ANCHOR_METERS;
  let { startKey, endKey } = compatibleAnchors(graph, startPoint, endPoint, snapMeters);
  if (!startKey || !endKey) {
    startKey = startKey ?? nearestNode(graph, startPoint, snapMeters + RELAXED_METERS);
    endKey = endKey ?? nearestNode(graph, endPoint, snapMeters + RELAXED_METERS);
  }
  if (!startKey || !endKey) {
    return { path: [], reason: !startKey && !endKey ? 'start_and_end_not_found' : !startKey ? 'start_not_found' : 'end_not_found' };
  }
  if (startKey === endKey) {
    return { path: keysToPath(graph, [startKey]) };
  }
  const startNode = graph.get(startKey);
  const endNode = graph.get(endKey);
  if (
    startNode &&
    endNode &&
    startNode.component != null &&
    endNode.component != null &&
    startNode.component !== endNode.component
  ) {
    return { path: [], reason: 'no_route_found' };
  }
  const cacheKey = `${startKey}>${endKey}`;
  const cached = graph.pathCache?.get(cacheKey);
  if (cached) {
    return { path: cached };
  }
  const span = haversine(startPoint, endPoint);
  const limit = Math.max(span * 3 + 12000, 25000);
  const keys = shortestKeys(graph, startKey, endKey, limit, undefined);
  if (!keys) {
    return { path: [], reason: 'no_route_found' };
  }
  const path = keysToPath(graph, keys);
  if (graph.pathCache) {
    if (graph.pathCache.size > 4000) {
      const first = graph.pathCache.keys().next().value;
      if (first) {
        graph.pathCache.delete(first);
      }
    }
    graph.pathCache.set(cacheKey, path);
  }
  return { path };
}

export function traceRailPath(graph, waypoints) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return [];
  }
  const path = [];
  const append = (point) => {
    const last = path[path.length - 1];
    if (last && last.lat === point.lat && last.lng === point.lng) {
      return;
    }
    path.push({ lat: point.lat, lng: point.lng, sequence: path.length + 1 });
  };
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    const start = waypoints[index];
    const end = waypoints[index + 1];
    const result = findRailPath(graph, start, end, undefined, Math.max(4000, haversine(start, end)));
    if (result.path.length === 0) {
      append(start);
      append(end);
      continue;
    }
    result.path.forEach((point) => append(point));
  }
  return path;
}
