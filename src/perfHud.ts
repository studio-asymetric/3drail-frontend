import { LITE_MODE, RENDER_PIXEL_RATIO } from './perf';

/**
 * On-device performance readout, shown with `?perf` in the URL (e.g. mojvlak.sk/?perf).
 * Real fps, frame-time p95, long tasks, and how many ms per second our own train work takes,
 * so a slow phone tells us whether the time goes to our code or to the map / GPU.
 */

export const PERF_HUD = (() => {
  try {
    return new URLSearchParams(window.location.search).has('perf');
  } catch {
    return false;
  }
})();

const totals = new Map<string, { ms: number; n: number; max: number }>();
const counters = new Map<string, number>();

/** Add one timed run of `label` (ms). No-op unless the HUD is on. */
export function perfAdd(label: string, ms: number) {
  if (!PERF_HUD) {
    return;
  }
  const entry = totals.get(label) ?? { ms: 0, n: 0, max: 0 };
  entry.ms += ms;
  entry.n += 1;
  entry.max = Math.max(entry.max, ms);
  totals.set(label, entry);
}

/** Latest value of a gauge (e.g. pills drawn). */
export function perfSet(label: string, value: number) {
  if (PERF_HUD) {
    counters.set(label, value);
  }
}

let started = false;

export function startPerfHud() {
  if (!PERF_HUD || started || typeof document === 'undefined') {
    return;
  }
  started = true;
  const box = document.createElement('pre');
  Object.assign(box.style, {
    position: 'fixed',
    left: '8px',
    top: 'calc(env(safe-area-inset-top, 0px) + 64px)',
    zIndex: '9999',
    margin: '0',
    padding: '6px 8px',
    font: '11px/1.35 ui-monospace, Menlo, monospace',
    color: '#0f0',
    background: 'rgba(0,0,0,0.78)',
    borderRadius: '6px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
  });
  document.body.appendChild(box);

  const frames: number[] = [];
  let last = performance.now();
  const tick = (now: number) => {
    frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  let longCount = 0;
  let longMs = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longCount += 1;
        longMs += entry.duration;
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    // Not supported (Safari): the line just stays at zero.
  }

  let windowStart = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const seconds = (now - windowStart) / 1000;
    windowStart = now;
    const sorted = frames.splice(0).sort((a, b) => a - b);
    const fps = sorted.length / seconds;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    const lines = [
      `fps ${fps.toFixed(0).padStart(3)}  p95 ${p95.toFixed(0)}ms`,
      `long ${longCount} (${longMs.toFixed(0)}ms)`,
      `dpr ${RENDER_PIXEL_RATIO}${LITE_MODE ? ' lite' : ''}`,
    ];
    longCount = 0;
    longMs = 0;
    totals.forEach((entry, label) => {
      lines.push(
        `${label.padEnd(8)} ${(entry.ms / seconds).toFixed(1).padStart(5)}ms/s  ${entry.n}x max ${entry.max.toFixed(1)}`
      );
    });
    totals.clear();
    counters.forEach((value, label) => lines.push(`${label.padEnd(8)} ${value}`));
    box.textContent = lines.join('\n');
  }, 1000);
}
