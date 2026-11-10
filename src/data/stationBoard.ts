export type StationBoardRow = {
  time: string;
  datetime?: string;
  code: string;
  trainId?: string;
  trainNumber: string;
  destination: string;
  via?: string;
  operator?: string;
  delayText?: string;
  delayMinutes: number;
};

export type StationBoardResponse = {
  station: string;
  arrivals: boolean;
  status?: string;
  error?: string;
  rows: StationBoardRow[];
};

export type FocusedStation = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

export async function fetchStationBoard(
  station: string,
  arrivals: boolean,
  signal?: AbortSignal
): Promise<StationBoardResponse> {
  const query = new URLSearchParams({
    station,
    byarr: arrivals ? 'true' : 'false',
  });
  const response = await fetch(`/proxy/station?${query.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Station board HTTP ${response.status}`);
  }
  return (await response.json()) as StationBoardResponse;
}
