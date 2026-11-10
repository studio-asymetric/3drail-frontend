export const RAIL_PACK_MAGIC = 'RNET';
export const RAIL_PACK_DECIMALS = 5;
export const RAIL_KINDS = [
  'rail',
  'light_rail',
  'subway',
  'tram',
  'narrow_gauge',
  'monorail',
  'funicular',
] as const;

export type PackedWay = {
  type: 'way';
  id: number;
  nodes: number[];
  tags: {
    railway?: string;
    bridge?: string;
    tunnel?: string;
  };
  geometry: Array<{ lat: number; lon: number }>;
};

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeRailPack(input: Uint8Array | ArrayBuffer): Promise<PackedWay[]> {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = await gunzipBytes(bytes);
  }
  const head = String.fromCharCode(...bytes.slice(0, Math.min(40, bytes.length)));
  if (head.startsWith('<') || head.startsWith('{')) {
    throw new Error(`Invalid rail pack (got ${head.replace(/\s+/g, ' ').slice(0, 48)})`);
  }
  return unpackRails(bytes);
}

export function unpackRails(input: Uint8Array | ArrayBuffer): PackedWay[] {
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
  const ways: PackedWay[] = [];
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
    const tags: PackedWay['tags'] = { railway: RAIL_KINDS[flags & 7] ?? 'rail' };
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
