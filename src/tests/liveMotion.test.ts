import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildJourney, JourneyAnimator } from '../data/journeyService';
import { encodePolyline } from '../data/routeService';

const LAT_METERS = 110_574;

describe('a vehicle with live GPS fixes', () => {
  afterEach(() => vi.useRealTimers());

  // A straight 55 km line, timetabled at 10 m/s, but the vehicle really goes 6 m/s, then 12, then
  // stands: the drawn spot must follow without jumping, whatever the timetable says.
  const t0 = 1_800_000_000;
  const raw = {
    n: 'v',
    sig: 'live',
    line: encodePolyline([
      { lat: 48.0, lng: 17.0 },
      { lat: 48.5, lng: 17.0 },
    ]),
    ok: true,
    at: [0, 50000] as Array<number | null>,
    stops: [
      [0, null, t0, 0, 1],
      [50000, t0 + 5000, null, 1, 1],
    ] as Array<[number, number | null, number | null, number, number?]>,
  };

  const realAlong = (seconds: number) => {
    if (seconds <= 60) return 6 * seconds;
    if (seconds <= 120) return 360 + 12 * (seconds - 60);
    return 1080; // stands from 120 s on
  };

  it('moves smoothly between fixes and stays near the real position', () => {
    vi.useFakeTimers();
    const start = (t0 + 5) * 1000;
    vi.setSystemTime(start);
    const animator = new JourneyAnimator();
    animator.setJourneys(new Map([['v', buildJourney(raw)!]]));

    const fixAt = (seconds: number) => {
      const along = realAlong(seconds);
      return {
        trainNumber: 'v',
        delayMinutes: 0,
        rosterOrderCurrentStation: 0,
        rosterLiveGps: true,
        rosterLiveAt: start + seconds * 1000,
        departureConfirmed: seconds < 120 ? true : false,
        position: { lat: 48.0 + along / LAT_METERS, lng: 17.0, sequence: 0 },
      };
    };

    let last: number | null = null;
    let worstStep = 0;
    let worstGap = 0;
    for (let frame = 0; frame <= 180 * 30; frame += 1) {
      const seconds = frame / 30;
      vi.setSystemTime(start + seconds * 1000);
      if (frame % (15 * 30) === 0) {
        animator.update([fixAt(seconds)]);
      }
      const spot = animator.position('v', start + seconds * 1000);
      if (!spot) continue;
      if (last != null && seconds > 20) {
        worstStep = Math.max(worstStep, Math.abs(spot.along - last));
      }
      last = spot.along;
      if (seconds > 30) {
        worstGap = Math.max(worstGap, Math.abs(spot.along - realAlong(seconds)));
      }
    }
    // no frame moves more than about 30 m/s * 1/30 s
    expect(worstStep).toBeLessThan(1.0);
    // and it never strays far from the vehicle (a fix is up to 15 s old: ~180 m at 12 m/s)
    expect(worstGap).toBeLessThan(500);
    // standing at the end: it waits (it does not reverse) at most about one fix interval's run past where the vehicle stands
    expect(Math.abs((last ?? 0) - 1080)).toBeLessThan(250);
  });
});
