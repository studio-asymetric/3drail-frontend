import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM module from the proxy, no type declarations
import { aheadKinds, classifyStops, isNonStopName, normalizeStationName, parseTrainDetail } from '../../proxy/trainDetail.mjs';
// @ts-expect-error plain ESM module from the proxy, no type declarations
import { withForeignStops } from '../../proxy/foreignStops.mjs';
import { indexJourneyRows } from '../data/trainService';
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
    // A departure leaves 5 s into its minute, an arrival at the start of it; a halt with
    // only a departure time arrived 50 s before it.
    expect(journey.stops[0].dep).toBe(t0 + 5);
    expect(journey.stops[1].arr).toBe(t0 + 135);
    expect(journey.stops[1].dep).toBe(t0 + 185);
    expect(journey.stops[2].dep - journey.stops[2].arr).toBe(0);
    expect(alongAtTime(journey, t0 + 140)).toBe(3000);
    expect(alongAtTime(journey, t0 + 184)).toBe(3000);
    expect(alongAtTime(journey, t0 + 190)).toBeGreaterThan(3000);
    // The passing point is one run with the halt-to-terminus leg: no stand there.
    expect(journey.runs).toEqual([
      [t0 + 5, t0 + 135],
      [t0 + 185, t0 + 540],
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
    const start = t0 + 5;
    const at = (s: number) => alongAtTime(journey, start + s)!;
    // Leaves 5 s into its minute, arrives at the start of its own (595 s later).
    expect(at(0)).toBe(0);
    expect(at(595)).toBe(6000);
    // First 10 s cover far less than a steady pace would (100 m).
    expect(at(10)).toBeLessThan(15);
    // Speed builds up: each 10 s covers more than the last, until cruising.
    expect(at(20) - at(10)).toBeGreaterThan(at(10) - at(0));
    expect(at(40) - at(30)).toBeGreaterThan(at(20) - at(10));
    // Symmetric braking.
    expect(6000 - at(585)).toBeCloseTo(at(10), 5);
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
  // The first departure is 5 s into its minute.
  const departure = (t0 + 5) * 1000;

  afterEach(() => vi.useRealTimers());

  it('does not hold a train ZSR still lists as waiting: it leaves on time like any other', () => {
    vi.useFakeTimers();
    vi.setSystemTime(departure);
    const waiting = make(false);
    const left = make(true);
    expect(waiting.target('7', departure + 60_000)).toBeGreaterThan(100);
    expect(waiting.target('7', departure + 60_000)).toBe(left.target('7', departure + 60_000));
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

describe('a train that arrived late and still stands at its station', () => {
  const t0 = 1_800_000_000;
  const raw = {
    n: '7',
    sig: 'late',
    line: encodePolyline([
      { lat: 48.0, lng: 17.0 },
      { lat: 48.5, lng: 17.0 },
    ]),
    ok: true,
    at: [0, 20000, 50000] as Array<number | null>,
    stops: [
      [0, null, t0 - 600, 0, 1],
      [20000, t0 + 600, t0 + 720, 1, 1],
      [50000, t0 + 3600, null, 2, 1],
    ] as Array<[number, number | null, number | null, number, number?]>,
  };
  // Timetable arrival t0+600, departure t0+725 (5 s into its minute); 2 minutes late on arrival.
  const standing = (currentStation?: string) => {
    const animator = new JourneyAnimator();
    animator.setJourneys(new Map([['7', buildJourney(raw)!]]));
    // ZSR's own estimate still says "on time" for the departure.
    animator.setEstimate('7', 0);
    animator.update([
      { trainNumber: '7', delayMinutes: 2, rosterOrderCurrentStation: 1, departureConfirmed: false, currentStation },
    ]);
    return animator;
  };

  afterEach(() => vi.useRealTimers());

  it('stays until its real arrival plus a short stay, not the stale on-time estimate', () => {
    const animator = standing('Leopoldov');
    // Real arrival t0+720, +20 s stay: still standing at t0+735, away by t0+765.
    expect(animator.target('7', (t0 + 735) * 1000)).toBe(20000);
    expect(animator.target('7', (t0 + 765) * 1000)!).toBeGreaterThan(20000);
  });

  it('stands a full minute at Bratislava hlavná stanica', () => {
    const animator = standing('Bratislava hlavná stanica');
    expect(animator.target('7', (t0 + 765) * 1000)).toBe(20000);
    expect(animator.target('7', (t0 + 810) * 1000)!).toBeGreaterThan(20000);
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

describe('stops abroad', () => {
  const zsrRows = [
    { name: 'Štúrovo št. hr.', scheduledArrival: '', scheduledDeparture: '18:24', state: 'passed' },
    { name: 'Štúrovo', scheduledArrival: '18:33', scheduledDeparture: '18:36', state: 'passed' },
    { name: 'Bratislava hlavná stanica', scheduledArrival: '19:55', scheduledDeparture: '19:58', state: 'ahead' },
    { name: 'Kúty', scheduledArrival: '20:47', scheduledDeparture: '20:49', state: 'ahead' },
    { name: 'Kúty št. hr.', scheduledArrival: '20:52', scheduledDeparture: '', state: 'ahead' },
  ];
  const trip = {
    stops: [
      { name: 'Budapest-Nyugati pu', arr: '17:30:00', dep: '17:30:00' },
      { name: 'Szob', arr: '18:22:00', dep: '18:23:00' },
      { name: 'Štúrovo', arr: '18:33:00', dep: '18:36:00' },
      { name: 'Bratislava hlavná stanica', arr: '19:55:00', dep: '19:58:00' },
      { name: 'Kúty', arr: '20:47:00', dep: '20:49:00' },
      { name: 'Břeclav', arr: '21:04:00', dep: '21:07:00' },
      { name: 'Praha hl.n.', arr: '24:18:00', dep: '24:18:00' },
    ],
  };

  it('puts the stops before and after ZSR\'s list around it, marked foreign', () => {
    const rows = withForeignStops(zsrRows, [trip]) as Array<{ name: string; foreign?: boolean; state: string; scheduledArrival: string; scheduledDeparture: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      'Budapest-Nyugati pu',
      'Szob',
      ...zsrRows.map((row) => row.name),
      'Břeclav',
      'Praha hl.n.',
    ]);
    expect(rows.filter((row) => row.foreign).map((row) => row.name)).toEqual([
      'Budapest-Nyugati pu',
      'Szob',
      'Břeclav',
      'Praha hl.n.',
    ]);
    expect(rows[0]).toMatchObject({ state: 'passed', scheduledArrival: '', scheduledDeparture: '17:30' });
    expect(rows[rows.length - 1]).toMatchObject({ state: 'ahead', scheduledArrival: '00:18', scheduledDeparture: '' });
  });

  it('leaves domestic trains and unknown trains alone', () => {
    expect(withForeignStops(zsrRows, [])).toBe(zsrRows);
    expect(withForeignStops(zsrRows, [{ stops: [{ name: 'Wien Hbf', arr: '10:00:00', dep: '10:00:00' }] }])).toBe(zsrRows);
  });

  it('numbers only the rows ZSR sent, so they keep lining up with the route', () => {
    const rows = indexJourneyRows([
      { name: 'Szob', foreign: true },
      { name: 'Štúrovo' },
      { name: 'Kúty' },
      { name: 'Břeclav', foreign: true },
    ] as never);
    expect(rows.map((row) => row.index)).toEqual([undefined, 0, 1, undefined]);
  });
});

describe('remembering what a train does at each station', () => {
  const row = (name: string, arr: string, dep: string, state: Row['state']) => ({
    name,
    scheduledArrival: arr,
    scheduledDeparture: dep,
    state,
  });

  it('reads it from the rows still ahead: only stops carry times there', () => {
    const learned = aheadKinds([
      row('Rača', '12:55', '12:55', 'passed'),
      row('Svätý Jur', '', '', 'ahead'),
      row('Pezinok', '13:04', '13:05', 'ahead'),
      row('Bratislava', '15:15', '', 'ahead'),
    ]);
    expect(learned).toEqual([
      ['svaty jur', 'pass'],
      ['pezinok', 'stop'],
    ]);
  });

  it('keeps a passed row a pass once the train has gone through it, though ZSR now times it', () => {
    const memory = new Map([
      ['svaty jur', 'pass'],
      ['pezinok', 'stop'],
    ]);
    const rows = [
      row('Rača', '12:55', '12:55', 'passed'),
      row('Svätý Jur', '12:59', '12:59', 'passed'),
      row('Pezinok', '13:04', '13:04', 'passed'),
      row('Šenkvice', '13:11', '13:11', 'passed'),
      row('Bratislava', '15:15', '', 'ahead'),
    ];
    const kinds = classifyStops(rows, null, memory).map((stop: { kind: string }) => stop.kind);
    // Šenkvice was never seen ahead, so it stays a stop; the rest follow the memory.
    expect(kinds).toEqual(['stop', 'pass', 'stop', 'stop', 'stop']);
    // Without a memory every passed row with a time would show up as a stop.
    const without = classifyStops(rows, null, null).map((stop: { kind: string }) => stop.kind);
    expect(without[1]).toBe('stop');
  });
});
