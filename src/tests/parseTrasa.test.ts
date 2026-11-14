import { describe, expect, it } from 'vitest';
import { parseTrasa } from '../data/trainService';

describe('parseTrasa', () => {
  it('flattens groups, drops repeated boundary points and accepts a JSON string', () => {
    const groups = [
      { Key: '30', Value: [[48.1589, 17.1067], [48.18676, 17.13427]] as [number, number][] },
      { Key: '10', Value: [[48.18676, 17.13427], [48.18854, 17.14967]] as [number, number][] },
    ];
    const expected = [
      { lat: 48.1589, lng: 17.1067, sequence: 0 },
      { lat: 48.18676, lng: 17.13427, sequence: 1 },
      { lat: 48.18854, lng: 17.14967, sequence: 2 },
    ];
    expect(parseTrasa(groups)).toEqual(expected);
    expect(parseTrasa(JSON.stringify(groups))).toEqual(expected);
  });

  it('returns an empty list for missing or broken input', () => {
    expect(parseTrasa(null)).toEqual([]);
    expect(parseTrasa('not json')).toEqual([]);
  });
});
