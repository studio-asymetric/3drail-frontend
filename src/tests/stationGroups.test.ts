import { describe, expect, it } from 'vitest';
import { baseStationName, groupStations, type StationPoint } from '../data/stationGroups';

const point = (id: string, name: string, lat: number, lng: number, rank = 1): StationPoint => ({
  id,
  name,
  lat,
  lng,
  color: '#fff',
  rank,
});

describe('baseStationName', () => {
  it('ignores a trailing number, case and accents', () => {
    expect(baseStationName('Bratislava-Vinohrady 2')).toBe('bratislava-vinohrady');
    expect(baseStationName('Náměstí Republiky')).toBe('namesti republiky');
    expect(baseStationName('Trnava')).toBe('trnava');
  });
});

describe('groupStations', () => {
  it('joins "Bratislava-Vinohrady" and "Bratislava-Vinohrady 2" in one pill with one label', () => {
    const { points, pills } = groupStations([
      point('a', 'Bratislava-Vinohrady', 48.1685, 17.1215, 2),
      point('b', 'Bratislava-Vinohrady 2', 48.1693, 17.1236, 1),
      point('c', 'Trnava', 48.37, 17.58),
    ]);
    expect(pills).toHaveLength(1);
    const [a, b, c] = points;
    expect(a.group).toBeDefined();
    expect(a.group).toBe(b.group);
    expect(c.group).toBeUndefined();
    // the label stays on the one without a number
    expect([a.hideLabel, b.hideLabel]).toEqual([false, true]);
  });

  it('joins the platforms of one tram stop', () => {
    const { pills, points } = groupStations([
      point('stop:Truhlářská', 'Truhlářská', 50.0895, 14.4287),
      point('stop:Truhlářská', 'Truhlářská', 50.0896, 14.4292),
    ]);
    expect(pills).toHaveLength(1);
    // one dot in the middle of the shape
    expect(points).toHaveLength(1);
    expect(points[0].lat).toBeCloseTo(50.08955, 5);
  });

  it('does not join same-named places far apart, or a group that is too wide', () => {
    expect(groupStations([point('a', 'Nádraží', 48.0, 17.0), point('b', 'Nádraží', 48.5, 17.5)]).pills).toHaveLength(0);
    // 100 m links in a chain, but 400 m end to end: too wide to be one place
    const chain = [0, 1, 2, 3, 4].map((i) => point(`c${i}`, 'Chain', 48.0, 17.0 + i * 0.0035));
    expect(groupStations(chain).pills).toHaveLength(0);
  });
});
