import { describe, expect, it } from 'vitest';
import {
  isDetailDisplayWay,
  isMainlineWay,
  isPathfindingWay,
  isSideRailwayTrack,
  type OSMWay,
} from '../data/osmRailService';

function way(tags: Record<string, string>): OSMWay {
  return {
    id: 1,
    type: 'way',
    nodes: [1, 2],
    geometry: [
      { lat: 48.15, lon: 17.1 },
      { lat: 48.16, lon: 17.11 },
    ],
    tags,
  };
}

describe('isDetailDisplayWay', () => {
  it('keeps through rail and Tatra metre-gauge', () => {
    expect(isDetailDisplayWay(way({ railway: 'rail' }))).toBe(true);
    expect(isDetailDisplayWay(way({ railway: 'narrow_gauge' }))).toBe(true);
  });

  it('drops yards, sidings, crossovers, and industrial spurs', () => {
    expect(isDetailDisplayWay(way({ railway: 'rail', service: 'siding' }))).toBe(false);
    expect(isDetailDisplayWay(way({ railway: 'rail', service: 'yard' }))).toBe(false);
    expect(isDetailDisplayWay(way({ railway: 'rail', service: 'spur' }))).toBe(false);
    expect(isDetailDisplayWay(way({ railway: 'rail', service: 'crossover' }))).toBe(false);
    expect(isDetailDisplayWay(way({ railway: 'rail', usage: 'industrial' }))).toBe(false);
  });

  it('drops tram and light rail that the ZSR detail map does not show', () => {
    expect(isDetailDisplayWay(way({ railway: 'tram' }))).toBe(false);
    expect(isDetailDisplayWay(way({ railway: 'light_rail' }))).toBe(false);
    expect(isMainlineWay(way({ railway: 'tram' }))).toBe(true);
  });

  it('still lets pathfinding use crossovers while hiding them on the detail map', () => {
    const crossover = way({ railway: 'rail', service: 'crossover' });
    expect(isPathfindingWay(crossover)).toBe(true);
    expect(isSideRailwayTrack(crossover)).toBe(true);
    expect(isDetailDisplayWay(crossover)).toBe(false);
  });
});
