import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { closeRailHoles, HOLE_CLOSE_VERSION } from './closeRailHoles.mjs';
import { fetchMaptilerAsset } from './maptilerStyle.mjs';

function tileRange(bounds, zoom) {
  const n = 2 ** zoom;
  const xMin = Math.max(0, Math.floor(((bounds.minLng + 180) / 360) * n));
  const xMax = Math.min(n - 1, Math.floor(((bounds.maxLng + 180) / 360) * n));
  const yOf = (lat) => {
    const rad = (lat * Math.PI) / 180;
    const merc = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
    return Math.floor(((1 - merc / Math.PI) / 2) * n);
  };
  const yNorth = yOf(bounds.maxLat);
  const ySouth = yOf(bounds.minLat);
  return {
    xMin,
    xMax,
    yMin: Math.max(0, Math.min(yNorth, ySouth)),
    yMax: Math.min(n - 1, Math.max(yNorth, ySouth)),
  };
}

function pointToLatLng(zoom, tileX, tileY, extent, point) {
  const n = 2 ** zoom;
  const lon = ((tileX + point.x / extent) / n) * 360 - 180;
  const mercY = (tileY + point.y / extent) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercY))) * 180) / Math.PI;
  return { lat, lon };
}

function railwayTag(properties) {
  const subclass = properties.subclass;
  if (subclass === 'tram' || subclass === 'subway' || subclass === 'light_rail' || subclass === 'narrow_gauge') {
    return subclass;
  }
  if (properties.class === 'transit') {
    return 'light_rail';
  }
  return 'rail';
}

function isRailFeature(properties) {
  const kind = properties.class;
  const subclass = String(properties.subclass ?? '');
  return (
    kind === 'rail' ||
    kind === 'transit' ||
    subclass === 'rail' ||
    subclass === 'narrow_gauge' ||
    subclass === 'subway' ||
    subclass === 'light_rail' ||
    subclass === 'tram' ||
    subclass === 'funicular' ||
    subclass === 'monorail'
  );
}

function railTags(properties) {
  const tags = { railway: railwayTag(properties) };
  if (properties.brunnel === 'tunnel' || properties.tunnel === true || properties.tunnel === 'yes') {
    tags.tunnel = 'yes';
  }
  if (properties.brunnel === 'bridge' || properties.bridge === true || properties.bridge === 'yes') {
    tags.bridge = 'yes';
  }
  return tags;
}

function waysFromTile(buffer, zoom, tileX, tileY) {
  let data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    data = zlib.gunzipSync(data);
  }
  const tile = new VectorTile(new PbfReader(data));
  const layer = tile.layers.transportation;
  if (!layer) {
    return [];
  }
  const ways = [];
  for (let index = 0; index < layer.length; index += 1) {
    const feature = layer.feature(index);
    if (!isRailFeature(feature.properties)) {
      continue;
    }
    const rings = feature.loadGeometry();
    rings.forEach((ring, ringIndex) => {
      if (ring.length < 2) {
        return;
      }
      ways.push({
        type: 'way',
        id: (tileX * 100000 + tileY) * 1000 + index * 10 + ringIndex,
        tags: railTags(feature.properties),
        geometry: ring.map((point) => pointToLatLng(zoom, tileX, tileY, layer.extent, point)),
      });
    });
  }
  return ways;
}

async function loadVectorTile(cacheDir, zoom, tileX, tileY, _apiKey) {
  const file = path.join(cacheDir, `ofmrail_${zoom}_${tileX}_${tileY}.json`);
  if (fs.existsSync(file)) {
    try {
      return { ways: JSON.parse(fs.readFileSync(file, 'utf8')), ok: true };
    } catch {
      fs.unlinkSync(file);
    }
  }
  const asset = await fetchMaptilerAsset(cacheDir, '', `/tiles/v3/${zoom}/${tileX}/${tileY}.pbf`);
  if (!asset?.buffer || asset.buffer.length === 0) {
    return { ways: [], ok: false };
  }
  try {
    const ways = waysFromTile(asset.buffer, zoom, tileX, tileY);
    fs.writeFileSync(file, JSON.stringify(ways));
    return { ways, ok: true };
  } catch (error) {
    console.error(
      `OpenFreeMap rail parse ${zoom}/${tileX}/${tileY}:`,
      error instanceof Error ? error.message : error
    );
    return { ways: [], ok: false };
  }
}

const PAIR_MIN_METERS = 1.5;
const PAIR_MAX_METERS = 24;
const PAIR_ANGLE_DEGREES = 20;
const PAIR_MIN_MATCH_METERS = 300;
const PAIR_MIN_BOTH_COVERAGE = 0.45;
const PAIR_LOOP_MATCH_METERS = 520;
export const RAIL_SHAPE_VERSION = 8;

function metersBetween(a, b) {
  const lat = (b.lat - a.lat) * 111320;
  const lng =
    ((b.lon ?? b.lng) - (a.lon ?? a.lng)) *
    111320 *
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(lat, lng);
}

function bearingDegrees(a, b) {
  const lat = (b.lat - a.lat) * 111320;
  const lng =
    ((b.lon ?? b.lng) - (a.lon ?? a.lng)) *
    111320 *
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return (Math.atan2(lng, lat) * 180) / Math.PI;
}

function angleBetween(left, right) {
  let delta = Math.abs(left - right) % 180;
  if (delta > 90) {
    delta = 180 - delta;
  }
  return delta;
}

function lineLength(line) {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) {
    total += metersBetween(line[index - 1], line[index]);
  }
  return total;
}

function closestOnLine(point, line) {
  let best = null;
  for (let index = 0; index < line.length - 1; index += 1) {
    const start = line[index];
    const end = line[index + 1];
    const latScale = 111320;
    const lngScale = 111320 * Math.cos((point.lat * Math.PI) / 180);
    const ax = (start.lon ?? start.lng) * lngScale;
    const ay = start.lat * latScale;
    const bx = (end.lon ?? end.lng) * lngScale;
    const by = end.lat * latScale;
    const px = (point.lon ?? point.lng) * lngScale;
    const py = point.lat * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    const projected = {
      lat: start.lat + (end.lat - start.lat) * t,
      lon: (start.lon ?? start.lng) + ((end.lon ?? end.lng) - (start.lon ?? start.lng)) * t,
    };
    const distance = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (!best || distance < best.distance) {
      best = { distance, point: projected, bearing: bearingDegrees(start, end) };
    }
  }
  return best;
}

function parallelHits(source, target) {
  const hits = [];
  for (let index = 0; index < source.length; index += 1) {
    const point = source[index];
    const before = source[Math.max(0, index - 1)];
    const after = source[Math.min(source.length - 1, index + 1)];
    const near = closestOnLine(point, target);
    if (!near) {
      continue;
    }
    if (near.distance < PAIR_MIN_METERS || near.distance > PAIR_MAX_METERS) {
      continue;
    }
    if (angleBetween(bearingDegrees(before, after), near.bearing) > PAIR_ANGLE_DEGREES) {
      continue;
    }
    hits.push({ index, distance: near.distance, point: near.point });
  }
  return hits;
}

function cellKey(point) {
  const latStep = PAIR_MAX_METERS / 111320;
  const lngStep = PAIR_MAX_METERS / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
  const lon = point.lon ?? point.lng;
  return `${Math.floor(point.lat / latStep)}:${Math.floor(lon / lngStep)}`;
}

/**
 * Replace a pair of tracks that run side by side with the centerline between them.
 * A track that splits away is left in place.
 */
export function collapseDoubleTracks(ways) {
  const lines = ways.map((way) =>
    (way.geometry || []).map((point) => ({ lat: point.lat, lon: point.lon ?? point.lng }))
  );
  const parent = lines.map((_, index) => index);
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

  const grid = new Map();
  lines.forEach((line, index) => {
    const seen = new Set();
    line.forEach((point) => {
      const key = cellKey(point);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const bucket = grid.get(key) ?? [];
      bucket.push(index);
      grid.set(key, bucket);
    });
  });

  const considered = new Set();
  lines.forEach((line, index) => {
    if ((ways[index].tags?.railway ?? 'rail') !== 'rail' || line.length < 2) {
      return;
    }
    const neighbors = new Set();
    line.forEach((point) => {
      const latStep = PAIR_MAX_METERS / 111320;
      const lngStep = PAIR_MAX_METERS / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
      const lon = point.lon ?? point.lng;
      const row = Math.floor(point.lat / latStep);
      const col = Math.floor(lon / lngStep);
      for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
          const bucket = grid.get(`${row + rowOffset}:${col + colOffset}`);
          if (!bucket) {
            continue;
          }
          bucket.forEach((other) => {
            if (other !== index) {
              neighbors.add(other);
            }
          });
        }
      }
    });
    neighbors.forEach((other) => {
      const mark = index < other ? `${index}:${other}` : `${other}:${index}`;
      if (considered.has(mark)) {
        return;
      }
      considered.add(mark);
      if ((ways[other].tags?.railway ?? 'rail') !== 'rail' || lines[other].length < 2) {
        return;
      }
      const leftHits = parallelHits(line, lines[other]);
      const rightHits = parallelHits(lines[other], line);
      const leftCoverage = leftHits.length / line.length;
      const rightCoverage = rightHits.length / lines[other].length;
      const distances = (leftCoverage >= rightCoverage ? leftHits : rightHits).map((hit) => hit.distance);
      if (distances.length < 2) {
        return;
      }
      const matchedLine = leftCoverage >= rightCoverage ? line : lines[other];
      const matchedMeters = (distances.length / matchedLine.length) * lineLength(matchedLine);
      const minCoverage = Math.min(leftCoverage, rightCoverage);
      const maxCoverage = Math.max(leftCoverage, rightCoverage);
      const shorterMeters = Math.min(lineLength(line), lineLength(lines[other]));
      const longDoubleTrack = minCoverage >= PAIR_MIN_BOTH_COVERAGE && matchedMeters >= PAIR_MIN_MATCH_METERS;
      const longPassingLoop =
        maxCoverage >= 0.85 &&
        matchedMeters >= PAIR_LOOP_MATCH_METERS &&
        matchedMeters >= shorterMeters * 0.7;
      if (!longDoubleTrack && !longPassingLoop) {
        return;
      }
      unite(index, other);
    });
  });

  const groups = new Map();
  lines.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });

  const drop = new Set();
  const extras = [];
  groups.forEach((members) => {
    if (members.length < 2) {
      return;
    }
    members.sort((left, right) => lineLength(lines[right]) - lineLength(lines[left]));
    const spine = members[0];
    const partners = members.slice(1);
    const originalSpine = lines[spine].map((point) => ({ ...point }));
    const partnerHits = partners.map((partner) => parallelHits(lines[partner], originalSpine));
    lines[spine] = originalSpine.map((point, pointIndex) => {
      const before = originalSpine[Math.max(0, pointIndex - 1)];
      const after = originalSpine[Math.min(originalSpine.length - 1, pointIndex + 1)];
      const direction = bearingDegrees(before, after);
      const samples = [{ lat: point.lat, lon: point.lon }];
      partners.forEach((partner) => {
        const near = closestOnLine(point, lines[partner]);
        if (!near || near.distance < PAIR_MIN_METERS || near.distance > PAIR_MAX_METERS) {
          return;
        }
        if (angleBetween(direction, near.bearing) > PAIR_ANGLE_DEGREES) {
          return;
        }
        samples.push(near.point);
      });
      if (samples.length === 1) {
        return point;
      }
      return {
        lat: samples.reduce((sum, sample) => sum + sample.lat, 0) / samples.length,
        lon: samples.reduce((sum, sample) => sum + sample.lon, 0) / samples.length,
      };
    });
    partners.forEach((partner, partnerIndex) => {
      drop.add(partner);
      const matched = new Set(partnerHits[partnerIndex].map((hit) => hit.index));
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          extras.push({
            type: 'way',
            id: ways[partner].id + run[0] * 17,
            tags: ways[partner].tags,
            geometry: run.map((point) => ({ lat: point.lat, lon: point.lon })),
          });
        }
        run = [];
      };
      lines[partner].forEach((point, pointIndex) => {
        if (matched.has(pointIndex)) {
          if (run.length > 0) {
            const join = closestOnLine(point, lines[spine]);
            if (join) {
              run.push(join.point);
            }
          }
          flush();
          return;
        }
        if (run.length === 0 && pointIndex > 0 && matched.has(pointIndex - 1)) {
          const join = closestOnLine(lines[partner][pointIndex - 1], lines[spine]);
          if (join) {
            run.push(join.point);
          }
        }
        run.push(point);
      });
      flush();
    });
  });

  const elements = [];
  ways.forEach((way, index) => {
    if (drop.has(index) || lines[index].length < 2) {
      return;
    }
    elements.push({
      ...way,
      geometry: lines[index].map((point) => ({ lat: point.lat, lon: point.lon })),
    });
  });
  extras.forEach((way) => elements.push(way));
  return { elements, before: ways.length, after: elements.length };
}

const STRAIGHT_TOLERANCE_METERS = 1.4;
const CURVE_TOLERANCE_METERS = 0.45;
const STRAIGHT_HEADING_DEGREES = 4;
const END_SNAP_METERS = 30;
const SEGMENT_JOIN_METERS = 45;
const GAP_BRIDGE_METERS = 120;
const JUNCTION_KEEP_METERS = 35;
const MIN_POINT_METERS = 0.5;

function perpendicularMeters(point, start, end) {
  const near = closestOnLine(point, [start, end]);
  return near ? near.distance : 0;
}

function simplifyLine(points, start, end, straightMeters, curveMeters) {
  if (end <= start) {
    return [points[start]];
  }
  let maxDistance = 0;
  let index = -1;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const distance = perpendicularMeters(points[cursor], points[start], points[end]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = cursor;
    }
  }
  const mid = start + Math.max(1, Math.floor((end - start) / 2));
  const heading = angleBetween(
    bearingDegrees(points[start], points[Math.min(end - 1, mid)]),
    bearingDegrees(points[Math.max(start + 1, mid)], points[end])
  );
  const tolerance = heading < STRAIGHT_HEADING_DEGREES ? straightMeters : curveMeters;
  if (maxDistance > tolerance && index !== -1) {
    const left = simplifyLine(points, start, index, straightMeters, curveMeters);
    const right = simplifyLine(points, index, end, straightMeters, curveMeters);
    return left.concat(right.slice(1));
  }
  return [points[start], points[end]];
}

function joinCellKeys(point, meters) {
  const latStep = meters / 111320;
  const lngStep = meters / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
  const lon = point.lon ?? point.lng;
  const row = Math.floor(point.lat / latStep);
  const col = Math.floor(lon / lngStep);
  const keys = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      keys.push(`${row + rowOffset}:${col + colOffset}`);
    }
  }
  return keys;
}

function pointKey(point) {
  return `${point.lat.toFixed(6)}:${(point.lon ?? point.lng).toFixed(6)}`;
}

function cleanLine(points) {
  const cleaned = [];
  points.forEach((point) => {
    const last = cleaned[cleaned.length - 1];
    if (!last || metersBetween(last, point) > MIN_POINT_METERS) {
      cleaned.push(point);
    }
  });
  return cleaned;
}

function outgoingBearing(line, endIndex) {
  if (line.length < 2) {
    return 0;
  }
  if (endIndex === 0) {
    return bearingDegrees(line[0], line[1]);
  }
  return bearingDegrees(line[line.length - 1], line[line.length - 2]);
}

function isContinuation(lineA, endA, lineB, endB) {
  const from = lineA[endA];
  const to = lineB[endB];
  return (
    angleBetween(outgoingBearing(lineA, endA), bearingDegrees(from, to)) <= 40 &&
    angleBetween(outgoingBearing(lineB, endB), bearingDegrees(to, from)) <= 40
  );
}

function buildEndpointGrid(ways) {
  const grid = new Map();
  ways.forEach((way, wayIndex) => {
    const geometry = way.geometry || [];
    if (geometry.length < 2) {
      return;
    }
    [geometry[0], geometry[geometry.length - 1]].forEach((point) => {
      joinCellKeys(point, JUNCTION_KEEP_METERS).forEach((key) => {
        const bucket = grid.get(key) ?? [];
        bucket.push({ wayIndex, point });
        grid.set(key, bucket);
      });
    });
  });
  return grid;
}

function nearForeignEndpoint(point, wayIndex, grid) {
  const keys = joinCellKeys(point, JUNCTION_KEEP_METERS);
  for (const key of keys) {
    const bucket = grid.get(key);
    if (!bucket) {
      continue;
    }
    for (const entry of bucket) {
      if (entry.wayIndex === wayIndex) {
        continue;
      }
      if (metersBetween(point, entry.point) <= JUNCTION_KEEP_METERS) {
        return true;
      }
    }
  }
  return false;
}

/** Drop points along straight runs. Curves and junctions keep their vertices. */
export function simplifyStraights(ways, options = {}) {
  const straightMeters = options.straightMeters ?? STRAIGHT_TOLERANCE_METERS;
  const curveMeters = options.curveMeters ?? CURVE_TOLERANCE_METERS;
  const endpointGrid = buildEndpointGrid(ways);
  let before = 0;
  let after = 0;
  const elements = ways.map((way, wayIndex) => {
    const geometry = way.geometry || [];
    before += geometry.length;
    if (geometry.length < 3) {
      after += geometry.length;
      return way;
    }
    const points = geometry.map((point) => ({ lat: point.lat, lon: point.lon ?? point.lng }));
    const kept = simplifyLine(points, 0, points.length - 1, straightMeters, curveMeters);
    const keptKeys = new Set(kept.map(pointKey));
    const restored = [];
    points.forEach((point, index) => {
      if (
        index === 0 ||
        index === points.length - 1 ||
        keptKeys.has(pointKey(point)) ||
        nearForeignEndpoint(point, wayIndex, endpointGrid)
      ) {
        restored.push(point);
      }
    });
    after += restored.length;
    return {
      ...way,
      geometry: restored.map((point) => ({ lat: point.lat, lon: point.lon })),
    };
  });
  return { elements, before, after };
}

/**
 * Snap nearby rail ends onto each other and onto nearby segments so tile seams
 * and leftover double-track stubs do not leave gaps.
 */
export function stitchRailNetwork(ways, endSnapMeters = END_SNAP_METERS, segmentJoinMeters = SEGMENT_JOIN_METERS) {
  const lines = ways.map((way) =>
    (way.geometry || []).map((point) => ({ lat: point.lat, lon: point.lon ?? point.lng }))
  );
  const endpoints = [];
  lines.forEach((line, lineIndex) => {
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

  const endpointGrid = new Map();
  endpoints.forEach((endpoint, index) => {
    joinCellKeys(lines[endpoint.line][endpoint.index], endSnapMeters).forEach((key) => {
      const bucket = endpointGrid.get(key) ?? [];
      bucket.push(index);
      endpointGrid.set(key, bucket);
    });
  });
  const considered = new Set();
  endpointGrid.forEach((bucket) => {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const a = bucket[left];
        const b = bucket[right];
        const mark = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (considered.has(mark)) {
          continue;
        }
        considered.add(mark);
        if (endpoints[a].line === endpoints[b].line) {
          continue;
        }
        const leftPoint = lines[endpoints[a].line][endpoints[a].index];
        const rightPoint = lines[endpoints[b].line][endpoints[b].index];
        if (
          metersBetween(leftPoint, rightPoint) <= endSnapMeters &&
          isContinuation(
            lines[endpoints[a].line],
            endpoints[a].index,
            lines[endpoints[b].line],
            endpoints[b].index
          )
        ) {
          unite(a, b);
        }
      }
    }
  });

  const snappedEnds = new Set();
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
        const point = lines[endpoints[member].line][endpoints[member].index];
        return { lat: sum.lat + point.lat, lon: sum.lon + point.lon };
      },
      { lat: 0, lon: 0 }
    );
    centroid.lat /= members.length;
    centroid.lon /= members.length;
    members.forEach((member) => {
      const slot = endpoints[member];
      lines[slot.line][slot.index] = { ...centroid };
      snappedEnds.add(member);
    });
  });

  const segmentGrid = new Map();
  lines.forEach((line, lineIndex) => {
    for (let segment = 0; segment < line.length - 1; segment += 1) {
      const keys = new Set([
        ...joinCellKeys(line[segment], segmentJoinMeters),
        ...joinCellKeys(line[segment + 1], segmentJoinMeters),
      ]);
      keys.forEach((key) => {
        const bucket = segmentGrid.get(key) ?? [];
        bucket.push({ line: lineIndex, segment });
        segmentGrid.set(key, bucket);
      });
    }
  });

  const insertions = [];
  endpoints.forEach((endpoint, endpointIndex) => {
    if (snappedEnds.has(endpointIndex)) {
      return;
    }
    const line = lines[endpoint.line];
    const point = line[endpoint.index];
    let bestDistance = segmentJoinMeters;
    let bestPoint = null;
    let bestLine = -1;
    let bestSegment = -1;
    const seen = new Set();
    joinCellKeys(point, segmentJoinMeters).forEach((key) => {
      const bucket = segmentGrid.get(key);
      if (!bucket) {
        return;
      }
      bucket.forEach(({ line: otherIndex, segment }) => {
        if (otherIndex === endpoint.line) {
          return;
        }
        const mark = `${otherIndex}:${segment}`;
        if (seen.has(mark)) {
          return;
        }
        seen.add(mark);
        const other = lines[otherIndex];
        if (segment >= other.length - 1) {
          return;
        }
        const near = closestOnLine(point, [other[segment], other[segment + 1]]);
        if (!near || near.distance >= bestDistance) {
          return;
        }
        if (angleBetween(outgoingBearing(line, endpoint.index), bearingDegrees(point, near.point)) > 45) {
          return;
        }
        bestDistance = near.distance;
        bestPoint = near.point;
        bestLine = otherIndex;
        bestSegment = segment;
      });
    });
    if (!bestPoint || bestLine < 0) {
      return;
    }
    const host = lines[bestLine];
    const start = host[bestSegment];
    const end = host[bestSegment + 1];
    if (metersBetween(bestPoint, start) < 12) {
      line[endpoint.index] = { ...start };
      return;
    }
    if (metersBetween(bestPoint, end) < 12) {
      line[endpoint.index] = { ...end };
      return;
    }
    line[endpoint.index] = { ...bestPoint };
    insertions.push({ line: bestLine, segment: bestSegment, point: { ...bestPoint } });
  });

  insertions
    .sort((left, right) => right.line - left.line || right.segment - left.segment)
    .forEach((insertion) => {
      lines[insertion.line].splice(insertion.segment + 1, 0, insertion.point);
    });

  const bridges = [];
  const bridged = new Set();
  const liveEnds = [];
  lines.forEach((line, lineIndex) => {
    if (line.length < 2) {
      return;
    }
    liveEnds.push({ line: lineIndex, index: 0 });
    liveEnds.push({ line: lineIndex, index: line.length - 1 });
  });
  const gapGrid = new Map();
  liveEnds.forEach((endpoint, index) => {
    joinCellKeys(lines[endpoint.line][endpoint.index], GAP_BRIDGE_METERS).forEach((key) => {
      const bucket = gapGrid.get(key) ?? [];
      bucket.push(index);
      gapGrid.set(key, bucket);
    });
  });
  liveEnds.forEach((left, leftIndex) => {
    if (bridged.has(leftIndex)) {
      return;
    }
    const leftLine = lines[left.line];
    const leftPoint = leftLine[left.index];
    let bestDistance = GAP_BRIDGE_METERS;
    let bestIndex = -1;
    joinCellKeys(leftPoint, GAP_BRIDGE_METERS).forEach((key) => {
      const bucket = gapGrid.get(key);
      if (!bucket) {
        return;
      }
      bucket.forEach((rightIndex) => {
        if (rightIndex === leftIndex || bridged.has(rightIndex)) {
          return;
        }
        const right = liveEnds[rightIndex];
        if (right.line === left.line) {
          return;
        }
        const rightLine = lines[right.line];
        const rightPoint = rightLine[right.index];
        const distance = metersBetween(leftPoint, rightPoint);
        if (
          distance < bestDistance &&
          isContinuation(leftLine, left.index, rightLine, right.index)
        ) {
          bestDistance = distance;
          bestIndex = rightIndex;
        }
      });
    });
    if (bestIndex < 0 || bestDistance <= MIN_POINT_METERS) {
      return;
    }
    const right = liveEnds[bestIndex];
    const rightPoint = lines[right.line][right.index];
    if (bestDistance <= endSnapMeters) {
      const mid = {
        lat: (leftPoint.lat + rightPoint.lat) / 2,
        lon: (leftPoint.lon + rightPoint.lon) / 2,
      };
      leftLine[left.index] = { ...mid };
      lines[right.line][right.index] = { ...mid };
    } else {
      bridges.push({
        type: 'way',
        id: 800000000 + left.line * 1000 + right.line,
        tags: ways[left.line]?.tags ?? { railway: 'rail' },
        geometry: [
          { lat: leftPoint.lat, lon: leftPoint.lon },
          { lat: rightPoint.lat, lon: rightPoint.lon },
        ],
      });
    }
    bridged.add(leftIndex);
    bridged.add(bestIndex);
  });

  const stitched = ways
    .map((way, index) => {
      const geometry = cleanLine(lines[index] ?? []);
      if (geometry.length < 2) {
        return null;
      }
      return {
        ...way,
        geometry: geometry.map((point) => ({ lat: point.lat, lon: point.lon })),
      };
    })
    .filter(Boolean);
  bridges.forEach((bridge) => stitched.push(bridge));
  return stitched;
}

export function flattenSimplifiedRail(way) {
  return {
    ...way,
    tags: { railway: way.tags?.railway ?? 'rail' },
  };
}

function mergeConnectedLineGeometries(lines) {
  const unused = new Set(lines.map((_, index) => index).filter((index) => lines[index].length >= 2));
  const byEnd = new Map();

  const addEnd = (line, end) => {
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

  const takeOther = (line, end) => {
    const point = end === 0 ? lines[line][0] : lines[line][lines[line].length - 1];
    const bucket = (byEnd.get(pointKey(point)) ?? []).filter(
      (entry) => unused.has(entry.line) && entry.line !== line
    );
    if (bucket.length !== 1) {
      return null;
    }
    return bucket[0];
  };

  const merged = [];
  unused.forEach((startLine) => {
    if (!unused.has(startLine)) {
      return;
    }
    let chain = [...lines[startLine]];
    unused.delete(startLine);

    const grow = (fromEnd) => {
      let currentLine = startLine;
      let currentEnd = fromEnd;
      for (let steps = 0; steps < 8000; steps += 1) {
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

/** Weld degree-2 chains so tunnel/bridge cuts become one continuous rail. */
export function mergeConnectedWays(ways) {
  const groups = new Map();
  ways.forEach((way, index) => {
    if (!Array.isArray(way?.geometry) || way.geometry.length < 2) {
      return;
    }
    const kind = way.tags?.railway ?? 'rail';
    const list = groups.get(kind) ?? [];
    list.push(index);
    groups.set(kind, list);
  });
  const out = [];
  groups.forEach((indexes, kind) => {
    const lines = indexes.map((index) =>
      ways[index].geometry.map((point) => ({ lat: point.lat, lon: point.lon ?? point.lng }))
    );
    mergeConnectedLineGeometries(lines).forEach((item, offset) => {
      out.push({
        type: 'way',
        id: ways[indexes[item.source]]?.id ?? offset,
        tags: { railway: kind },
        geometry: item.points.map((point) => ({ lat: point.lat, lon: point.lon })),
      });
    });
  });
  return out;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function countWayPoints(ways) {
  return ways.reduce((sum, way) => sum + (way.geometry?.length ?? 0), 0);
}

/** The black lines from mapa.zsr.sk: MapTiler planet tiles, transportation class rail or transit. */
export async function fetchMaptilerRails(bounds, cacheDir, apiKey, zoom = 11, options = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const range = tileRange(bounds, zoom);
  const tiles = [];
  for (let x = range.xMin; x <= range.xMax; x += 1) {
    for (let y = range.yMin; y <= range.yMax; y += 1) {
      tiles.push([x, y]);
    }
  }
  console.log(`MapTiler rails: reading ${tiles.length} tiles at z${zoom}`);
  const groups = await mapLimit(tiles, 8, ([x, y]) => loadVectorTile(cacheDir, zoom, x, y, apiKey));
  const missingTiles = groups.filter((group) => !group.ok).length;
  console.log(`MapTiler rails: loaded ${groups.filter((group) => group.ok).length}/${tiles.length} tiles, collapsing tracks`);
  const collapsed = collapseDoubleTracks(groups.flatMap((group) => group.ways));
  const joined = stitchRailNetwork(collapsed.elements);
  const shaped = options.skipSimplify
    ? { elements: joined, before: countWayPoints(joined), after: countWayPoints(joined) }
    : simplifyStraights(joined, options);
  const stitched = stitchRailNetwork(shaped.elements);
  const holes = closeRailHoles(stitched, { bounds, skipEdges: true });
  return {
    elements: holes.elements,
    simplified: options.skipSimplify ? false : true,
    collapsed: true,
    collapsedFrom: collapsed.before,
    collapsedTo: collapsed.after,
    shapeVersion: RAIL_SHAPE_VERSION,
    pointsBefore: shaped.before,
    pointsAfter: shaped.after,
    holesFound: holes.found,
    holesClosed: holes.closed,
    holesRemaining: holes.remaining,
    holeVersion: HOLE_CLOSE_VERSION,
    source: 'maptiler',
    maptilerZoom: zoom,
    maptilerTiles: tiles.length,
    missingTiles,
    complete: missingTiles === 0,
  };
}

function wayTouchesBounds(way, bounds) {
  const geometry = way.geometry;
  if (!Array.isArray(geometry) || geometry.length < 2) {
    return false;
  }
  return geometry.some((point) => {
    const lng = point.lon ?? point.lng;
    return (
      point.lat >= bounds.minLat &&
      point.lat <= bounds.maxLat &&
      lng >= bounds.minLng &&
      lng <= bounds.maxLng
    );
  });
}

/** Uncollapsed MapTiler rails for close-up display. Reuses the same MVT cache. */
export async function fetchMaptilerRailsDisplay(bounds, cacheDir, apiKey, zoom = 13) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const range = tileRange(bounds, zoom);
  const tiles = [];
  for (let x = range.xMin; x <= range.xMax; x += 1) {
    for (let y = range.yMin; y <= range.yMax; y += 1) {
      tiles.push([x, y]);
    }
  }
  const groups = await mapLimit(tiles, 8, ([x, y]) => loadVectorTile(cacheDir, zoom, x, y, apiKey));
  const missingTiles = groups.filter((group) => !group.ok).length;
  const elements = groups
    .flatMap((group) => group.ways)
    .filter((way) => wayTouchesBounds(way, bounds));
  return {
    elements,
    simplified: false,
    collapsed: false,
    source: 'maptiler-display',
    maptilerZoom: zoom,
    maptilerTiles: tiles.length,
    missingTiles,
    complete: missingTiles === 0,
  };
}
