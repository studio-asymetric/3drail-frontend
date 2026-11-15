import { describe, expect, it } from 'vitest';
import { buildJourney, expandJourney } from '../data/journeyService';
import { encodePolyline } from '../data/routeService';

describe('journey payload v2', () => {
  const line = encodePolyline([
    { lat: 48.0, lng: 17.0 },
    { lat: 48.1, lng: 17.0 },
  ]);

  it('expands a shared route and times counted from t0', () => {
    const raw = expandJourney(
      {
        n: '5',
        sig: 'abc',
        t0: 1_800_000_000,
        stops: [
          [0, null, 0, 0, 1],
          [9000, 600, 660, 1, 1],
        ],
      },
      { abc: { line, at: [0, 9000], ok: true } }
    )!;
    expect(raw.line).toBe(line);
    expect(raw.at).toEqual([0, 9000]);
    expect(raw.stops[1][1]).toBe(1_800_000_600);
    expect(raw.stops[1][2]).toBe(1_800_000_660);
    expect(raw.stops[0][1]).toBeNull();
    const journey = buildJourney(raw)!;
    expect(journey.stops).toHaveLength(2);
  });

  it('still reads the older payload where each train carries its own line', () => {
    const raw = expandJourney(
      { n: '6', sig: 'old', line, ok: true, at: [0, 5], stops: [[0, null, 1_800_000_000, 0, 1]] } as never,
      undefined
    )!;
    expect(raw.stops[0][2]).toBe(1_800_000_000);
    expect(raw.line).toBe(line);
  });

  it('skips an entry whose route is missing', () => {
    expect(expandJourney({ n: '7', sig: 'gone', stops: [] }, {})).toBeNull();
  });
});
