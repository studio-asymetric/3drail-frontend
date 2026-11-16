/**
 * Device budget. Phones with 3x screens render nine times the pixels of 1x; above 2x the
 * difference is hard to see, so the map and the train canvas stop there. Weak devices (little
 * memory or few cores) get "lite" mode: 1.5x, fewer train-position updates, no hillshade.
 */
type NavigatorWithMemory = Navigator & { deviceMemory?: number };

function detectLite(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  try {
    if (new URLSearchParams(window.location.search).has('lite')) {
      return true;
    }
  } catch {
    // ignore
  }
  const memory = (navigator as NavigatorWithMemory).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  return (typeof memory === 'number' && memory <= 4) || (typeof cores === 'number' && cores > 0 && cores <= 4);
}

export const LITE_MODE = detectLite();

const deviceRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

/** Pixel ratio for the map and the train canvas. */
export const RENDER_PIXEL_RATIO = Math.min(deviceRatio, LITE_MODE ? 1.5 : 2);

/** Shortest gap between train-position refreshes when zoomed in (ms). */
export const TRAIN_FRAME_MS = LITE_MODE ? 66 : 40;

/** Shortest gap between follow-camera moves (ms): 0 = every frame. */
export const FOLLOW_FRAME_MS = LITE_MODE ? 33 : 0;
