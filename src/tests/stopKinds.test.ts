import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM module from the proxy, no type declarations
import { classifyStops, isNonStopName, normalizeStationName, parseTrainDetail } from '../../proxy/trainDetail.mjs';
import { alongAtTime, buildJourney, JourneyAnimator } from '../data/journeyService';
import { encodePolyline } from '../data/routeService';

type Row = {
  name: string;
  scheduledArrival: string;
  scheduledDeparture: string;
  state: 'passed' | 'current' | 'ahead';
};

const row = (name: string, arr: string, dep: string, state: Row['state'] = 'ahead'): Row => ({
  name,
  scheduledArrival: arr,
  scheduledDeparture: dep,
  state,
});

describe('isNonStopName', () => {
  it('recognises operational points', () => {
    [
      'Odb. Vinohrady',
      'Výh. Svätý Jur',
      'AH Vinosady',
      'Vlečka Calmit',
      'hranica BA - TT',
      'km 80,400',
      'Potok odb.',
      'Kysak výh. č. 35/36',
      'Nové Mesto nad Váhom výh. č. 48/49',
      'Trnava nákladná stanica',
      'Bratislava ústredná nákladná stanic',
      'Štúrovo tranzitná skupina',
      'Kúty št. hr.',
    ].forEach((name) => expect(isNonStopName(name), name).toBe(true));
  });

  it('keeps passenger stations', () => {
    ['Trnava', 'Ahoj', 'Kmeťovo', 'Odborárska', 'Bratislava-Vinohrady', 'Liptovský Hrádok'].forEach(
      (name) => expect(isNonStopName(name), name).toBe(false)
    );
  });
});

describe('classifyStops', () => {
  it('uses times for rows ahead of the train', () => {
    const kinds = classifyStops([
      row('Štúrovo št. hr.', '', '18:24', 'passed'),
      row('Svit', '', ''),
      row('Poprad-Tatry', '21:26', '21:31'),
      row('Výh. Paludza', '', ''),
      row('Košice', '22:53', ''),
    ]).map((stop: { kind: string }) => stop.kind);
    expect(kinds).toEqual(['stop', 'pass', 'stop', 'pass', 'stop']);
  });

  it('tells passed run-throughs from stops with the GTFS call list', () => {
    const calls = new Set(['Bratislava hlavná stanica', 'Bratislava-Vinohrady', 'Trnava', 'Košice'].map(normalizeStationName));
    const kinds = classifyStops(
      [
        row('Bratislava hlavná stanica', '', '17:16', 'passed'),
        row('Bratislava-Vinohrady', '17:21', '17:23', 'passed'),
        row('Bratislava-Rača', '17:25', '17:25', 'passed'),
        row('Výh. Horná Streda', '18:14', '18:16', 'passed'),
        row('Trnava', '17:47', '17:47', 'passed'),
        row('Košice', '22:53', ''),
      ],
      calls
    ).map((stop: { kind: string }) => stop.kind);
    expect(kinds).toEqual(['stop', 'stop', 'pass', 'wait', 'stop', 'stop']);
  });
});

describe('buildJourney stop dwell', () => {
  const line = encodePolyline([
    { lat: 48.0, lng: 17.0 },
    { lat: 48.1, lng: 17.0 },
  ]);
  const t0 = 1_800_000_000;

  it('gives a zero-minute passenger stop a short stand but not a passing point', () => {
    const journey = buildJourney({
      n: '1',
      sig: 'x',
      line,
      ok: true,
      stops: [
        [0, null, t0, 0, 1],
        [3000, t0 + 180, t0 + 180, 1, 1],
        [6000, t0 + 360, t0 + 360, 2, 0],
        [9000, t0 + 540, null, 3, 1],
      ],
    })!;
    // Times sit mid-minute: the 0-minute halt stands one minute, ending at :30.
    expect(journey.stops[0].dep).toBe(t0 + 30);
    expect(journey.stops[1].arr).toBe(t0 + 150);
    expect(journey.stops[1].dep).toBe(t0 + 210);
    expect(journey.stops[2].dep - journey.stops[2].arr).toBe(0);
    expect(alongAtTime(journey, t0 + 155)).toBe(3000);
    expect(alongAtTime(journey, t0 + 209)).toBe(3000);
    expect(alongAtTime(journey, t0 + 212)).toBeGreaterThan(3000);
    // The passing point is one run with the halt-to-terminus leg: no stand there.
    expect(journey.runs).toEqual([
      [t0 + 30, t0 + 150],
      [t0 + 210, t0 + 570],
    ]);
  });

  it('speeds up and slows down gently but keeps the timetable', () => {
    const journey = buildJourney({
      n: '2',
      sig: 'y',
      line,
      ok: true,
      stops: [
        [0, null, t0, 0, 1],
        [6000, t0 + 600, null, 1, 1],
      ],
    })!;
    const start = t0 + 30;
    const at = (s: number) => alongAtTime(journey, start + s)!;
    // Leaves on the half minute, arrives on time.
    expect(at(0)).toBe(0);
    expect(at(600)).toBe(6000);
    // First 10 s cover far less than a steady pace would (100 m).
    expect(at(10)).toBeLessThan(15);
    // Speed builds up: each 10 s covers more than the last, until cruising.
    expect(at(20) - at(10)).toBeGreaterThan(at(10) - at(0));
    expect(at(40) - at(30)).toBeGreaterThan(at(20) - at(10));
    // Symmetric braking.
    expect(6000 - at(590)).toBeCloseTo(at(10), 5);
  });
});

describe('JourneyAnimator glitches', () => {
  const line = encodePolyline([
    { lat: 48.0, lng: 17.0 },
    { lat: 48.5, lng: 17.0 },
  ]);
  const t0 = 1_800_000_000;
  const raw = {
    n: '7',
    sig: 'z',
    line,
    ok: true,
    at: [0, 50000] as Array<number | null>,
    stops: [
      [0, null, t0, 0, 1],
      [50000, t0 + 3600, null, 1, 1],
    ] as Array<[number, number | null, number | null, number, number?]>,
  };
  const make = (departureConfirmed: boolean, delayMinutes = 0) => {
    const animator = new JourneyAnimator();
    animator.setJourneys(new Map([['7', buildJourney(raw)!]]));
    animator.update([{ trainNumber: '7', delayMinutes, rosterOrderCurrentStation: 0, departureConfirmed }]);
    return animator;
  };
  // Timetable times sit mid-minute, so the departure is t0 + 30 s.
  const departure = (t0 + 30) * 1000;

  afterEach(() => vi.useRealTimers());

  it('holds a train ZSR still lists as waiting for a short grace after departure + delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(departure);
    const waiting = make(false);
    const left = make(true);
    expect(waiting.target('7', departure + 60_000)).toBe(0);
    expect(left.target('7', departure + 60_000)).toBeGreaterThan(500);
    expect(waiting.target('7', departure + 150_000)).toBeGreaterThan(50);
  });

  it('slides a train back instead of teleporting it when its delay grows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(departure);
    const animator = make(true, 0);
    const later = departure + 1_800_000;
    animator.position('7', later);
    const before = animator.peek('7', later)!.along;
    animator.update([{ trainNumber: '7', delayMinutes: 20, rosterOrderCurrentStation: 0, departureConfirmed: true }]);
    const target = animator.target('7', later)!;
    expect(before - target).toBeGreaterThan(8000);
    animator.position('7', later + 1000);
    animator.position('7', later + 2000);
    const shown = animator.peek('7', later + 2000)!.along;
    expect(shown).toBeLessThan(before - 1000);
    expect(shown).toBeGreaterThan(target + 1000);
  });
});

describe('replacement bus rows', () => {
  const rowHtml = (name: string, bus: boolean, arr: string, dep: string) => `
    <div class="row row__after afterNext" style="display:flex">
      <div class="timeline__marker timeline__marker__${bus ? 'nad' : 'after'}"></div>
      <div class="bold col-lg-4"><span class="futureName">${name}</span></div>
      <div class="col-lg-2">${bus ? '<span lang-title-key="nadKey"><img src="/images/nad.svg" /></span>' : ''}</div>
      <div class="col-lg-2">
        <span lang-title-key="arrivalEst"> ${arr} </span><span> - </span><span lang-title-key="departEst"> ${dep} </span>
      </div>
      <div class="col-lg-3"><span><span lang-title-key="arrivalGvd">(${arr}</span><span> - </span><span lang-title-key="departGvd">${dep}</span><span>)</span></span></div>
    </div>`;

  it('flags the stops the bus serves and counts them as passenger stops', () => {
    const html = [
      rowHtml('Zelené', false, '09:24', '09:25'),
      rowHtml('Poltár', true, '09:29', '09:30'),
      rowHtml('Zlatno', true, '09:43', '09:45'),
      rowHtml('Utekáč', true, '10:13', ''),
    ].join('');
    const stops = parseTrainDetail(html) as Array<{ name: string; bus?: boolean }>;
    expect(stops.map((stop) => Boolean(stop.bus))).toEqual([false, true, true, true]);
    // Not in the train's GTFS call list, but the bus still stops there.
    const kinds = classifyStops(stops, new Set(['zelene'])).map((stop: { kind: string }) => stop.kind);
    expect(kinds).toEqual(['stop', 'stop', 'stop', 'stop']);
  });
});
