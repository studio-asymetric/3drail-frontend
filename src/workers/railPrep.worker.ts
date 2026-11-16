/// <reference lib="webworker" />
/**
 * Loads and prepares the rail network off the main thread: download + decode the pack,
 * clip it to Slovakia, close the small gaps between ways and pick what is drawn.
 * Done on the page this froze it for about a second on load (more on slow phones).
 */
import { fetchSimplifiedNetwork, isPathfindingWay, type OSMWay } from '../data/osmRailService';
import { clipWaysToOutline, type LatLngPolygon } from '../data/slovakiaClip';
import { closeRailGaps } from '../data/railStitch';
import { classifyDisplayRails } from '../data/railGeoJson';

type Request = { outline: LatLngPolygon[] };

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    let ways: OSMWay[] = [];
    let meta: unknown;
    for (let attempt = 0; attempt < 3 && ways.length === 0; attempt += 1) {
      const result = await fetchSimplifiedNetwork();
      ways = result.ways;
      meta = result.meta;
      if (ways.length === 0 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
    const clipped = clipWaysToOutline(ways, event.data.outline);
    const stitched = closeRailGaps(clipped);
    const display = classifyDisplayRails(stitched);
    const pathfinding = stitched.filter(isPathfindingWay);
    self.postMessage({ ok: true, display, pathfinding, meta });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
