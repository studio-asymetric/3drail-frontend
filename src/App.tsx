import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapScene } from './components/MapScene';
import {
  TrainService,
  type JourneyStop,
  type TrainRenderState,
  getDelayColor,
  routeCursor,
  stationPoints,
} from './data/trainService';
import type { Coordinate, GtfsDataset } from './data/gtfsParser';
import { buildGtfsDataset } from './data/gtfsParser';

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
  const [trainSearch, setTrainSearch] = useState('');
  
  const service = useMemo(() => {
    if (!dataset) return null;
    return new TrainService(dataset);
  }, [dataset]);
  const [statusMessage, setStatusMessage] = useState('Loading GTFS data...');
  const [statusKind, setStatusKind] = useState<'loading' | 'success' | 'error'>(
    'loading'
  );
  const [journeyStops, setJourneyStops] = useState<JourneyStop[]>([]);
  const [journeyStatus, setJourneyStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [clock, setClock] = useState(() => new Date());

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
  const focusedStations = useMemo(() => {
    if (!dataset || journeyStops.length === 0) {
      return [] as Array<Coordinate | null>;
    }
    return stationPoints(journeyStops, Object.values(dataset.stops));
  }, [dataset, journeyStops]);

  const cursor = useMemo(() => {
    if (!focusedTrain) {
      return null;
    }
    return routeCursor(focusedStations, journeyStops, clock);
  }, [focusedTrain, focusedStations, journeyStops, clock]);

  const focusedPositionRef = useRef(cursor?.position ?? null);
  focusedPositionRef.current = cursor?.position ?? null;

  const shownTrains = useMemo(() => {
    if (!focusedTrainNumber) {
      return trains;
    }
    const straight = focusedStations.filter((point): point is NonNullable<typeof point> => point != null);
    if (straight.length < 2) {
      return trains;
    }
    return trains.map((train) =>
      train.trainNumber === focusedTrainNumber ? { ...train, shapePath: straight } : train
    );
  }, [trains, focusedStations, focusedTrainNumber]);

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

  // Fetch live trains once dataset is loaded. A failed refresh keeps the last good list.
  useEffect(() => {
    if (!service || !dataset) return;
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
            setTrains(live);
            setStatusMessage(`${live.length} trains`);
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
      setStatusMessage('Train list unavailable');
    };
    refresh();
    const interval = setInterval(refresh, 45_000);
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
    const interval = window.setInterval(() => {
      fetch(`/proxy?mode=detail&train=${encodeURIComponent(focusedTrainNumber)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            return;
          }
          const body = (await response.json()) as { stops?: JourneyStop[] };
          if (!controller.signal.aborted && Array.isArray(body.stops) && body.stops.length > 0) {
            setJourneyStops(body.stops);
            setJourneyStatus('ready');
          }
        })
        .catch(() => undefined);
    }, 20_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [focusedTrainNumber]);

  useEffect(() => {
    if (!focusedTrainNumber) {
      return;
    }
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [focusedTrainNumber]);

  const handleCanvasStateChange = useCallback((_state: 'loading' | 'loaded') => {}, []);
  const handleTrainClick = useCallback((trainNumber: string) => {
    setFocusedTrainNumber(trainNumber || null);
  }, []);
  const handleOsmStatusChange = useCallback((status: { tilesLoaded: number }) => {
    setOsmTilesLoaded(status.tilesLoaded);
  }, []);
  const handleToggleLiveApi = useCallback((enabled: boolean) => {
    setUseLiveApi(enabled);
  }, []);

  return (
    <div className="shell">
      <div className="shell__map">
        <MapScene
          trains={shownTrains}
          focusedPositionRef={focusedPositionRef}
          focusedStations={focusedStations}
          journeyStops={journeyStops}
          focusedTrainNumber={focusedTrainNumber}
          onTrainClick={handleTrainClick}
          dataset={dataset}
          onOsmStatusChange={handleOsmStatusChange}
          useLiveApi={useLiveApi}
          onToggleLiveApi={handleToggleLiveApi}
          onCanvasStateChange={handleCanvasStateChange}
        />
      </div>
      <aside className="dock">
        <header className="dock__bar">
          <button type="button" className="dock__mark" onClick={() => setFocusedTrainNumber(null)}>
            railatlas
          </button>
          <p className={`dock__status is-${statusKind}`}>
            {loading ? 'Loading trains' : statusMessage}
            {osmTilesLoaded > 0 ? ` · ${osmTilesLoaded} tiles` : ''}
          </p>
        </header>
        {focusedTrain ? (
          <div className="dock__train">
            <button type="button" className="dock__back" onClick={() => setFocusedTrainNumber(null)}>
              All trains
            </button>
            <p className="dock__kicker">
              {focusedTrain.trainType ? `${focusedTrain.trainType} ` : ''}
              {focusedTrain.trainNumber}
            </p>
            <h1 className="dock__title">{focusedTrain.trainName || focusedTrain.summary || 'Train'}</h1>
            <p className="dock__delay">{selectedTrainDelayText}</p>
            <dl className="dock__facts">
              {focusedTrain.operator && (
                <>
                  <dt>Operator</dt>
                  <dd>{focusedTrain.operator}</dd>
                </>
              )}
              {focusedTrain.currentStation && (
                <>
                  <dt>Last report</dt>
                  <dd>{focusedTrain.currentStation}</dd>
                </>
              )}
              {focusedTrain.plannedTime && (
                <>
                  <dt>Scheduled</dt>
                  <dd>{focusedTrain.plannedTime}</dd>
                </>
              )}
            </dl>
            {focusedTrain.note && <p className="dock__note">{focusedTrain.note}</p>}
            <ol className="dock__stops">
              {journeyStatus === 'loading' && <li className="is-muted">Loading stations</li>}
              {journeyStatus === 'error' && <li className="is-muted">Station list unavailable</li>}
              {journeyStops.map((stop, index) => {
                const state =
                  cursor && journeyStatus === 'ready'
                    ? index < cursor.stopIndex
                      ? 'passed'
                      : index === cursor.stopIndex
                        ? 'current'
                        : 'ahead'
                    : stop.state;
                return (
                  <li key={`${stop.name}-${index}`} className={`is-${state}`}>
                    <span>{stop.name}</span>
                    <time>{stop.departure || stop.arrival || stop.scheduledDeparture || stop.scheduledArrival || '—'}</time>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <div className="dock__index">
            <input
              type="search"
              value={trainSearch}
              onChange={(event) => setTrainSearch(event.target.value)}
              className="dock__search"
              placeholder="Number or name"
              aria-label="Search trains"
            />
            <div className="dock__list">
              {filteredTrains.map((train, index) => (
                <button
                  key={train.trainNumber}
                  type="button"
                  className="dock__row"
                  onClick={() => setFocusedTrainNumber(train.trainNumber)}
                >
                  <span className="dock__index-no">{String(index + 1).padStart(2, '0')}</span>
                  <span className="dock__row-main">
                    <span className="dock__row-title">
                      {train.trainType ? `${train.trainType} ` : ''}
                      {train.trainNumber}
                      {train.trainName ? ` ${train.trainName}` : ''}
                    </span>
                    <span className="dock__row-sub">{train.summary || train.delayText || 'On time'}</span>
                  </span>
                  <span className="dock__row-delay" style={{ color: getDelayColor(train.delayMinutes) }}>
                    {train.delayMinutes > 0 ? `${train.delayMinutes} min` : 'On time'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
};

export default App;

