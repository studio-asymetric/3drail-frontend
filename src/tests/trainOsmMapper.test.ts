import { describe, expect, it } from 'vitest';
import type { OSMWay } from '../data/osmRailService';
import { waysToLineCollection } from '../data/railGeoJson';
import {
  extendOsmGraph,
  findOsmPath,
  haversineDistance,
  resetSpatialIndex,
  traceWaypointSegments,
  type OsmGraph,
} from '../data/trainOsmMapper';

function railWay(id: number, points: Array<[number, number]>): OSMWay {
  return {
    id,
    type: 'way',
    nodes: points.map((_, index) => id * 100 + index),
    geometry: points.map(([lat, lon]) => ({ lat, lon })),
    tags: { railway: 'rail' },
  };
}

function buildGraph(ways: OSMWay[]): OsmGraph {
  resetSpatialIndex();
  const graph: OsmGraph = new Map();
  extendOsmGraph(graph, ways);
  return graph;
}

describe('rail pathfinding', () => {
  it('follows an L-shaped rail instead of the hypotenuse', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.15, 17.12],
        [48.17, 17.12],
      ]),
    ]);
    const path = findOsmPath(
      graph,
      { lat: 48.15, lng: 17.1, sequence: 1 },
      { lat: 48.17, lng: 17.12, sequence: 2 }
    ).path;
    expect(path.length).toBeGreaterThanOrEqual(3);
    const cornerDistance = Math.min(
      ...path.map((point) => haversineDistance(point, { lat: 48.15, lng: 17.12 }))
    );
    expect(cornerDistance).toBeLessThan(80);
    const direct = haversineDistance(
      { lat: 48.15, lng: 17.1 },
      { lat: 48.17, lng: 17.12 }
    );
    let length = 0;
    for (let index = 1; index < path.length; index += 1) {
      length += haversineDistance(path[index - 1], path[index]);
    }
    expect(length).toBeGreaterThan(direct + 400);
  });

  it('does not mesh parallel tracks 16m apart', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.18, 17.1],
      ]),
      railWay(2, [
        [48.15, 17.10022],
        [48.18, 17.10022],
      ]),
    ]);
    const path = findOsmPath(
      graph,
      { lat: 48.151, lng: 17.0999, sequence: 1 },
      { lat: 48.179, lng: 17.0999, sequence: 2 }
    ).path;
    expect(path.length).toBeGreaterThanOrEqual(2);
    path.forEach((point) => {
      expect(Math.abs(point.lng - 17.1)).toBeLessThan(0.00008);
    });
  });

  it('snaps a station beside a long segment onto that rail', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.2, 17.1],
      ]),
    ]);
    const path = findOsmPath(
      graph,
      { lat: 48.175, lng: 17.101, sequence: 1 },
      { lat: 48.199, lng: 17.1005, sequence: 2 }
    ).path;
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0].lat).toBeGreaterThan(48.16);
    expect(path[0].lat).toBeLessThan(48.19);
    expect(Math.abs(path[0].lng - 17.1)).toBeLessThan(0.00005);
  });

  it('keeps a sharp corner when simplifying display rails', () => {
    const collection = waysToLineCollection(
      [
        railWay(1, [
          [48.15, 17.1],
          [48.15, 17.1004],
          [48.15, 17.101],
          [48.1504, 17.101],
          [48.151, 17.101],
        ]),
      ],
      'main',
      8
    );
    const coordinates = collection.features[0]?.geometry.coordinates ?? [];
    expect(coordinates.length).toBeGreaterThanOrEqual(3);
    expect(coordinates.some(([lng, lat]) => Math.abs(lat - 48.15) < 0.00002 && Math.abs(lng - 17.101) < 0.00002)).toBe(
      true
    );
  });

  it('bridges a short mainline seam instead of dropping the hop', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.16, 17.1],
      ]),
      railWay(2, [
        [48.1609, 17.1],
        [48.18, 17.1],
      ]),
    ]);
    const path = findOsmPath(
      graph,
      { lat: 48.151, lng: 17.1, sequence: 1 },
      { lat: 48.179, lng: 17.1, sequence: 2 }
    ).path;
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0].lat).toBeLessThan(48.155);
    expect(path[path.length - 1].lat).toBeGreaterThan(48.175);
    path.forEach((point) => {
      expect(Math.abs(point.lng - 17.1)).toBeLessThan(0.0002);
    });
  });

  it('fills a missing hop from the live route polyline', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.16, 17.1],
      ]),
      railWay(2, [
        [48.3, 17.4],
        [48.31, 17.4],
      ]),
    ]);
    const fallback = [
      { lat: 48.16, lng: 17.1, sequence: 1 },
      { lat: 48.22, lng: 17.22, sequence: 2 },
      { lat: 48.3, lng: 17.4, sequence: 3 },
    ];
    const segments = traceWaypointSegments(
      graph,
      [
        { lat: 48.151, lng: 17.1, sequence: 1 },
        { lat: 48.309, lng: 17.4, sequence: 2 },
      ],
      fallback
    );
    expect(segments.length).toBe(1);
    expect(segments[0].some((point) => Math.abs(point.lat - 48.22) < 0.002)).toBe(true);
  });

  it('uses Tatra narrow-gauge tracks for pathfinding', () => {
    const graph = buildGraph([
      {
        ...railWay(1, [
          [49.139, 20.22],
          [49.139, 20.24],
        ]),
        tags: { railway: 'narrow_gauge' },
      },
    ]);
    const path = findOsmPath(
      graph,
      { lat: 49.139, lng: 20.22, sequence: 1 },
      { lat: 49.139, lng: 20.24, sequence: 2 }
    ).path;
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0].lng).toBeCloseTo(20.22, 4);
    expect(path[path.length - 1].lng).toBeCloseTo(20.24, 4);
  });

  it('does not use tram tracks or station sidings as shortcuts', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.15, 17.12],
        [48.17, 17.12],
      ]),
      {
        ...railWay(2, [
          [48.15, 17.1],
          [48.17, 17.12],
        ]),
        tags: { railway: 'tram' },
      },
      {
        ...railWay(3, [
          [48.15, 17.1],
          [48.17, 17.12],
        ]),
        tags: { railway: 'rail', service: 'siding' },
      },
    ]);
    const path = findOsmPath(
      graph,
      { lat: 48.15, lng: 17.1, sequence: 1 },
      { lat: 48.17, lng: 17.12, sequence: 2 }
    ).path;
    const cornerDistance = Math.min(
      ...path.map((point) => haversineDistance(point, { lat: 48.15, lng: 17.12 }))
    );
    expect(cornerDistance).toBeLessThan(80);
  });

  it('jumps a hop when the only rail path is more than 10x the straight gap', () => {
    const graph = buildGraph([
      railWay(1, [
        [48.15, 17.1],
        [48.155, 17.1],
      ]),
      railWay(2, [
        [48.205, 17.1],
        [48.21, 17.1],
      ]),
      railWay(3, [
        [48.21, 17.1],
        [48.21, 17.7],
        [48.15, 17.7],
        [48.15, 17.1],
      ]),
    ]);
    const start = { lat: 48.152, lng: 17.1, sequence: 1 };
    const end = { lat: 48.208, lng: 17.1, sequence: 2 };
    const segments = traceWaypointSegments(graph, [start, end]);
    expect(segments).toHaveLength(1);
    const path = segments[0];
    const eastDetour = Math.max(...path.map((point) => point.lng));
    expect(eastDetour).toBeLessThan(17.2);
    expect(path).toHaveLength(2);
    expect(haversineDistance(path[0], start)).toBeLessThan(80);
    expect(haversineDistance(path[path.length - 1], end)).toBeLessThan(80);
  });
});
