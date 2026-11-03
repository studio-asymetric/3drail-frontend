import { describe, expect, it } from 'vitest';
import { buildGtfsDataset, parseGtfsShapes } from '../data/gtfsParser';
import { buildTrainRenderState, type TrainRosterItem } from '../data/trainService';

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
});
