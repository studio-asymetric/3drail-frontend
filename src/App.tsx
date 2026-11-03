import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import Lenis from 'lenis/dist/lenis.mjs';
import { MapScene } from './components/MapScene';
import {
  TrainService,
  type JourneyStop,
  type TrainRenderState,
  getDelayColor,
} from './data/trainService';
import type { GtfsDataset } from './data/gtfsParser';
import { buildGtfsDataset } from './data/gtfsParser';
import logoLong from './logo long.svg';

function timeToMs(value: string): number {
  const [hours = '0', minutes = '0', seconds = '0'] = value.split(':');
  return (
    (parseInt(hours, 10) * 3600 +
      parseInt(minutes, 10) * 60 +
      parseInt(seconds, 10)) *
    1000
  );
}

const demoShape = [
  { lat: 48.1486, lng: 17.1077, sequence: 1 },
  { lat: 48.1635, lng: 17.1442, sequence: 2 },
  { lat: 48.2104, lng: 17.2481, sequence: 3 },
  { lat: 48.2451, lng: 17.3855, sequence: 4 },
  { lat: 48.3218, lng: 17.6403, sequence: 5 },
];

// Load GTFS data from public folder
async function loadGtfsDataset(): Promise<GtfsDataset> {
  try {
    const [shapesRes, tripsRes, stopsRes, stopTimesRes] = await Promise.all([
      fetch('/gtfs/shapes.txt'),
      fetch('/gtfs/trips.txt'),
      fetch('/gtfs/stops.txt'),
      fetch('/gtfs/stop_times.txt'),
    ]);

    const shapesCsv = await shapesRes.text();
    const tripsCsv = await tripsRes.text();
    const stopsCsv = await stopsRes.text();
    const stopTimesCsv = await stopTimesRes.text();

    return buildGtfsDataset({
      shapesCsv,
      tripsCsv,
      stopsCsv,
      stopTimesCsv,
    });
  } catch (error) {
    console.error('Failed to load GTFS data, using demo dataset:', error);
    // Fallback to demo dataset
    return {
      shapes: {
        demo: {
          shapeId: 'demo',
          points: demoShape,
        },
      },
      trips: {
        byTripId: {
          demoTrip: {
            tripId: 'demoTrip',
            shapeId: 'demo',
            trainNumber: 'R123',
            routeId: 'routeDemo',
            headsign: 'Košice',
          },
        },
        byTrainNumber: {
          R123: {
            tripId: 'demoTrip',
            shapeId: 'demo',
            trainNumber: 'R123',
            routeId: 'routeDemo',
            headsign: 'Košice',
          },
        },
      },
      stops: {
        bratislava: {
          stopId: 'bratislava',
          name: 'Bratislava hl.st.',
          lat: 48.1486,
          lng: 17.1077,
          code: '01',
          uicCode: '5392013',
        },
        kosice: {
          stopId: 'kosice',
          name: 'Košice',
          lat: 48.7164,
          lng: 21.255,
          code: '13',
          uicCode: '5250005',
        },
      },
      stopTimes: {
        demoTrip: [
          {
            tripId: 'demoTrip',
            stopId: 'bratislava',
            stopSequence: 1,
            arrivalTimeMs: timeToMs('08:00:00'),
            departureTimeMs: timeToMs('08:02:00'),
          },
          {
            tripId: 'demoTrip',
            stopId: 'kosice',
            stopSequence: 2,
            arrivalTimeMs: timeToMs('12:30:00'),
            departureTimeMs: timeToMs('12:35:00'),
          },
        ],
      },
};
  }
}

const fallbackTrains: TrainRenderState[] = [
  {
    trainNumber: 'R123',
    trainName: 'Bratislava – Košice',
    shapePath: demoShape,
    position: demoShape[2],
    progress: 0.5,
    delayMinutes: 5,
    color: '#f8a82a',
    nextStation: 'Košice',
    currentStation: 'Kremnica',
    reportedAt: Date.now(),
  },
];

const App: React.FC = () => {
  const [trains, setTrains] = useState<TrainRenderState[]>(fallbackTrains);
  const [loading, setLoading] = useState(true);
  const [dataset, setDataset] = useState<GtfsDataset | null>(null);
  const [focusedTrainNumber, setFocusedTrainNumber] = useState<string | null>(null);
  const [useLiveApi, setUseLiveApi] = useState(true);
  const [osmTilesLoaded, setOsmTilesLoaded] = useState(0);
  const [selectorVisible, setSelectorVisible] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth > 768 : true)
  );
  const [trainSearch, setTrainSearch] = useState('');
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const listWrapperRef = useRef<HTMLDivElement | null>(null);
  const lenisRef = useRef<Lenis | null>(null);
  
  const service = useMemo(() => {
    if (!dataset) return null;
    return new TrainService(dataset);
  }, [dataset]);
  const [statusMessage, setStatusMessage] = useState('Loading GTFS data...');
  const [statusKind, setStatusKind] = useState<'loading' | 'success' | 'error'>(
    'loading'
  );
  const [canvasLoadingState, setCanvasLoadingState] = useState<'loading' | 'loaded'>('loading');
  const [journeyStops, setJourneyStops] = useState<JourneyStop[]>([]);
  const [journeyStatus, setJourneyStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // Load GTFS data on mount
  useEffect(() => {
    setStatusMessage('Loading GTFS data from public/gtfs...');
    loadGtfsDataset()
      .then((data) => {
        const shapeCount = Object.keys(data.shapes).length;
        const tripCount = Object.keys(data.trips.byTripId).length;
        const stopCount = Object.keys(data.stops).length;
        setDataset(data);
        setStatusMessage(`✓ GTFS loaded: ${shapeCount} shapes, ${tripCount} trips, ${stopCount} stops`);
        console.log(`✓ GTFS Dataset loaded:`, { shapeCount, tripCount, stopCount });
      })
      .catch((error) => {
        console.error('Failed to load GTFS:', error);
        setStatusMessage('⚠ GTFS load failed, using demo data');
      });
  }, []);
  const statusIndicatorColor =
    statusKind === 'success'
      ? '#22c55e'
      : statusKind === 'error'
      ? '#dc2626'
      : '#fbbf24';
  const selectorToggleLabel = selectorVisible ? 'Hide train selector' : 'Select train from list';
  const filteredTrains = useMemo(() => {
    const query = trainSearch.trim().toLowerCase();
    if (!query) {
      return trains;
    }
    return trains.filter((train) => {
      const haystack = `${train.trainType ?? ''} ${train.trainNumber} ${train.trainName ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [trains, trainSearch]);

  const focusedTrain = useMemo(
    () => trains.find((train) => train.trainNumber === focusedTrainNumber) ?? null,
    [trains, focusedTrainNumber]
  );
  const selectedTrainDelayText = useMemo(() => {
    if (!focusedTrain) {
      return '';
    }
    if (focusedTrain.delayText) {
      return focusedTrain.delayText;
    }
    return focusedTrain.delayMinutes > 0
      ? `${focusedTrain.delayMinutes} min delay`
      : 'On time';
  }, [focusedTrain]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!listWrapperRef.current) {
      return;
    }
    if (lenisRef.current) {
      lenisRef.current.destroy();
      lenisRef.current = null;
    }
    if (isMobile) {
      return;
    }
    const content = listWrapperRef.current.querySelector(
      '.train-selector-panel__list'
    ) as HTMLElement | null;
    if (!content) {
      return;
    }
    const lenis = new Lenis({
      duration: 1,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      wrapper: listWrapperRef.current,
      content,
      smoothWheel: true,
      smoothTouch: true,
    });
    lenisRef.current = lenis;
    let animationId: number;
    const raf = (time: number) => {
      lenis.raf(time);
      animationId = requestAnimationFrame(raf);
    };
    animationId = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(animationId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [selectorVisible, trains, isMobile]);

  // Fetch live trains once dataset is loaded
  useEffect(() => {
    if (!service || !dataset) return;
    service.setFetchConfig({ useLiveApi, useProxy: useLiveApi, proxyUrl: '/proxy' });

    let mounted = true;
    const refresh = async () => {
      try {
        setStatusKind('loading');
        setStatusMessage('🔄 Fetching live trains from mapa.zsr.sk...');
        const live = await service.fetchLiveTrains();
        if (mounted && live.length > 0) {
          setTrains(live);
          setStatusMessage(`${live.length} trains loaded from mapa.zsr.sk`);
          setStatusKind('success');
          console.log(`✓ Successfully loaded ${live.length} trains from live API:`, live.slice(0, 5).map(t => `${t.trainNumber} ${t.trainName || ''}`));
        } else if (mounted) {
          setStatusMessage(
            `⚠ No trains returned (${live.length}) - check console for details`
          );
          setStatusKind('error');
        }
      } catch (error) {
        console.warn('Realtime train fetch failed', error);
        setStatusKind('error');
        setStatusMessage('Realtime train fetch failed (see console)');
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [service, dataset, useLiveApi]);

  useEffect(() => {
    if (!focusedTrainNumber) {
      setJourneyStops([]);
      setJourneyStatus('idle');
      return;
    }
    const controller = new AbortController();
    setJourneyStatus('loading');
    fetch(`/proxy?mode=detail&train=${encodeURIComponent(focusedTrainNumber)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = (await response.json()) as { stops?: JourneyStop[] };
        if (!controller.signal.aborted) {
          setJourneyStops(Array.isArray(body.stops) ? body.stops : []);
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
    return () => controller.abort();
  }, [focusedTrainNumber]);

  const handleCanvasStateChange = useCallback(
    (state: 'loading' | 'loaded') => {
      setCanvasLoadingState(state);
    },
    []
  );

  return (
    <div className={`app-shell ${canvasLoadingState}`}>
      <header className="app-header">
        <div className="app-header__logo-wrap">
          <img src={logoLong} alt="Railatlas" className="logo-mark" />
        </div>
        <div className="header-right">
          <a href="#" className="header-info header-info--link">
            Rail vectors: {osmTilesLoaded} tiles
          </a>
          <div className={`status-indicator status-${statusKind}`}>
          <span className="status-indicator__dot" />
          <span>{statusMessage}</span>
        </div>
          <button
            className="selector-toggle-pill"
            onClick={() => setSelectorVisible((prev) => !prev)}
          >
            {selectorToggleLabel}
          </button>
        </div>
      </header>
      {loading && (
        <div className="app-loading">
          Loading trains... ({trains.length} loaded)
        </div>
      )}
      {focusedTrain && (
        <aside className="journey-card">
          <div className="journey-card__kicker">
            {focusedTrain.trainType ? `${focusedTrain.trainType} ` : ''}
            {focusedTrain.trainNumber}
          </div>
          <h2 className="journey-card__title">
            {focusedTrain.trainName || focusedTrain.summary || 'Train'}
          </h2>
          {focusedTrain.summary && (
            <p className="journey-card__summary">{focusedTrain.summary}</p>
          )}
          <p className="journey-card__delay" style={{ color: focusedTrain.color }}>
            {selectedTrainDelayText}
          </p>
          <dl className="journey-card__facts">
            {focusedTrain.currentStation && (
              <>
                <dt>Last report</dt>
                <dd>{focusedTrain.currentStation}</dd>
              </>
            )}
            {focusedTrain.actualTime && (
              <>
                <dt>Actual</dt>
                <dd>{focusedTrain.actualTime}</dd>
              </>
            )}
            {focusedTrain.plannedTime && (
              <>
                <dt>Scheduled</dt>
                <dd>{focusedTrain.plannedTime}</dd>
              </>
            )}
            {focusedTrain.operator && (
              <>
                <dt>Operator</dt>
                <dd>{focusedTrain.operator}</dd>
              </>
            )}
          </dl>
          {focusedTrain.replacementFrom && focusedTrain.replacementTo && (
            <p className="journey-card__note">
              Replacement bus {focusedTrain.replacementFrom} – {focusedTrain.replacementTo}
            </p>
          )}
          {focusedTrain.note && <p className="journey-card__note">{focusedTrain.note}</p>}
          <div className="journey-card__legend">
            <span><i style={{ background: '#12A5F4' }} /> already run</span>
            <span><i style={{ background: '#22c55e' }} /> still ahead</span>
          </div>
          <ol className="journey-card__stops">
            {journeyStatus === 'loading' && <li className="is-muted">Loading the station list…</li>}
            {journeyStatus === 'error' && (
              <li className="is-muted">The station list is not available right now.</li>
            )}
            {journeyStops.map((stop, index) => (
              <li key={`${stop.name}-${index}`} className={`is-${stop.state}`}>
                <span className="journey-card__stop-name">{stop.name}</span>
                <span className="journey-card__stop-time">
                  {stop.arrival || stop.departure || '—'}
                  {(stop.scheduledArrival || stop.scheduledDeparture) && (
                    <small>
                      {' '}
                      ({stop.scheduledArrival || '—'}
                      {stop.scheduledDeparture && stop.scheduledDeparture !== stop.scheduledArrival
                        ? `–${stop.scheduledDeparture}`
                        : ''}
                      )
                    </small>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      )}
      <div className="app-body">
        <div
          className={`train-selector-panel ${
            selectorVisible ? 'train-selector-panel--visible' : 'train-selector-panel--hidden'
          } ${isMobile ? 'train-selector-panel--mobile' : ''}`}
        >
          <div className="train-selector-panel__handle" />
          <div className="train-selector-panel__inner">
            <label className="train-selector-panel__label">Select Train to Focus:</label>
            <input
              type="search"
              value={trainSearch}
              onChange={(event) => setTrainSearch(event.target.value)}
              className="train-selector-panel__search"
              placeholder="Search type, number, name…"
            />
            <div className="train-selector-panel__list" ref={listWrapperRef}>
              {filteredTrains.map((train) => {
                const isActive = focusedTrainNumber === train.trainNumber;
                const delayText =
                  train.delayMinutes > 0
                    ? `${train.delayMinutes} min delay`
                    : 'On time';
                return (
                  <button
                    key={train.trainNumber}
                    className={`train-selector-panel__train ${isActive ? 'is-active' : ''}`}
                    onClick={() => {
                      setFocusedTrainNumber(train.trainNumber);
                      if (isMobile) {
                        setSelectorVisible(false);
                      }
                    }}
                  >
                    <span
                      className="train-selector-panel__dot"
                      style={{ background: getDelayColor(train.delayMinutes) }}
                    />
                    <div>
                      <div className="train-selector-panel__title">
                        {train.trainType ? `${train.trainType} ` : ''}
                        {train.trainNumber}
                        {train.trainName ? ` - ${train.trainName}` : ''}
                      </div>
                      <div className="train-selector-panel__delay">
                        {train.delayText || delayText}
                        {train.summary ? ` · ${train.summary}` : ''}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <MapScene
          trains={trains}
          focusedTrainNumber={focusedTrainNumber}
          onTrainClick={(trainNumber) => setFocusedTrainNumber(trainNumber || null)}
          dataset={dataset}
          onOsmStatusChange={(status) => setOsmTilesLoaded(status.tilesLoaded)}
          useLiveApi={useLiveApi}
          onToggleLiveApi={(enabled) => setUseLiveApi(enabled)}
          onCanvasStateChange={handleCanvasStateChange}
        />
      </div>
    </div>
  );
};

export default App;

