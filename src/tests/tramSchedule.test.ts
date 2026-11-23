import { describe, expect, it } from 'vitest';
import { buildJourney, scheduledAlong } from '../data/journeyService';
import { encodePolyline } from '../data/routeService';

// Three stops 1 km apart on a straight line, timetabled at t0, t0+120 and t0+240 (arrival = departure).
const t0 = 1_800_000_000;
const journey = buildJourney({
  n: 'tram',
  sig: 'sched',
  line: encodePolyline([
    { lat: 48.0, lng: 17.0 },
    { lat: 48.0181, lng: 17.0 },
  ]),
  ok: true,
  at: [0, 1000, 2000],
  stops: [
    [0, null, t0, 0, 1],
    [1000, t0 + 120, t0 + 120, 1, 1],
    [2000, t0 + 240, null, 2, 1],
  ],
})!;

describe('tram and metro placed from the timetable', () => {
  it('arrives on the timetable minute and stands for the stand time', () => {
    expect(scheduledAlong(journey, t0 + 120, 10)).toBeCloseTo(1000, 0);
    expect(scheduledAlong(journey, t0 + 125, 10)).toBeCloseTo(1000, 0);
    expect(scheduledAlong(journey, t0 + 129.9, 10)).toBeCloseTo(1000, 0);
    expect(scheduledAlong(journey, t0 + 135, 10)!).toBeGreaterThan(1000);
    expect(scheduledAlong(journey, t0 + 119, 10)!).toBeLessThan(1000);
  });

  it('a metro stands twice as long', () => {
    expect(scheduledAlong(journey, t0 + 139, 20)).toBeCloseTo(1000, 0);
    expect(scheduledAlong(journey, t0 + 150, 20)!).toBeGreaterThan(1000);
  });

  it('never goes backwards and reaches the next stop on time', () => {
    let last = -1;
    for (let s = 0; s <= 240; s += 0.5) {
      const along = scheduledAlong(journey, t0 + s, 10)!;
      expect(along).toBeGreaterThanOrEqual(last);
      last = along;
    }
    expect(scheduledAlong(journey, t0 + 240, 10)).toBeCloseTo(2000, 0);
  });
});
