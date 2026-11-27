import React, { useEffect, useState } from 'react';

/**
 * The open train's "last position" line with a live dot in place of the info icon, and a countdown
 * to the next fetch of the live data ("· 32 s").
 *
 * It says whether what is shown is current with the server, not how old the train's own report
 * is. The countdown runs to 0, the dot turns into a small spinner while the feed is fetched, then
 * pulses once when it arrives and the countdown starts again, so it is plain the page is live (no reload
 * button needed). Grey when the feed has not come for a while or cannot be reached.
 */

/** Shortest time the spinner shows, so a quick fetch is still seen (ms). */
const MIN_SPIN_MS = 700;

export type FreshnessLabels = {
  /** Tooltip: "Aktualizované pred 20 s". */
  updated: (seconds: number) => string;
  offline: string;
};

type Props = {
  /** When the live feed last arrived (ms), null before the first one. */
  fetchedAt: number | null;
  /** How often the feed is fetched (ms): two missed turns count as out of date. */
  intervalMs: number;
  offline: boolean;
  /** The feed is being fetched right now. */
  fetching: boolean;
  /** When the next regular fetch is due (ms). */
  nextAt: number | null;
  labels: FreshnessLabels;
  /** The full station name, when the line shows a shortened one. */
  fullName?: string;
  children: React.ReactNode;
};

export function FreshnessPosition({ fetchedAt, intervalMs, offline, fetching, nextAt, labels, fullName, children }: Props) {
  // Its own one-second tick for the seconds, so the panel around it does not re-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [fetchedAt, nextAt]);

  // Keep the spinner up a moment, or a 200 ms fetch would only flicker.
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (fetching) {
      setSpinning(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setSpinning(false), MIN_SPIN_MS);
    return () => window.clearTimeout(timer);
  }, [fetching]);

  const age = fetchedAt != null ? Math.max(0, now - fetchedAt) : null;
  const stale = offline || age == null || age > intervalMs * 2 + 10_000;
  const seconds = age != null ? Math.floor(age / 1000) : null;
  const left = nextAt != null ? Math.ceil((nextAt - now) / 1000) : null;
  // Counting down to the next fetch; nothing once it is due (the spinner takes over) or out of date.
  const countText = left != null && left > 0 && !stale ? `${left} s` : null;
  const title = [fullName, offline ? labels.offline : seconds != null ? labels.updated(seconds) : null]
    .filter(Boolean)
    .join(' · ');
  const state = spinning ? ' freshness--fetching' : stale ? ' freshness--stale' : '';
  return (
    <span className={`dock__last-position freshness${state}`} title={title || undefined}>
      {/* Keyed on the fetch: every new one pulses again. */}
      <span key={fetchedAt ?? 0} className="freshness__dot" aria-hidden="true" />
      {children}
      {countText && !spinning && <span className="freshness__age">· {countText}</span>}
    </span>
  );
}
