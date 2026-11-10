import { describe, expect, it } from 'vitest';
import {
  EMPTY_COLLECTION,
  TRAIN_BUBBLE_GAP_PX,
  TRAIN_BUBBLE_RADIUS_PX,
  mergeLineCollections,
  spreadOverlappingTrainPoints,
  stationLabelRank,
} from '../data/railGeoJson';

const project = (lng: number, lat: number) => ({ x: lng, y: lat });
const unproject = (x: number, y: number) => ({ lng: x, lat: y });

describe('spreadOverlappingTrainPoints', () => {
  it('leaves a single train in place', () => {
    const points = [{ id: '8111', lat: 49.1, lng: 20.2 }];
    expect(spreadOverlappingTrainPoints(points, project, unproject)).toEqual(points);
  });

  it('bubbles two trains on the same node apart', () => {
    const points = [
      { id: '8112', lat: 10, lng: 20 },
      { id: '8111', lat: 10, lng: 20 },
    ];
    const spread = spreadOverlappingTrainPoints(points, project, unproject, { iterations: 18 });
    const byId = Object.fromEntries(spread.map((point) => [point.id, point]));
    const distance = Math.hypot(byId['8111'].lng - byId['8112'].lng, byId['8111'].lat - byId['8112'].lat);
    expect(distance).toBeGreaterThan(TRAIN_BUBBLE_RADIUS_PX * 2 + TRAIN_BUBBLE_GAP_PX - 1);
    expect(distance).toBeLessThan(TRAIN_BUBBLE_RADIUS_PX * 2 + TRAIN_BUBBLE_GAP_PX + 2);
  });

  it('does not move trains that are already apart', () => {
    const points = [
      { id: 'a', lat: 10, lng: 20 },
      { id: 'b', lat: 10, lng: 80 },
    ];
    expect(spreadOverlappingTrainPoints(points, project, unproject)).toEqual(points);
  });

  it('packs three stacked trains so none overlap', () => {
    const points = [
      { id: 'a', lat: 10, lng: 20 },
      { id: 'b', lat: 10, lng: 20 },
      { id: 'c', lat: 10, lng: 20 },
    ];
    const spread = spreadOverlappingTrainPoints(points, project, unproject, { iterations: 18 });
    const minDist = TRAIN_BUBBLE_RADIUS_PX * 2 + TRAIN_BUBBLE_GAP_PX - 1;
    for (let left = 0; left < spread.length; left += 1) {
      for (let right = left + 1; right < spread.length; right += 1) {
        const distance = Math.hypot(
          spread[left].lng - spread[right].lng,
          spread[left].lat - spread[right].lat
        );
        expect(distance).toBeGreaterThanOrEqual(minDist);
      }
    }
  });

  it('leaves an isolated train still while packing a nearby stack', () => {
    const points = [
      { id: 'a', lat: 10, lng: 20 },
      { id: 'b', lat: 10, lng: 20 },
      { id: 'lonely', lat: 10, lng: 200 },
    ];
    const spread = spreadOverlappingTrainPoints(points, project, unproject, { iterations: 18 });
    const lonely = spread.find((point) => point.id === 'lonely');
    expect(lonely).toEqual(points[2]);
  });

  it('gives a wide pill more clearance than a narrow one', () => {
    const narrow = spreadOverlappingTrainPoints(
      [
        { id: 'a', lat: 10, lng: 20, radius: 10 },
        { id: 'b', lat: 10, lng: 20, radius: 10 },
      ],
      project,
      unproject,
      { iterations: 18 }
    );
    const mixed = spreadOverlappingTrainPoints(
      [
        { id: 'a', lat: 10, lng: 20, radius: 10 },
        { id: 'b', lat: 10, lng: 20, radius: 22 },
      ],
      project,
      unproject,
      { iterations: 18 }
    );
    const narrowDist = Math.hypot(
      narrow[0].lng - narrow[1].lng,
      narrow[0].lat - narrow[1].lat
    );
    const mixedDist = Math.hypot(mixed[0].lng - mixed[1].lng, mixed[0].lat - mixed[1].lat);
    expect(mixedDist).toBeGreaterThan(narrowDist + 8);
  });
});

describe('stationLabelRank', () => {
  it('treats main-line hubs as rank 3', () => {
    expect(stationLabelRank('Bratislava hl.st.')).toBe(3);
    expect(stationLabelRank('Košice', 12)).toBe(3);
    expect(stationLabelRank('Humenné', 4)).toBe(3);
  });

  it('keeps busy towns above halts', () => {
    expect(stationLabelRank('Púchov', 40)).toBe(2);
    expect(stationLabelRank('Svrčinovec zastávka', 40)).toBe(1);
    expect(stationLabelRank('AH Dubeň', 8)).toBe(1);
  });
});

describe('mergeLineCollections', () => {
  it('returns empty when nothing is cached', () => {
    expect(mergeLineCollections([])).toEqual(EMPTY_COLLECTION);
  });

  it('concatenates features from tile collections', () => {
    const left = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { id: 1 },
          geometry: { type: 'LineString' as const, coordinates: [[17, 48], [18, 49]] },
        },
      ],
    };
    const merged = mergeLineCollections([left, EMPTY_COLLECTION, left]);
    expect(merged.features).toHaveLength(2);
  });
});
