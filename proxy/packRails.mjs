export const RAIL_PACK_MAGIC = 'RNET';
export const RAIL_PACK_VERSION = 1;
export const RAIL_PACK_DECIMALS = 5;
export const RAIL_KINDS = [
  'rail',
  'light_rail',
  'subway',
  'tram',
  'narrow_gauge',
  'monorail',
  'funicular',
];

const SCALE = 10 ** RAIL_PACK_DECIMALS;
const MAX_DELTA = 32767;

function kindIndex(railway) {
  const index = RAIL_KINDS.indexOf(railway);
  return index >= 0 ? index : 0;
}

function wayFlags(way) {
  const tags = way.tags ?? {};
  let flags = kindIndex(tags.railway ?? 'rail') & 7;
  if (tags.bridge === 'yes' || tags.bridge === 'true' || tags.bridge === 'viaduct' || tags.bridge === '1') {
    flags |= 8;
  }
  if (tags.tunnel === 'yes' || tags.tunnel === 'true') {
    flags |= 16;
  }
  return flags;
}

function quantizePoints(geometry) {
  return geometry.map((point) => ({
    lat: Math.round(point.lat * SCALE),
    lon: Math.round((point.lon ?? point.lng) * SCALE),
  }));
}

function splitForDeltas(points) {
  const chains = [];
  let current = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = current[current.length - 1];
    const dlat = points[index].lat - previous.lat;
    const dlon = points[index].lon - previous.lon;
    if (dlat > MAX_DELTA || dlat < -MAX_DELTA || dlon > MAX_DELTA || dlon < -MAX_DELTA) {
      if (current.length >= 2) {
        chains.push(current);
      }
      current = [points[index]];
    } else {
      current.push(points[index]);
    }
  }
  if (current.length >= 2) {
    chains.push(current);
  }
  return chains;
}

export function packRails(ways) {
  const chains = [];
  ways.forEach((way) => {
    const geometry = way.geometry || [];
    if (geometry.length < 2) {
      return;
    }
    const flags = wayFlags(way);
    splitForDeltas(quantizePoints(geometry)).forEach((points) => {
      chains.push({ flags, points });
    });
  });

  let size = 12;
  chains.forEach((chain) => {
    size += 11 + (chain.points.length - 1) * 4;
  });

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes[0] = 82;
  bytes[1] = 78;
  bytes[2] = 69;
  bytes[3] = 84;
  bytes[4] = RAIL_PACK_VERSION;
  bytes[5] = RAIL_PACK_DECIMALS;
  view.setUint16(6, 0, true);
  view.setUint32(8, chains.length, true);

  let offset = 12;
  chains.forEach((chain) => {
    view.setUint8(offset, chain.flags);
    offset += 1;
    view.setUint16(offset, chain.points.length, true);
    offset += 2;
    view.setInt32(offset, chain.points[0].lat, true);
    offset += 4;
    view.setInt32(offset, chain.points[0].lon, true);
    offset += 4;
    for (let index = 1; index < chain.points.length; index += 1) {
      view.setInt16(offset, chain.points[index].lat - chain.points[index - 1].lat, true);
      offset += 2;
      view.setInt16(offset, chain.points[index].lon - chain.points[index - 1].lon, true);
      offset += 2;
    }
  });

  return bytes;
}

export function unpackRails(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12) {
    throw new Error('Rail pack is too small');
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== RAIL_PACK_MAGIC) {
    throw new Error('Invalid rail pack');
  }
  const decimals = bytes[5] || RAIL_PACK_DECIMALS;
  const scale = 10 ** decimals;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wayCount = view.getUint32(8, true);
  let offset = 12;
  const ways = [];
  for (let index = 0; index < wayCount; index += 1) {
    const flags = view.getUint8(offset);
    offset += 1;
    const count = view.getUint16(offset, true);
    offset += 2;
    let lat = view.getInt32(offset, true);
    offset += 4;
    let lon = view.getInt32(offset, true);
    offset += 4;
    const geometry = [{ lat: lat / scale, lon: lon / scale }];
    for (let pointIndex = 1; pointIndex < count; pointIndex += 1) {
      lat += view.getInt16(offset, true);
      offset += 2;
      lon += view.getInt16(offset, true);
      offset += 2;
      geometry.push({ lat: lat / scale, lon: lon / scale });
    }
    const tags = { railway: RAIL_KINDS[flags & 7] ?? 'rail' };
    if (flags & 8) {
      tags.bridge = 'yes';
    }
    if (flags & 16) {
      tags.tunnel = 'yes';
    }
    ways.push({
      type: 'way',
      id: index + 1,
      nodes: [],
      tags,
      geometry,
    });
  }
  return ways;
}
