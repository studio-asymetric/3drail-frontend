import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOLE_CLOSE_VERSION = 1;

const CONNECTED_METERS = 2;
const SNAP_METERS = 30;
const BRIDGE_METERS = 160;
const T_JOIN_METERS = 50;
const PARALLEL_MIN = 2;
const PARALLEL_MAX = 28;
const EDGE_SKIP_METERS = 80;
const MIN_POINT_METERS = 0.5;
const HEADING_LIMIT = 55;

function lonOf(point) {
  return point.lon ?? point.lng ?? 0;
}

function asPoint(point) {
  return { lat: point.lat, lon: lonOf(point) };
}

function metersBetween(a, b) {
  const lat = (b.lat - a.lat) * 111320;
  const lng = (lonOf(b) - lonOf(a)) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(lat, lng);
}

function bearingDegrees(a, b) {
  const lat = (b.lat - a.lat) * 111320;
  const lng = (lonOf(b) - lonOf(a)) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return (Math.atan2(lng, lat) * 180) / Math.PI;
}

function headingDelta(left, right) {
  let delta = Math.abs(left - right) % 360;
  if (delta > 180) {
    delta = 360 - delta;
  }
  return delta;
}

function alongHeading(heading, target, limit = HEADING_LIMIT) {
  const delta = headingDelta(heading, target);
  return delta <= limit || delta >= 180 - limit;
}

function outgoingBearing(line, endIndex) {
  if (line.length < 2) {
    return 0;
  }
  return endIndex === 0
    ? bearingDegrees(line[0], line[1])
    : bearingDegrees(line[line.length - 1], line[line.length - 2]);
}

function isParallelTrack(lineA, endA, lineB, endB, distance) {
  if (distance < PARALLEL_MIN || distance > PARALLEL_MAX) {
    return false;
  }
  const from = lineA[endA];
  const to = lineB[endB];
  const across = bearingDegrees(from, to);
  const headingA = outgoingBearing(lineA, endA);
  const headingB = outgoingBearing(lineB, endB);
  const sameDirection =
    headingDelta(headingA, headingB) <= 28 || headingDelta(headingA, headingB) >= 152;
  const acrossIsSideways = headingDelta(headingA, across) > 48 && headingDelta(headingA, across) < 132;
  return sameDirection && acrossIsSideways;
}

function cellKeys(point, meters) {
  const latStep = meters / 111320;
  const lngStep = meters / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
  const row = Math.floor(point.lat / latStep);
  const col = Math.floor(lonOf(point) / lngStep);
  const keys = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      keys.push(`${row + rowOffset}:${col + colOffset}`);
    }
  }
  return keys;
}

function cleanLine(points) {
  const cleaned = [];
  points.forEach((point) => {
    const next = asPoint(point);
    const last = cleaned[cleaned.length - 1];
    if (!last || metersBetween(last, next) > MIN_POINT_METERS) {
      cleaned.push(next);
    }
  });
  return cleaned;
}

function projectOntoSegment(point, start, finish) {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((point.lat * Math.PI) / 180);
  const ax = lonOf(start) * lngScale;
  const ay = start.lat * latScale;
  const bx = lonOf(finish) * lngScale;
  const by = finish.lat * latScale;
  const px = lonOf(point) * lngScale;
  const py = point.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return {
    point: {
      lat: start.lat + (finish.lat - start.lat) * t,
      lon: lonOf(start) + (lonOf(finish) - lonOf(start)) * t,
    },
    distance: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)),
  };
}

function nearBounds(point, bounds, meters) {
  if (!bounds) {
    return false;
  }
  const latM = meters / 111320;
  const lngM = meters / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
  return (
    point.lat - bounds.minLat < latM ||
    bounds.maxLat - point.lat < latM ||
    lonOf(point) - bounds.minLng < lngM ||
    bounds.maxLng - lonOf(point) < lngM
  );
}

function collectEnds(lines) {
  const ends = [];
  lines.forEach((line, lineIndex) => {
    if (line.length < 2) {
      return;
    }
    ends.push({ line: lineIndex, index: 0 });
    ends.push({ line: lineIndex, index: line.length - 1 });
  });
  return ends;
}

function buildGrid(ends, lines, meters) {
  const grid = new Map();
  ends.forEach((end, index) => {
    cellKeys(lines[end.line][end.index], meters).forEach((key) => {
      const bucket = grid.get(key) ?? [];
      bucket.push(index);
      grid.set(key, bucket);
    });
  });
  return grid;
}

function buildSegmentGrid(lines, meters) {
  const grid = new Map();
  lines.forEach((line, lineIndex) => {
    for (let segment = 0; segment < line.length - 1; segment += 1) {
      const payload = { line: lineIndex, segment };
      const keys = new Set([
        ...cellKeys(line[segment], meters),
        ...cellKeys(line[segment + 1], meters),
      ]);
      keys.forEach((key) => {
        const bucket = grid.get(key) ?? [];
        bucket.push(payload);
        grid.set(key, bucket);
      });
    }
  });
  return grid;
}

function isConnected(end, ends, lines, endGrid, segmentGrid) {
  const point = lines[end.line][end.index];
  const seen = new Set();
  for (const key of cellKeys(point, SNAP_METERS)) {
    for (const otherIndex of endGrid.get(key) ?? []) {
      if (seen.has(otherIndex)) {
        continue;
      }
      seen.add(otherIndex);
      const other = ends[otherIndex];
      if (other.line === end.line) {
        continue;
      }
      const distance = metersBetween(point, lines[other.line][other.index]);
      if (distance <= CONNECTED_METERS) {
        return true;
      }
    }
  }
  const seenSeg = new Set();
  for (const key of cellKeys(point, T_JOIN_METERS)) {
    for (const entry of segmentGrid.get(key) ?? []) {
      const token = `${entry.line}:${entry.segment}`;
      if (entry.line === end.line || seenSeg.has(token)) {
        continue;
      }
      seenSeg.add(token);
      const host = lines[entry.line];
      const projected = projectOntoSegment(point, host[entry.segment], host[entry.segment + 1]);
      if (projected.distance <= 6) {
        return true;
      }
    }
  }
  return false;
}

function scorePair(lineA, endA, lineB, endB, distance) {
  if (isParallelTrack(lineA, endA, lineB, endB, distance)) {
    return Number.POSITIVE_INFINITY;
  }
  const from = lineA[endA];
  const to = lineB[endB];
  const alongA = alongHeading(outgoingBearing(lineA, endA), bearingDegrees(from, to));
  const alongB = alongHeading(outgoingBearing(lineB, endB), bearingDegrees(to, from));
  if (alongA && alongB) {
    return distance;
  }
  if (distance <= SNAP_METERS) {
    return distance * 1.6;
  }
  if (distance <= 120 && (alongA || alongB)) {
    return distance * 2;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Snap and bridge leftover holes. Pass `bounds` to leave cell-edge ends for a
 * later global pass; omit it when stitching the whole loaded network.
 */
export function closeRailHoles(ways, options = {}) {
  const bounds = options.bounds ?? null;
  const skipEdges = Boolean(bounds) && options.skipEdges !== false;
  const lines = ways.map((way) => cleanLine(way.geometry || []));
  const bridges = [];
  let closed = 0;
  let found = 0;

  const closePass = () => {
    const ends = collectEnds(lines);
    const endGrid = buildGrid(ends, lines, BRIDGE_METERS);
    const segmentGrid = buildSegmentGrid(lines, T_JOIN_METERS);
    const dangling = [];
    ends.forEach((end, endIndex) => {
      if (isConnected(end, ends, lines, endGrid, segmentGrid)) {
        return;
      }
      const point = lines[end.line][end.index];
      if (skipEdges && nearBounds(point, bounds, EDGE_SKIP_METERS)) {
        return;
      }
      dangling.push(endIndex);
    });
    found = Math.max(found, dangling.length);
    const used = new Set();
    dangling.forEach((leftIndex) => {
      if (used.has(leftIndex)) {
        return;
      }
      const left = ends[leftIndex];
      const leftLine = lines[left.line];
      const leftPoint = leftLine[left.index];
      let bestScore = BRIDGE_METERS;
      let bestIndex = -1;
      const seen = new Set();
      cellKeys(leftPoint, BRIDGE_METERS).forEach((key) => {
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
          if (distance >= BRIDGE_METERS) {
            return;
          }
          const score = scorePair(leftLine, left.index, rightLine, right.index, distance);
          if (score < bestScore) {
            bestScore = score;
            bestIndex = rightIndex;
          }
        });
      });
      if (bestIndex < 0) {
        let nearest = BRIDGE_METERS;
        let nearestIndex = -1;
        let second = BRIDGE_METERS;
        seen.clear();
        cellKeys(leftPoint, 140).forEach((key) => {
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
            if (
              distance >= 140 ||
              isParallelTrack(leftLine, left.index, rightLine, right.index, distance)
            ) {
              return;
            }
            if (distance < nearest) {
              second = nearest;
              nearest = distance;
              nearestIndex = rightIndex;
            } else if (distance < second) {
              second = distance;
            }
          });
        });
        if (nearestIndex >= 0 && nearest < 140 && second > nearest * 1.6) {
          bestIndex = nearestIndex;
          bestScore = nearest;
        } else {
          return;
        }
      }
      const right = ends[bestIndex];
      const rightPoint = lines[right.line][right.index];
      const distance = metersBetween(leftPoint, rightPoint);
      if (distance <= SNAP_METERS) {
        const mid = {
          lat: (leftPoint.lat + rightPoint.lat) / 2,
          lon: (leftPoint.lon + rightPoint.lon) / 2,
        };
        leftLine[left.index] = { ...mid };
        lines[right.line][right.index] = { ...mid };
      } else {
        const geometry = [
          { lat: leftPoint.lat, lon: leftPoint.lon },
          { lat: rightPoint.lat, lon: rightPoint.lon },
        ];
        lines.push(geometry.map((point) => ({ ...point })));
        bridges.push({
          type: 'way',
          id: 810000000 + left.line * 1009 + right.line,
          tags: { ...(ways[left.line]?.tags ?? { railway: 'rail' }), hole_fill: 'yes' },
          geometry,
        });
      }
      used.add(leftIndex);
      used.add(bestIndex);
      closed += 1;
    });

    ends.forEach((end, endIndex) => {
      if (used.has(endIndex) || isConnected(end, ends, lines, endGrid, segmentGrid)) {
        return;
      }
      const point = lines[end.line][end.index];
      if (skipEdges && nearBounds(point, bounds, EDGE_SKIP_METERS)) {
        return;
      }
      let bestDistance = T_JOIN_METERS;
      let bestPoint = null;
      let bestLine = -1;
      let bestSegment = -1;
      const seen = new Set();
      cellKeys(point, T_JOIN_METERS).forEach((key) => {
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
      } else if (metersBetween(bestPoint, host[bestSegment + 1]) < 12) {
        lines[end.line][end.index] = { ...host[bestSegment + 1] };
      } else {
        lines[end.line][end.index] = { ...bestPoint };
        host.splice(bestSegment + 1, 0, { ...bestPoint });
      }
      used.add(endIndex);
      closed += 1;
    });
    return used.size > 0;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    if (!closePass()) {
      break;
    }
  }

  const remainingEnds = collectEnds(lines);
  const remainingGrid = buildGrid(remainingEnds, lines, BRIDGE_METERS);
  const remainingSeg = buildSegmentGrid(lines, T_JOIN_METERS);
  let remaining = 0;
  remainingEnds.forEach((end) => {
    if (isConnected(end, remainingEnds, lines, remainingGrid, remainingSeg)) {
      return;
    }
    const point = lines[end.line][end.index];
    if (skipEdges && nearBounds(point, bounds, EDGE_SKIP_METERS)) {
      return;
    }
    remaining += 1;
  });

  const elements = ways.map((way, index) => {
    const geometry = cleanLine(lines[index] ?? []);
    if (geometry.length < 2) {
      return way;
    }
    return {
      ...way,
      geometry: geometry.map((point) => ({ lat: point.lat, lon: point.lon })),
    };
  });
  return {
    elements: elements.concat(bridges),
    found,
    closed,
    remaining,
    bridges: bridges.length,
    extraWays: bridges,
  };
}

function parseTileFileName(fileName) {
  if (!fileName.endsWith('.json') || fileName.startsWith('mvt_')) {
    return null;
  }
  const base = fileName.slice(0, -5);
  const parts = base.split('_');
  if (parts.length < 5) {
    return null;
  }
  const nums = parts.slice(-4).map((part) => Number(part.replace(/^m/, '-')));
  if (nums.some((value) => Number.isNaN(value))) {
    return null;
  }
  return {
    key: base,
    fileName,
    level: parts.slice(0, -4).join('_'),
    bounds: {
      minLat: nums[0],
      minLng: nums[1],
      maxLat: nums[2],
      maxLng: nums[3],
    },
  };
}

function pointInBounds(point, bounds) {
  const lon = lonOf(point);
  return (
    point.lat >= bounds.minLat &&
    point.lat <= bounds.maxLat &&
    lon >= bounds.minLng &&
    lon <= bounds.maxLng
  );
}

function loadMaptilerTiles(cacheDir) {
  if (!fs.existsSync(cacheDir)) {
    return [];
  }
  return fs
    .readdirSync(cacheDir)
    .map(parseTileFileName)
    .filter(Boolean)
    .map((meta) => {
      const filePath = path.join(cacheDir, meta.fileName);
      try {
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (payload?.source !== 'maptiler' || !Array.isArray(payload.elements)) {
          return null;
        }
        return { ...meta, filePath, payload };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stripHoleFills(ways) {
  return (ways || []).filter((way) => way?.tags?.hole_fill !== 'yes');
}

/**
 * Load every cached MapTiler rail tile, close holes across cell borders, write back.
 */
export function repairCachedRailTiles(cacheDir, options = {}) {
  const tiles = loadMaptilerTiles(cacheDir);
  if (tiles.length === 0) {
    return { tiles: 0, found: 0, closed: 0, remaining: 0, written: 0 };
  }

  const records = [];
  tiles.forEach((tile) => {
    stripHoleFills(tile.payload.elements).forEach((way, wayIndex) => {
      records.push({
        tileKey: tile.key,
        wayIndex,
        way,
      });
    });
  });

  const combined = records.map((record) => record.way);
  const result = closeRailHoles(combined, { skipEdges: false });

  tiles.forEach((tile) => {
    tile.payload.elements = [];
  });
  const tileByKey = new Map(tiles.map((tile) => [tile.key, tile]));
  result.elements.slice(0, records.length).forEach((way, index) => {
    const tile = tileByKey.get(records[index].tileKey);
    if (tile) {
      tile.payload.elements.push(way);
    }
  });
  (result.extraWays ?? []).forEach((bridge) => {
    const mid = bridge.geometry[0];
    const host =
      tiles.find((tile) => pointInBounds(mid, tile.bounds)) ??
      tiles[0];
    host.payload.elements.push(bridge);
  });

  let written = 0;
  tiles.forEach((tile) => {
    tile.payload.holesClosed = result.closed;
    tile.payload.holesFound = result.found;
    tile.payload.holesRemaining = result.remaining;
    tile.payload.holeVersion = HOLE_CLOSE_VERSION;
    tile.payload.seamRepaired = true;
    if (!options.dryRun) {
      fs.writeFileSync(tile.filePath, JSON.stringify(tile.payload));
      written += 1;
    }
  });

  return {
    tiles: tiles.length,
    found: result.found,
    closed: result.closed,
    remaining: result.remaining,
    bridges: result.bridges,
    written,
  };
}

function invokedFromCli() {
  const self = fileURLToPath(import.meta.url);
  const argv = process.argv[1];
  if (!argv) {
    return false;
  }
  return path.normalize(self) === path.normalize(path.resolve(argv));
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  const cacheDir =
    process.env.OSM_CACHE_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'osm-cache');
  const dryRun = args.has('--dry-run');
  const rebuild = args.has('--rebuild');

  if (rebuild) {
    const { fetchMaptilerRails } = await import('./maptilerRails.mjs');
    const tiles = loadMaptilerTiles(cacheDir);
    const apiKey = process.env.MAPTILER_KEY ?? '';
    for (const tile of tiles) {
      process.stdout.write(`Rebuilding ${tile.key} with milder simplify…\n`);
      const payload = await fetchMaptilerRails(tile.bounds, cacheDir, apiKey);
      if (payload?.complete) {
        fs.writeFileSync(tile.filePath, JSON.stringify(payload));
      } else {
        process.stderr.write(`Skipped ${tile.key}: incomplete (${payload?.missingTiles ?? '?'} missing)\n`);
      }
    }
  }

  const stats = repairCachedRailTiles(cacheDir, { dryRun });
  const prefix = dryRun ? '[dry-run] ' : '';
  process.stdout.write(
    `${prefix}Checked ${stats.tiles} tiles, found ${stats.found} holes, closed ${stats.closed}, ${stats.remaining} termini left, wrote ${stats.written} files.\n`
  );
}

if (invokedFromCli()) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
