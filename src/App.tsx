import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapScene } from './components/MapScene';
import { DockScroller } from './components/DockScroller';
import { DockPanelControls } from './components/DockPanelControls';
import { DockSheetHandle } from './components/DockSheetHandle';
import { AboutPanel } from './components/AboutPanel';
import { useMobileLayout } from './hooks/useMobileLayout';
import { useMobileDockSheet } from './hooks/useMobileDockSheet';
import {
  TrainService,
  type JourneyStop,
  type TrainRenderState,
  contrastInk,
  getDelayColor,
  filterTimedJourneyStops,
  mergeTrainList,
  routeCursor,
  stationPoints,
  trainTypeCallout,
} from './data/trainService';
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
  readStoredLocale,
  type AppLocale,
} from './i18n';

const THEME_STORAGE_KEY = 'railatlas-theme';

type SearchHit =
  | { kind: 'train'; id: string; score: number; train: TrainRenderState }
  | { kind: 'station'; id: string; score: number; station: FocusedStation };

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
  return stops.findIndex((stop) => {
    const folded = foldName(stop.name);
    return folded === key || folded.startsWith(key) || key.startsWith(folded);
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
  for (const stop of Object.values(dataset.stops)) {
    const folded = foldName(stop.name);
    if (folded === key || folded.startsWith(key) || key.startsWith(folded)) {
      return stop;
    }
  }
  return null;
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

function dockStopRailColor(
  delayColor: string | null,
  onTimeRail: string
): string {
  return delayColor ?? onTimeRail;
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

async function loadGtfsDataset(): Promise<GtfsDataset> {
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
  const t = useMemo(() => copyFor(locale), [locale]);
  const [statusMessage, setStatusMessage] = useState(() => copyFor(readStoredLocale()).loadingGtfs);
  const [statusKind, setStatusKind] = useState<'loading' | 'success' | 'error'>(
    'loading'
  );
  const [journeyStops, setJourneyStops] = useState<JourneyStop[]>([]);
  const [journeyStatus, setJourneyStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [clock, setClock] = useState(() => new Date());
  const [following, setFollowing] = useState(false);
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
  const applyingUrlRef = useRef(false);
  const historyIndexRef = useRef(0);
  const lastSerializedRouteRef = useRef(serializeAppRoute(bootRoute));
  const [theme, setTheme] = useState<MapTheme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore private-mode storage failures.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'sk';
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
  const focusedStations = useMemo(() => {
    if (!dataset || journeyStops.length === 0) {
      return [] as Array<Coordinate | null>;
    }
    return stationPoints(journeyStops, Object.values(dataset.stops));
  }, [dataset, journeyStops]);

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
            setTrains((current) => mergeTrainList(current, live));
            setStatusMessage(t.trainsCount(live.length));
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
        return;
      }
      setStatusKind('error');
      setStatusMessage(t.trainListUnavailable);
    };
    refresh();
    const interval = setInterval(refresh, 45_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [service, t, useLiveApi]);

  useEffect(() => {
    if (!focusedTrainNumber) {
      setJourneyStops([]);
      setJourneyStatus('idle');
      return;
    }
    const controller = new AbortController();
    setJourneyStops([]);
    setJourneyStatus('loading');
    fetch(`/proxy/detail?mode=detail&train=${encodeURIComponent(focusedTrainNumber)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = (await response.json()) as { stops?: JourneyStop[] };
        if (!controller.signal.aborted) {
          setJourneyStops(
            filterTimedJourneyStops(Array.isArray(body.stops) ? body.stops : [])
          );
          setJourneyStatus('ready');
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        if (!controller.signal.aborted) {
          setJourneyStops([]);
          setJourneyStatus('error');
        }
      });
    const interval = window.setInterval(() => {
      fetch(`/proxy/detail?mode=detail&train=${encodeURIComponent(focusedTrainNumber)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            return;
          }
          const body = (await response.json()) as { stops?: JourneyStop[] };
          if (!controller.signal.aborted && Array.isArray(body.stops) && body.stops.length > 0) {
            setJourneyStops(filterTimedJourneyStops(body.stops));
            setJourneyStatus('ready');
          }
        })
        .catch(() => undefined);
    }, following ? 20_000 : 45_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [focusedTrainNumber, following]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!focusedStation?.name) {
      setStationBoard([]);
      setStationBoardStatus('idle');
      return;
    }
    const controller = new AbortController();
    setStationBoardStatus('loading');
    fetchStationBoard(focusedStation.name, stationTab === 'arrivals', controller.signal)
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
    return () => controller.abort();
  }, [focusedStation, stationTab]);

  const handleCanvasStateChange = useCallback((state: 'loading' | 'loaded') => {
    setMapBooting(state === 'loading');
  }, []);
  const applyRoute = useCallback((route: AppRoute, leaving: boolean) => {
    setAboutOpen(route.about);
    setFocusedTrainNumber(route.train);
    setFocusedStation(route.station);
    setStationTab(route.tab);
    if (!route.train) {
      setFollowing(false);
    }
    if (leaving) {
      setDockLeaving(true);
    } else {
      setDockLeaving(false);
    }
  }, []);
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
        centerMapOn(point.lng, point.lat, 11);
      }
    },
    [centerMapOn, cursor, currentStopIndex, dataset, focusedStations, focusedTrain, journeyStops]
  );
  const centerOnTrainPosition = useCallback(() => {
    if (!focusedTrain) {
      return;
    }
    const live = cursor?.position ?? focusedTrain.position;
    if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
      centerMapOn(live.lng, live.lat, 11);
    }
  }, [centerMapOn, cursor, focusedTrain]);
  const handleTrainClick = useCallback(
    (trainNumber: string) => {
      setAboutOpen(false);
      setFocusedStation(null);
      setFocusedTrainNumber(trainNumber || null);
      setDockLeaving(false);
      const train = trains.find((item) => item.trainNumber === trainNumber);
      const position = train?.position;
      if (position) {
        centerMapOn(position.lng, position.lat, 10);
      }
    },
    [centerMapOn, trains]
  );
  const handleStationClick = useCallback(
    (station: FocusedStation) => {
      setAboutOpen(false);
      setFocusedTrainNumber(null);
      setFollowing(false);
      setStationTab('departures');
      setFocusedStation(station);
      setDockLeaving(false);
      centerMapOn(station.lng, station.lat, 11);
    },
    [centerMapOn]
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
    setAboutOpen(true);
  }, [aboutOpen, handleAboutBack]);

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
  const panelOpen = Boolean(focusedTrain || focusedStation || aboutOpen);
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
  const displayAbout =
    aboutOpen || Boolean(leaveSnap?.about && !leaveSnap.train && !leaveSnap.station);
  const displayTrain = displayAbout ? null : focusedTrain ?? leaveSnap?.train ?? null;
  const displayStation =
    displayAbout || displayTrain != null
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
  const showDock = Boolean(displayTrain || displayStation || displayAbout);
  const bootLocked = mapBooting || statusKind === 'loading';

  useEffect(() => {
    setMobileDockExpanded(false);
  }, [focusedTrainNumber, focusedStation?.id, aboutOpen]);

  const mobileSheetEnabled = isMobile && showDock && !displayAbout;
  const mobileSheet = useMobileDockSheet(
    mobileSheetEnabled,
    mobileDockExpanded,
    setMobileDockExpanded
  );

  const accent =
    displayTrain?.color || getDelayColor(displayTrain?.delayMinutes ?? focusedTrain?.delayMinutes ?? 0);
  const nextStopIndex = journeyNextIndex(
    displayStops,
    displayTrain,
    cursor?.stopIndex ?? null
  );
  const approachingStopName =
    nextStopIndex >= 0 && displayStops[nextStopIndex]
      ? displayStops[nextStopIndex].name
      : displayTrain?.nextStation ?? displayTrain?.currentStation ?? '—';
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
  const liveSegmentRowIndex = useMemo(() => {
    if (!displayTrain || !cursor || displayStops.length < 2) {
      return -1;
    }
    const from = cursor.stopIndex;
    if (from < 0 || from >= displayStops.length - 1) {
      return -1;
    }
    return from + 1;
  }, [cursor, displayStops.length, displayTrain]);
  const stopsHaveDelay = displayStops.some((stop) => stopTimesView(stop).actual != null);
  const properTrainName = isProperTrainName(displayTrain?.trainName)
    ? displayTrain?.trainName?.trim() ?? ''
    : '';
  const routeEnds =
    displayJourneyStatus === 'ready' && displayStops.length >= 2
      ? { from: displayStops[0].name, to: displayStops[displayStops.length - 1].name }
      : parseSummaryRoute(displayTrain?.summary || displayTrain?.trainName);
  const clockLabel = clock.toLocaleTimeString('sk-SK', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
        return leftLabel.localeCompare(rightLabel, 'sk');
      })
      .slice(0, 8);
  }, [dataset, searchQuery, trains]);

  return (
    <div
      className={`shell ${panelOpen ? 'is-panel-open' : ''} ${bootLocked ? 'shell--booting' : ''}`}
      data-theme={theme}
    >
      <div className="shell__map">
        <MapScene
          trains={trains}
          focusedStations={focusedStations}
          journeyStops={journeyStops}
          journeyStatus={journeyStatus}
          following={following}
          onFollowBreak={() => setFollowing(false)}
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
            <img src={theme === 'light' ? logoMarkLight : logoMarkDark} alt="" width={17} height={20} />
            <span>railatlas</span>
          </button>
          <small className="chrome__brand-meta">
            {loading ? t.loadingTrains : t.trainsCount(trains.length)}
            {' · '}
            {clockLabel}
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
          className={`chrome__search${searchOpen && searchHits.length > 0 ? ' is-open' : ''}${
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
          {searchMobileOpen && !searchQuery.trim() && (
            <p className="chrome__search-mobile-hint">{t.searchMobileHint}</p>
          )}
          {searchMobileOpen && Boolean(searchQuery.trim()) && searchHits.length === 0 && (
            <p className="chrome__search-empty">{t.searchNoResults}</p>
          )}
          {searchOpen && searchHits.length > 0 && (
            <ul className="chrome__hits">
              {searchHits.map((hit) => (
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
                        handleTrainClick(hit.train.trainNumber);
                      } else {
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
                          ? `${hit.train.trainType ? `${hit.train.trainType} ` : ''}${hit.train.trainNumber}`
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
            className="chrome__tool"
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
          <button
            type="button"
            className="chrome__tool chrome__theme"
            aria-label={theme === 'dark' ? t.themeToLight : t.themeToDark}
            title={theme === 'dark' ? t.themeLight : t.themeDark}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M3.1 12.9l1.1-1.1M11.8 4.2l1.1-1.1"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M13.2 9.3A5.4 5.4 0 1 1 6.7 2.8 4.3 4.3 0 0 0 13.2 9.3Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="chrome__tool chrome__tool--lang"
            aria-label={t.langSwitchAria}
            title={t.langSwitchAria}
            onClick={() => setLocale((current) => (current === 'sk' ? 'en' : 'sk'))}
          >
            <span aria-hidden="true">{t.langSwitchTo}</span>
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
        </div>
      </header>
      {statusKind === 'error' && !panelOpen && (
        <p className="shell__toast">{statusMessage}</p>
      )}
      {showDock && (
      <aside
        ref={mobileSheet.dockRef}
        className={`dock ${dockLeaving ? 'is-leave' : 'is-enter'}${
          mobileSheetEnabled
            ? mobileDockExpanded
              ? ' dock--expanded'
              : ' dock--collapsed'
            : ''
        }${mobileSheetEnabled ? ' dock--mobile-interactive' : ''}${
          mobileSheet.dragging ? ' dock--dragging' : ''
        }${displayAbout ? ' dock--about' : ''}`}
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
            className={`dock__body${
              isMobile ? ' dock__body--sheet-touch' : ''
            }${isMobile && !mobileDockExpanded ? ' dock__body--sheet-collapsed' : ''}`}
            {...(isMobile ? mobileSheet.gesture : {})}
          >
            {isMobile && (
              <>
                <DockSheetHandle
                  expanded={mobileDockExpanded}
                  expandLabel={t.dockExpandSheet}
                />
                <button
                  type="button"
                  className="dock__peek"
                  aria-expanded={mobileDockExpanded}
                  onClick={() => {
                    if (mobileSheet.consumePeekClick()) {
                      return;
                    }
                    setMobileDockExpanded(true);
                  }}
                >
                  <span className="dock__peek-identity">
                    <span className="dock__pill">{`${displayTrain.trainType ? `${displayTrain.trainType} ` : ''}${displayTrain.trainNumber}`}</span>
                    <span className={`dock__name${properTrainName ? '' : ' is-route'}`}>
                      {properTrainName ||
                        (routeEnds ? (
                          <>
                            {routeEnds.from}
                            <span className="dock__name-arrow" aria-hidden="true">
                              →
                            </span>
                            {routeEnds.to}
                          </>
                        ) : (
                          t.train
                        ))}
                    </span>
                  </span>
                  <span className="dock__peek-meta">
                    <span>{displayDelayText}</span>
                    <span>
                      {t.approachingStation}: <strong>{approachingStopName}</strong>
                    </span>
                  </span>
                </button>
              </>
            )}
            <div
              className={`dock__sheet-main${
                mobileSheet.listSheetGrab ? ' dock__sheet-main--list-grab' : ''
              }`}
            >
              {!isMobile && (
                <DockPanelControls
                  backLabel={t.back}
                  closeLabel={t.dockCloseAria}
                  onBack={handleDockBack}
                  onClose={handleClearFocus}
                />
              )}
              {!isMobile && (
                <div className="dock__head">
                  <p className="dock__identity">
                    <span className="dock__pill">{`${displayTrain.trainType ? `${displayTrain.trainType} ` : ''}${displayTrain.trainNumber}`}</span>
                    <span className={`dock__name${properTrainName ? '' : ' is-route'}`}>
                      {properTrainName ||
                        (routeEnds ? (
                          <>
                            {routeEnds.from}
                            <span className="dock__name-arrow" aria-hidden="true">
                              →
                            </span>
                            {routeEnds.to}
                          </>
                        ) : (
                          t.train
                        ))}
                    </span>
                  </p>
                  <div className="dock__meta">
                    <p className="dock__delay">{displayDelayText}</p>
                  </div>
                </div>
              )}
              {displayTrain.note && <p className="dock__note">{displayTrain.note}</p>}
              <DockScroller
              loading={displayJourneyStatus === 'loading' || displayJourneyStatus === 'idle'}
              error={displayJourneyStatus === 'error' ? t.stationListUnavailable : null}
              label={t.loadingStations}
              contentKey={displayTrain.trainNumber}
              listSheetGrab={mobileSheet.listSheetGrab}
            >
              <ol className={`dock__stops${stopsHaveDelay ? ' has-delay' : ''}`}>
                {displayStops.map((stop, index) => {
                  const isTrailStop = trailheadIndex >= 0 && index >= trailheadIndex;
                  const isPassedStop = trailheadIndex >= 0 && index < trailheadIndex;
                  const isUpcomingLeg =
                    liveSegmentRowIndex >= 0 && index > liveSegmentRowIndex;
                  const isLiveSegment = index === liveSegmentRowIndex;
                  const { planned, actual, delayMinutes } = stopTimesView(stop);
                  const delayColor = delayMinutes > 0 ? getDelayColor(delayMinutes) : null;
                  const onTimeRail = 'var(--dock-rail-on-time)';
                  const trackColor = isUpcomingLeg
                    ? null
                    : dockStopRailColor(delayColor, onTimeRail);
                  const segmentColor = isUpcomingLeg ? null : trackColor;
                  const tickColor = isTrailStop ? trackColor : isPassedStop ? trackColor : null;
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
                  const stopInteractive = Boolean(stationMatch || point);
                  return (
                    <li
                      key={`${stop.name}-${index}`}
                      className={[
                        isTrailStop ? 'is-trail' : 'is-ahead',
                        isUpcomingLeg ? 'is-upcoming-leg' : '',
                        isLiveSegment ? 'is-live-segment' : '',
                        stopInteractive ? 'is-interactive' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={
                        {
                          ...(tickColor ? { '--stop-delay': tickColor } : {}),
                          ...(segmentColor ? { '--segment': segmentColor } : {}),
                        } as React.CSSProperties
                      }
                    >
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
                {displayTrain.currentStation && (
                  <div>
                    <dt>{t.lastPosition}</dt>
                    <dd>
                      {focusedTrain ? (
                        <button
                          type="button"
                          className="dock__fact-link"
                          onClick={centerOnTrainPosition}
                        >
                          {displayTrain.currentStation}
                        </button>
                      ) : (
                        displayTrain.currentStation
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        ) : displayStation ? (
          <div
            className={`dock__body${
              isMobile ? ' dock__body--sheet-touch' : ''
            }${isMobile && !mobileDockExpanded ? ' dock__body--sheet-collapsed' : ''}`}
            {...(isMobile ? mobileSheet.gesture : {})}
          >
            {isMobile && (
              <>
                <DockSheetHandle
                  expanded={mobileDockExpanded}
                  expandLabel={t.dockExpandSheet}
                />
                <button
                  type="button"
                  className="dock__peek"
                  aria-expanded={mobileDockExpanded}
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
            <div
              className={`dock__sheet-main${
                mobileSheet.listSheetGrab ? ' dock__sheet-main--list-grab' : ''
              }`}
            >
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
              listSheetGrab={mobileSheet.listSheetGrab}
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
                            {row.code || t.train}
                          </span>
                          <span className="dock__board-dest">
                            <span className="dock__name-arrow" aria-hidden="true">
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
              href={`https://cp.sk/vlakbusmhd/odchody/?f=${encodeURIComponent(displayStation.name)}&submit=true&changeShield=true${
                displayStationTab === 'arrivals' ? '&byarr=true' : ''
              }`}
              target="_blank"
              rel="noreferrer"
            >
              {t.openOnCpSk}
            </a>
            </div>
          </div>
        ) : displayAbout ? (
          <AboutPanel onBack={handleAboutBack} copy={t} locale={locale} />
        ) : null}
      </aside>
      )}
    </div>
  );
};

export default App;

