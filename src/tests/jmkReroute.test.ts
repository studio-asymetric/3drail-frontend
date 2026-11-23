import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS modules of the proxy
import { buildGraphs, tracePattern } from '../../proxy/regions/buildJmk.mjs';
// @ts-expect-error plain JS modules of the proxy
import { createRerouter, hopOf } from '../../proxy/regions/jmkReroute.mjs';

// Two ways between stop A and stop B: a short one straight east, and a longer one that goes round to the north.
const way = (points: Array<[number, number]>) => ({ tram: false, geometry: points.map(([lat, lon]) => ({ lat, lon })) });
const direct = way([
  [49.0, 16.0],
  [49.0, 16.005],
  [49.0, 16.01],
]);
const round = way([
  [49.0, 16.0],
  [49.005, 16.0],
  [49.01, 16.005],
  [49.005, 16.01],
  [49.0, 16.01],
]);
const stops = [
  { id: 'A', name: 'A', lat: 49.0, lng: 16.0 },
  { id: 'B', name: 'B', lat: 49.0, lng: 16.01 },
];
const northmost = (line: Array<[number, number]>) => Math.max(...line.map((p) => p[0]));

describe('routes that correct themselves', () => {
  const graphs = buildGraphs([direct, round]);

  it('takes the short way until a vehicle shows the other', () => {
    expect(northmost(tracePattern(graphs, 2, stops).line)).toBeLessThan(49.001);
    const hinted = tracePattern(graphs, 2, stops, [{ from: 'A', to: 'B', lat: 49.01, lng: 16.005 }]);
    expect(northmost(hinted.line)).toBeGreaterThan(49.009);
  });

  it('says which hop a place belongs to', () => {
    const three = [...stops, { id: 'C', name: 'C', lat: 49.0, lng: 16.02 }];
    expect(hopOf(three, 49.0, 16.0149)).toBe(1);
    expect(hopOf(three, 49.0, 16.004)).toBe(0);
    expect(hopOf(three, 49.5, 16.5)).toBe(-1);
  });

  it('redraws a line once a vehicle keeps to a place off it, and not before', async () => {
    const shapes = new Map<string, Array<[number, number]>>();
    shapes.set('s1', [
      [49.0, 16.0],
      [49.0, 16.01],
    ]);
    const region = {
      tripInfo: () => ({ type: 2, shapeId: 's1', stops }),
      patterns: () => [{ type: 2, shapeId: 's1', stops }],
      shapeDeviation: (_id: string, lat: number) => (Math.abs(lat - 49.0) < 0.0003 ? 5 : Math.abs(lat - 49.0) * 110574),
      setShape: (id: string, line: Array<[number, number]>) => shapes.set(id, line),
    };
    let clock = 0;
    const logs: string[] = [];
    const dir = `rr-test-${Date.now()}/jmk`;
    const rerouter = createRerouter({ region, dataDir: dir, log: (m: string) => logs.push(m), now: () => clock, graphs });
    // on the line: nothing happens
    clock += 10_000;
    rerouter.observe([{ key: 'v', tripId: 't', lat: 49.0, lng: 16.005, stopId: 'B', status: 2 }]);
    // off it for a moment only: nothing happens
    clock += 5_000;
    rerouter.observe([{ key: 'v', tripId: 't', lat: 49.005, lng: 16.0, stopId: 'B', status: 2 }]);
    expect(shapes.get('s1')?.length).toBe(2);
    // off it, moving, for long enough: the line is drawn through where it is
    for (const [lat, lng] of [
      [49.007, 16.002],
      [49.009, 16.004],
      [49.01, 16.005],
      [49.0075, 16.0075],
    ]) {
      clock += 10_000;
      rerouter.observe([{ key: 'v', tripId: 't', lat, lng, stopId: 'B', status: 2 }]);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(northmost(shapes.get('s1') as Array<[number, number]>)).toBeGreaterThan(49.009);
  });
});
