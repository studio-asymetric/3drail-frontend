export type WaterPoint = { lat: number; lng: number };

export type WaterPolygon = {
  outer: WaterPoint[];
  holes: WaterPoint[][];
  class?: string;
};

export async function fetchWaterBodies(): Promise<WaterPolygon[]> {
  try {
    const response = await fetch('/proxy?mode=water');
    if (!response.ok) {
      throw new Error(`Water fetch failed: ${response.status}`);
    }
    const data = (await response.json()) as { polygons?: WaterPolygon[] };
    return Array.isArray(data.polygons) ? data.polygons : [];
  } catch (error) {
    console.warn('Failed to fetch water bodies:', error);
    return [];
  }
}
