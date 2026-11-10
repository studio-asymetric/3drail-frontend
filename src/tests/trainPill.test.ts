import { describe, expect, it } from 'vitest';
import {
  headingFromPoints,
  normalizeHeading,
  resolveTrainHeading,
  stadiumEdgePoint,
} from '../data/trainPill';

describe('normalizeHeading', () => {
  it('wraps signed ZSR angles into 0-360', () => {
    expect(normalizeHeading(-66)).toBeCloseTo(294);
    expect(normalizeHeading(370)).toBeCloseTo(10);
    expect(normalizeHeading(undefined)).toBeNull();
  });
});

describe('headingFromPoints', () => {
  it('returns ~90 for due east', () => {
    expect(headingFromPoints({ lat: 48.2, lng: 17.1 }, { lat: 48.2, lng: 17.3 })).toBeCloseTo(90, 0);
  });
});

describe('stadiumEdgePoint', () => {
  const width = 26;
  const height = 14;
  const radius = height / 2;
  const flat = width / 2 - radius;

  it('puts north on the top and east on the right cap', () => {
    const north = stadiumEdgePoint(width, height, 0, 0);
    expect(north.x).toBeCloseTo(0, 2);
    expect(north.y).toBeCloseTo(-7, 2);
    const east = stadiumEdgePoint(width, height, 90, 0);
    expect(east.x).toBeCloseTo(13, 2);
    expect(east.y).toBeCloseTo(0, 2);
    const south = stadiumEdgePoint(width, height, 180, 0);
    expect(south.x).toBeCloseTo(0, 2);
    expect(south.y).toBeCloseTo(7, 2);
    const west = stadiumEdgePoint(width, height, 270, 0);
    expect(west.x).toBeCloseTo(-13, 2);
    expect(west.y).toBeCloseTo(0, 2);
  });

  it('places a heading on the cap point with that outward normal', () => {
    const heading = 45;
    const rad = (heading * Math.PI) / 180;
    const nx = Math.sin(rad);
    const ny = -Math.cos(rad);
    const ne = stadiumEdgePoint(width, height, heading, 0);
    expect(ne.x).toBeCloseTo(flat + nx * radius, 5);
    expect(ne.y).toBeCloseTo(ny * radius, 5);
  });

  it('keeps a shallow heading on the cap, tangent rather than on the flat', () => {
    const heading = 30;
    const rad = (heading * Math.PI) / 180;
    const point = stadiumEdgePoint(width, height, heading, 0);
    expect(point.x).toBeCloseTo(flat + Math.sin(rad) * radius, 5);
    expect(point.y).toBeCloseTo(-Math.cos(rad) * radius, 5);
    expect(point.x).toBeGreaterThan(flat);
  });

  it('tucks the base inward along the heading so corners sit under the pill', () => {
    const heading = 90;
    const onEdge = stadiumEdgePoint(width, height, heading, 0);
    const tucked = stadiumEdgePoint(width, height, heading, 4);
    expect(tucked.x).toBeCloseTo(onEdge.x - 4, 5);
    expect(tucked.y).toBeCloseTo(onEdge.y, 5);
  });
});

describe('resolveTrainHeading', () => {
  it('prefers the ZSR angle', () => {
    expect(
      resolveTrainHeading({
        heading: 118,
        liveRoute: [
          { lat: 48, lng: 17 },
          { lat: 48.2, lng: 17 },
        ],
      })
    ).toBeCloseTo(118);
  });
});
