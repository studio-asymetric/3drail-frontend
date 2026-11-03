import { fetchRailwayLinesInBounds, OsmFetchResult } from '../data/osmRailService';
import type { OsmDetailLevel } from '../types/osm';

export type TileBounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

type LoadTileMessage = {
  type: 'loadTile';
  id: number;
  bounds: TileBounds;
  level: OsmDetailLevel;
};

type TileResponse =
  | {
      type: 'tileResult';
      id: number;
      key: string;
      level: OsmDetailLevel;
      result: OsmFetchResult;
    }
  | {
      type: 'tileError';
      id: number;
      error: string;
    };

const ctx: Worker = self as any;

ctx.addEventListener('message', async (event: MessageEvent<LoadTileMessage>) => {
  const { id, bounds, level } = event.data;
  const key = `${bounds.minLat}:${bounds.maxLat}:${bounds.minLng}:${bounds.maxLng}:${level}`;

  try {
    const result = await fetchRailwayLinesInBounds(
      bounds.minLat,
      bounds.maxLat,
      bounds.minLng,
      bounds.maxLng,
      level
    );
    ctx.postMessage({
      type: 'tileResult',
      id,
      key,
      level,
      result,
    } as TileResponse);
  } catch (error) {
    ctx.postMessage({
      type: 'tileError',
      id,
      error: error instanceof Error ? error.message : String(error),
    } as TileResponse);
  }
});

