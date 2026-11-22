import type { FeatureCollection } from 'geojson';
import { REGION_ID } from '../region';

/** Tram and metro tracks of the region (Prague), or null when the region has none or the request fails. */
export async function fetchTransitLines(signal?: AbortSignal): Promise<FeatureCollection | null> {
  if (REGION_ID === 'sk') {
    return null;
  }
  try {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const response = await fetch(`/proxy/lines?mode=lines&regions=${REGION_ID}&only=1`, { signal });
      if (response.status === 202) {
        await new Promise((resolve) => window.setTimeout(resolve, 4000));
        continue;
      }
      return response.ok ? ((await response.json()) as FeatureCollection) : null;
    }
  } catch {
    // no lines: the map is just without them
  }
  return null;
}
