const RAIL_JOIN_METERS = 80;
const RAIL_SIMPLIFY_METERS = 4;

function distanceMeters(a, b) {
  const latMeters = (b.lat - a.lat) * 111320;
  const lngMeters =
    (b.lng - a.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(latMeters, lngMeters);
}

function perpendicularMeters(point, start, end) {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos(((start.lat + end.lat) / 2) * (Math.PI / 180));
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function douglasPeucker(points, epsilon) {
  if (points.length <= 2 || epsilon <= 0) {
    return points.map((point) => ({ lat: point.lat, lng: point.lng }));
  }
  let index = -1;
  let maxDistance = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let cursor = 1; cursor < points.length - 1; cursor += 1) {
    const distance = perpendicularMeters(points[cursor], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = cursor;
    }
  }
  if (maxDistance > epsilon && index > 0) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [
    { lat: first.lat, lng: first.lng },
    { lat: last.lat, lng: last.lng },
  ];
}

function decimatePoints(points, toleranceMeters = RAIL_SIMPLIFY_METERS) {
  if (points.length <= 2) {
    return points.map((point) => ({ lat: point.lat, lng: point.lng }));
  }
  return douglasPeucker(
    points.map((point) => ({ lat: point.lat, lng: point.lng })),
    toleranceMeters
  );
}

function closestOnSegment(point, start, end) {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos(point.lat * (Math.PI / 180));
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lng: start.lng + (end.lng - start.lng) * t,
  };
}

function nearbyKeys(point, joinMeters) {
  const latStep = joinMeters / 111320;
  const lngStep = joinMeters / (111320 * Math.max(0.2, Math.cos(point.lat * (Math.PI / 180))));
  const row = Math.floor(point.lat / latStep);
  const col = Math.floor(point.lng / lngStep);
  const keys = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      keys.push(`${row + rowOffset}:${col + colOffset}`);
    }
  }
  return keys;
}

function joinRailEnds(lines, joinMeters = RAIL_JOIN_METERS) {
  const next = lines.map((line) => line.map((point) => ({ lat: point.lat, lng: point.lng })));
  const segmentGrid = new Map();
  next.forEach((line, lineIndex) => {
    for (let segment = 0; segment < line.length - 1; segment += 1) {
      const keys = new Set([
        ...nearbyKeys(line[segment], joinMeters),
        ...nearbyKeys(line[segment + 1], joinMeters),
      ]);
      keys.forEach((key) => {
        const bucket = segmentGrid.get(key) ?? [];
        bucket.push({ line: lineIndex, segment });
        segmentGrid.set(key, bucket);
      });
    }
  });

  const insertions = [];
  for (let lineIndex = 0; lineIndex < next.length; lineIndex += 1) {
    const line = next[lineIndex];
    if (line.length < 2) {
      continue;
    }
    for (const endIndex of [0, line.length - 1]) {
      const endpoint = line[endIndex];
      let bestDistance = joinMeters;
      let bestPoint = null;
      let bestLine = -1;
      let bestSegment = -1;
      const seen = new Set();
      nearbyKeys(endpoint, joinMeters).forEach((key) => {
        const bucket = segmentGrid.get(key);
        if (!bucket) {
          return;
        }
        bucket.forEach(({ line: otherIndex, segment }) => {
          if (otherIndex === lineIndex) {
            return;
          }
          const mark = `${otherIndex}:${segment}`;
          if (seen.has(mark)) {
            return;
          }
          seen.add(mark);
          const other = next[otherIndex];
          if (segment >= other.length - 1) {
            return;
          }
          const projected = closestOnSegment(endpoint, other[segment], other[segment + 1]);
          const distance = distanceMeters(endpoint, projected);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestPoint = projected;
            bestLine = otherIndex;
            bestSegment = segment;
          }
        });
      });
      if (!bestPoint || bestLine < 0) {
        continue;
      }
      const host = next[bestLine];
      const start = host[bestSegment];
      const end = host[bestSegment + 1];
      const nearVertex =
        distanceMeters(bestPoint, start) < 15 || distanceMeters(bestPoint, end) < 15;
      if (!nearVertex) {
        line[endIndex] = { ...bestPoint };
        insertions.push({ line: bestLine, segment: bestSegment, point: { ...bestPoint } });
      } else if (distanceMeters(bestPoint, start) <= distanceMeters(bestPoint, end)) {
        line[endIndex] = { ...start };
      } else {
        line[endIndex] = { ...end };
      }
    }
  }

  insertions
    .sort((left, right) => right.line - left.line || right.segment - left.segment)
    .forEach((insertion) => {
      next[insertion.line].splice(insertion.segment + 1, 0, insertion.point);
    });

  const endpoints = [];
  next.forEach((line, lineIndex) => {
    if (line.length < 2) {
      return;
    }
    endpoints.push({ line: lineIndex, index: 0 });
    endpoints.push({ line: lineIndex, index: line.length - 1 });
  });

  const parent = endpoints.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  const unite = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let left = 0; left < endpoints.length; left += 1) {
    const leftPoint = next[endpoints[left].line][endpoints[left].index];
    for (let right = left + 1; right < endpoints.length; right += 1) {
      const rightPoint = next[endpoints[right].line][endpoints[right].index];
      if (distanceMeters(leftPoint, rightPoint) <= joinMeters) {
        unite(left, right);
      }
    }
  }

  const groups = new Map();
  endpoints.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });
  groups.forEach((members) => {
    if (members.length < 2) {
      return;
    }
    const centroid = members.reduce(
      (sum, member) => {
        const point = next[endpoints[member].line][endpoints[member].index];
        return { lat: sum.lat + point.lat, lng: sum.lng + point.lng };
      },
      { lat: 0, lng: 0 }
    );
    centroid.lat /= members.length;
    centroid.lng /= members.length;
    members.forEach((member) => {
      const slot = endpoints[member];
      next[slot.line][slot.index] = { ...centroid };
    });
  });

  return next;
}

export function simplifyOsmPayload(payload) {
  if (!payload || payload.simplified === true || !Array.isArray(payload.elements)) {
    return payload;
  }
  const ways = payload.elements.filter(
    (element) =>
      element &&
      element.type === 'way' &&
      Array.isArray(element.geometry) &&
      element.geometry.length >= 2
  );
  const before = ways.reduce((sum, way) => sum + way.geometry.length, 0);
  const simplified = joinRailEnds(
    ways.map((way) =>
      decimatePoints(way.geometry.map((node) => ({ lat: node.lat, lng: node.lon })))
    )
  );
  ways.forEach((way, index) => {
    const line = simplified[index];
    if (!line || line.length < 2) {
      return;
    }
    way.geometry = line.map((point) => ({ lat: point.lat, lon: point.lng }));
  });
  const after = ways.reduce((sum, way) => sum + way.geometry.length, 0);
  payload.simplified = true;
  payload.simplifiedPoints = { before, after, toleranceMeters: RAIL_SIMPLIFY_METERS };
  return payload;
}
