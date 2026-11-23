import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module of the proxy
import { convertRecords, decodeVehiclePositions } from '../../proxy/regions/jmkLive.mjs';
import { regionFromPath } from '../region';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;

describe('Brno + South Moravia (JMK)', () => {
  it('opens at /jmk', () => {
    expect(regionFromPath('/jmk')).toBe('jmk');
    expect(regionFromPath('/jmk/')).toBe('jmk');
    expect(regionFromPath('/pid')).toBe('pid');
    expect(regionFromPath('/')).toBe('sk');
  });

  it('decodes the positions of a GTFS-Realtime feed', () => {
    // FeedMessage { entity { id, vehicle { trip { trip_id "22891" }, position { lat, lon }, timestamp } } }
    const field = (tag: number, body: { length: number }) => Buffer.concat([Buffer.from([tag, body.length]), body]);
    const float = (tag: number, value: number) => {
      const b = Buffer.alloc(5);
      b[0] = tag;
      b.writeFloatLE(value, 1);
      return b;
    };
    const trip = field(0x0a, Buffer.from('22891'));
    const position = Buffer.concat([float(0x0d, 49.25), float(0x15, 16.5)]);
    const vehicle = Buffer.concat([field(0x0a, trip), field(0x12, position), Buffer.from([0x28, 100])]);
    const entity = Buffer.concat([field(0x0a, Buffer.from('1')), field(0x22, vehicle)]);
    const feed = field(0x12, entity);
    const [first] = decodeVehiclePositions(feed);
    expect(first.tripId).toBe('22891');
    expect(first.lat).toBeCloseTo(49.25, 4);
    expect(first.lng).toBeCloseTo(16.5, 4);
    expect(first.at).toBe(100_000);
  });

  it('joins a stream vehicle to the run of its line that is nearest', () => {
    const now = Date.now();
    const result = convertRecords(
      [
        { ID: 1, LineName: '4', VType: 0, Lat: 49.2, Lng: 16.6, Delay: 2, TimeUpdated: now },
        { ID: 2, LineName: '33', VType: 1, Lat: 49.21, Lng: 16.61, Delay: 0, TimeUpdated: now },
      ],
      {
        positions: [
          { tripId: 'far', lat: 49.3, lng: 16.6, at: now },
          { tripId: 'near', lat: 49.2001, lng: 16.6, at: now },
        ],
        tripKey: new Map([
          ['far', 'pFar'],
          ['near', 'pNear'],
        ]),
        tripInfo: new Map(),
        routes: new Map(),
        shortOfTrip: () => '4',
      }
    );
    expect(result.rail.get('pNear')?.delaySec).toBe(120);
    expect(result.rail.has('pFar')).toBe(false);
    // the trolleybus has no timetable run here: it is shown from the stream alone
    expect(result.other.map((v: { short: string; type: number }) => [v.short, v.type])).toEqual([['33', 11]]);
  });
});
