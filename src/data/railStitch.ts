import type { OSMWay } from './osmRailService';

const SNAP_METERS = 30;
const GAP_BRIDGE_METERS = 160;
const SEGMENT_JOIN_METERS = 50;
const PARALLEL_SPACING_METERS = 28;
const HEADING_LIMIT = 52;

type Point = { lat: number; lon: number };
type End = { line: number; index: number };

function lonOf(point: { lon?: number; lng?: number }): number {
  return point.lon ?? point.lng ?? 0;
}

function metersBetween(a: Point, b: Point): number {
  const lat = (b.lat - a.lat) * 111320;
  const lng = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(lat, lng);
}

function bearingDegrees(a: Point, b: Point): number {
  const lat = (b.lat - a.lat) * 111320;
  const lng = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return (Math.atan2(lng, lat) * 180) / Math.PI;
}

function headingDelta(left: number, right: number): number {
  let delta = Math.abs(left - right) % 360;
  if (delta > 180) {
    delta = 360 - delta;
  }
  return delta;
}

function alongHeading(heading: number, target: number): boolean {
  const delta = headingDelta(heading, target);
  return delta <= HEADING_LIMIT || delta >= 180 - HEADING_LIMIT;
}

function outgoingBearing(line: Point[], endIndex: number): number {
  if (line.length < 2) {
    return 0;
  }
  return endIndex === 0
    ? bearingDegrees(line[0], line[1])
    : bearingDegrees(line[line.length - 1], line[line.length - 2]);
}

function isParallelTrack(
  lineA: Point[],
  endA: number,
  lineB: Point[],
  endB: number,
  distance: number
): boolean {
  if (distance < 2 || distance > PARALLEL_SPACING_METERS) {
    return false;
  }
  const from = lineA[endA];
  const to = lineB[endB];
  const across = bearingDegrees(from, to);
  const headingA = outgoingBearing(lineA, endA);
  const headingB = outgoingBearing(lineB, endB);
  const sameDirection =
    headingDelta(headingA, headingB) <= 28 || headingDelta(headingA, headingB) >= 152;
  const acrossIsSideways =
    headingDelta(headingA, across) > 48 && headingDelta(headingA, across) < 132;
  return sameDirection && acrossIsSideways;
}

function isContinuation(
  lineA: Point[],
  endA: number,
  lineB: Point[],
  endB: number
): boolean {
  const from = lineA[endA];
  const to = lineB[endB];
  return (
    alongHeading(outgoingBearing(lineA, endA), bearingDegrees(from, to)) &&
    alongHeading(outgoingBearing(lineB, endB), bearingDegrees(to, from))
  );
}

function cellKeys(point: Point, meters: number): string[] {
  const latStep = meters / 111320;
  const lngStep = meters / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
  const row = Math.floor(point.lat / latStep);
  const col = Math.floor(point.lon / lngStep);
  const keys: string[] = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      keys.push(`${row + rowOffset}:${col + colOffset}`);
    }
  }
  return keys;
}

function cleanLine(points: Point[]): Point[] {
  const cleaned: Point[] = [];
  points.forEach((point) => {
    const last = cleaned[cleaned.length - 1];
    if (!last || metersBetween(last, point) > 0.5) {
      cleaned.push(point);
    }
  });
  return cleaned;
}

function pointKey(point: Point): string {
  return `${point.lat.toFixed(5)}:${point.lon.toFixed(5)}`;
}

function mergeConnectedLines(lines: Point[][]): Point[][] {
  const unused = new Set(lines.map((_, index) => index).filter((index) => lines[index].length >= 2));
  const byEnd = new Map<string, Array<{ line: number; end: 0 | 1 }>>();

  const addEnd = (line: number, end: 0 | 1) => {
    const point = end === 0 ? lines[line][0] : lines[line][lines[line].length - 1];
    const key = pointKey(point);
    const bucket = byEnd.get(key) ?? [];
    bucket.push({ line, end });
    byEnd.set(key, bucket);
  };

  unused.forEach((line) => {
    addEnd(line, 0);
    addEnd(line, 1);
  });

  const takeOther = (line: number, end: 0 | 1): { line: number; end: 0 | 1 } | null => {
    const point = end === 0 ? lines[line][0] : lines[line][lines[line].length - 1];
    const bucket = (byEnd.get(pointKey(point)) ?? []).filter(
      (entry) => unused.has(entry.line) && entry.line !== line
    );
    if (bucket.length !== 1) {
      return null;
    }
    return bucket[0];
  };

  const merged: Array<{ points: Point[]; source: number }> = [];
  unused.forEach((startLine) => {
    if (!unused.has(startLine)) {
      return;
    }
    let chain = [...lines[startLine]];
    unused.delete(startLine);

    const grow = (fromEnd: 0 | 1) => {
      let currentLine = startLine;
      let currentEnd = fromEnd;
      let steps = 0;
      while (steps < 8000) {
        steps += 1;
        const next = takeOther(currentLine, currentEnd);
        if (!next || !unused.has(next.line)) {
          return;
        }
        unused.delete(next.line);
        const nextLine = lines[next.line];
        const nextPoints = next.end === 0 ? nextLine.slice(1) : [...nextLine].reverse().slice(1);
        if (fromEnd === 0) {
          chain = [...nextPoints].reverse().concat(chain);
          currentLine = next.line;
          currentEnd = next.end === 0 ? 1 : 0;
        } else {
          chain = chain.concat(nextPoints);
          currentLine = next.line;
          currentEnd = next.end === 0 ? 1 : 0;
        }
      }
    };

    grow(0);
    grow(1);
    const cleaned = cleanLine(chain);
    if (cleaned.length >= 2) {
      merged.push({ points: cleaned, source: startLine });
    }
  });
  return merged;
}

function projectOntoSegment(
  point: Point,
  start: Point,
  finish: Point
): { point: Point; distance: number; t: number } {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((point.lat * Math.PI) / 180);
  const ax = start.lon * lngScale;
  const ay = start.lat * latScale;
  const bx = finish.lon * lngScale;
  const by = finish.lat * latScale;
  const px = point.lon * lngScale;
  const py = point.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return {
    point: {
      lat: start.lat + (finish.lat - start.lat) * t,
      lon: start.lon + (finish.lon - start.lon) * t,
    },
    distance: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)),
    t,
  };
}

/**
 * Close leftover gaps after tile seams and double-track collapse.
 * Joins ends that continue each other, snaps tiny leftover holes, and
 * welds degree-2 chains so cell borders do not stay open.
 */
export function closeRailGaps(ways: OSMWay[]): OSMWay[] {
  const lines = ways.map((way) =>
    cleanLine((way.geometry || []).map((point) => ({ lat: point.lat, lon: lonOf(point) })))
  );
  const ends: End[] = [];
  lines.forEach((line, lineIndex) => {
    if (line.length < 2) {
      return;
    }
    ends.push({ line: lineIndex, index: 0 });
    ends.push({ line: lineIndex, index: line.length - 1 });
  });

  const endGrid = new Map<string, number[]>();
  ends.forEach((end, index) => {
    cellKeys(lines[end.line][end.index], GAP_BRIDGE_METERS).forEach((key) => {
      const bucket = endGrid.get(key) ?? [];
      bucket.push(index);
      endGrid.set(key, bucket);
    });
  });

  const used = new Set<number>();
  const bridges: Point[][] = [];

  ends.forEach((left, leftIndex) => {
    if (used.has(leftIndex)) {
      return;
    }
    const leftLine = lines[left.line];
    const leftPoint = leftLine[left.index];
    let bestDistance = GAP_BRIDGE_METERS;
    let bestIndex = -1;
    let bestContinuation = false;
    const seen = new Set<number>();
    cellKeys(leftPoint, GAP_BRIDGE_METERS).forEach((key) => {
      (endGrid.get(key) ?? []).forEach((rightIndex) => {
        if (rightIndex === leftIndex || used.has(rightIndex) || seen.has(rightIndex)) {
          return;
        }
        seen.add(rightIndex);
        const right = ends[rightIndex];
        if (right.line === left.line) {
          return;
        }
        const rightLine = lines[right.line];
        const distance = metersBetween(leftPoint, rightLine[right.index]);
        if (distance >= bestDistance) {
          return;
        }
        if (isParallelTrack(leftLine, left.index, rightLine, right.index, distance)) {
          return;
        }
        const continuation = isContinuation(leftLine, left.index, rightLine, right.index);
        if (!continuation && distance > SNAP_METERS) {
          return;
        }
        bestDistance = distance;
        bestIndex = rightIndex;
        bestContinuation = continuation;
      });
    });
    if (bestIndex < 0) {
      return;
    }
    const right = ends[bestIndex];
    const rightPoint = lines[right.line][right.index];
    if (bestDistance <= SNAP_METERS || bestContinuation) {
      if (bestDistance <= SNAP_METERS) {
        const mid = {
          lat: (leftPoint.lat + rightPoint.lat) / 2,
          lon: (leftPoint.lon + rightPoint.lon) / 2,
        };
        leftLine[left.index] = { ...mid };
        lines[right.line][right.index] = { ...mid };
      } else if (bestDistance > 0.5) {
        bridges.push([
          { lat: leftPoint.lat, lon: leftPoint.lon },
          { lat: rightPoint.lat, lon: rightPoint.lon },
        ]);
      }
      used.add(leftIndex);
      used.add(bestIndex);
    }
  });

  const segmentGrid = new Map<string, Array<{ line: number; segment: number }>>();
  lines.forEach((line, lineIndex) => {
    for (let segment = 0; segment < line.length - 1; segment += 1) {
      const start = line[segment];
      const finish = line[segment + 1];
      const payload = { line: lineIndex, segment };
      cellKeys(start, SEGMENT_JOIN_METERS).forEach((key) => {
        const bucket = segmentGrid.get(key) ?? [];
        bucket.push(payload);
        segmentGrid.set(key, bucket);
      });
      cellKeys(finish, SEGMENT_JOIN_METERS).forEach((key) => {
        const bucket = segmentGrid.get(key) ?? [];
        bucket.push(payload);
        segmentGrid.set(key, bucket);
      });
    }
  });

  ends.forEach((end, endIndex) => {
    if (used.has(endIndex)) {
      return;
    }
    const point = lines[end.line][end.index];
    let bestDistance = SEGMENT_JOIN_METERS;
    let bestPoint: Point | null = null;
    let bestLine = -1;
    let bestSegment = -1;
    const seen = new Set<string>();
    cellKeys(point, SEGMENT_JOIN_METERS).forEach((key) => {
      (segmentGrid.get(key) ?? []).forEach((entry) => {
        const token = `${entry.line}:${entry.segment}`;
        if (entry.line === end.line || seen.has(token)) {
          return;
        }
        seen.add(token);
        const host = lines[entry.line];
        const start = host[entry.segment];
        const finish = host[entry.segment + 1];
        if (!start || !finish) {
          return;
        }
        const projected = projectOntoSegment(point, start, finish);
        if (
          projected.distance < bestDistance &&
          alongHeading(outgoingBearing(lines[end.line], end.index), bearingDegrees(point, projected.point))
        ) {
          bestDistance = projected.distance;
          bestPoint = projected.point;
          bestLine = entry.line;
          bestSegment = entry.segment;
        }
      });
    });
    if (!bestPoint || bestLine < 0) {
      return;
    }
    const host = lines[bestLine];
    if (metersBetween(bestPoint, host[bestSegment]) < 12) {
      lines[end.line][end.index] = { ...host[bestSegment] };
      used.add(endIndex);
      return;
    }
    if (metersBetween(bestPoint, host[bestSegment + 1]) < 12) {
      lines[end.line][end.index] = { ...host[bestSegment + 1] };
      used.add(endIndex);
      return;
    }
    lines[end.line][end.index] = { ...bestPoint };
    host.splice(bestSegment + 1, 0, { ...bestPoint });
    used.add(endIndex);
  });

  const taggedLines: Point[][] = [];
  const taggedTags: OSMWay['tags'][] = [];
  lines.forEach((line, index) => {
    if (line.length < 2) {
      return;
    }
    taggedLines.push(line);
    taggedTags.push(ways[index]?.tags ?? { railway: 'rail' });
  });
  bridges.forEach((bridge) => {
    taggedLines.push(bridge);
    taggedTags.push({ railway: 'rail' });
  });
  const merged = mergeConnectedLines(taggedLines);
  return merged.map((item, index) => ({
    id: 900000000 + index,
    type: 'way' as const,
    nodes: [],
    tags: taggedTags[item.source] ?? { railway: 'rail' },
    geometry: item.points,
  }));
}
