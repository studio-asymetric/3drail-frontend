import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MapScene } from './components/MapScene';
import { abbreviationSteps, townOf } from './data/placeName';
import { applySeo } from './seo';
import { vagonwebTrainUrl } from './data/vagonweb';
import { DisruptionsPanel, describeDisruption } from './components/DisruptionsPanel';
import { DockInfoPanel } from './components/DockInfoPanel';
import { eventsForTrain, fetchDisruptions, type DisruptionPayload } from './data/disruptionService';
import { DockScroller } from './components/DockScroller';
import { DockPanelControls } from './components/DockPanelControls';
import { DockSheetHandle } from './components/DockSheetHandle';
import { STATION_FOCUS_ZOOM } from './data/viewConstants';
import { useMobileLayout } from './hooks/useMobileLayout';
import { useMobileDockSheet } from './hooks/useMobileDockSheet';
import {
  TrainService,
  type JourneyStop,
  type TrainRenderState,
  contrastInk,
  getDelayColor,
  filterTimedJourneyStops,
  indexJourneyRows,
  isPassengerStop,
  mergeTrainList,
  routeCursor,
  stationPoints,
  trainTypeCallout,
  trainLabel,
  vehicleInk,
} from './data/trainService';
import { REGION_ID, readStoredModes, regionsQuery, storeModes, vehicleModeOf, type VehicleMode } from './region';
import { MainMenu } from './components/MainMenu';
import { MetroLogo } from './components/MetroLogo';
import { fetchTransitLines } from './data/transitLines';
import type { FeatureCollection } from 'geojson';
import type { Coordinate, GtfsDataset } from './data/gtfsParser';
import { buildGtfsDataset } from './data/gtfsParser';
import {
  fetchStationBoard,
  type FocusedStation,
  type StationBoardRow,
} from './data/stationBoard';
import type { MapTheme, MapViewControls } from './components/MapScene';
import {
  parseAppRoute,
  routeFromView,
  serializeAppRoute,
  type AppRoute,
} from './appRoute';
import logoMarkDark from './logo icon white.svg';
import logoMarkLight from './logo icon black.svg';
import { ChromeSearchIcon } from './components/ChromeSearchIcon';
import {
  copyFor,
  LOCALE_STORAGE_KEY,
  LOCALE_TAG,
  readStoredLocale,
  type AppLocale,
} from './i18n';

const THEME_STORAGE_KEY = 'railatlas-theme';

type SearchHit =
  | { kind: 'train'; id: string; score: number; train: TrainRenderState }
  | { kind: 'station'; id: string; score: number; station: FocusedStation };

/** What a past search picked: enough to show it again and to open it. */
type SearchRef =
  | { kind: 'train'; trainNumber: string }
  | { kind: 'station'; station: FocusedStation };

const SEARCH_HISTORY_KEY = 'railatlas-search-history';
const SEARCH_HISTORY_LIMIT = 6;

/** Recent picks live in sessionStorage: this tab only, gone when it closes, no cookies. */
function readSearchHistory(): SearchRef[] {
  try {
    const raw = window.sessionStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as SearchRef[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, SEARCH_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function searchRefId(ref: SearchRef): string {
  return ref.kind === 'train' ? `train:${ref.trainNumber}` : `station:${ref.station.id}`;
}

function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchScore(value: string, query: string): number {
  const text = foldName(value);
  if (!text || !query) {
    return 0;
  }
  if (text === query) {
    return 4;
  }
  if (text.startsWith(query)) {
    return 3;
  }
  if (` ${text}`.includes(` ${query}`)) {
    return 2;
  }
  if (text.includes(query)) {
    return 1;
  }
  return 0;
}

function readStoredTheme(): MapTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function clockFace(value: string): string {
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return value.trim();
  }
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function minutesOfDay(value: string): number | null {
  const match = clockFace(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function delayDeltaMinutes(plannedRaw: string, actualRaw: string): number {
  const planned = minutesOfDay(plannedRaw);
  const actual = minutesOfDay(actualRaw);
  if (planned == null || actual == null) {
    return 0;
  }
  let delta = actual - planned;
  if (delta > 12 * 60) {
    delta -= 24 * 60;
  }
  if (delta < -12 * 60) {
    delta += 24 * 60;
  }
  return delta;
}

function stopDelayMinutes(stop: JourneyStop): number {
  if (stop.scheduledDeparture && stop.departure) {
    return delayDeltaMinutes(stop.scheduledDeparture, stop.departure);
  }
  if (stop.scheduledArrival && stop.arrival) {
    return delayDeltaMinutes(stop.scheduledArrival, stop.arrival);
  }
  return 0;
}

function indexByStationName(stops: JourneyStop[], name?: string): number {
  if (!name) {
    return -1;
  }
  const key = foldName(name);
  if (!key) {
    return -1;
  }
  // An exact name wins; only then a name that merely starts with the other ("Trnava" must
  // not match "Trnava Hora" while a stop called exactly "Trnava" exists).
  const exact = stops.findIndex((stop) => foldName(stop.name) === key);
  if (exact >= 0) {
    return exact;
  }
  return stops.findIndex((stop) => {
    const folded = foldName(stop.name);
    return folded.startsWith(key) || key.startsWith(folded);
  });
}

function gtfsStopForName(name: string, dataset: GtfsDataset | null) {
  if (!dataset) {
    return null;
  }
  const key = foldName(name);
  if (!key) {
    return null;
  }
  // An exact name wins. Otherwise the closest name that starts with the other (or the
  // other way round): "Trnava" must not land on "Trnava Hora" just because that comes first.
  let best: (typeof dataset.stops)[string] | null = null;
  let bestGap = Infinity;
  for (const stop of Object.values(dataset.stops)) {
    const folded = foldName(stop.name);
    if (folded === key) {
      return stop;
    }
    if (folded.startsWith(key) || key.startsWith(folded)) {
      const gap = Math.abs(folded.length - key.length);
      if (gap < bestGap) {
        best = stop;
        bestGap = gap;
      }
    }
  }
  return best;
}

function coordFromDataset(name: string, dataset: GtfsDataset | null): Coordinate | null {
  const stop = gtfsStopForName(name, dataset);
  return stop ? { lat: stop.lat, lng: stop.lng } : null;
}

function stationFromDataset(name: string, dataset: GtfsDataset | null): FocusedStation | null {
  const stop = gtfsStopForName(name, dataset);
  if (!stop) {
    return null;
  }
  const label = stop.name.trim();
  return {
    id: stop.stopId,
    name: label || name,
    lat: stop.lat,
    lng: stop.lng,
  };
}

function stopTimesView(stop: JourneyStop): {
  planned: string;
  actual: string | null;
  delayMinutes: number;
} {
  const paired =
    stop.scheduledDeparture && stop.departure
      ? { plannedRaw: stop.scheduledDeparture, actualRaw: stop.departure }
      : stop.scheduledArrival && stop.arrival
        ? { plannedRaw: stop.scheduledArrival, actualRaw: stop.arrival }
        : {
            plannedRaw: stop.scheduledDeparture || stop.scheduledArrival,
            actualRaw: stop.departure || stop.arrival,
          };
  const planned = clockFace(paired.plannedRaw || paired.actualRaw || '') || '—';
  const actual = paired.actualRaw ? clockFace(paired.actualRaw) : '';
  const delayMinutes = stopDelayMinutes(stop);
  const late = Boolean(paired.plannedRaw && paired.actualRaw && delayMinutes > 0);
  return { planned, actual: late ? actual : null, delayMinutes: late ? delayMinutes : 0 };
}

function BusIcon() {
  return (
    <svg className="dock__bus-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="12" height="9.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 7h12" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="9.2" r="0.9" fill="currentColor" />
      <circle cx="11" cy="9.2" r="0.9" fill="currentColor" />
      <path d="M4.5 11.5v2M11.5 11.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function isProperTrainName(name?: string): boolean {
  const value = name?.trim() ?? '';
  if (value.length < 2) {
    return false;
  }
  if (/\d{1,2}\.\d{1,2}\.\d{2,4}/.test(value)) {
    return false;
  }
  if (/\(\s*\d/.test(value)) {
    return false;
  }
  if (/->|→/.test(value)) {
    return false;
  }
  return true;
}

function parseSummaryRoute(summary?: string): { from: string; to: string } | null {
  if (!summary) {
    return null;
  }
  const cleaned = summary.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s*(?:->|→)\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return { from: parts[0], to: parts[parts.length - 1] };
}

function searchTrainSubtitle(train: Pick<TrainRenderState, 'trainName' | 'summary'>): string {
  const name = train.trainName?.trim() ?? '';
  if (name && isProperTrainName(name)) {
    return name;
  }
  const route = parseSummaryRoute(train.summary ?? name);
  if (route) {
    return `${route.from} → ${route.to}`;
  }
  const fallback = (train.summary ?? name).trim();
  if (!fallback) {
    return '';
  }
  return fallback
    .replace(/\(\s*\d{1,2}\.\d{1,2}\.\d{2,4}(?:\s+\d{1,2}:\d{2})?\s*\)/gi, ' ')
    .replace(/\d{1,2}\.\d{1,2}\.\d{2,4}(?:\s+\d{1,2}:\d{2})?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function journeyNextIndex(
  stops: JourneyStop[],
  train: { nextStation?: string; currentStation?: string } | null,
  cursorIndex: number | null
): number {
  const namedNext = indexByStationName(stops, train?.nextStation);
  if (namedNext >= 0) {
    return namedNext;
  }
  const ahead = stops.findIndex((stop) => stop.state === 'ahead');
  if (ahead >= 0) {
    return ahead;
  }
  const current = stops.findIndex((stop) => stop.state === 'current');
  if (current >= 0 && current < stops.length - 1) {
    return current + 1;
  }
  if (cursorIndex != null && cursorIndex >= 0) {
    return Math.min(cursorIndex + 1, stops.length - 1);
  }
  return -1;
}

const EMPTY_DATASET: GtfsDataset = {
  shapes: {},
  trips: { byTripId: {}, byTrainNumber: {} },
  stops: {},
  stopTimes: {},
};

/**
 * Stations only: names, coordinates and trip counts from the proxy (a few KB).
 * Live trains carry their own GPS positions, so the full timetable is not needed.
 */
let stationDatasetPromise: Promise<GtfsDataset> | null = null;

function loadStationDataset(): Promise<GtfsDataset> {
  // One download per page load, even when effects run twice.
  stationDatasetPromise ??= fetchStationDataset().catch((error) => {
    stationDatasetPromise = null;
    throw error;
  });
  return stationDatasetPromise;
}

async function fetchStationDataset(): Promise<GtfsDataset> {
  let response: Response | null = null;
  // A region still reading its timetable answers 202: ask again shortly.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    response = await fetch(`/proxy/stations?mode=stations&v=1${regionsQuery()}`);
    if (response.status !== 202) {
      break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 4000));
  }
  if (!response?.ok) {
    throw new Error(`Stations HTTP ${response?.status}`);
  }
  const payload = (await response.json()) as {
    stations?: Array<[string, string, number, number, number, string?, string?]>;
  };
  const stops: GtfsDataset['stops'] = {};
  (payload.stations ?? []).forEach(([stopId, name, lat, lng, tripCount, code, uicCode]) => {
    stops[stopId] = {
      stopId,
      name,
      lat,
      lng,
      tripCount,
      code: code || undefined,
      uicCode: uicCode || undefined,
    };
  });
  if (Object.keys(stops).length === 0) {
    throw new Error('Empty station list');
  }
  return { ...EMPTY_DATASET, stops };
}

async function loadGtfsDataset(): Promise<GtfsDataset> {
  try {
    return await loadStationDataset();
  } catch (error) {
    console.warn('Station list unavailable, loading full GTFS:', error);
  }
  const [shapesRes, tripsRes, stopsRes, stopTimesRes] = await Promise.all([
    fetch('/gtfs/shapes.txt'),
    fetch('/gtfs/trips.txt'),
    fetch('/gtfs/stops.txt'),
    fetch('/gtfs/stop_times.txt'),
  ]);

  return buildGtfsDataset({
    shapesCsv: await shapesRes.text(),
    tripsCsv: await tripsRes.text(),
    stopsCsv: await stopsRes.text(),
    stopTimesCsv: await stopTimesRes.text(),
  });
}

/** The header clock, ticking on its own so the rest of the page does not re-render each second. */
function ClockLabel({ locale }: { locale: AppLocale }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      {now.toLocaleTimeString(LOCALE_TAG[locale], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}
    </>
  );
}

const ArrowIcon: React.FC = () => (
  <svg className="dock__name-arrow" width="22" height="12" viewBox="0 0 22 12" fill="none" aria-hidden="true">
    <path
      d="M0 5.52296V6.27296H21V5.52296V4.77296H0V5.52296ZM21.5303 6.05329C21.8232 5.7604 21.8232 5.28553 21.5303 4.99263L16.7574 0.219664C16.4645 -0.0732298 15.9896 -0.0732298 15.6967 0.219664C15.4038 0.512557 15.4038 0.987431 15.6967 1.28032L19.9393 5.52296L15.6967 9.7656C15.4038 10.0585 15.4038 10.5334 15.6967 10.8263C15.9896 11.1192 16.4645 11.1192 16.7574 10.8263L21.5303 6.05329Z"
      fill="currentColor"
    />
  </svg>
);

/**
 * The train's title: its name, then "→ town" it runs to; a train without a name shows just
 * "→ town" in the same style. When that does not fit on a line the town is abbreviated one
 * word at a time ("Banská Bystrica" -> "B. Bystrica", "Nové Mesto n. V.").
 */
const DockTitle: React.FC<{ properName: string; to: string; fallback: string }> = ({
  properName,
  to,
  fallback,
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const steps = useMemo(() => abbreviationSteps(townOf(to)), [to]);
  const maxStep = to ? steps.length - 1 : 0;
  const key = `${properName}|${to}`;
  const [fit, setFit] = useState({ key, step: 0 });
  const step = fit.key === key ? fit.step : 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || step >= maxStep) {
      return;
    }
    const lineHeight = parseFloat(getComputedStyle(el).fontSize) * 1.7;
    if (el.getBoundingClientRect().height > lineHeight) {
      setFit({ key, step: step + 1 });
    }
  }, [step, maxStep, key]);

  // The room changed (window or panel resized): try the full name again.
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') {
      return;
    }
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - width) > 1) {
        width = box.clientWidth;
        setFit({ key, step: 0 });
      }
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [key]);

  if (!to) {
    return <span className={`dock__name${properName ? '' : ' is-route'}`}>{properName || fallback}</span>;
  }
  return (
    <span ref={ref} className={`dock__name${properName ? '' : ' dock__name--dest-only'}`}>
      {properName}
      <span className="dock__name-dest">
        <ArrowIcon />
        {steps[Math.min(step, steps.length - 1)]}
      </span>
    </span>
  );
};

/** "rj 273 METROPOLITAN" -> "rj 273": the pill carries the type and number, not the train's name. */
function boardPillLabel(code?: string): string {
  // Czech boards (idos.cz) name a train by its line, with the train in brackets: "S7 (Os 8870)" -> "S7"
  const line = String(code ?? '').trim().match(/^(\S+)\s+\(/);
  if (line) {
    return line[1];
  }
  const match = String(code ?? '').trim().match(/^(\S+)\s+(\d+)/);
  return match ? `${match[1]} ${match[2]}` : String(code ?? '').trim();
}

const AlertIcon: React.FC = () => (
  <svg className="dock__status-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M7 1.8 12.6 11.4H1.4L7 1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M7 5.6v2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="7" cy="9.7" r="0.7" fill="currentColor" />
  </svg>
);

const ClockIcon: React.FC = () => (
  <svg className="dock__status-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
    <path d="M7 3.9V7l2.1 1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const InfoIcon: React.FC = () => (
  <svg className="dock__status-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
    <path d="M7 6.3v3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="7" cy="4.5" r="0.75" fill="currentColor" />
  </svg>
);

/** "5 min meškanie": the amount stands out, the rest is lighter. */
function delayView(text: string): React.ReactNode {
  const match = text.match(/^(\d+\s*min)(\s.*)?$/i);
  return match ? (
    <>
      <strong>{match[1]}</strong>
      {match[2] ?? ''}
    </>
  ) : (
    text
  );
}

// The About article is only needed when opened: load it on demand.
const AboutPanel = lazy(() => import('./components/AboutPanel').then((module) => ({ default: module.AboutPanel })));

const App: React.FC = () => {
  const [trains, setTrains] = useState<TrainRenderState[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataset, setDataset] = useState<GtfsDataset | null>(null);
  const bootRoute = useMemo(() => parseAppRoute(), []);
  const [focusedTrainNumber, setFocusedTrainNumber] = useState<string | null>(bootRoute.train);
  const [focusedStation, setFocusedStation] = useState<FocusedStation | null>(bootRoute.station);
  const [stationTab, setStationTab] = useState<'departures' | 'arrivals'>(bootRoute.tab);
  const [stationBoard, setStationBoard] = useState<StationBoardRow[]>([]);
  const [stationBoardStatus, setStationBoardStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [useLiveApi, setUseLiveApi] = useState(true);
  
  const service = useMemo(() => new TrainService(dataset ?? EMPTY_DATASET), [dataset]);
  const [locale, setLocale] = useState<AppLocale>(readStoredLocale);
  const [menuOpen, setMenuOpen] = useState(false);
  // Prague: which kinds of vehicle are drawn (trains, metro, trams, trolleybuses, buses).
  const [modes, setModes] = useState<VehicleMode[]>(readStoredModes);
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const [allTransitLines, setAllTransitLines] = useState<FeatureCollection | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchTransitLines(controller.signal).then((lines) => {
      if (!controller.signal.aborted) setAllTransitLines(lines);
    });
    return () => controller.abort();
  }, []);
  // tracks of the kinds that are switched on
  const transitLines = useMemo(
    () =>
      allTransitLines
        ? {
            ...allTransitLines,
            features: allTransitLines.features.filter((feature) =>
              modes.includes((feature.properties as { mode?: VehicleMode } | null)?.mode ?? 'tram')
            ),
          }
        : null,
    [allTransitLines, modes]
  );
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const t = useMemo(() => copyFor(locale), [locale]);
  const [statusMessage, setStatusMessage] = useState(() => copyFor(readStoredLocale()).loadingGtfs);
  const [statusKind, setStatusKind] = useState<'loading' | 'success' | 'error'>(
    'loading'
  );
  const [journeyRows, setJourneyRows] = useState<JourneyStop[]>([]);
  /** Stops passengers can use: the panel list and its cursor. Passing points are left out. */
  const journeyStops = useMemo(() => journeyRows.filter(isPassengerStop), [journeyRows]);
  const [journeyStatus, setJourneyStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const journeyAbortRef = useRef<AbortController | null>(null);
  const journeyPollRef = useRef(0);
  const stationBoardAbortRef = useRef<AbortController | null>(null);
  const bootPanelLoadRef = useRef(false);
  const [clock, setClock] = useState(() => new Date());
  const [following, setFollowing] = useState(false);
  const [searchHistory, setSearchHistory] = useState<SearchRef[]>(readSearchHistory);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory));
    } catch {
      // storage can be blocked; the history then lasts until reload
    }
  }, [searchHistory]);
  const rememberSearch = useCallback((ref: SearchRef) => {
    setSearchHistory((current) =>
      [ref, ...current.filter((item) => searchRefId(item) !== searchRefId(ref))].slice(0, SEARCH_HISTORY_LIMIT)
    );
  }, []);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const toastSeqRef = useRef(0);
  const toastKeysRef = useRef(new Map<string, number>());
  /** Small corner notice; `key` stops the same event from stacking up. */
  const pushToast = useCallback((text: string, key = text, quietMs = 20_000) => {
    const now = Date.now();
    if (now - (toastKeysRef.current.get(key) ?? 0) < quietMs) {
      return;
    }
    toastKeysRef.current.set(key, now);
    const id = (toastSeqRef.current += 1);
    setToasts((current) => [...current.slice(-2), { id, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 5200);
  }, []);
  const [timelineProgress, setTimelineProgress] = useState<{
    train: string;
    from: number;
    fraction: number;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMobileOpen, setSearchMobileOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useMobileLayout();
  const [mobileDockExpanded, setMobileDockExpanded] = useState(false);
  const [mapBooting, setMapBooting] = useState(true);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchMobileOpen(false);
  }, []);

  const openMobileSearch = useCallback(() => {
    setSearchMobileOpen(true);
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!searchMobileOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSearch, searchMobileOpen]);

  useEffect(() => {
    if (!searchMobileOpen) {
      return;
    }
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, [searchMobileOpen]);

  const mapViewRef = useRef<MapViewControls | null>(null);
  const [dockLeaving, setDockLeaving] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(bootRoute.about);
  const [disruptions, setDisruptions] = useState<DisruptionPayload | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const applyingUrlRef = useRef(false);
  const historyIndexRef = useRef(0);
  const lastSerializedRouteRef = useRef(serializeAppRoute(bootRoute));
  const [theme, setTheme] = useState<MapTheme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // The page background behind the app (set before it starts, in index.html) follows too.
    document.documentElement.dataset.bootTheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore private-mode storage failures.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore private-mode storage failures.
    }
  }, [locale]);

  // Load GTFS data on mount
  useEffect(() => {
    const strings = copyFor(readStoredLocale());
    setStatusMessage(strings.loadingGtfsFrom);
    loadGtfsDataset()
      .then((data) => {
        const shapeCount = Object.keys(data.shapes).length;
        const tripCount = Object.keys(data.trips.byTripId).length;
        const stopCount = Object.keys(data.stops).length;
        setDataset(data);
        setStatusMessage(strings.gtfsLoaded(shapeCount, tripCount, stopCount));
        console.log(`✓ GTFS Dataset loaded:`, { shapeCount, tripCount, stopCount });
      })
      .catch((error) => {
        console.error('Failed to load GTFS:', error);
        setDataset(EMPTY_DATASET);
        setStatusMessage(strings.stationDataUnavailable);
      });
  }, []);
  const focusedTrain = useMemo(
    () => trains.find((train) => train.trainNumber === focusedTrainNumber) ?? null,
    [trains, focusedTrainNumber]
  );
  // Following a train that left the feed (journey over): stop and say so.
  useEffect(() => {
    if (!following || !focusedTrainNumber || loading || trains.length === 0) {
      return;
    }
    if (!trains.some((train) => train.trainNumber === focusedTrainNumber)) {
      setFollowing(false);
      pushToast(t.toastTrainEnded(focusedTrainNumber), `ended:${focusedTrainNumber}`, 60_000);
    }
  }, [following, focusedTrainNumber, loading, pushToast, t, trains]);
  const focusedStations = useMemo(() => {
    if (!dataset || journeyStops.length === 0) {
      return [] as Array<Coordinate | null>;
    }
    const points = stationPoints(journeyStops, Object.values(dataset.stops));
    // Stops abroad have no place on our map.
    return points.map((point, index) => (journeyStops[index]?.foreign ? null : point));
  }, [dataset, journeyStops]);
  /** Every listed point, passing points included: route waypoints for the map. */
  const routeStations = useMemo(() => {
    if (!dataset || journeyRows.length === 0) {
      return [] as Array<Coordinate | null>;
    }
    const points = stationPoints(journeyRows, Object.values(dataset.stops));
    return points.map((point, index) => (journeyRows[index]?.foreign ? null : point));
  }, [dataset, journeyRows]);

  const cursor = useMemo(() => {
    if (!focusedTrain || journeyStops.length === 0) {
      return null;
    }
    if (!focusedStations.some((point) => point != null)) {
      return null;
    }
    const delayMinutes =
      focusedTrain.delayMinutes > 0 ? focusedTrain.delayMinutes : 0;
    return routeCursor(focusedStations, journeyStops, clock, delayMinutes);
  }, [focusedTrain, focusedStations, journeyStops, clock]);

  const currentStopIndex = useMemo(() => {
    if (!focusedTrain || journeyStops.length === 0) {
      return -1;
    }
    const fromReport = indexByStationName(journeyStops, focusedTrain.currentStation);
    if (fromReport >= 0) {
      return fromReport;
    }
    const fromState = journeyStops.findIndex((stop) => stop.state === 'current');
    if (fromState >= 0) {
      return fromState;
    }
    if (cursor && cursor.stopIndex >= 0) {
      return cursor.stopIndex;
    }
    return -1;
  }, [cursor, focusedTrain, journeyStops]);

  const selectedTrainDelayText = useMemo(() => {
    if (!focusedTrain) {
      return '';
    }
    if (focusedTrain.delayMinutes > 0) {
      return t.delayMinutes(focusedTrain.delayMinutes);
    }
    if (focusedTrain.delayMinutes === 0) {
      return t.onTime;
    }
    return focusedTrain.delayText || '';
  }, [focusedTrain, t]);

  // Fetch live trains. A failed refresh keeps the last good list.
  useEffect(() => {
    service.setFetchConfig({ useLiveApi, useProxy: useLiveApi, proxyUrl: '/proxy' });

    let mounted = true;
    let requestId = 0;
    let haveTrains = false;
    let feedDown = false;
    const refresh = async () => {
      const id = ++requestId;
      if (!haveTrains) {
        setStatusKind('loading');
      }
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const live = await service.fetchLiveTrains();
          if (!mounted || id !== requestId) {
            return;
          }
          if (live.length > 0) {
            haveTrains = true;
            if (feedDown) {
              feedDown = false;
              pushToast(t.toastFeedBack, 'feed-back', 10_000);
            }
            const shown = live.filter((train) => modesRef.current.includes(vehicleModeOf(train.mode)));
            setTrains((current) => mergeTrainList(current, shown));
            setStatusMessage(t.trainsCount(shown.length));
            setStatusKind('success');
            setLoading(false);
            return;
          }
          lastError = new Error('empty train list');
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
      if (!mounted || id !== requestId) {
        return;
      }
      console.warn('Realtime train fetch failed', lastError);
      setLoading(false);
      if (haveTrains) {
        setStatusKind('success');
        if (!feedDown) {
          feedDown = true;
          pushToast(t.toastFeedLost, 'feed-lost', 60_000);
        }
        return;
      }
      setStatusKind('error');
      setStatusMessage(t.trainListUnavailable);
    };
    refresh();
    // a region's live feed moves every 15 s; Slovakia's source is slower
    const interval = setInterval(refresh, REGION_ID === 'sk' ? 45_000 : 10_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [service, t, useLiveApi, pushToast]);

  const stopJourneyLoad = useCallback(() => {
    journeyAbortRef.current?.abort();
    journeyAbortRef.current = null;
    if (journeyPollRef.current) {
      window.clearInterval(journeyPollRef.current);
      journeyPollRef.current = 0;
    }
  }, []);

  const refreshJourney = useCallback(
    (trainNumber: string) => {
      if (!trainNumber) {
        stopJourneyLoad();
        setJourneyRows([]);
        setJourneyStatus('idle');
        return;
      }
      stopJourneyLoad();
      const controller = new AbortController();
      journeyAbortRef.current = controller;
      setJourneyRows([]);
      setJourneyStatus('loading');
      fetch(`/proxy/detail?mode=detail&train=${encodeURIComponent(trainNumber)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const body = (await response.json()) as { stops?: JourneyStop[] };
          if (!controller.signal.aborted) {
            setJourneyRows(
              filterTimedJourneyStops(indexJourneyRows(Array.isArray(body.stops) ? body.stops : []))
            );
            setJourneyStatus('ready');
          }
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          if (!controller.signal.aborted) {
            setJourneyRows([]);
            setJourneyStatus('error');
          }
        });
      journeyPollRef.current = window.setInterval(() => {
        fetch(`/proxy/detail?mode=detail&train=${encodeURIComponent(trainNumber)}`, {
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) {
              return;
            }
            const body = (await response.json()) as { stops?: JourneyStop[] };
            if (!controller.signal.aborted && Array.isArray(body.stops) && body.stops.length > 0) {
              setJourneyRows(filterTimedJourneyStops(indexJourneyRows(body.stops)));
              setJourneyStatus('ready');
            }
          })
          .catch(() => undefined);
      }, following ? 20_000 : 45_000);
    },
    [following, stopJourneyLoad]
  );

  const stopStationBoardLoad = useCallback(() => {
    stationBoardAbortRef.current?.abort();
    stationBoardAbortRef.current = null;
  }, []);

  const refreshStationBoard = useCallback(
    (station: FocusedStation | null, tab: 'departures' | 'arrivals') => {
      if (!station?.name) {
        stopStationBoardLoad();
        setStationBoard([]);
        setStationBoardStatus('idle');
        return;
      }
      stopStationBoardLoad();
      const controller = new AbortController();
      stationBoardAbortRef.current = controller;
      setStationBoardStatus('loading');
      fetchStationBoard(station.name, tab === 'arrivals', controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) {
            return;
          }
          setStationBoard(payload.rows ?? []);
          setStationBoardStatus(payload.rows?.length ? 'ready' : 'error');
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          if (!controller.signal.aborted) {
            setStationBoard([]);
            setStationBoardStatus('error');
          }
        });
    },
    [stopStationBoardLoad]
  );

  useEffect(() => {
    if (bootPanelLoadRef.current) {
      return;
    }
    bootPanelLoadRef.current = true;
    if (bootRoute.train) {
      refreshJourney(bootRoute.train);
    }
    if (bootRoute.station) {
      refreshStationBoard(bootRoute.station, bootRoute.tab);
    }
  }, [bootRoute, refreshJourney, refreshStationBoard]);

  useEffect(() => {
    if (!focusedTrainNumber) {
      stopJourneyLoad();
      setJourneyRows([]);
      setJourneyStatus('idle');
    }
  }, [focusedTrainNumber, stopJourneyLoad]);

  useEffect(() => {
    if (!focusedStation) {
      stopStationBoardLoad();
      setStationBoard([]);
      setStationBoardStatus('idle');
    }
  }, [focusedStation, stopStationBoardLoad]);

  const focusedTrainNumberRef = useRef(focusedTrainNumber);
  focusedTrainNumberRef.current = focusedTrainNumber;
  const focusedStationRef = useRef(focusedStation);
  focusedStationRef.current = focusedStation;
  const followingPrimedRef = useRef(false);
  const stationTabPrimedRef = useRef(false);

  useEffect(() => {
    if (!followingPrimedRef.current) {
      followingPrimedRef.current = true;
      return;
    }
    const train = focusedTrainNumberRef.current;
    if (!train) {
      return;
    }
    refreshJourney(train);
  }, [following, refreshJourney]);

  useEffect(() => {
    if (!stationTabPrimedRef.current) {
      stationTabPrimedRef.current = true;
      return;
    }
    const station = focusedStationRef.current;
    if (!station?.name) {
      return;
    }
    refreshStationBoard(station, stationTab);
  }, [stationTab, refreshStationBoard]);

  // The whole app re-rendered every second for the header clock. Now the clock label ticks on
  // its own (ClockLabel); this clock only drives the opened train's timetable cursor, which
  // the timetable model replaces once it runs the train (timelineProgress): then it is slow.
  const modelDrivesFocus = Boolean(focusedTrainNumber && timelineProgress?.train === focusedTrainNumber);
  useEffect(() => {
    if (!focusedTrainNumber) {
      return;
    }
    setClock(new Date());
    const timer = window.setInterval(() => setClock(new Date()), modelDrivesFocus ? 15_000 : 1000);
    return () => window.clearInterval(timer);
  }, [focusedTrainNumber, modelDrivesFocus]);

  useEffect(
    () => () => {
      stopJourneyLoad();
      stopStationBoardLoad();
    },
    [stopJourneyLoad, stopStationBoardLoad]
  );

  const handleCanvasStateChange = useCallback((state: 'loading' | 'loaded') => {
    setMapBooting(state === 'loading');
  }, []);
  const applyRoute = useCallback(
    (route: AppRoute, leaving: boolean) => {
      setAboutOpen(route.about);
      setFocusedTrainNumber(route.train);
      setFocusedStation(route.station);
      setStationTab(route.tab);
      if (route.train) {
        refreshJourney(route.train);
      }
      if (route.station) {
        refreshStationBoard(route.station, route.tab);
      }
      if (!route.train) {
        setFollowing(false);
      }
      if (leaving) {
        setDockLeaving(true);
      } else {
        setDockLeaving(false);
      }
    },
    [refreshJourney, refreshStationBoard]
  );
  const centerMapOn = useCallback((lng: number, lat: number, minZoom = 10) => {
    mapViewRef.current?.centerOn(lng, lat, { minZoom });
  }, []);
  const centerOnDockStop = useCallback(
    (index: number) => {
      const stop = journeyStops[index];
      if (!stop) {
        return;
      }
      const nextIndex = journeyNextIndex(journeyStops, focusedTrain ?? null, cursor?.stopIndex ?? null);
      const enRouteToNext =
        index === nextIndex &&
        cursor != null &&
        cursor.fraction > 0.02 &&
        cursor.fraction < 0.98;
      const isTrainHere =
        index === currentStopIndex ||
        enRouteToNext ||
        stop.state === 'current' ||
        (focusedTrain?.currentStation &&
          foldName(focusedTrain.currentStation) === foldName(stop.name));
      if (isTrainHere && focusedTrain) {
        const live = cursor?.position ?? focusedTrain.position;
        if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
          centerMapOn(live.lng, live.lat, 11);
          return;
        }
      }
      const point = focusedStations[index] ?? coordFromDataset(stop.name, dataset);
      if (point) {
        // A stop that is not a known station still gets a close look at its surroundings.
        centerMapOn(point.lng, point.lat, STATION_FOCUS_ZOOM - 0.5);
      }
    },
    [centerMapOn, cursor, currentStopIndex, dataset, focusedStations, focusedTrain, journeyStops]
  );
  const centerOnTrainPosition = useCallback(() => {
    if (!focusedTrain) {
      return;
    }
    // The link names the station ZSR last heard from the train at: go to that station. The
    // timetable estimate (cursor) is somewhere else along the line, which is not what it says.
    const at =
      coordFromDataset(focusedTrain.currentStation ?? '', dataset) ??
      (focusedTrain.position as { lat: number; lng: number } | undefined) ??
      null;
    if (at && Number.isFinite(at.lat) && Number.isFinite(at.lng)) {
      centerMapOn(at.lng, at.lat, 12);
    }
  }, [centerMapOn, dataset, focusedTrain]);
  const handleTrainClick = useCallback(
    (trainNumber: string) => {
      setAboutOpen(false);
      setFocusedStation(null);
      stopStationBoardLoad();
      setStationBoard([]);
      setStationBoardStatus('idle');
      setAlertsOpen(false);
      const next = trainNumber || null;
      // Following belongs to one train: picking another ends it, and the map
      // flies to the new train (MapScene) instead of drifting off.
      if (next !== focusedTrainNumberRef.current) {
        setFollowing(false);
      }
      setFocusedTrainNumber(next);
      if (next) {
        refreshJourney(next);
      } else {
        stopJourneyLoad();
        setJourneyRows([]);
        setJourneyStatus('idle');
      }
      setDockLeaving(false);
    },
    [refreshJourney, stopJourneyLoad, stopStationBoardLoad]
  );
  const handleStationClick = useCallback(
    (station: FocusedStation) => {
      setAlertsOpen(false);
      setAboutOpen(false);
      setFocusedTrainNumber(null);
      setFollowing(false);
      stopJourneyLoad();
      setJourneyRows([]);
      setJourneyStatus('idle');
      setStationTab('departures');
      setFocusedStation(station);
      refreshStationBoard(station, 'departures');
      setDockLeaving(false);
      centerMapOn(station.lng, station.lat, STATION_FOCUS_ZOOM);
    },
    [centerMapOn, refreshStationBoard, stopJourneyLoad]
  );
  const handleDockStopActivate = useCallback(
    (index: number) => {
      const stop = journeyStops[index];
      if (!stop) {
        return;
      }
      const station = stationFromDataset(stop.name, dataset);
      if (station) {
        handleStationClick(station);
        return;
      }
      centerOnDockStop(index);
    },
    [centerOnDockStop, dataset, handleStationClick, journeyStops]
  );
  const handleClearFocus = useCallback(() => {
    setDockLeaving((leaving) => leaving || Boolean(focusedTrainNumber || focusedStation || aboutOpen));
    setFocusedTrainNumber(null);
    setFocusedStation(null);
    setFollowing(false);
    setAboutOpen(false);
  }, [focusedTrainNumber, focusedStation, aboutOpen]);
  const handleDockBack = useCallback(() => {
    if (historyIndexRef.current > 0) {
      window.history.back();
      return;
    }
    applyingUrlRef.current = true;
    handleClearFocus();
  }, [handleClearFocus]);
  const openAlertTrain = useCallback(
    (trainNumber: string) => {
      setAlertsOpen(false);
      handleTrainClick(trainNumber);
    },
    [handleTrainClick]
  );
  const openAlertSection = useCallback(
    (stationName: string) => {
      setAlertsOpen(false);
      const at = coordFromDataset(stationName, dataset);
      if (at) {
        centerMapOn(at.lng, at.lat, 11);
      }
    },
    [centerMapOn, dataset]
  );

  // ZSSK mimoriadnosti (cancellations, forecasts, notes, closures): every few minutes.
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const load = async () => {
      const next = await fetchDisruptions(controller.signal);
      if (next && !controller.signal.aborted) {
        setDisruptions(next);
      }
      if (!controller.signal.aborted) {
        timer = window.setTimeout(load, 3 * 60 * 1000);
      }
    };
    load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const handleAboutBack = useCallback(() => {
    if (historyIndexRef.current > 0) {
      window.history.back();
      return;
    }
    applyingUrlRef.current = true;
    setAboutOpen(false);
    setDockLeaving((leaving) => leaving || Boolean(!focusedTrainNumber && !focusedStation));
  }, [focusedStation, focusedTrainNumber]);
  const handleAboutToggle = useCallback(() => {
    if (aboutOpen) {
      handleAboutBack();
      return;
    }
    setDockLeaving(false);
    setAlertsOpen(false);
    setAboutOpen(true);
  }, [aboutOpen, handleAboutBack]);

  const handleToggleMode = useCallback((mode: VehicleMode) => {
    setModes((current) => {
      const next = current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode];
      storeModes(next);
      return next;
    });
  }, []);
  // switching a kind off removes it at once; switching it on brings it back with the next update
  useEffect(() => {
    setTrains((current) => {
      const kept = current.filter((train) => modes.includes(vehicleModeOf(train.mode)));
      return kept.length === current.length ? current : kept;
    });
  }, [modes]);

  // Where am I: asks the browser for the position, centres the map there and marks it. The position
  // stays in the browser; nothing is sent anywhere.
  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) {
      pushToast(t.locateFailed, 'locate', 8_000);
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const here = { lat: position.coords.latitude, lng: position.coords.longitude };
        setUserLocation(here);
        mapViewRef.current?.centerOn(here.lng, here.lat, { minZoom: 12 });
      },
      (error) => {
        setLocating(false);
        pushToast(error.code === error.PERMISSION_DENIED ? t.locateDenied : t.locateFailed, 'locate', 8_000);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 }
    );
  }, [pushToast, t]);

  const handleAlertsToggle = useCallback(() => {
    if (alertsOpen) {
      setAlertsOpen(false);
      return;
    }
    setFocusedTrainNumber(null);
    setFocusedStation(null);
    setFollowing(false);
    setAboutOpen(false);
    setDockLeaving(false);
    setAlertsOpen(true);
  }, [alertsOpen]);

  const panelBitsRef = useRef({ aboutOpen, focusedTrainNumber, focusedStation });
  panelBitsRef.current = { aboutOpen, focusedTrainNumber, focusedStation };

  useEffect(() => {
    window.history.replaceState(
      { railatlas: 1, index: historyIndexRef.current },
      '',
      `${window.location.pathname}${lastSerializedRouteRef.current}${window.location.hash}`
    );
    const onPopState = (event: PopStateEvent) => {
      applyingUrlRef.current = true;
      const index =
        event.state && event.state.railatlas === 1 && typeof event.state.index === 'number'
          ? event.state.index
          : 0;
      historyIndexRef.current = index;
      const route = parseAppRoute();
      lastSerializedRouteRef.current = serializeAppRoute(route);
      const bits = panelBitsRef.current;
      const hadPanel = Boolean(bits.aboutOpen || bits.focusedTrainNumber || bits.focusedStation);
      const willHave = Boolean(route.about || route.train || route.station);
      applyRoute(route, hadPanel && !willHave);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute]);

  useEffect(() => {
    const serialized = serializeAppRoute(
      routeFromView({
        aboutOpen,
        trainNumber: focusedTrainNumber,
        station: focusedStation,
        tab: stationTab,
      })
    );
    if (serialized === lastSerializedRouteRef.current) {
      applyingUrlRef.current = false;
      return;
    }
    lastSerializedRouteRef.current = serialized;
    const url = `${window.location.pathname}${serialized}${window.location.hash}`;
    if (applyingUrlRef.current) {
      applyingUrlRef.current = false;
      window.history.replaceState({ railatlas: 1, index: historyIndexRef.current }, '', url);
      return;
    }
    historyIndexRef.current += 1;
    window.history.pushState({ railatlas: 1, index: historyIndexRef.current }, '', url);
  }, [aboutOpen, focusedStation, focusedTrainNumber, stationTab]);

  const matchingLiveTrain = useCallback(
    (row: StationBoardRow) => {
      if (!row.trainNumber) {
        return null;
      }
      return (
        trains.find((train) => train.trainNumber === row.trainNumber) ??
        trains.find((train) => train.trainNumber.replace(/\D/g, '') === row.trainNumber) ??
        null
      );
    },
    [trains]
  );
  const handleOsmStatusChange = useCallback((_status: { tilesLoaded: number }) => {}, []);
  // Stable callbacks: MapScene is memoised and inline arrows made it re-render with the app.
  const handleFollowBreak = useCallback(() => setFollowing(false), []);
  const handleFollowCorrection = useCallback(
    ({ train, meters }: { train: string; meters: number }) => {
      pushToast(
        t.toastPositionCorrected((Math.abs(meters) / 1000).toFixed(1).replace('.', locale === 'en' ? '.' : ','), meters < 0),
        `correct:${train}`,
        25_000
      );
    },
    [locale, pushToast, t]
  );
  const handlePositionUpdating = useCallback(
    ({ train }: { train: string; meters: number }) => {
      pushToast(t.toastPositionUpdating, `updating:${train}`, 25_000);
    },
    [pushToast, t]
  );
  const panelOpen = Boolean(focusedTrain || focusedStation || aboutOpen || alertsOpen);
  const leaveSnapshotRef = useRef<{
    train: TrainRenderState | null;
    station: FocusedStation | null;
    about: boolean;
    stops: JourneyStop[];
    journeyStatus: 'idle' | 'loading' | 'ready' | 'error';
    board: StationBoardRow[];
    boardStatus: 'idle' | 'loading' | 'ready' | 'error';
    stationTab: 'departures' | 'arrivals';
    delayText: string;
  } | null>(null);

  useEffect(() => {
    if (panelOpen) {
      setDockLeaving(false);
    }
  }, [panelOpen]);

  if (panelOpen) {
    leaveSnapshotRef.current = {
      train: aboutOpen ? null : focusedTrain,
      station: aboutOpen ? null : focusedStation,
      about: aboutOpen,
      stops: journeyStops,
      journeyStatus,
      board: stationBoard,
      boardStatus: stationBoardStatus,
      stationTab,
      delayText: selectedTrainDelayText,
    };
  }

  const leaveSnap = dockLeaving ? leaveSnapshotRef.current : null;
  const displayAlerts = alertsOpen;
  const displayAbout =
    !displayAlerts && (aboutOpen || Boolean(leaveSnap?.about && !leaveSnap.train && !leaveSnap.station));
  const displayTrain = displayAbout || displayAlerts ? null : focusedTrain ?? leaveSnap?.train ?? null;
  const displayStation =
    displayAbout || displayAlerts || displayTrain != null
      ? null
      : focusedStation ?? leaveSnap?.station ?? null;
  const displayStops = focusedTrain ? journeyStops : leaveSnap?.stops ?? journeyStops;
  const displayJourneyStatus = focusedTrain
    ? journeyStatus
    : leaveSnap?.journeyStatus ?? journeyStatus;
  const displayBoard = focusedStation ? stationBoard : leaveSnap?.board ?? stationBoard;
  const displayBoardStatus = focusedStation
    ? stationBoardStatus
    : leaveSnap?.boardStatus ?? stationBoardStatus;
  const displayStationTab = focusedStation
    ? stationTab
    : leaveSnap?.stationTab ?? stationTab;
  const displayDelayText = focusedTrain
    ? selectedTrainDelayText
    : leaveSnap?.delayText ?? selectedTrainDelayText;
  // Where the coach order of the opened train can be seen (vagonWEB): ZSSK trains only.
  const compositionUrl = displayTrain
    ? vagonwebTrainUrl(
        { trainType: displayTrain.trainType, trainNumber: displayTrain.trainNumber, operator: displayTrain.operator },
        locale
      )
    : null;
  const liveTrainNumbers = useMemo(() => new Set(trains.map((train) => train.trainNumber)), [trains]);
  // Only notices about a train that is on the map right now: line closures (no train) and trains
  // that have left the map are not shown.
  const disruptionEvents = useMemo(
    () =>
      (disruptions?.events ?? []).filter((event) => event.train != null && liveTrainNumbers.has(event.train.number)),
    [disruptions, liveTrainNumbers]
  );
  // Notices about the opened train; a plain delay is already in the status line.
  const trainAlerts = eventsForTrain(disruptionEvents, displayTrain?.trainNumber).filter(
    (event) => event.kind !== 'delay' || event.forecast
  );
  const alertBadge = disruptionEvents.filter((event) => event.kind === 'cancel' || event.kind === 'closure').length;
  const showDock = Boolean(displayTrain || displayStation || displayAbout || displayAlerts);
  const bootLocked = mapBooting || statusKind === 'loading';

  // The text panels (About, Mimoriadnosti) have no small version on a phone: they open full size,
  // and pulling them down closes them. Trains and stations open small and can be pulled up.
  const textPanelOpen = displayAlerts || displayAbout;
  useEffect(() => {
    setMobileDockExpanded(isMobile && (alertsOpen || aboutOpen));
  }, [focusedTrainNumber, focusedStation?.id, aboutOpen, alertsOpen, isMobile]);

  const handleSheetExpandedChange = useCallback(
    (next: boolean) => {
      setMobileDockExpanded(next);
      if (next || !isMobile) {
        return;
      }
      if (alertsOpen) {
        setAlertsOpen(false);
      } else if (aboutOpen) {
        handleAboutBack();
      }
    },
    [alertsOpen, aboutOpen, handleAboutBack, isMobile]
  );

  const mobileSheetEnabled = isMobile && showDock;
  const mobileSheet = useMobileDockSheet(
    mobileSheetEnabled,
    mobileDockExpanded,
    handleSheetExpandedChange
  );
  const mobileSheetOpen =
    mobileSheetEnabled &&
    (mobileSheet.progress >= 0.5 || mobileDockExpanded);
  const mobileSheetRevealed = mobileSheet.sheetContentRevealed;

  useEffect(() => {
    if (!isMobile || !mobileSheetRevealed) {
      return;
    }
    if (focusedTrainNumber && (journeyStatus === 'idle' || journeyStatus === 'error')) {
      refreshJourney(focusedTrainNumber);
    }
    if (focusedStation && (stationBoardStatus === 'idle' || stationBoardStatus === 'error')) {
      refreshStationBoard(focusedStation, stationTab);
    }
  }, [
    focusedStation,
    focusedTrainNumber,
    isMobile,
    journeyStatus,
    mobileSheetRevealed,
    refreshJourney,
    refreshStationBoard,
    stationBoardStatus,
    stationTab,
  ]);

  const accent =
    vehicleInk(displayTrain?.color, theme) || getDelayColor(displayTrain?.delayMinutes ?? focusedTrain?.delayMinutes ?? 0);
  const nextStopIndex = journeyNextIndex(
    displayStops,
    displayTrain,
    cursor?.stopIndex ?? null
  );
  const trailheadIndex = useMemo(() => {
    if (displayStops.length === 0) {
      return -1;
    }
    if (currentStopIndex >= 0) {
      return currentStopIndex;
    }
    if (cursor && cursor.stopIndex >= 0) {
      return cursor.stopIndex;
    }
    const liveState = displayStops.findIndex((stop) => stop.state === 'current');
    if (liveState >= 0) {
      return liveState;
    }
    return nextStopIndex;
  }, [currentStopIndex, cursor, displayStops, nextStopIndex]);
  /** Where the train is on the list: the last stop it reached and how far it is toward the next. */
  const railProgress = useMemo(() => {
    if (!displayTrain || displayStops.length < 2) {
      return null;
    }
    if (
      timelineProgress &&
      timelineProgress.train === displayTrain.trainNumber &&
      timelineProgress.from < displayStops.length
    ) {
      return { from: timelineProgress.from, fraction: timelineProgress.fraction };
    }
    if (cursor && cursor.stopIndex >= 0 && cursor.stopIndex < displayStops.length) {
      return { from: cursor.stopIndex, fraction: cursor.fraction };
    }
    return null;
  }, [cursor, displayStops.length, displayTrain, timelineProgress]);
  /** "Poltár → Utekáč" when part of the journey runs by replacement bus. */
  const busNotice = useMemo(() => {
    const stops = displayStops.filter((stop) => stop.bus);
    if (stops.length < 2) {
      return '';
    }
    return `${stops[0].name} → ${stops[stops.length - 1].name}`;
  }, [displayStops]);
  /** Where ZSR last heard from the train; tapping it centres the map there. */
  const lastPositionLink = displayTrain?.currentStation ? (
    focusedTrain ? (
      <button
        type="button"
        className="dock__fact-link"
        onClick={(event) => {
          event.stopPropagation();
          centerOnTrainPosition();
        }}
      >
        {displayTrain.currentStation}
      </button>
    ) : (
      displayTrain.currentStation
    )
  ) : null;
  const followButton = focusedTrain ? (
    <span className="dock__actions">
      <button
        type="button"
        className={`dock__follow ${following ? 'is-active' : ''}`}
        aria-pressed={following}
        onClick={() => setFollowing((value) => !value)}
      >
        {following ? t.following : t.follow}
      </button>
      {compositionUrl && (
        <a
          className="dock__follow dock__follow--link"
          href={compositionUrl}
          target="_blank"
          rel="noopener"
          title={t.trainCompositionTitle}
        >
          {t.trainCompositionButton}
          <span aria-hidden="true">↗</span>
        </a>
      )}
    </span>
  ) : null;
  const stopsHaveDelay = displayStops.some((stop) => stopTimesView(stop).actual != null);
  const properTrainName = isProperTrainName(displayTrain?.trainName)
    ? displayTrain?.trainName?.trim() ?? ''
    : '';
  const routeEnds =
    displayJourneyStatus === 'ready' && displayStops.length >= 2
      ? { from: displayStops[0].name, to: displayStops[displayStops.length - 1].name }
      : parseSummaryRoute(displayTrain?.summary || displayTrain?.trainName);
  useEffect(() => {
    if (displayAbout) {
      applySeo(locale, { kind: 'about' });
    } else if (displayTrain) {
      applySeo(locale, {
        kind: 'train',
        label: `${trainLabel(displayTrain)}${properTrainName ? ` ${properTrainName}` : ''}`,
        destination: routeEnds?.to ? townOf(routeEnds.to) : '',
      });
    } else if (displayStation) {
      applySeo(locale, { kind: 'station', name: displayStation.name });
    } else {
      applySeo(locale, { kind: 'home' });
    }
  }, [locale, displayAbout, displayTrain?.trainNumber, displayTrain?.trainType, properTrainName, routeEnds?.to, displayStation?.name]);
  const searchHits = useMemo(() => {
    const query = foldName(searchQuery);
    if (query.length < 1) {
      return [] as SearchHit[];
    }
    const trainHits: SearchHit[] = trains.flatMap((train) => {
      const score = Math.max(
        matchScore(train.trainNumber, query),
        matchScore(train.trainType ?? '', query),
        matchScore(train.trainName ?? '', query),
        matchScore(train.summary ?? '', query),
        matchScore(`${train.trainType ?? ''} ${train.trainNumber}`, query)
      );
      if (score <= 0) {
        return [];
      }
      return [{ kind: 'train' as const, id: `train:${train.trainNumber}`, score, train }];
    });
    const seenStations = new Set<string>();
    const stationHits: SearchHit[] = Object.values(dataset?.stops ?? {}).flatMap((stop) => {
      const name = stop.name.trim();
      if (!name) {
        return [];
      }
      const key = foldName(name);
      if (seenStations.has(key)) {
        return [];
      }
      const score = Math.max(matchScore(name, query), matchScore(stop.code ?? '', query));
      if (score <= 0) {
        return [];
      }
      seenStations.add(key);
      return [
        {
          kind: 'station' as const,
          id: `station:${stop.stopId}`,
          score,
          station: { id: stop.stopId, name, lat: stop.lat, lng: stop.lng },
        },
      ];
    });
    return [...trainHits, ...stationHits]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.kind !== right.kind) {
          return left.kind === 'train' ? -1 : 1;
        }
        const leftLabel = left.kind === 'train' ? left.train.trainNumber : left.station.name;
        const rightLabel = right.kind === 'train' ? right.train.trainNumber : right.station.name;
        return leftLabel.localeCompare(rightLabel, LOCALE_TAG[locale]);
      })
      .slice(0, 8);
  }, [dataset, searchQuery, trains]);

  // With nothing typed, the search offers what was picked earlier in this session
  // (trains that have since left the feed are left out).
  const historyHits = useMemo(
    () =>
      searchHistory.flatMap((ref): SearchHit[] => {
        if (ref.kind === 'station') {
          return [{ kind: 'station', id: `station:${ref.station.id}`, score: 0, station: ref.station }];
        }
        const train = trains.find((item) => item.trainNumber === ref.trainNumber);
        return train ? [{ kind: 'train', id: `train:${ref.trainNumber}`, score: 0, train }] : [];
      }),
    [searchHistory, trains]
  );
  const showingHistory = !searchQuery.trim() && historyHits.length > 0;
  const shownHits = showingHistory ? historyHits : searchHits;

  return (
    <div
      className={`shell ${panelOpen ? 'is-panel-open' : ''} ${bootLocked ? 'shell--booting' : ''}`}
      data-theme={theme}
    >
      <div className="shell__map">
        <MapScene
          trains={trains}
          focusedStations={routeStations}
          journeyStops={journeyRows}
          journeyStatus={journeyStatus}
          following={following}
          onFollowBreak={handleFollowBreak}
          onTimelineProgress={setTimelineProgress}
          onFollowCorrection={handleFollowCorrection}
          onPositionUpdating={handlePositionUpdating}
          focusedTrainNumber={focusedTrainNumber}
          focusedRouteCursor={focusedTrain ? cursor : null}
          onTrainClick={handleTrainClick}
          onStationClick={handleStationClick}
          onBackgroundClick={handleClearFocus}
          focusedStationId={focusedStation?.id ?? null}
          focusedStation={focusedStation}
          dataset={dataset}
          onOsmStatusChange={handleOsmStatusChange}
          onCanvasStateChange={handleCanvasStateChange}
          trainsLoaded={!loading}
          theme={theme}
          locale={locale}
          mapViewRef={mapViewRef}
          transitLines={transitLines}
          userLocation={userLocation}
        />
      </div>
      <header className="chrome">
        <div className={`chrome__brand ${panelOpen ? 'is-active' : ''}`}>
          <button
            type="button"
            className="chrome__brand-mark"
            aria-pressed={aboutOpen}
            aria-label={t.aboutRailatlas}
            onClick={handleAboutToggle}
          >
            <img src={theme === 'light' ? logoMarkLight : logoMarkDark} alt="" width={20} height={20} />
            <span>Môj Vlak</span>
          </button>
          <small className="chrome__brand-meta">
            {loading ? t.loadingTrains : t.trainsCount(trains.length)}
            {' · '}
            <ClockLabel locale={locale} />
            {' · '}
            <a
              className="chrome__brand-studio"
              href="https://asymetric.studio"
              target="_blank"
              rel="noreferrer"
            >
              {t.studioBy}
            </a>
          </small>
        </div>
        {searchMobileOpen && (
          <button
            type="button"
            className="chrome__search-backdrop"
            aria-label={t.searchCloseAria}
            onClick={closeSearch}
          />
        )}
        <div
          className={`chrome__search${searchOpen && shownHits.length > 0 ? ' is-open' : ''}${
            searchMobileOpen ? ' is-mobile-open' : ''
          }`}
          role={searchMobileOpen ? 'dialog' : undefined}
          aria-modal={searchMobileOpen ? true : undefined}
          aria-label={searchMobileOpen ? t.searchPlaceholder : undefined}
        >
          <div
            className="chrome__search-bar"
            onMouseDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('input, button')) {
                return;
              }
              event.preventDefault();
              searchInputRef.current?.focus();
            }}
          >
            <ChromeSearchIcon size={14} className="chrome__search-glyph" />
            <input
              ref={searchInputRef}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              value={searchQuery}
              placeholder={t.searchPlaceholder}
              aria-label={t.searchPlaceholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => {
                window.setTimeout(() => {
                  if (!searchMobileOpen) {
                    setSearchOpen(false);
                  }
                }, 160);
              }}
            />
            {searchMobileOpen && (
              <button
                type="button"
                className="chrome__search-dismiss"
                aria-label={t.searchCloseAria}
                onClick={closeSearch}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
          {searchMobileOpen && !searchQuery.trim() && !showingHistory && (
            <p className="chrome__search-mobile-hint">{t.searchMobileHint}</p>
          )}
          {searchMobileOpen && Boolean(searchQuery.trim()) && searchHits.length === 0 && (
            <p className="chrome__search-empty">{t.searchNoResults}</p>
          )}
          {searchOpen && shownHits.length > 0 && (
            <ul className="chrome__hits">
              {showingHistory && (
                <li className="chrome__hits-head">
                  <span>{t.searchRecent}</span>
                  <button
                    type="button"
                    className="chrome__hits-clear"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSearchHistory([])}
                  >
                    {t.searchClearRecent}
                  </button>
                </li>
              )}
              {shownHits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className={
                      hit.kind === 'train'
                        ? hit.train.trainNumber === focusedTrainNumber
                          ? 'is-selected'
                          : ''
                        : hit.station.id === focusedStation?.id
                          ? 'is-selected'
                          : ''
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (hit.kind === 'train') {
                        rememberSearch({ kind: 'train', trainNumber: hit.train.trainNumber });
                        handleTrainClick(hit.train.trainNumber);
                      } else {
                        rememberSearch({ kind: 'station', station: hit.station });
                        handleStationClick(hit.station);
                      }
                      setSearchQuery('');
                      closeSearch();
                    }}
                  >
                    {hit.kind === 'train' ? (
                      <span
                        className="chrome__hit-pill chrome__hit-pill--train"
                        style={{
                          backgroundColor: hit.train.color,
                          color: contrastInk(hit.train.color),
                        }}
                        aria-hidden="true"
                      >
                        {hit.train.mode === 'metro' && <MetroLogo height={10} />}
                        {trainTypeCallout(hit.train.trainType) || 'Os'}
                      </span>
                    ) : (
                      <span className="chrome__hit-pill chrome__hit-pill--station" aria-hidden="true">
                        <span className="chrome__hit-pill-line" />
                      </span>
                    )}
                    <span className="chrome__hit-copy">
                      <span className="chrome__hit-title">
                        {hit.kind === 'train'
                          ? `${trainLabel(hit.train)}`
                          : hit.station.name}
                      </span>
                      <small className="chrome__hit-meta">
                        {hit.kind === 'train' ? searchTrainSubtitle(hit.train) : t.station}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="chrome__tools">
          <button
            type="button"
            className={`chrome__tool chrome__tool--menu${menuOpen ? ' is-active' : ''}`}
            aria-label={t.menuOpen}
            aria-expanded={menuOpen}
            title={t.menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="menu-bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </button>
          <button
            type="button"
            className={`chrome__tool chrome__tool--search${searchMobileOpen ? ' is-active' : ''}`}
            aria-label={t.searchPlaceholder}
            aria-pressed={searchMobileOpen}
            title={t.searchPlaceholder}
            onClick={() => {
              if (searchMobileOpen) {
                searchInputRef.current?.focus();
                return;
              }
              openMobileSearch();
            }}
          >
            <ChromeSearchIcon className="chrome__search-glyph chrome__search-glyph--tool" />
          </button>
          <button
            type="button"
            className={`chrome__tool chrome__tool--info${aboutOpen ? ' is-active' : ''}`}
            aria-pressed={aboutOpen}
            aria-label={t.aboutRailatlas}
            title={t.aboutRailatlas}
            onClick={handleAboutToggle}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.35" />
              <path
                d="M8 7.1v4.2M8 5.4h.01"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {REGION_ID === 'sk' && (
          <button
            type="button"
            className={`chrome__tool chrome__tool--alerts${alertsOpen ? ' is-active' : ''}`}
            aria-pressed={alertsOpen}
            aria-label={t.alertsAria}
            title={t.alertsAria}
            onClick={handleAlertsToggle}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2 14.2 12.8H1.8L8 2Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
              <path d="M8 6.6v3M8 11.2h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {alertBadge > 0 && <span className="chrome__badge">{alertBadge > 9 ? '9+' : alertBadge}</span>}
          </button>
          )}
          <button
            type="button"
            className="chrome__tool chrome__tool--gap"
            aria-label={t.zoomIn}
            title={t.zoomIn}
            onClick={() => mapViewRef.current?.zoomIn()}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            type="button"
            className="chrome__tool"
            aria-label={t.zoomOut}
            title={t.zoomOut}
            onClick={() => mapViewRef.current?.zoomOut()}
          >
            <span aria-hidden="true">−</span>
          </button>
          <button
            type="button"
            className={`chrome__tool chrome__tool--locate${locating ? ' is-active' : ''}`}
            aria-label={t.locateAria}
            title={t.locateAria}
            disabled={locating}
            onClick={handleLocate}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 .9v2.3M8 12.8v2.3M.9 8h2.3M12.8 8h2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      <MainMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        logo={theme === 'dark' ? logoMarkDark : logoMarkLight}
        locale={locale}
        onLocale={setLocale}
        theme={theme}
        onTheme={setTheme}
        modes={modes}
        onToggleMode={handleToggleMode}
        onAbout={() => {
          setMenuOpen(false);
          if (!aboutOpen) {
            handleAboutToggle();
          }
        }}
        copy={{
          menuClose: t.menuClose,
          menuRegion: t.menuRegion,
          menuLanguage: t.menuLanguage,
          menuAppearance: t.menuAppearance,
          menuDarkMode: t.menuDarkMode,
          menuAbout: t.menuAbout,
          menuShow: t.menuShow,
          modeNames: { rail: t.modeRail, metro: t.modeMetro, tram: t.modeTram, trolley: t.modeTrolley, bus: t.modeBus },
          menuStudio: t.menuStudio,
          regionNames: { sk: t.regionSk, pid: t.regionPid },
          regionMeta: { sk: t.regionSkMeta, pid: t.regionPidMeta },
        }}
      />
      {toasts.length > 0 && (
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <p className="toast" key={toast.id}>
              {toast.text}
            </p>
          ))}
        </div>
      )}
      {statusKind === 'error' && !panelOpen && (
        <p className="shell__toast">{statusMessage}</p>
      )}
      {showDock && (
      <aside
        ref={mobileSheet.dockRef}
        className={`dock ${dockLeaving ? 'is-leave' : 'is-enter'}${
          mobileSheetEnabled
            ? mobileSheetOpen
              ? ' dock--expanded'
              : ' dock--collapsed'
            : ''
        }${mobileSheetRevealed ? ' dock--sheet-opening' : ''}${
          mobileSheetEnabled ? ' dock--mobile-interactive' : ''
        }${
          mobileSheet.dragging ? ' dock--dragging' : ''
        }${textPanelOpen ? ' dock--about' : ''}`}
        style={
          {
            '--accent': accent,
            '--accent-ink': contrastInk(accent),
            ...mobileSheet.dockStyle,
          } as React.CSSProperties
        }
        onAnimationEnd={(event) => {
          if (event.currentTarget !== event.target) {
            return;
          }
          if (event.animationName !== 'dock-out') {
            return;
          }
          if (!(event.currentTarget as HTMLElement).classList.contains('is-leave')) {
            return;
          }
          setDockLeaving(false);
        }}
      >
        {displayTrain ? (
          <div
            className={`dock__body dock__body--train${
              isMobile ? ' dock__body--sheet-touch' : ''
            }${isMobile && !mobileSheetRevealed ? ' dock__body--sheet-collapsed' : ''}`}
            {...(isMobile ? mobileSheet.gesture : {})}
          >
            {isMobile && (
              <DockSheetHandle
                expanded={mobileSheetOpen}
                expandLabel={t.dockExpandSheet}
                onToggle={() => setMobileDockExpanded(!mobileSheetOpen)}
              />
            )}
            {isMobile && followButton && <div className="dock__follow-float">{followButton}</div>}
            <div className="dock__sheet-main">
              {!isMobile && (
                <DockPanelControls
                  backLabel={t.back}
                  closeLabel={t.dockCloseAria}
                  onBack={handleDockBack}
                  onClose={handleClearFocus}
                  center={followButton}
                />
              )}
              {/* One header for every state and size: it never changes what it shows when the
                  mobile sheet opens or closes (it used to swap to a different "peek" and flicker). */}
              <div
                className={`dock__head${isMobile ? ' dock__head--tap' : ''}`}
                onClick={
                  isMobile
                    ? () => {
                        if (mobileSheet.consumePeekClick()) {
                          return;
                        }
                        setMobileDockExpanded(!mobileSheetOpen);
                      }
                    : undefined
                }
              >
                <p className="dock__identity">
                  <span className="dock__pill">
                    {displayTrain.mode === 'metro' && <MetroLogo />}
                    {`${trainLabel(displayTrain)}`}
                  </span>
                  <DockTitle properName={properTrainName} to={routeEnds?.to ?? ''} fallback={t.train} />
                </p>
                <p className="dock__status">
                  <span className="dock__delay">
                    <ClockIcon />
                    <span>{delayView(displayDelayText)}</span>
                  </span>
                  {lastPositionLink && (
                    <>
                      <span className="dock__status-dash" aria-hidden="true" />
                      <span className="dock__last-position" title={t.lastPosition}>
                        <InfoIcon />
                        {lastPositionLink}
                      </span>
                    </>
                  )}
                </p>
                {trainAlerts.length > 0 && (
                  <ul className="dock__alerts">
                    {trainAlerts.map((event) => (
                      <li key={event.id} className={`dock__alert dock__alert--${event.kind}`}>
                        <AlertIcon />
                        <span>{describeDisruption(event, t)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {busNotice && (
                <p className="dock__note dock__bus-notice">
                  <BusIcon />
                  <span>
                    {t.replacementBus}
                    <strong>{busNotice}</strong>
                  </span>
                </p>
              )}
              {displayTrain.note && <p className="dock__note">{displayTrain.note}</p>}
              <DockScroller
              loading={displayJourneyStatus === 'loading' || displayJourneyStatus === 'idle'}
              error={displayJourneyStatus === 'error' ? t.stationListUnavailable : null}
              label={t.loadingStations}
              contentKey={displayTrain.trainNumber}
              revealKey={isMobile ? `${displayTrain.trainNumber}:${mobileSheetOpen ? 'open' : 'closed'}` : undefined}
              listPointerHandoff={mobileSheet.listPointerHandoff}
              listAtScrollTop={mobileSheet.listAtScrollTop}
              loadingVisible={!isMobile || mobileSheetRevealed}
              loadingDelayMs={isMobile && mobileSheetRevealed ? 500 : 0}
              loadingVariant={isMobile ? 'bar' : 'spinner'}
            >
              <ol className={`dock__stops${stopsHaveDelay ? ' has-delay' : ''}`}>
                {displayStops.map((stop, index) => {
                  // One source for the whole row: where the train really is on the list.
                  // Rail: dark where it has been, grey where it has not; the segment it is in
                  // fills partway and a dot marks the head. Text: stops it has left are dimmed
                  // and only one stays bold: the stop it stands at, or the next one between stops.
                  const focusIndex = railProgress
                    ? railProgress.fraction <= 0.02 || railProgress.from >= displayStops.length - 1
                      ? railProgress.from
                      : railProgress.from + 1
                    : trailheadIndex;
                  const isPassedStop = focusIndex >= 0 && index < focusIndex;
                  const isFocusStop = focusIndex >= 0 && index === focusIndex;
                  const isReached = railProgress != null && index <= railProgress.from;
                  // The dot rides in the row below the stop the train last reached, so it sits on
                  // that stop's stud while the train stands there; after the last stop it rests on it.
                  const isHeadRow =
                    railProgress != null &&
                    (index === railProgress.from + 1 ||
                      (railProgress.from >= displayStops.length - 1 && index === displayStops.length - 1));
                  const segmentFill =
                    railProgress == null || index === 0
                      ? 0
                      : index - 1 < railProgress.from
                        ? 1
                        : index - 1 === railProgress.from
                          ? railProgress.fraction
                          : 0;
                  const { planned, actual } = stopTimesView(stop);
                  const isBusLeg = Boolean(stop.bus && displayStops[index - 1]?.bus);
                  const times = (
                    <span className="dock__stop-times">
                      <time className={`dock__stop-planned${actual ? ' is-late' : ''}`}>
                        {planned}
                      </time>
                      {actual ? (
                        <time className="dock__stop-actual">{actual}</time>
                      ) : (
                        <span className="dock__stop-actual" aria-hidden="true" />
                      )}
                    </span>
                  );
                  const point = focusedStations[index] ?? coordFromDataset(stop.name, dataset);
                  const stationMatch = stationFromDataset(stop.name, dataset);
                  const stopInteractive = !stop.foreign && Boolean(stationMatch || point);
                  return (
                    <li
                      key={`${stop.name}-${index}`}
                      className={[
                        isPassedStop ? 'is-passed' : '',
                        isFocusStop ? 'is-focus' : '',
                        isReached ? 'is-reached' : '',
                        isBusLeg ? 'is-bus-leg' : '',
                        stopInteractive ? 'is-interactive' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={
                        {
                          '--tl-fill': segmentFill,
                          // Colour of the dotted rail leading into the pinned first / last stop.
                          ...(index === 0
                            ? { '--tl-edge': railProgress && railProgress.from >= 1 ? 'var(--tl-done)' : 'var(--tl-todo)' }
                            : {}),
                          ...(index === displayStops.length - 1
                            ? {
                                '--tl-edge':
                                  railProgress && railProgress.from >= displayStops.length - 1
                                    ? 'var(--tl-done)'
                                    : 'var(--tl-todo)',
                              }
                            : {}),
                        } as React.CSSProperties
                      }
                    >
                      {isHeadRow && <span className="dock__stop-train" aria-hidden="true" />}
                      {stopInteractive ? (
                        <button
                          type="button"
                          className="dock__stop-row"
                          onClick={() => handleDockStopActivate(index)}
                        >
                          <span className="dock__stop-label">{stop.name}</span>
                          {times}
                        </button>
                      ) : (
                        <>
                          <span className="dock__stop-label is-plain">{stop.name}</span>
                          {times}
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
            </DockScroller>
              <dl className="dock__facts">
                {displayTrain.operator && (
                  <div>
                    <dt>{t.operator}</dt>
                    <dd>{displayTrain.operator}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        ) : displayStation ? (
          <div
            className={`dock__body${
              isMobile ? ' dock__body--sheet-touch' : ''
            }${isMobile && !mobileSheetRevealed ? ' dock__body--sheet-collapsed' : ''}`}
            {...(isMobile ? mobileSheet.gesture : {})}
          >
            {isMobile && (
              <>
                <DockSheetHandle
                  expanded={mobileSheetOpen}
                  expandLabel={t.dockExpandSheet}
                  onToggle={() => setMobileDockExpanded(!mobileSheetOpen)}
                />
                <button
                  type="button"
                  className="dock__peek"
                  aria-expanded={mobileSheetOpen}
                  onClick={() => {
                    if (mobileSheet.consumePeekClick()) {
                      return;
                    }
                    setMobileDockExpanded(true);
                  }}
                >
                  <span className="dock__peek-identity">
                    <span className="dock__pill is-station">{t.station}</span>
                    <span className="dock__name">{displayStation.name}</span>
                  </span>
                  <span className="dock__peek-meta">
                    {displayStationTab === 'arrivals' ? t.arrivals : t.departures}
                  </span>
                </button>
              </>
            )}
            <div className="dock__sheet-main">
              {!isMobile && (
                <DockPanelControls
                  backLabel={t.back}
                  closeLabel={t.dockCloseAria}
                  onBack={handleDockBack}
                  onClose={handleClearFocus}
                />
              )}
              <div className="dock__head">
              {!isMobile && (
                <p className="dock__identity">
                  <span className="dock__pill is-station">{t.station}</span>
                  <span className="dock__name">{displayStation.name}</span>
                </p>
              )}
              <div className="dock__tabs" role="tablist" aria-label={t.stationBoard}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={displayStationTab === 'departures'}
                  className={`dock__tab ${displayStationTab === 'departures' ? 'is-active' : ''}`}
                  onClick={() => setStationTab('departures')}
                >
                  {t.departures}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={displayStationTab === 'arrivals'}
                  className={`dock__tab ${displayStationTab === 'arrivals' ? 'is-active' : ''}`}
                  onClick={() => setStationTab('arrivals')}
                >
                  {t.arrivals}
                </button>
              </div>
            </div>
            <DockScroller
              loading={displayBoardStatus === 'loading' || displayBoardStatus === 'idle'}
              error={
                displayBoardStatus === 'error'
                  ? displayStationTab === 'arrivals'
                    ? t.boardErrorArrivals
                    : t.boardErrorDepartures
                  : null
              }
              label={displayStationTab === 'arrivals' ? t.loadingArrivals : t.loadingDepartures}
              contentKey={`${displayStation.id}-${displayStationTab}`}
              listPointerHandoff={mobileSheet.listPointerHandoff}
              listAtScrollTop={mobileSheet.listAtScrollTop}
              loadingVisible={!isMobile || mobileSheetRevealed}
              loadingDelayMs={isMobile && mobileSheetRevealed ? 500 : 0}
              loadingVariant={isMobile ? 'bar' : 'spinner'}
            >
              <ol className="dock__board">
                {displayBoard.map((row, index) => {
                  const live = matchingLiveTrain(row);
                  const delayMinutes = live?.delayMinutes ?? row.delayMinutes;
                  const delayColor = getDelayColor(delayMinutes);
                  const delayLabel =
                    delayMinutes > 0
                      ? t.delayMinutesShort(delayMinutes)
                      : live
                        ? t.onTime
                        : '';
                  return (
                    <li key={`${row.datetime ?? row.time}-${row.code}-${index}`}>
                      <button
                        type="button"
                        className={`dock__board-row ${live ? 'is-live' : ''}`}
                        onClick={() => live && handleTrainClick(live.trainNumber)}
                        disabled={!live}
                      >
                        <time>{row.time || '—'}</time>
                        <span className="dock__board-main">
                          <span
                            className="dock__pill is-row"
                            style={{ background: delayColor, color: contrastInk(delayColor) }}
                          >
                            {boardPillLabel(row.code) || t.train}
                          </span>
                          <span className="dock__board-dest">
                            <span className="dock__board-arrow" aria-hidden="true">
                              →
                            </span>
                            {row.destination}
                          </span>
                        </span>
                        {delayLabel ? (
                          <span className="dock__row-delay" style={{ color: delayColor }}>
                            {delayLabel}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </DockScroller>
            <a
              className="dock__cp-link"
              href={`${REGION_ID === 'sk' ? 'https://cp.sk/vlakbusmhd/odchody/' : 'https://idos.cz/vlaky/odjezdy/'}?f=${encodeURIComponent(displayStation.name)}&submit=true&changeShield=true${
                displayStationTab === 'arrivals' ? '&byarr=true' : ''
              }`}
              target="_blank"
              rel="noreferrer"
            >
              {REGION_ID === 'sk' ? t.openOnCpSk : t.openOnIdos}
            </a>
            </div>
          </div>
        ) : displayAlerts ? (
          <DockInfoPanel
            isMobile={isMobile}
            sheet={mobileSheet}
            open={mobileSheetOpen}
            revealed={mobileSheetRevealed}
            onExpandedChange={handleSheetExpandedChange}
            expandLabel={t.dockExpandSheet}
            pill={t.alertsPill}
            title={t.alertsTitle}
            backLabel={t.back}
            onBack={() => setAlertsOpen(false)}
            contentKey={`alerts-${locale}`}
            loadingLabel={t.loadingAbout}
          >
            <DisruptionsPanel
              events={disruptionEvents}
              t={t}
              liveTrains={liveTrainNumbers}
              sourceName={disruptions?.source.name ?? ''}
              sourceUrl={disruptions?.source.url ?? 'https://mastodon.social/@zssk_mimoriadne'}
              onTrain={openAlertTrain}
              onSection={openAlertSection}
            />
          </DockInfoPanel>
        ) : displayAbout ? (
          <Suspense fallback={null}>
            <AboutPanel
              onBack={handleAboutBack}
              copy={t}
              locale={locale}
              sheet={{
              isMobile,
              sheet: mobileSheet,
              open: mobileSheetOpen,
              revealed: mobileSheetRevealed,
              onExpandedChange: handleSheetExpandedChange,
              expandLabel: t.dockExpandSheet,
            }}
            />
          </Suspense>
        ) : null}
      </aside>
      )}
    </div>
  );
};

export default App;

