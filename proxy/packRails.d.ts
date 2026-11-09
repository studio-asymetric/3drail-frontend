export const RAIL_PACK_MAGIC: string;
export const RAIL_PACK_VERSION: number;
export const RAIL_PACK_DECIMALS: number;
export const RAIL_KINDS: string[];

type PackedWay = {
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

export function packRails(ways: Array<{ tags?: PackedWay['tags']; geometry?: PackedWay['geometry'] }>): Uint8Array;
export function unpackRails(input: Uint8Array | ArrayBuffer): PackedWay[];
