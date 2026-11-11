import type {
  Coordinate,
  GtfsDataset,
  GtfsTrip,
  GtfsStopTime,
} from './gtfsParser';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
export const DEFAULT_API_KEY = import.meta.env.VITE_API_KEY ?? '';

function trainLog(...args: unknown[]) {
  if (import.meta.env.DEV && import.meta.env.VITE_TRAIN_LOGS === '1') {
    console.log(...args);
  }
}

// Interface matching mapa.zsr.sk response format
interface MapaZsrTrain {
  CisloVlaku: string;
  NazovVlaku: string;
  TypVlaku: string;
  Nazov: string;
  Popis?: string;
  Position: [number, number]; // [lat, lng]
  PositionNext?: [number, number] | null;
  Trasa: Array<{ Key: string; Value: [number, number][] }>;
  Meska: number;
  MeskaSkutocne: number;
  MeskaColor: string;
  MeskaText?: string;
  MeskaTextEn?: string;
  InfoZoStanice?: string;
  NextStation?: string;
  Cas?: string;
  CasPlan?: string;
  Dopravca?: string;
  Poznamka?: string;
  Angle?: number;
  Narusenie?: boolean;
  OrderCurrentStation?: number | string;
  NadOd?: string | null;
  NadDo?: string | null;
}

export interface RouteSegment {
  key: string;
  points: Coordinate[];
}

export interface JourneyStop {
  name: string;
  arrival: string;
  departure: string;
  scheduledArrival: string;
  scheduledDeparture: string;
  state: 'passed' | 'current' | 'ahead';
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrainRosterItem {
  train: {
    number: string;
    name?: string;
    type?: string;
  };
  trainDelay?: TrainDelayPayload;
  timestamp: number;
  route?: Coordinate[]; // Route coordinates from mapa.zsr.sk
  routeSegments?: RouteSegment[];
  position?: Coordinate; // Current position
  rosterPreviousStation?: string;
  rosterNextStation?: string;
  orderCurrentStation?: number;
  summary?: string;
  operator?: string;
  delayText?: string;
  actualTime?: string;
  plannedTime?: string;
  heading?: number;
  disrupted?: boolean;
  replacementFrom?: string;
  replacementTo?: string;
  note?: string;
}

export interface TrainDelayPayload {
  trainNumber: string;
    delayMinutes: number;
  currentUic?: string;
  currentName?: string;
  nextStationName?: string;
    timestamp: number;
}

export interface TrainRenderState {
  trainNumber: string;
  trainName?: string;
  trainType?: string;
  shapePath: Coordinate[];
  position?: Coordinate;
  progress: number;
    delayMinutes: number;
  color: string;
  nextStation?: string;
  currentStation?: string;
  reportedAt: number;
  rosterPreviousStation?: string;
  rosterNextStation?: string;
  rosterOrderCurrentStation?: number;
  liveRoute?: Coordinate[];
  routeSegments?: RouteSegment[];
  summary?: string;
  operator?: string;
  delayText?: string;
  actualTime?: string;
  plannedTime?: string;
  heading?: number;
  disrupted?: boolean;
  replacementFrom?: string;
  replacementTo?: string;
  note?: string;
}

function clamp(value: number, min = 0, max = 1): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function findStopNameByUic(
  dataset: GtfsDataset,
  uic?: string
): string | undefined {
  if (!uic) {
    return undefined;
  }
  const normalized = uic.replace(/\D/g, '');
  return Object.values(dataset.stops).find(
    (stop) => stop.uicCode?.replace(/\D/g, '') === normalized
  )?.name;
}

function isStationUicCode(value: string) {
  return /^\d{5,}$/.test(value.replace(/\s/g, ''));
}

function resolveStationDisplayName(
  dataset: GtfsDataset,
  label?: string,
  fallback?: string
): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed) {
    const fb = fallback?.trim();
    return fb || undefined;
  }
  if (isStationUicCode(trimmed)) {
    return findStopNameByUic(dataset, trimmed) ?? fallback?.trim() ?? undefined;
  }
  return trimmed;
}

function estimateProgress(
  trainNumber: string,
  trip: GtfsTrip,
  dataset: GtfsDataset,
  reportedAt: number,
  delayMinutes: number,
  delayInfo?: TrainDelayPayload
): number {
  const stopTimes = dataset.stopTimes[trip.tripId];
  if (!stopTimes || stopTimes.length < 2) {
    return 0.5;
  }

  const departureMs =
    stopTimes[0].departureTimeMs ?? stopTimes[0].arrivalTimeMs ?? 0;
  let arrivalMs =
    stopTimes[stopTimes.length - 1].arrivalTimeMs ??
    stopTimes[stopTimes.length - 1].departureTimeMs ??
    departureMs + 30 * 60 * 1000;

  if (arrivalMs <= departureMs) {
    arrivalMs += DAY_MS;
  }

  const normalizedTimestamp = reportedAt % DAY_MS;
  let adjustedTimestamp = normalizedTimestamp;
  if (adjustedTimestamp < departureMs) {
    adjustedTimestamp += DAY_MS;
  }

  const tripDuration = arrivalMs - departureMs;
  if (tripDuration <= 0) {
    return 0.5;
  }

  const baseProgress = clamp(
    (adjustedTimestamp - departureMs) / tripDuration,
    0,
    1
  );
  const delayOffset = clamp(delayMinutes / 120, -0.25, 0.25);

  const delayInfoUic = delayInfo?.currentUic;
  if (delayInfoUic) {
    const stopIndex = stopTimes.findIndex((stopTime) => {
      const stop = dataset.stops[stopTime.stopId];
      return (
        stop &&
        stop.uicCode &&
        stop.uicCode.replace(/\D/g, '') ===
          delayInfoUic.replace(/\D/g, '')
      );
    });
    if (stopIndex !== -1) {
      const stopProgress = stopIndex / Math.max(stopTimes.length - 1, 1);
      return clamp(stopProgress + delayOffset, 0, 1);
    }
  }

  return clamp(baseProgress + delayOffset, 0, 1);
}

function interpolateShape(
  shape: Coordinate[],
  progress: number
): Coordinate | undefined {
  if (shape.length === 0) {
    return undefined;
}
  const lastIndex = shape.length - 1;
  const scaled = clamp(progress, 0, 1) * lastIndex;
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(lastIndex, lowerIndex + 1);
  const fraction = scaled - lowerIndex;
  const lower = shape[lowerIndex];
  const upper = shape[upperIndex];
  return {
    lat: lerp(lower.lat, upper.lat, fraction),
    lng: lerp(lower.lng, upper.lng, fraction),
    sequence: upper.sequence,
  };
}

function resolveTripForTrain(
  dataset: GtfsDataset,
  trainNumber: string
): GtfsTrip | undefined {
  return (
    dataset.trips.byTrainNumber[trainNumber] ??
    dataset.trips.byTripId[trainNumber]
  );
}

/** Turn roster names like OSTRAVAN into Ostravan; leave already mixed names alone. */
export function formatTrainDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }
  const letters = [...trimmed].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) {
    return trimmed;
  }
  const upperCount = letters.filter(
    (ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase()
  ).length;
  if (upperCount / letters.length < 0.85) {
    return trimmed;
  }
  return trimmed
    .toLocaleLowerCase('sk-SK')
    .replace(
      /(^|[\s\-–—(])(\p{L})/gu,
      (_, separator: string, letter: string) =>
        `${separator}${letter.toLocaleUpperCase('sk-SK')}`
    );
}

export function getDelayColor(delayMinutes: number): string {
  if (delayMinutes >= 30) {
    return '#D12F2F';
  }
  if (delayMinutes >= 10) {
    return '#FF6E12';
  }
  if (delayMinutes > 0) {
    return '#F0B400';
  }
  return '#1B9E6A';
}

/** Type color that stays readable on a delay fill. */
export function contrastInk(fill: string): string {
  const hex = fill.replace('#', '');
  if (hex.length < 6) {
    return '#ffffff';
  }
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const linear = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.32 ? '#1a1a1a' : '#ffffff';
}

/** Short callout on the map pill: Ex, Os, rj. */
export function trainTypeCallout(type?: string): string {
  const raw = (type ?? '').trim();
  if (!raw) {
    return '';
  }
  const compact = raw.replace(/\s+/g, '');
  const key = compact.toLowerCase();
  if (key === 'railjet') {
    return 'rj';
  }
  if (key === 'regiojet') {
    return 'RJ';
  }
  return compact;
}

function normalizeRoster(
  roster: TrainRosterItem
): { trainNumber: string; reportedAt: number; delayMinutes: number } {
  const trainNumber = roster.train?.number ?? roster.trainDelay?.trainNumber ?? '';
  if (!trainNumber) {
    throw new Error('Roster entry missing train number');
  }
  const delayMinutes = roster.trainDelay?.delayMinutes ?? 0;
  return { trainNumber, reportedAt: roster.timestamp, delayMinutes };
}

/**
 * Fetch ALL trains from mapa.zsr.sk
 * This gets all active trains, not just from specific stations
 */
export interface LiveFetchOptions {
  useProxy?: boolean;
  proxyUrl?: string;
  refresh?: boolean;
}

export async function fetchAllTrains(options?: LiveFetchOptions): Promise<TrainRosterItem[]> {
  // Fetch from live mapa.zsr.sk using the same method as the website
  // POST to /api/action with action: "gtall" (GetAll)
  const isProxy = Boolean(options?.useProxy);
  const proxyUrl = options?.proxyUrl ?? '/proxy';
  const endpoint =
    isProxy
      ? `${proxyUrl.replace(/\/$/, '')}/gtall?mode=gtall${options?.refresh ? '&refresh=1' : ''}`
      : '/api/action';
  
  try {
    trainLog(`🚂 Fetching ${isProxy ? 'proxy' : 'live'} train data from ${endpoint}...`);
    
    // Use URLSearchParams to send as application/x-www-form-urlencoded (like jQuery does)
    // jQuery serializes objects, so args should be JSON stringified
    const params = new URLSearchParams();
    params.append('action', 'gtall');
    params.append('args', JSON.stringify({})); // Empty object as JSON string
    
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      body: params,
      headers,
    });
    
    trainLog(`Response status: ${res.status} ${res.statusText}`);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    let content = await res.text();
    trainLog(`Response length: ${content.length} characters`);
    trainLog(`Response content:`, content.substring(0, 500));
    
    // Check if it's HTML (error page) instead of JSON
    if (content.trim().startsWith('<')) {
      throw new Error('Received HTML instead of JSON (likely error page)');
    }
    
    // Fix common JSON issues (control characters, etc.)
    content = content
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
      .trim();
    
    // Parse JSON
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(content);
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError);
      console.error('Raw content:', content);
      throw new Error(`Invalid JSON response: ${content.substring(0, 100)}`);
    }

    // Check if response is wrapped in an object (like { result: [...] })
    let trains: MapaZsrTrain[];
    if (Array.isArray(parsedResponse)) {
      trains = parsedResponse;
    } else if (parsedResponse && Array.isArray(parsedResponse.result)) {
      trains = parsedResponse.result;
    } else if (parsedResponse && Array.isArray(parsedResponse.data)) {
      trains = parsedResponse.data;
    } else {
      const payload = parsedResponse?.data ?? parsedResponse;
      if (payload === 'tokenError') {
        throw new Error('ZSR session token expired');
      }
      console.error('Unexpected response format:', parsedResponse);
      throw new Error(`Response is not an array. Got: ${JSON.stringify(parsedResponse).substring(0, 200)}`);
  }
    
    if (trains.length === 0) {
      console.warn('⚠ Received empty train array from live API');
      return [];
    }
    
    trainLog(`✓ Successfully loaded ${trains.length} trains from live mapa.zsr.sk`);
    trainLog(`Sample trains:`, trains.slice(0, 5).map(t => `${t.CisloVlaku} ${t.NazovVlaku}`));
    
    return convertTrainsToRosterItems(trains);
    
  } catch (error) {
    console.error('❌ Failed to fetch from live API:', error);
    console.error('This might be due to:');
    console.error('  1. Network connectivity issues');
    console.error('  2. CORS restrictions (check vite proxy configuration)');
    console.error('  3. The API endpoint changed');
    console.error('  4. Server is temporarily unavailable');
    
    // Fallback: Try static file (mirror data from mapa.zsr.sk)
    // Note: Live API requires authentication token. The static file contains snapshot data.
    try {
      trainLog('🔄 API requires authentication. Trying static fallback from /gtfs/train-data.json...');
      const staticRes = await fetch('/gtfs/train-data.json', {
        cache: 'no-cache',
      });
      
      trainLog(`Static file response: ${staticRes.status} ${staticRes.statusText}`);
      
      if (!staticRes.ok) {
        throw new Error(`Static file returned ${staticRes.status}: ${staticRes.statusText}`);
      }
      
      let content = await staticRes.text();
      trainLog(`Static file content length: ${content.length} characters`);
      trainLog(`First 100 chars:`, content.substring(0, 100));
      
      // Check if it's HTML (404 page or error)
      const trimmed = content.trim();
      if (trimmed.startsWith('<')) {
        console.error('Static file appears to be HTML, not JSON');
        console.error('First 200 chars:', trimmed.substring(0, 200));
        throw new Error('Static fallback file is HTML (likely 404 page)');
      }
      
      // Fix JSON issues: The file has literal newlines in string values that need to be escaped
      // We'll use a state machine approach to properly escape newlines inside strings
      let fixedContent = '';
      let inString = false;
      let escapeNext = false;
      
      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1];
        
        if (escapeNext) {
          fixedContent += char;
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          fixedContent += char;
          escapeNext = true;
          continue;
        }
        
        if (char === '"' && (i === 0 || content[i - 1] !== '\\')) {
          inString = !inString;
          fixedContent += char;
          continue;
        }
        
        if (inString) {
          // Inside a string: escape newlines and other control characters
          if (char === '\n') {
            fixedContent += '\\n';
          } else if (char === '\r') {
            // Skip \r if followed by \n (Windows line ending)
            if (nextChar === '\n') {
              i++; // Skip the \n too, we'll add \n
              fixedContent += '\\n';
            } else {
              fixedContent += '\\r';
            }
          } else if (char >= '\x00' && char <= '\x1F' && char !== '\t') {
            // Escape other control characters
            const code = char.charCodeAt(0);
            fixedContent += `\\u${code.toString(16).padStart(4, '0')}`;
          } else {
            fixedContent += char;
          }
        } else {
          // Outside strings: keep as-is (but normalize whitespace)
          if (char === '\n' || char === '\r') {
            // Keep newlines outside strings for readability, but normalize
            if (fixedContent[fixedContent.length - 1] !== '\n') {
              fixedContent += ' ';
            }
          } else {
            fixedContent += char;
          }
        }
      }
      
      let staticData;
      try {
        staticData = JSON.parse(fixedContent);
        trainLog('✓ Successfully parsed JSON after fixing control characters');
      } catch (parseError) {
        console.error('Failed to parse JSON even after fixing:', parseError);
        console.error('Error position:', parseError instanceof SyntaxError ? (parseError as any).message : 'unknown');
        console.error('Content around error (chars 300-400):', fixedContent.substring(300, 400));
        throw parseError;
      }
      
      if (Array.isArray(staticData) && staticData.length > 0) {
        trainLog(`✓ Using static fallback data: ${staticData.length} trains`);
        trainLog(`ℹ Note: This is snapshot data from the mirror. For live data, authentication is required.`);
        const trains = staticData as MapaZsrTrain[];
        return convertTrainsToRosterItems(trains);
      } else {
        throw new Error(`Static data is not an array. Got: ${typeof staticData}`);
      }
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      if (fallbackError instanceof Error) {
        console.error('Error details:', fallbackError.message);
}
    }
    
    return [];
  }
}

function convertTrainsToRosterItems(trains: MapaZsrTrain[]): TrainRosterItem[] {
  // Convert mapa.zsr.sk format to our TrainRosterItem format
  const rosterItems: TrainRosterItem[] = trains.map((train) => {
    const parsedOrder =
      train.OrderCurrentStation !== undefined && train.OrderCurrentStation !== null
        ? Number(train.OrderCurrentStation)
        : NaN;

    return {
      train: {
        number: train.CisloVlaku,
        name: train.NazovVlaku,
        type: train.TypVlaku,
      },
      trainDelay: {
        trainNumber: train.CisloVlaku,
        delayMinutes: train.Meska || 0,
        currentName: train.InfoZoStanice,
        nextStationName: train.NextStation,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
      position: train.Position
        ? {
            lat: train.Position[0],
            lng: train.Position[1],
            sequence: 0,
          }
        : undefined,
      rosterPreviousStation: train.NadOd || undefined,
      rosterNextStation: train.NadDo || undefined,
      orderCurrentStation: Number.isFinite(parsedOrder) ? parsedOrder : undefined,
      summary: train.Popis || train.Nazov || undefined,
      operator: train.Dopravca || undefined,
      delayText: train.MeskaTextEn || train.MeskaText || undefined,
      actualTime: train.Cas || undefined,
      plannedTime: train.CasPlan || undefined,
      heading: typeof train.Angle === 'number' ? train.Angle : undefined,
      disrupted: Boolean(train.Narusenie),
      replacementFrom: train.NadOd || undefined,
      replacementTo: train.NadDo || undefined,
      note: train.Poznamka || undefined,
    };
  });

  return rosterItems;
}

export async function fetchDelayBatch(
  trainNumbers: string[],
  travelDate: number,
  apiKey: string
): Promise<Record<string, TrainDelayPayload>> {
  if (trainNumbers.length === 0) {
    return {};
  }
  const payload = trainNumbers.map((trainNumber) => ({
    trainNumber,
    travelDate,
  }));
  const res = await fetch(`${API_BASE}/train/delay`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error('Unable to load train delays');
  }
  const body = (await res.json()) as TrainDelayPayload[];
  const map: Record<string, TrainDelayPayload> = {};
  body.forEach((item) => {
    if (item?.trainNumber) {
      map[item.trainNumber] = item;
    }
  });
  return map;
}

const EMPTY_SHAPE_PATH: Coordinate[] = [];

export function buildTrainRenderState(
  roster: TrainRosterItem,
  dataset: GtfsDataset,
  delayInfo: TrainDelayPayload | undefined,
  normalizedEntry?: { trainNumber: string; reportedAt: number }
): TrainRenderState | null {
  let trainNumber: string;
  let reportedAt: number;
  try {
    const normalized = normalizedEntry ?? normalizeRoster(roster);
    trainNumber = normalized.trainNumber;
    reportedAt = normalized.reportedAt;
  } catch (err) {
    return null;
  }

  // Live GPS trains don't need the Trasa/GTFS polyline on the map roster.
  if (roster.position) {
    reportedAt = delayInfo?.timestamp ?? roster.timestamp;
    const delayMinutes =
      delayInfo?.delayMinutes ?? roster.trainDelay?.delayMinutes ?? 0;
    const currentStation = delayInfo?.currentName
      ? delayInfo.currentName
      : findStopNameByUic(dataset, delayInfo?.currentUic);
    const nextStation = resolveStationDisplayName(
      dataset,
      delayInfo?.nextStationName,
      roster.rosterNextStation
    );
    return {
      trainNumber,
      trainName: roster.train?.name
        ? formatTrainDisplayName(roster.train.name)
        : undefined,
      trainType: roster.train?.type,
      shapePath: EMPTY_SHAPE_PATH,
      position: roster.position,
      progress: 0.5,
      delayMinutes,
      color: getDelayColor(delayMinutes),
      nextStation,
      currentStation,
      reportedAt,
      rosterPreviousStation: roster.rosterPreviousStation,
      rosterNextStation: roster.rosterNextStation,
      rosterOrderCurrentStation: roster.orderCurrentStation,
      summary: roster.summary,
      operator: roster.operator,
      delayText: roster.delayText,
      actualTime: roster.actualTime,
      plannedTime: roster.plannedTime,
      heading: roster.heading,
      disrupted: roster.disrupted,
      replacementFrom: roster.replacementFrom,
      replacementTo: roster.replacementTo,
      note: roster.note,
    };
  }

  const trip = resolveTripForTrain(dataset, trainNumber);
  const shape = trip?.shapeId ? dataset.shapes[trip.shapeId] : undefined;
  if (!trip || !shape || shape.points.length === 0) {
    return null;
  }

  reportedAt = delayInfo?.timestamp ?? roster.timestamp;
  const delayMinutes =
    delayInfo?.delayMinutes ?? roster.trainDelay?.delayMinutes ?? 0;
  const progress = estimateProgress(
    trainNumber,
    trip,
    dataset,
    Math.max(reportedAt, delayInfo?.timestamp ?? reportedAt),
    delayMinutes,
    delayInfo ?? roster.trainDelay
  );
  const currentStation = delayInfo?.currentName
    ? delayInfo.currentName
    : findStopNameByUic(dataset, delayInfo?.currentUic);
  const nextStation = resolveStationDisplayName(
    dataset,
    delayInfo?.nextStationName,
    roster.rosterNextStation
  );

  return {
    trainNumber,
    trainName: roster.train?.name
      ? formatTrainDisplayName(roster.train.name)
      : undefined,
    trainType: roster.train?.type,
    shapePath: shape.points,
    position: interpolateShape(shape.points, progress),
    progress,
    delayMinutes,
    color: getDelayColor(delayMinutes),
    nextStation,
    currentStation,
    reportedAt,
    rosterPreviousStation: roster.rosterPreviousStation,
    rosterNextStation: roster.rosterNextStation,
    rosterOrderCurrentStation: roster.orderCurrentStation,
    summary: roster.summary,
    operator: roster.operator,
    delayText: roster.delayText,
    actualTime: roster.actualTime,
    plannedTime: roster.plannedTime,
    heading: roster.heading,
    disrupted: roster.disrupted,
    replacementFrom: roster.replacementFrom,
    replacementTo: roster.replacementTo,
    note: roster.note,
  };
}

export function mergeTrainList(
  previous: TrainRenderState[],
  next: TrainRenderState[]
): TrainRenderState[] {
  if (previous.length === next.length && previous.every((train, index) => train === next[index])) {
    return previous;
  }
  const prevById = new Map(previous.map((train) => [train.trainNumber, train]));
  let changed = previous.length !== next.length;
  const merged = next.map((train, index) => {
    const prior = prevById.get(train.trainNumber);
    if (prior && trainsLookEqual(prior, train)) {
      if (previous[index] !== prior) {
        changed = true;
      }
      return prior;
    }
    changed = true;
    return train;
  });
  if (!changed && previous.length === merged.length && previous.every((train, index) => train === merged[index])) {
    return previous;
  }
  return merged;
}

function trainsLookEqual(left: TrainRenderState, right: TrainRenderState): boolean {
  return (
    left.trainNumber === right.trainNumber &&
    left.position?.lat === right.position?.lat &&
    left.position?.lng === right.position?.lng &&
    left.heading === right.heading &&
    left.delayMinutes === right.delayMinutes &&
    left.color === right.color &&
    left.trainType === right.trainType &&
    left.trainName === right.trainName &&
    left.currentStation === right.currentStation &&
    left.nextStation === right.nextStation &&
    left.delayText === right.delayText &&
    left.summary === right.summary &&
    left.disrupted === right.disrupted
  );
}

function dedupeTrains(roster: TrainRosterItem[]): TrainRosterItem[] {
  const seen = new Set<string>();
  const unique: TrainRosterItem[] = [];
  roster.forEach((row) => {
    try {
      const { trainNumber } = normalizeRoster(row);
      if (!seen.has(trainNumber)) {
        seen.add(trainNumber);
        unique.push(row);
      }
    } catch {
      // skip
    }
  });
  return unique;
}

export interface TrainServiceConfig {
  useLiveApi?: boolean;
  cookieHeader?: string;
  useProxy?: boolean;
  proxyUrl?: string;
}

export class TrainService {
  private fetchConfig: TrainServiceConfig = {};

  constructor(
    private dataset: GtfsDataset,
    private apiKey: string = DEFAULT_API_KEY
  ) {}

  public setFetchConfig(config: TrainServiceConfig) {
    this.fetchConfig = config;
  }

  public async fetchLiveTrains(
    stations?: string[], // Optional, if not provided fetches ALL trains
    travelDate: number = Date.now()
  ): Promise<TrainRenderState[]> {
    // Fetch ALL trains from mapa.zsr.sk (not station-specific)
    const rosters = await fetchAllTrains(this.fetchConfig).catch(() => []);
    trainLog(`📦 Fetched ${rosters.length} roster items`);

    const unique = dedupeTrains(rosters);
    trainLog(`🔍 After deduplication: ${unique.length} unique trains`);

    // Note: Delay information is already included in the train data from mapa.zsr.sk
    // No need to fetch delays separately - the roster items already contain trainDelay info
    const renderStates = unique
      .map((roster, idx) => {
        try {
          const normalized = normalizeRoster(roster);
          // Use delay info from roster (already included in train data)
          const state = buildTrainRenderState(
            roster,
            this.dataset,
            roster.trainDelay, // Use delay from roster instead of separate API call
            normalized
          );
          
          if (!state && idx < 5) {
            console.warn(`⚠ Train ${normalized.trainNumber} returned null state. Has route: ${!!roster.route}, route length: ${roster.route?.length || 0}, has position: ${!!roster.position}`);
          }
          
          return state;
        } catch (error) {
          console.warn(`⚠ Error building render state for train:`, error);
          return null;
        }
      })
      .filter((state): state is TrainRenderState => Boolean(state));

    trainLog(`✓ Built ${renderStates.length} render states`);
    if (renderStates.length > 0) {
      const sample = renderStates[0];
      trainLog(`Sample train state:`, {
        trainNumber: sample.trainNumber,
        shapePathLength: sample.shapePath.length,
        hasPosition: !!sample.position,
        color: sample.color,
      });
    }

    return renderStates;
}
}

function clockToMs(value: string): number | null {
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  return (Number(match[1]) * 3600 + Number(match[2]) * 60) * 1000;
}

function stopClock(stop: JourneyStop): number | null {
  return (
    clockToMs(stop.departure) ??
    clockToMs(stop.arrival) ??
    clockToMs(stop.scheduledDeparture) ??
    clockToMs(stop.scheduledArrival)
  );
}

/** Passenger / timetable row — excludes výhybne and other points with no published times. */
export function isTimedJourneyStop(stop: JourneyStop): boolean {
  return [stop.scheduledDeparture, stop.scheduledArrival, stop.departure, stop.arrival].some(
    (value) => /\d{1,2}:\d{2}/.test(String(value ?? ''))
  );
}

export function filterTimedJourneyStops(stops: JourneyStop[]): JourneyStop[] {
  return stops.filter(isTimedJourneyStop);
}

function segmentMeters(a: Coordinate, b: Coordinate): number {
  const lat = (b.lat - a.lat) * 111320;
  const lng = (b.lng - a.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(lat, lng);
}

function pointAlong(route: Coordinate[], from: number, to: number, fraction: number): Coordinate {
  const start = Math.max(0, Math.min(from, route.length - 1));
  const end = Math.max(start, Math.min(to, route.length - 1));
  if (start === end || fraction <= 0) {
    return route[start];
  }
  if (fraction >= 1) {
    return route[end];
  }
  const slice = route.slice(start, end + 1);
  const lengths = [0];
  for (let index = 1; index < slice.length; index += 1) {
    lengths.push(lengths[index - 1] + segmentMeters(slice[index - 1], slice[index]));
  }
  const total = lengths[lengths.length - 1];
  if (total <= 0) {
    return slice[0];
  }
  const target = total * fraction;
  let index = 1;
  while (index < lengths.length && lengths[index] < target) {
    index += 1;
  }
  const previous = lengths[index - 1];
  const span = Math.max(1, lengths[index] - previous);
  const local = (target - previous) / span;
  const a = slice[index - 1];
  const b = slice[index];
  return {
    lat: a.lat + (b.lat - a.lat) * local,
    lng: a.lng + (b.lng - a.lng) * local,
    sequence: a.sequence ?? index,
  };
}

export interface RouteCursor {
  position: Coordinate | null;
  stopIndex: number;
  from: Coordinate | null;
  to: Coordinate | null;
  fraction: number;
}

function foldStationName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bhl\.?\s*st\.?\b/g, 'hlavna stanica')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bn\s+/g, 'nad ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripStationSuffix(value: string): string {
  return value.replace(/\b(zastavka|predmestie|nakladna stanica|osobna stanica)$/g, '').trim();
}

/** One coordinate per timetable stop, matched to the GTFS station list. */
export function stationPoints(
  stops: JourneyStop[],
  stations: Array<{ name: string; lat: number; lng: number }>
): Array<Coordinate | null> {
  const byName = new Map<string, Coordinate>();
  const byStripped = new Map<string, Coordinate>();
  stations.forEach((station) => {
    const key = foldStationName(station.name);
    if (!key) {
      return;
    }
    const coord = { lat: station.lat, lng: station.lng };
    if (!byName.has(key)) {
      byName.set(key, coord);
    }
    const stripped = stripStationSuffix(key);
    if (stripped && !byStripped.has(stripped)) {
      byStripped.set(stripped, coord);
    }
  });
  return stops.map((stop, index) => {
    const key = foldStationName(stop.name);
    const stripped = stripStationSuffix(key);
    const hit = byName.get(key) ?? byName.get(stripped) ?? byStripped.get(stripped);
    return hit ? { ...hit, sequence: index } : null;
  });
}

/** Place one train on the straight segments between its stations, from the clock alone. */
export function routeCursor(
  points: Array<Coordinate | null>,
  stops: JourneyStop[],
  now = new Date(),
  delayMinutes = 0
): RouteCursor {
  const timed = stops
    .map((stop, index) => ({ index, time: stopClock(stop), point: points[index] ?? null }))
    .filter(
      (item): item is { index: number; time: number; point: Coordinate } =>
        item.time != null && item.point != null
    );
  if (timed.length === 0) {
    const point = points.find((item) => item != null) ?? null;
    return { position: point, stopIndex: 0, from: point, to: point, fraction: 0 };
  }
  if (timed.length < 2) {
    return {
      position: timed[0].point,
      stopIndex: timed[0].index,
      from: timed[0].point,
      to: timed[0].point,
      fraction: 0,
    };
  }
  const times: number[] = [];
  let previous = timed[0].time;
  timed.forEach((item) => {
    let time = item.time;
    if (times.length > 0 && time < previous) {
      time += DAY_MS;
    }
    times.push(time);
    previous = time;
  });
  let clock =
    (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000 -
    delayMinutes * 60 * 1000;
  if (clock < times[0] - 6 * 60 * 60 * 1000) {
    clock += DAY_MS;
  }
  if (clock < 0) {
    clock += DAY_MS;
  }
  if (clock <= times[0]) {
    return {
      position: timed[0].point,
      stopIndex: timed[0].index,
      from: timed[0].point,
      to: timed[0].point,
      fraction: 0,
    };
  }
  const last = times.length - 1;
  if (clock >= times[last]) {
    return {
      position: timed[last].point,
      stopIndex: timed[last].index,
      from: timed[last].point,
      to: timed[last].point,
      fraction: 1,
    };
  }
  let segment = 0;
  while (segment < last - 1 && clock > times[segment + 1]) {
    segment += 1;
  }
  const span = Math.max(1, times[segment + 1] - times[segment]);
  const fraction = Math.min(1, Math.max(0, (clock - times[segment]) / span));
  const from = timed[segment].point;
  const to = timed[segment + 1].point;
  return {
    position: pointAlong([from, to], 0, 1, fraction),
    stopIndex: timed[segment].index,
    from,
    to,
    fraction,
  };
}

function nearestPathIndex(path: Coordinate[], point: Coordinate): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < path.length; index += 1) {
    const sample = path[index];
    const lat = sample.lat - point.lat;
    const lng = sample.lng - point.lng;
    const distance = lat * lat + lng * lng;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function closestOnSegment(from: Coordinate, to: Coordinate, point: Coordinate): Coordinate {
  const abLat = to.lat - from.lat;
  const abLng = to.lng - from.lng;
  const span = abLat * abLat + abLng * abLng;
  if (span <= 0) {
    return from;
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.lat - from.lat) * abLat + (point.lng - from.lng) * abLng) / span)
  );
  return { lat: from.lat + abLat * t, lng: from.lng + abLng * t };
}

/** Snap a live GPS point onto a traced rail polyline. */
export function snapToPath(path: Coordinate[], point: Coordinate): Coordinate {
  if (path.length === 0) {
    return point;
  }
  if (path.length === 1) {
    return path[0];
  }
  let best = path[0];
  let bestDistance = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    const snapped = closestOnSegment(path[index - 1], path[index], point);
    const lat = snapped.lat - point.lat;
    const lng = snapped.lng - point.lng;
    const distance = lat * lat + lng * lng;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = snapped;
    }
  }
  return best;
}

/** Station-to-station slice of a traced route polyline. */
export function routeLegPath(
  path: Coordinate[],
  from: Coordinate,
  to: Coordinate
): Coordinate[] {
  if (path.length < 2) {
    return [from, to];
  }
  let startIndex = nearestPathIndex(path, from);
  let endIndex = nearestPathIndex(path, to);
  if (startIndex === endIndex) {
    return [from, to];
  }
  if (startIndex > endIndex) {
    const slice = path.slice(endIndex, startIndex + 1).reverse();
    slice[0] = from;
    slice[slice.length - 1] = to;
    return slice;
  }
  const slice = path.slice(startIndex, endIndex + 1);
  slice[0] = from;
  slice[slice.length - 1] = to;
  return slice;
}

/** Shortest forward slice along a leg toward the next scheduled point. */
export function motionPathToward(
  leg: Coordinate[],
  from: Coordinate,
  to: Coordinate
): Coordinate[] {
  if (leg.length < 2) {
    return [from, to];
  }
  const startIndex = nearestPathIndex(leg, from);
  const endIndex = nearestPathIndex(leg, to);
  if (startIndex >= endIndex) {
    return [from, to];
  }
  const slice = leg.slice(startIndex, endIndex + 1);
  slice[0] = from;
  slice[slice.length - 1] = to;
  return slice.length >= 2 ? slice : [from, to];
}

/** Move along a traced rail polyline between the current pair of stations. */
export function placeOnPath(
  path: Coordinate[],
  from: Coordinate,
  to: Coordinate,
  fraction: number
): Coordinate {
  if (path.length === 0) {
    return from;
  }
  if (path.length === 1) {
    return path[0];
  }
  const startIndex = nearestPathIndex(path, from);
  const endIndex = nearestPathIndex(path, to);
  if (startIndex === endIndex) {
    return path[startIndex];
  }
  if (startIndex < endIndex) {
    return pointAlong(path, startIndex, endIndex, fraction);
  }
  return pointAlong(path, endIndex, startIndex, 1 - fraction);
}
