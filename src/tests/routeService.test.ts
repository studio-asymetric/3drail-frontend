import { describe, expect, it } from 'vitest';
import { decodePolyline, encodePolyline } from '../data/routeService';

describe('route polyline encoding', () => {
  it('matches the reference Google polyline example', () => {
    const points = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('round-trips Slovak coordinates at 1e-5 precision', () => {
    const points = [
      { lat: 48.15827, lng: 17.10615 },
      { lat: 48.72257, lng: 21.26749 },
      { lat: 49.22668, lng: 18.74626 },
    ];
    const decoded = decodePolyline(encodePolyline(points));
    expect(decoded.map(({ lat, lng }) => ({ lat, lng }))).toEqual(points);
    expect(decoded.map((point) => point.sequence)).toEqual([1, 2, 3]);
  });
});
