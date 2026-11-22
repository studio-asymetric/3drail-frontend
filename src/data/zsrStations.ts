export type ZsrStation = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

export async function fetchZsrStations(): Promise<ZsrStation[]> {
  const response = await fetch('/proxy/stations?mode=stations', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Station catalog HTTP ${response.status}`);
  }
  const body = (await response.json()) as { stations?: ZsrStation[] };
  return Array.isArray(body.stations) ? body.stations : [];
}
