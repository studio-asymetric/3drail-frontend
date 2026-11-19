import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * Screen projection as plain arithmetic.
 *
 * The map is locked north-up with no pitch, so lng/lat → pixels is Web Mercator scaled and
 * shifted: one `map.project` per frame (for the centre, which carries any camera padding)
 * replaces ~130 of them for the train pills.
 */

const DEG = Math.PI / 180;

function mercX(lng: number): number {
  return (lng + 180) / 360;
}

function mercY(lat: number): number {
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) / (2 * Math.PI);
}

export interface ScreenProjection {
  /** Pixels per Mercator unit (MapLibre's world size). */
  scale: number;
  projectX(lng: number): number;
  projectY(lat: number): number;
  project(lng: number, lat: number): { x: number; y: number };
  unproject(x: number, y: number): { lng: number; lat: number };
}

export function screenProjection(map: MapLibreMap): ScreenProjection {
  const center = map.getCenter();
  const origin = map.project(center);
  const scale = 512 * 2 ** map.getZoom();
  const cx = mercX(center.lng);
  const cy = mercY(center.lat);
  const projectX = (lng: number) => origin.x + (mercX(lng) - cx) * scale;
  const projectY = (lat: number) => origin.y + (mercY(lat) - cy) * scale;
  return {
    scale,
    projectX,
    projectY,
    project: (lng, lat) => ({ x: projectX(lng), y: projectY(lat) }),
    unproject: (x, y) => {
      const mx = cx + (x - origin.x) / scale;
      const my = cy + (y - origin.y) / scale;
      return {
        lng: mx * 360 - 180,
        lat: (2 * Math.atan(Math.exp((0.5 - my) * 2 * Math.PI)) - Math.PI / 2) / DEG,
      };
    },
  };
}
