import { describe, expect, it } from 'vitest';
import { buildGtfsDataset, parseGtfsShapes } from '../data/gtfsParser';
import {
  buildTrainRenderState,
  filterTimedJourneyStops,
  formatTrainDisplayName,
  isTimedJourneyStop,
  mergeTrainList,
  routeCursor,
  snapToPath,
  stationPoints,
  trainTypeCallout,
  type JourneyStop,
  type TrainRosterItem,
  type TrainRenderState,
} from '../data/trainService';

describe('formatTrainDisplayName', () => {
  it('title-cases all-caps roster names', () => {
    expect(formatTrainDisplayName('OSTRAVAN')).toBe('Ostravan');
    expect(formatTrainDisplayName('METROPOLITAN')).toBe('Metropolitan');
  });

  it('leaves mixed-case names untouched', () => {
    expect(formatTrainDisplayName('Tatran')).toBe('Tatran');
  });
});

describe('GTFS parsing helpers', () => {
  it('parses shapes and respects sequence order', () => {
    const csv = `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
demo,48.1,17.1,2
demo,48.0,17.0,1`;
    const shapes = parseGtfsShapes(csv);
    const shape = shapes.demo;
    expect(shape.points[0].sequence).toBe(1);
    expect(shape.points[0].lat).toBeCloseTo(48.0);
    expect(shape.points[1].sequence).toBe(2);
  });
});

describe('Train service rendering', () => {
  const shapesCsv = `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
demo,48.1,17.1,1
demo,48.3,17.3,2`;

  const tripsCsv = `route_id,service_id,trip_id,trip_headsign,shape_id,trip_short_name
R1,WE,trip101,Test,demo,101`;

  const stopsCsv = `stop_id,stop_name,stop_lat,stop_lon,stop_code,stop_uic_code
s1,Bratislava,48.1,17.1,01,5392013
s2,Košice,48.7,21.2,02,5250005`;

  const stopTimesCsv = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
trip101,08:00:00,08:02:00,s1,1
trip101,12:30:00,12:35:00,s2,2`;

  const dataset = buildGtfsDataset({
    shapesCsv,
    tripsCsv,
    stopsCsv,
    stopTimesCsv,
  });

  it('builds train render state with delay info', () => {
    const roster: TrainRosterItem = {
      train: {
        number: '101',
        name: 'Test',
      },
      timestamp: Date.now(),
      trainDelay: {
        trainNumber: '101',
        delayMinutes: 12,
        currentName: 'Bratislava',
        currentUic: '5392013',
        nextStationName: 'Košice',
        timestamp: Date.now(),
      },
    };

    const renderState = buildTrainRenderState(roster, dataset, roster.trainDelay);
    expect(renderState).not.toBeNull();
    expect(renderState?.shapePath.length).toBeGreaterThan(1);
    expect(renderState?.delayMinutes).toBe(12);
    expect(renderState?.currentStation).toBe('Bratislava');
    expect(renderState?.nextStation).toBe('Košice');
    expect(renderState?.progress).toBeGreaterThanOrEqual(0);
    expect(renderState?.progress).toBeLessThanOrEqual(1);
  });

  it('resolves next station UIC codes to stop names', () => {
    const roster: TrainRosterItem = {
      train: { number: '101', name: 'Test' },
      timestamp: Date.now(),
      rosterNextStation: 'Fallback',
      trainDelay: {
        trainNumber: '101',
        delayMinutes: 0,
        nextStationName: '5392013',
        timestamp: Date.now(),
      },
    };

    const renderState = buildTrainRenderState(roster, dataset, roster.trainDelay);
    expect(renderState?.nextStation).toBe('Bratislava');
  });

  it('keeps a live GPS train off the GTFS polyline', () => {
    const roster: TrainRosterItem = {
      train: { number: '101', name: 'Live', type: 'Ex' },
      timestamp: Date.now(),
      position: { lat: 48.2, lng: 17.2, sequence: 0 },
      heading: 90,
      trainDelay: {
        trainNumber: '101',
        delayMinutes: 3,
        timestamp: Date.now(),
      },
    };
    const renderState = buildTrainRenderState(roster, dataset, roster.trainDelay);
    expect(renderState).not.toBeNull();
    expect(renderState?.shapePath).toEqual([]);
    expect(renderState?.liveRoute).toBeUndefined();
    expect(renderState?.position).toEqual(roster.position);
    expect(renderState?.heading).toBe(90);
  });
});

describe('mergeTrainList', () => {
  const sample = (overrides: Partial<TrainRenderState> = {}): TrainRenderState => ({
    trainNumber: '101',
    shapePath: [],
    progress: 0.5,
    delayMinutes: 0,
    color: '#4fc08d',
    reportedAt: 1,
    heading: 10,
    position: { lat: 48, lng: 17, sequence: 0 },
    ...overrides,
  });

  it('reuses the previous array when nothing moved', () => {
    const previous = [sample()];
    const merged = mergeTrainList(previous, [sample()]);
    expect(merged).toBe(previous);
    expect(merged[0]).toBe(previous[0]);
  });

  it('keeps unchanged trains by identity and replaces movers', () => {
    const parked = sample({ trainNumber: 'parked' });
    const moving = sample({ trainNumber: 'moving', position: { lat: 48, lng: 17, sequence: 0 } });
    const previous = [parked, moving];
    const next = [
      sample({ trainNumber: 'parked' }),
      sample({ trainNumber: 'moving', position: { lat: 48.1, lng: 17.1, sequence: 0 } }),
    ];
    const merged = mergeTrainList(previous, next);
    expect(merged[0]).toBe(parked);
    expect(merged[1]).not.toBe(moving);
    expect(merged[1].position?.lat).toBeCloseTo(48.1);
  });
});

describe('filterTimedJourneyStops', () => {
  it('drops výhybne rows without any clock time', () => {
    const stops: JourneyStop[] = [
      {
        name: 'Košice',
        arrival: '',
        departure: '13:21',
        scheduledArrival: '',
        scheduledDeparture: '13:21',
        state: 'passed',
      },
      {
        name: 'Výh. Chym',
        arrival: '',
        departure: '',
        scheduledArrival: '',
        scheduledDeparture: '',
        state: 'ahead',
      },
      {
        name: 'Margecany',
        arrival: '14:20',
        departure: '14:21',
        scheduledArrival: '14:00',
        scheduledDeparture: '14:01',
        state: 'ahead',
      },
    ];
    expect(isTimedJourneyStop(stops[1])).toBe(false);
    expect(filterTimedJourneyStops(stops).map((stop) => stop.name)).toEqual(['Košice', 'Margecany']);
  });
});

describe('station name matching', () => {
  it('matches GTFS abbreviations to timetable names', () => {
    const points = stationPoints(
      [
        { name: 'Dubnica nad Váhom' } as JourneyStop,
        { name: 'Kostoľany nad Hornádom' } as JourneyStop,
        { name: 'Bratislava hlavná stanica' } as JourneyStop,
      ],
      [
        { name: 'Dubnica n.Váhom', lat: 48.966, lng: 18.168 },
        { name: 'Kostoľany n.Hornádom', lat: 48.796, lng: 21.246 },
        { name: 'Bratislava hl.st.', lat: 48.158, lng: 17.106 },
      ]
    );
    expect(points[0]).toMatchObject({ lat: 48.966, lng: 18.168 });
    expect(points[1]).toMatchObject({ lat: 48.796, lng: 21.246 });
    expect(points[2]).toMatchObject({ lat: 48.158, lng: 17.106 });
  });
});

describe('routeCursor delay', () => {
  it('holds the train back by the reported delay', () => {
    const stops = [
      {
        name: 'A',
        arrival: '10:00',
        departure: '10:00',
        scheduledArrival: '10:00',
        scheduledDeparture: '10:00',
        state: 'passed',
      },
      {
        name: 'B',
        arrival: '11:00',
        departure: '11:00',
        scheduledArrival: '11:00',
        scheduledDeparture: '11:00',
        state: 'ahead',
      },
    ] as JourneyStop[];
    const points = [
      { lat: 48, lng: 17 },
      { lat: 49, lng: 18 },
    ];
    const now = new Date(2026, 0, 1, 10, 30, 0);
    const onTime = routeCursor(points, stops, now, 0);
    const delayed = routeCursor(points, stops, now, 30);
    expect(onTime.fraction).toBeGreaterThan(delayed.fraction);
    expect(delayed.fraction).toBeCloseTo(0, 5);
  });
});

describe('trainTypeCallout', () => {
  it('keeps short types and shortens railjet', () => {
    expect(trainTypeCallout('Ex')).toBe('Ex');
    expect(trainTypeCallout('Os')).toBe('Os');
    expect(trainTypeCallout('railjet')).toBe('rj');
  });
});

describe('snapToPath', () => {
  it('projects a live point onto the nearest rail segment', () => {
    const path = [
      { lat: 48.19, lng: 17.1 },
      { lat: 48.19, lng: 17.2 },
      { lat: 48.25, lng: 17.2 },
    ];
    const snapped = snapToPath(path, { lat: 48.21, lng: 17.18 });
    expect(snapped.lng).toBeCloseTo(17.2, 3);
    expect(snapped.lat).toBeGreaterThan(48.19);
    expect(snapped.lat).toBeLessThan(48.25);
  });
});
