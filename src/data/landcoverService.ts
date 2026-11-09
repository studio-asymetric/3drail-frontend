export type LandcoverKind = 'forest' | 'urban';

export type LandcoverPoint = { lat: number; lng: number };

export type LandcoverPolygon = {
  outer: LandcoverPoint[];
  holes: LandcoverPoint[][];
  class?: string;
  kind?: LandcoverKind;
};

export async function fetchLandcover(): Promise<LandcoverPolygon[]> {
  try {
    const response = await fetch('/proxy?mode=landcover');
    if (!response.ok) {
      throw new Error(`Landcover fetch failed: ${response.status}`);
    }
    const data = (await response.json()) as { polygons?: LandcoverPolygon[] };
    return Array.isArray(data.polygons) ? data.polygons : [];
  } catch (error) {
    console.warn('Failed to fetch landcover:', error);
    return [];
  }
}
