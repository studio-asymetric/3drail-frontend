# 3D Slovak Rail Map Plan

## Purpose
Build a frontend-only interactive map that mirrors the `mapa.zsr.sk` experience in 3D by merging official GTFS route shapes with live roster and delay information from the unofficial Slovakrail API. The goal is to keep the UI entirely in the browser while still incorporating accurate scheduled paths, real-time train states, and delay overlays.

## Data Sources

- **Official GTFS dataset** (ŽSR / Slovensko data portal):
  - Primary endpoint: `https://data.slovensko.sk/datasety/ca4cb74c-7192-4198-b074-34acd9d295e7`
  - Key files:
    - `shapes.txt` – ordered GPS points defining every route `shape_id`.
    - `trips.txt` – ties `route_id`, `shape_id`, and `trip_headsign` to each AD number.
    - `stop_times.txt` – arrival/departure timestamps per stop that allow interpolation.
    - `stops.txt` – station metadata with lat/lng, UIC codes, and names.
  - License: CC-BY 4.0 (reuseable once credited).

- **Unofficial Slovakrail API** (used by `IdemeVlakom`):
  - Base URL: `https://app.slovakrail.sk/api/v1`
  - Authentication: shared API key (e.g., `x-api-key: PDh^2-$-M]8(dG8E+Q,FR}zsfz"Q~:N2pp\ykmg9ZEgKVrh42PHS?^sQ6<3;X,?-`).
  - Endpoints of interest:
    - `/station/{stationName}/roster` – lists active trains with `train.number`, `delay`, and `timestamp`.
    - `/train/delay` (batch POST) – returns precise `currentUic`, `delayMinutes`, `nextStation` for a list of train numbers.
    - `/route` and `/station/name/{prefix}` – optional for enrichment such as route planning or station hints.
  - Usage pattern: poll every 20–30 seconds from the frontend; respect unknown rate limits by limiting station coverage (major hubs).

## Frontend Flow

1. **Static GTFS load** (one-time per session):
   - Download GTFS zip ahead of time (or host pre-parsed artifacts).
   - Parse `shapes.txt` into an object keyed by `shape_id` with coordinate arrays.
   - Build `trip` lookup table to map `trainNumber` → `shape_id` and stop sequences.

2. **Realtime polling**:
   - Fetch rosters for a curated list of stations (`Bratislava`, `Žilina`, `Košice`, `Prievidza`, etc.).
   - Batch POST to `/train/delay` to obtain delay offsets and last reported station.
   - Merge delay data with GTFS shapes to calculate current progress along the spline.

3. **3D rendering pipeline**:
   - Use React Three Fiber + Three.js to render:
     - Heightmap terrain mesh (placeholder materials for valleys/ridges).
     - Station platforms and tracks (avoid overlapping tracks by offsetting parallel lines).
     - Train meshes that follow spline paths derived from GTFS shapes.
     - Delay visuals: color trains red/orange/yellow based on severity, floating labels at key stations.
   - Camera controls: allow orbit/pan/zoom around train paths, auto-follow selected service, and snap to city-level overview.

4. **Optimization & UX**:
   - Only render trains inside the camera frustum or within N km of view.
   - Cache parsed GTFS data in IndexedDB or `localStorage` for future visits.
   - Expose toggle to highlight delayed services and layer schedule vs. live track paths.

## Constraints and Assumptions

- All data must be fetched live from the browser; no intermediate backend, mirroring the user's request.
- Terrain/heightmap assets can be loaded from third-party sources (e.g., Mapbox terrain tiles) or simplified using procedural noise until a proper mesh is available.
- GTFS shapes and stop sequences are sufficient to infer the train path once we know the shape_id and current progress derived from delays.
- Delay interpolation assumes linear progression between reported stops unless more precise telemetry is provided.

## Testing Strategy

- Validate `gtfsParser` outputs with synthetic GTFS records to ensure shapes and trips align.
- Mock API responses in `trainService` tests to check that delay interpolation correctly adjusts positions and statuses.
- Snapshot the calculated route geometry to make sure it remains stable when adding new GTFS samples.

## Next Steps

1. Implement `gtfsParser` and `trainService` modules that return `TrainRoute` and `TrainState` objects ready for the renderer.
2. Build the React + Three Fiber scene (`MapScene`, `MapControls`, `TrainIndicators`) that visualizes tracks and trains.
3. Add unit tests for parsing and interpolation utilities (`trainService.test.ts`).
## Purpose

Document how the Slovak rail data plan supports a frontend-only 3D map that mirrors mapa.zsr.sk.
The goal is to remain serverless: static assets load once, realtime feeds come directly from public APIs, and the renderer glues GTFS shapes with live delays.

## Data Sources

- **GTFS dataset (stable):** `https://data.slovensko.sk/datasets/ca4cb74c-7192-4198-b074-34acd9d295e7`
  - `shapes.txt` provides ordered latitude/longitude sequences for each route (`shape_id`).
  - `trips.txt` ties a train/route combination to `shape_id` and service IDs.
  - `stops.txt` and `stop_times.txt` keep station coordinates plus scheduled arrival/departure times.
  - Download once, cache in the browser (IndexedDB/localStorage) or bundle as JSON assets.

- **Slovakrail realtime API (unofficial but supplied by cp.sk/ZSSK app):**
  - Base: `https://app.slovakrail.sk/api/v1` with shared header `x-api-key: PDh^2-$-M]8(dG8E+Q,FR}zsfz"Q~:N2pp\ykmg9ZEgKVrh42PHS?^sQ6<3;X,-`.
  - `/station/{stationName}/roster?departure=true`: current trains passing through a station.
  - `/train/delay`: POST with `[{"trainNumber","travelDate"}]` returns delay, `currentUic`, `nextStation`, `timestamp`.
  - `/station/name/{prefix}?maxCount=100`: search stations with GPS and UIC codes useful for interpolation.
  - Poll conservatively (~30s) to respect API limits.

## Data Flow

1. **Initialization**
   - Fetch GTFS once and build lookup tables: `shape_id` → `routePoints`, `trainNumber` → `shape_id`.
   - Pre-generate spline interpolators retaining time metadata for each route segment.
2. **Realtime Updates**
   - Poll selected hubs (e.g., Bratislava, Košice, Žilina) for `roster` data every 20–60 seconds.
   - Batch train numbers to `/train/delay` to get precise delay/correction info.
   - Combine delay data with the associated route metadata to compute progress along the spline.
3. **Rendering**
   - Interpolate train positions from GTFS shape points using scheduled time + delay / actual timestamp.
   - Animate the icon along the curve in Three.js.
   - Color/label trains with `delayMinutes`, highlight late vs early/ontime.

## Frontend Architecture

- **Data services (`src/data/`)**
  - `gtfsParser.ts`: handles reading raw CSV, deduping, caching per `shape_id`, exposing helper `getSpline(shapeId)`.
  - `trainService.ts`: abstracts API fetch, batching, naive rate-limiting, and exposes typed updates for `TrainUpdate`.

- **3D Renderer (`src/components/MapScene.tsx`)**
  - React Three Fiber scene with a ground plane textured with a heightmap (processed from public terrain data).
  - Route splines drawn with `Line`/`Tube` to show tracks; trains represented with small meshes that follow the spline.
  - Station footprints automatically derived from `shape_id` data & additional spacing heuristics so tracks do not overlap visually.
  - Camera controls (orbit/flight) plus UI overlays for delays.

- **App container (`src/App.tsx`)**
  - Loads GTFS via `useEffect`, exposes context for `DataService`.
  - Synchronizes polls + caching status for fallback when API is unavailable.
  - Provides controls (time scrub, delay filter, station search).

## Performance & Optimizations

- Cache GTFS JSON in `localStorage` or `IndexedDB` to avoid repeated downloads; consider `service worker` for offline ability.
- Deduplicate route rendering by grouping shoots by `shape_id`.
- Use GSAP or `react-spring` for smooth train interpolation.
- Limit map updates (train animations) by throttling `requestAnimationFrame` to 30 fps when the tab is inactive.

## Testing Strategy

- Tests under `src/tests/trainService.test.ts` simulate:
  - GTFS parser correctly associates `trainNumber` with the right `shape_id` and returns ordered coordinates.
  - Delay interpolation adjusts the progress marker proportionately when `delayMinutes` increases/decreases.
  - Batching logic properly formats `/train/delay` payloads and handles API `retry-after`.

## Next Steps

1. Convert this plan into working modules/imports.
2. Keep the UI modular so future additions (e.g., terrain overlays, station filters) slot in with minimal rework.

