import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Map as MapLibreMap,
  Marker,
  setWorkerCount,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import maplibreWorkerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Coordinate, GtfsDataset } from '../data/gtfsParser';
import {
  contrastInk,
  getDelayColor,
  motionPathToward,
  placeOnPath,
  routeLegPath,
  snapToPath,
  trainTypeCallout,
  type JourneyStop,
  type RouteCursor,
  type TrainRenderState,
} from '../data/trainService';
import {
  headingFromPoints,
  resolveTrainHeading,
  stadiumEdgePoint,
  TRAIN_ARROW_INSET_PX,
} from '../data/trainPill';
import {
  motionDurationMs,
  positionAlongPath,
  readPrefersReducedMotion,
  TRAIN_MOVE_MIN_METERS,
} from '../data/trainMotion';
import {
  fetchSimplifiedNetwork,
  isPathfindingWay,
  type OSMWay,
  type OsmProxyMeta,
} from '../data/osmRailService';
import {
  extendOsmGraph,
  haversineDistance,
  resetSpatialIndex,
  type OsmGraph,
  type OsmPathResult,
} from '../data/trainOsmMapper';
import { closeRailGaps } from '../data/railStitch';
import { fetchSlovakiaOutline } from '../data/slovakiaOutlineService';
import {
  clipWaysToOutline,
  isCoordinateInsideOutline,
  simplifyRing,
  type LatLngPolygon,
} from '../data/slovakiaClip';
import { copyFor, type AppLocale } from '../i18n';
import {
  EMPTY_COLLECTION,
  pathsToLineCollection,
  classifyDisplayRails,
  pointsToCollection,
  railKind,
  spreadOverlappingTrainPoints,
  stationLabelRank,
  waysToLineCollection,
} from '../data/railGeoJson';

const SLOVAKIA_BOUNDS = {
  minLat: 47.7311798,
  maxLat: 49.6138162,
  minLng: 16.8331891,
  maxLng: 22.5657103,
};
/** Extra pan room beyond Slovakia (degrees). */
const MAP_VIEW_BOUNDS_PAD = { lng: 1.5, lat: 1.1 };
const CENTER_LAT = (SLOVAKIA_BOUNDS.minLat + SLOVAKIA_BOUNDS.maxLat) / 2;
const CENTER_LNG = (SLOVAKIA_BOUNDS.minLng + SLOVAKIA_BOUNDS.maxLng) / 2;
const RAIL_FILL_COLOR = '#f4f7fb';
const RAIL_MAIN_FILL_COLOR = '#b5bcc5';
const RAIL_SIDE_FILL_COLOR = '#939aa3';
const RAIL_CASING_COLOR = '#0b0d10';
export type MapTheme = 'dark' | 'light';

export type MapViewControls = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetToSlovakia: () => void;
  centerOn: (lng: number, lat: number, options?: { minZoom?: number }) => void;
};

function railPalette(theme: MapTheme) {
  if (theme === 'light') {
    return {
      fill: '#1a1a1a',
      main: '#0c0c0c',
      side: '#8f8f8f',
      casing: '#f4f4f4',
      label: '#1a1a1a',
      halo: 'rgba(255, 255, 255, 0.9)',
    };
  }
  return {
    fill: RAIL_FILL_COLOR,
    main: RAIL_MAIN_FILL_COLOR,
    side: RAIL_SIDE_FILL_COLOR,
    casing: RAIL_CASING_COLOR,
    label: '#f2f4f7',
    halo: 'rgba(11, 13, 16, 0.88)',
  };
}
const RAIL_SIDE_OPACITY: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6,
  0.22,
  9,
  0.34,
  12,
  0.78,
  15,
  0.92,
];
const RAIL_BRANCH_OPACITY = 0.62;
const SIMPLIFIED_RAIL_FADE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  12.4,
  1,
  12.9,
  0.55,
  13.4,
  0,
];
const BASEMAP_RAIL_FADE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  12.8,
  0,
  13.3,
  1,
];

function zoomInterpolateStops(expr: number | ExpressionSpecification): Array<[number, number]> | null {
  if (typeof expr === 'number') {
    return null;
  }
  if (!Array.isArray(expr) || expr[0] !== 'interpolate' || expr[2]?.[0] !== 'zoom') {
    return null;
  }
  const stops: Array<[number, number]> = [];
  for (let index = 3; index < expr.length - 1; index += 2) {
    const zoom = expr[index];
    const value = expr[index + 1];
    if (typeof zoom === 'number' && typeof value === 'number') {
      stops.push([zoom, value]);
    }
  }
  return stops.length > 0 ? stops : null;
}

function sampleZoomStops(stops: Array<[number, number]>, zoom: number): number {
  if (zoom <= stops[0][0]) {
    return stops[0][1];
  }
  for (let index = 1; index < stops.length; index += 1) {
    const [endZoom, endValue] = stops[index];
    if (zoom <= endZoom) {
      const [startZoom, startValue] = stops[index - 1];
      const span = endZoom - startZoom;
      const t = span <= 0 ? 1 : (zoom - startZoom) / span;
      return startValue + (endValue - startValue) * t;
    }
  }
  return stops[stops.length - 1][1];
}

function productOpacity(
  left: number | ExpressionSpecification,
  right: number | ExpressionSpecification
): number | ExpressionSpecification {
  if (typeof left === 'number' && typeof right === 'number') {
    return left * right;
  }
  const leftStops = zoomInterpolateStops(left);
  const rightStops = zoomInterpolateStops(right);
  const zooms = [
    ...new Set([
      ...(leftStops ?? []).map(([zoom]) => zoom),
      ...(rightStops ?? []).map(([zoom]) => zoom),
    ]),
  ].sort((a, b) => a - b);
  if (zooms.length === 0) {
    return 1;
  }
  const interpolate: ExpressionSpecification = ['interpolate', ['linear'], ['zoom']];
  zooms.forEach((zoom) => {
    const leftValue = leftStops ? sampleZoomStops(leftStops, zoom) : Number(left);
    const rightValue = rightStops ? sampleZoomStops(rightStops, zoom) : Number(right);
    interpolate.push(zoom, leftValue * rightValue);
  });
  return interpolate;
}

const RAIL_MAIN_FILL = 1.9;
const RAIL_MAIN_CASING = 4.6;
const RAIL_BRANCH_FILL = 1.15;
const RAIL_BRANCH_CASING = 2.9;
const RAIL_SIDE_FILL = 0.8;
const RAIL_SIDE_CASING = 1.85;

function railLineWidthExprs(
  fill: number,
  casing: number
): { fill: ExpressionSpecification; casing: ExpressionSpecification } {
  return {
    fill: [
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      fill * 0.35,
      8,
      fill * 0.65,
      11,
      fill,
      14,
      fill * 1.6,
    ],
    casing: [
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      casing * 0.35,
      8,
      casing * 0.65,
      11,
      casing,
      14,
      casing * 1.6,
    ],
  };
}

type TrainPillPoint = {
  id: string;
  lat: number;
  lng: number;
  color: string;
  selected: boolean;
  type: string;
  number: string;
  heading: number | null;
  radius?: number;
};

type TrainMarkerEntry = {
  marker: Marker;
  attached: boolean;
  el: HTMLButtonElement;
  typeEl: HTMLElement;
  arrowEl: HTMLElement;
  heading: number | null;
  lastLng: number;
  lastLat: number;
  trackLat: number;
  trackLng: number;
  targetLat: number;
  targetLng: number;
  motion?: {
    path: Coordinate[];
    startMs: number;
    durationMs: number;
  };
  motionRequestId?: string;
  lastArrowKey: string;
  lastColor: string;
  lastSelected: boolean;
  lastType: string;
  width: number;
};

function trainPillRadius(selected: boolean): number {
  return selected ? 15 : 13;
}

function estimateTrainPillWidth(type: string, selected: boolean): number {
  const typeWidth = Math.max(12, type.length * 6.4);
  return 14 + typeWidth + (selected ? 2 : 0);
}

function trainNumberLabel(type: string, trainNumber: string): string {
  const number = (trainNumber ?? '').trim();
  const prefix = type.trim();
  if (!number) {
    return '';
  }
  if (prefix && number.toLowerCase().startsWith(prefix.toLowerCase())) {
    return number.slice(prefix.length).trim();
  }
  return number;
}

function placeTrainArrow(entry: TrainMarkerEntry) {
  const heading = entry.heading;
  if (heading == null) {
    if (entry.lastArrowKey !== 'hidden') {
      entry.arrowEl.style.opacity = '0';
      entry.lastArrowKey = 'hidden';
    }
      return;
    }
  const width = entry.width || 26;
  const height = 14;
  const key = `${heading.toFixed(2)}:${width}:${height}:${TRAIN_ARROW_INSET_PX}`;
  if (entry.lastArrowKey === key) {
      return;
    }
  const { x, y } = stadiumEdgePoint(width, height, heading, TRAIN_ARROW_INSET_PX);
  entry.lastArrowKey = key;
  entry.arrowEl.style.opacity = '1';
  entry.arrowEl.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${heading}deg)`;
}

function createTrainPill(onPick: (trainId: string) => void): TrainMarkerEntry {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'train-pill';
  const typeEl = document.createElement('span');
  typeEl.className = 'train-pill__type';
  const arrowEl = document.createElement('span');
  arrowEl.className = 'train-pill__arrow';
  arrowEl.setAttribute('aria-hidden', 'true');
  el.append(typeEl, arrowEl);
  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const id = el.dataset.trainId;
    if (id) {
      onPick(id);
    }
  });
  return {
    marker: new Marker({ element: el, anchor: 'center', className: 'train-pill-wrap' }),
    attached: false,
    el,
    typeEl,
    arrowEl,
    heading: null,
    lastLng: Number.NaN,
    lastLat: Number.NaN,
    trackLat: Number.NaN,
    trackLng: Number.NaN,
    targetLat: Number.NaN,
    targetLng: Number.NaN,
    lastArrowKey: '',
    lastColor: '',
    lastSelected: false,
    lastType: '',
    width: 26,
  };
}

function absoluteAppUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

function packingIterationsForZoom(zoom: number): number {
  if (zoom < 9) {
    return 0;
  }
  if (zoom < 11) {
    return 4;
  }
  return 6;
}
const HIGHLIGHT_LINE_WIDTH = 4;
const SIMPLIFIED_TOLERANCE_METERS = 0;

setWorkerUrl(
  URL.createObjectURL(new Blob([maplibreWorkerSource], { type: 'text/javascript' }))
);
try {
  setWorkerCount(Math.max(2, Math.min(4, navigator.hardwareConcurrency || 2)));
} catch {
  // Worker count can only be set before the pool starts.
}

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#161616' },
    },
  ],
};

const STATION_HIT_LAYERS = [
  'stations-halo',
  'stations-casing',
  'stations-fill',
  'stations-selected',
];
const STATION_DOT_MIN_ZOOM = 12.8;

function stationLabelFont(map: MapLibreMap): string[] {
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type !== 'symbol') {
      continue;
    }
    const font = layer.layout?.['text-font'];
    if (Array.isArray(font) && font.length > 0) {
      return font as string[];
    }
  }
  return ['Noto Sans Regular'];
}

function stationCircleRadius(base: [number, number, number, number]): ExpressionSpecification {
  const [close, mid, near, hoverGain] = base;
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    12.8,
    ['case', ['boolean', ['feature-state', 'hover'], false], close * hoverGain, close],
    14,
    ['case', ['boolean', ['feature-state', 'hover'], false], mid * hoverGain, mid],
    16,
    ['case', ['boolean', ['feature-state', 'hover'], false], near * hoverGain, near],
  ];
}

type OsmStatus = {
  tilesLoaded: number;
  lastFetch: string;
  lastStatus: string;
  loading: boolean;
};

type PathfinderWorkerResponse =
  | {
      type: 'result';
      requestId: string;
  path: Coordinate[];
      paths?: Coordinate[][];
      durationMs: number;
      reason?: string;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'graphReady'; nodeCount: number };

type SerializedOsmGraph = Record<
  string,
  { lat: number; lng: number; neighbors: [string, number][] }
>;

function serializeOsmGraph(graph: OsmGraph): SerializedOsmGraph {
  const payload: SerializedOsmGraph = {};
  graph.forEach((node, key) => {
    payload[key] = {
      lat: node.lat,
      lng: node.lng,
      neighbors: Array.from(node.neighbors.entries()),
    };
  });
  return payload;
}

function emphasizeRelief(map: MapLibreMap, theme: MapTheme) {
  if (!map.getLayer('background_relief')) {
    return;
  }
  const night = theme !== 'light';
  const layerType = map.getStyle()?.layers?.find((layer) => layer.id === 'background_relief')?.type;
  if (layerType === 'hillshade') {
    map.setPaintProperty('background_relief', 'hillshade-exaggeration', [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      0,
      6,
      night ? 0.24 : 0.26,
      12,
      night ? 0.2 : 0.22,
      14,
      night ? 0.2 : 0.22,
      16,
      night ? 0.2 : 0.22,
    ]);
    map.setPaintProperty('background_relief', 'hillshade-shadow-color', night ? '#050505' : '#c8c4be');
    map.setPaintProperty('background_relief', 'hillshade-highlight-color', night ? '#3a3a38' : '#ffffff');
    map.setPaintProperty('background_relief', 'hillshade-accent-color', night ? '#101010' : '#ddd8d2');
    return;
  }
  map.setPaintProperty('background_relief', 'raster-opacity', [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    0,
    6,
    night ? 0.55 : 0.5,
    12,
    night ? 0.55 : 0.5,
    14,
    night ? 0.55 : 0.5,
    16,
    night ? 0.55 : 0.5,
  ]);
  map.setPaintProperty('background_relief', 'raster-contrast', night ? 0.12 : 0.08);
  map.setPaintProperty('background_relief', 'raster-brightness-min', 0);
  map.setPaintProperty('background_relief', 'raster-brightness-max', night ? 0.15 : 0.94);
  map.setPaintProperty('background_relief', 'raster-saturation', 0);
}

function flattenNetworkRoute(paths: Coordinate[][]): Coordinate[] {
  const out: Coordinate[] = [];
  paths.forEach((path) => {
    path.forEach((point, index) => {
      const last = out[out.length - 1];
      if (index === 0 && last && last.lat === point.lat && last.lng === point.lng) {
        return;
      }
      out.push(point);
    });
  });
  return out;
}

function setSourceData(map: MapLibreMap | null, sourceId: string, data: FeatureCollection) {
  const source = map?.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

function publishSimplifiedRails(map: MapLibreMap | null, ways: OSMWay[]) {
  setSourceData(
    map,
    'rails-simplified-main',
    waysToLineCollection(
      ways.filter((way) => railKind(way) === 'main'),
      undefined,
      SIMPLIFIED_TOLERANCE_METERS
    )
  );
  setSourceData(
    map,
    'rails-simplified-branch',
    waysToLineCollection(
      ways.filter((way) => railKind(way) === 'branch'),
      undefined,
      SIMPLIFIED_TOLERANCE_METERS
    )
  );
  setSourceData(
    map,
    'rails-simplified-side',
    waysToLineCollection(
      ways.filter((way) => railKind(way) === 'side'),
      undefined,
      SIMPLIFIED_TOLERANCE_METERS
    )
  );
}

function applyStationSelection(
  map: MapLibreMap | null,
  nextId: string | null | undefined,
  previousId: string | null
): string | null {
  if (!map) {
    return previousId;
  }
  if (previousId && previousId !== nextId) {
    try {
      map.setFeatureState({ source: 'stations', id: previousId }, { selected: false });
    } catch {
      // Feature may not exist yet if station GeoJSON has not loaded.
    }
  }
  if (nextId) {
    try {
      map.setFeatureState({ source: 'stations', id: nextId }, { selected: true });
    } catch {
      // Same as above: selection is retried after the next setData.
    }
  }
  return nextId ?? null;
}

function placeRailsHighlightAboveTracks(map: MapLibreMap) {
  if (!map.getLayer('rails-highlight')) {
      return;
    }
  const style = map.getStyle();
  const layers = style?.layers;
  if (!layers?.length) {
      return;
    }
  let beforeId: string | undefined;
  for (const layer of layers) {
    if (layer.id === 'rails-highlight') {
      continue;
    }
    if (layer.id === 'stations-halo' || layer.id.startsWith('stations-')) {
      beforeId = layer.id;
      break;
    }
  }
  try {
    map.moveLayer('rails-highlight', beforeId);
  } catch {
    // Style may be mid-reload.
  }
}

function addRailLayers(map: MapLibreMap, theme: MapTheme = 'light') {
  const {
    fill: fillColor,
    main: mainFillColor,
    side: sideColor,
    casing: casingColor,
    label: labelColor,
    halo: haloColor,
  } = railPalette(theme);
  const ensureSource = (
    id: string,
    options: { maxzoom?: number; tolerance?: number; buffer?: number; promoteId?: string } = {}
  ) => {
    if (!map.getSource(id)) {
      map.addSource(id, {
        type: 'geojson',
        data: EMPTY_COLLECTION,
        maxzoom: options.maxzoom ?? 12,
        tolerance: options.tolerance ?? 0.75,
        buffer: options.buffer ?? 32,
        ...(options.promoteId ? { promoteId: options.promoteId } : {}),
      });
    }
  };
  const upsertLineLayer = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
    if (map.getLayer(layer.id)) {
      map.removeLayer(layer.id);
    }
    map.addLayer(layer);
  };
  const addPair = (
    source: string,
    prefix: string,
    fill: number,
    casing: number,
    opacity: number | ExpressionSpecification = 1,
    options: {
      filter?: ExpressionSpecification;
      dasharray?: number[];
      color?: string;
      maxzoom?: number;
    } = {}
  ) => {
    const { fill: fillWidth, casing: casingWidth } = railLineWidthExprs(fill, casing);
    const layout = {
      'line-cap': (options.dasharray ? 'butt' : 'round') as 'butt' | 'round',
      'line-join': 'round' as const,
    };
    const filter = options.filter;
    const dash = options.dasharray ? { 'line-dasharray': options.dasharray } : {};
    const fillOpacity: number | ExpressionSpecification =
      typeof opacity === 'number' ? opacity * 0.98 : opacity;
    upsertLineLayer({
      id: `${prefix}-casing`,
      type: 'line',
      source,
      minzoom: 8.6,
      ...(options.maxzoom ? { maxzoom: options.maxzoom } : {}),
      layout,
      ...(filter ? { filter } : {}),
      paint: {
        'line-color': casingColor,
        'line-width': casingWidth,
        'line-opacity': opacity,
        ...dash,
      },
    });
    upsertLineLayer({
      id: `${prefix}-fill`,
      type: 'line',
      source,
      ...(options.maxzoom ? { maxzoom: options.maxzoom } : {}),
      layout,
      ...(filter ? { filter } : {}),
      paint: {
        'line-color': options.color ?? fillColor,
        'line-width': fillWidth,
        'line-opacity': fillOpacity,
        ...dash,
      },
    });
  };

  if (map.getSource('basemap')) {
    for (const legacyId of [
      'basemap-rails-main',
      'basemap-rails-side',
      'basemap-rails-branch',
      'basemap-rails-tunnel',
    ]) {
      if (map.getLayer(legacyId)) {
        map.removeLayer(legacyId);
      }
    }
    const tramSubclassMatch: ExpressionSpecification = [
      'match',
      ['get', 'subclass'],
      ['tram', 'light_rail'],
      true,
      false,
    ];
    const isBasemapTramLine: ExpressionSpecification = [
      'any',
      ['==', ['get', 'class'], 'tram'],
      ['all', ['==', ['get', 'class'], 'transit'], tramSubclassMatch],
      tramSubclassMatch,
    ];
    const mainFilter: ExpressionSpecification = [
      'all',
      ['==', ['get', 'class'], 'rail'],
      ['!', ['has', 'service']],
      ['!=', ['get', 'brunnel'], 'tunnel'],
      ['!', tramSubclassMatch],
    ];
    const sideFilter: ExpressionSpecification = [
      'all',
      ['match', ['get', 'class'], ['rail', 'transit'], true, false],
      ['has', 'service'],
    ];
    const branchFilter: ExpressionSpecification = [
      'all',
      ['==', ['get', 'class'], 'transit'],
      ['!', ['has', 'service']],
      ['!=', ['get', 'brunnel'], 'tunnel'],
      ['!', tramSubclassMatch],
    ];
    const tramFilter: ExpressionSpecification = [
      'all',
      isBasemapTramLine,
      ['!=', ['get', 'brunnel'], 'tunnel'],
    ];
    const tramTunnelFilter: ExpressionSpecification = [
      'all',
      isBasemapTramLine,
      ['==', ['get', 'brunnel'], 'tunnel'],
    ];
    const tunnelFilter: ExpressionSpecification = [
      'all',
      ['==', ['get', 'class'], 'rail'],
      ['!', ['has', 'service']],
      ['==', ['get', 'brunnel'], 'tunnel'],
      ['!', tramSubclassMatch],
    ];
    const addBasemapPair = (
      prefix: string,
      filter: ExpressionSpecification,
      fillScale: number,
      casingScale: number,
      color: string,
      opacity: number | ExpressionSpecification,
      options: { dasharray?: number[] } = {}
    ) => {
      const { fill: fillWidth, casing: casingWidth } = railLineWidthExprs(fillScale, casingScale);
      const layout = {
        'line-cap': (options.dasharray ? 'butt' : 'round') as 'butt' | 'round',
        'line-join': 'round' as const,
      };
      const dash = options.dasharray ? { 'line-dasharray': options.dasharray } : {};
      const lineOpacity =
        typeof opacity === 'number' ? opacity : (opacity as ExpressionSpecification);
      const fillOpacity: number | ExpressionSpecification =
        typeof opacity === 'number' ? opacity * 0.98 : opacity;
      upsertLineLayer({
        id: `${prefix}-casing`,
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 12.8,
        filter,
        layout,
        paint: {
          'line-color': casingColor,
          'line-width': casingWidth,
          'line-opacity': lineOpacity,
          ...dash,
        },
      });
      upsertLineLayer({
        id: `${prefix}-fill`,
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 12.8,
        filter,
        layout,
        paint: {
          'line-color': color,
          'line-width': fillWidth,
          'line-opacity': fillOpacity,
          ...dash,
        },
      });
    };
    addBasemapPair('basemap-rails-side', sideFilter, RAIL_SIDE_FILL, RAIL_SIDE_CASING, sideColor, BASEMAP_RAIL_FADE);
    addBasemapPair(
      'basemap-rails-branch',
      branchFilter,
      RAIL_BRANCH_FILL,
      RAIL_BRANCH_CASING,
      fillColor,
      productOpacity(BASEMAP_RAIL_FADE, RAIL_BRANCH_OPACITY)
    );
    addBasemapPair('basemap-rails-tram', tramFilter, RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, fillColor, BASEMAP_RAIL_FADE);
    addBasemapPair('basemap-rails-tram-tunnel', tramTunnelFilter, RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, fillColor, BASEMAP_RAIL_FADE, {
      dasharray: [2.4, 2.1],
    });
    addBasemapPair('basemap-rails-main', mainFilter, RAIL_MAIN_FILL, RAIL_MAIN_CASING, mainFillColor, BASEMAP_RAIL_FADE);
    addBasemapPair('basemap-rails-tunnel', tunnelFilter, RAIL_MAIN_FILL, RAIL_MAIN_CASING, mainFillColor, BASEMAP_RAIL_FADE, {
      dasharray: [2.6, 2.2],
    });
  }

  ensureSource('stations', { maxzoom: 14, tolerance: 0, buffer: 16, promoteId: 'id' });
  ensureSource('stations-hover', { maxzoom: 16, tolerance: 0, buffer: 64 });
  ensureSource('rails-highlight', { maxzoom: 16, tolerance: 0.35 });
  ensureSource('rails-simplified-main', { maxzoom: 14, tolerance: 0 });
  ensureSource('rails-simplified-branch', { maxzoom: 14, tolerance: 0 });
  ensureSource('rails-simplified-side', { maxzoom: 14, tolerance: 0 });

  const simplifiedMaxZoom = 13.5;
  for (const leftover of [
    'rails-simplified-main-tunnel-casing',
    'rails-simplified-main-tunnel-fill',
    'rails-simplified-branch-tunnel-casing',
    'rails-simplified-branch-tunnel-fill',
  ]) {
    if (map.getLayer(leftover)) {
      map.removeLayer(leftover);
    }
  }
  addPair('rails-simplified-side', 'rails-simplified-side', RAIL_SIDE_FILL, RAIL_SIDE_CASING, productOpacity(SIMPLIFIED_RAIL_FADE, RAIL_SIDE_OPACITY), {
    color: sideColor,
    maxzoom: simplifiedMaxZoom,
  });
  addPair('rails-simplified-branch', 'rails-simplified-branch', RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, productOpacity(SIMPLIFIED_RAIL_FADE, RAIL_BRANCH_OPACITY), {
    maxzoom: simplifiedMaxZoom,
  });
  addPair('rails-simplified-main', 'rails-simplified-main', RAIL_MAIN_FILL, RAIL_MAIN_CASING, SIMPLIFIED_RAIL_FADE, {
    color: mainFillColor,
    maxzoom: simplifiedMaxZoom,
  });

  const upsertLayer = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
    if (map.getLayer(layer.id)) {
      map.removeLayer(layer.id);
    }
    map.addLayer(layer);
  };
  const labelFont = stationLabelFont(map);
  const labelLayout = {
    'text-font': labelFont,
    'text-field': ['coalesce', ['get', 'name'], ''],
    'text-size': ['interpolate', ['linear'], ['zoom'], 12.8, 10.5, 14, 12, 16, 13],
    'text-anchor': 'left' as const,
    'text-offset': [1.15, 0],
    'text-optional': true,
    'text-padding': 6,
    'text-max-width': 8,
    'symbol-sort-key': ['-', ['coalesce', ['get', 'rank'], 1]],
  };
  const labelPaint = {
    'text-color': labelColor,
    'text-halo-color': haloColor,
    'text-halo-width': 1.15,
    'text-halo-blur': 0.3,
  };
  const hideLabelWhenHovered: ExpressionSpecification = [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    0,
    1,
  ];
  const showSelectedUnlessHovered: ExpressionSpecification = [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    0,
    ['boolean', ['feature-state', 'selected'], false],
    1,
    0,
  ];

  upsertLayer({
    id: 'stations-halo',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([5.2, 8.4, 12, 1.35]),
      'circle-color': fillColor,
      'circle-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.42,
        ['boolean', ['feature-state', 'selected'], false],
        0.3,
        0.13,
      ],
      'circle-blur': 0.18,
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-casing',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([2.3, 3.5, 4.8, 1.18]),
      'circle-color': casingColor,
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-fill',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([1.55, 2.45, 3.35, 1.18]),
      'circle-color': fillColor,
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-selected',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([4.2, 6.2, 8, 1.08]),
      'circle-color': '#fddf57',
      'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2, 0],
      'circle-stroke-color': casingColor,
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-label-major',
    type: 'symbol',
    source: 'stations',
    minzoom: 13,
    filter: ['==', ['get', 'rank'], 3],
    layout: {
      ...labelLayout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 14, 13, 16, 14],
    },
    paint: { ...labelPaint, 'text-opacity': hideLabelWhenHovered },
  });
  upsertLayer({
    id: 'stations-label-mid',
    type: 'symbol',
    source: 'stations',
    minzoom: 13.4,
    filter: ['==', ['get', 'rank'], 2],
    layout: labelLayout,
    paint: { ...labelPaint, 'text-opacity': hideLabelWhenHovered },
  });
  upsertLayer({
    id: 'stations-label-minor',
    type: 'symbol',
    source: 'stations',
    minzoom: 14.1,
    filter: ['==', ['get', 'rank'], 1],
    layout: {
      ...labelLayout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 15, 12],
    },
    paint: { ...labelPaint, 'text-opacity': hideLabelWhenHovered },
  });
  upsertLayer({
    id: 'stations-label-selected',
    type: 'symbol',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    layout: {
      ...labelLayout,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { ...labelPaint, 'text-opacity': showSelectedUnlessHovered },
  });
  upsertLayer({
    id: 'stations-label-hover',
    type: 'symbol',
    source: 'stations-hover',
    minzoom: STATION_DOT_MIN_ZOOM,
    layout: {
      ...labelLayout,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-optional': false,
    },
    paint: labelPaint,
  });

  upsertLayer({
    id: 'rails-highlight',
    type: 'line',
    source: 'rails-highlight',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ffffff'],
      'line-width': HIGHLIGHT_LINE_WIDTH,
      'line-opacity': 0.95,
    },
  });
  placeRailsHighlightAboveTracks(map);
}

interface MapSceneProps {
  trains: TrainRenderState[];
  focusedTrainNumber?: string | null;
  focusedRouteCursor?: RouteCursor | null;
  focusedStations?: Array<Coordinate | null>;
  journeyStops?: JourneyStop[];
  journeyStatus?: 'idle' | 'loading' | 'ready' | 'error';
  following?: boolean;
  onFollowBreak?: () => void;
  onTrainClick?: (trainNumber: string) => void;
  onStationClick?: (station: { id: string; name: string; lat: number; lng: number }) => void;
  onBackgroundClick?: () => void;
  focusedStationId?: string | null;
  focusedStation?: { id: string; name: string; lat: number; lng: number } | null;
  dataset?: GtfsDataset | null;
  onOsmStatusChange?: (status: OsmStatus) => void;
  onCanvasStateChange?: (state: 'loading' | 'loaded') => void;
  trainsLoaded?: boolean;
  theme?: MapTheme;
  locale?: AppLocale;
  mapViewRef?: React.MutableRefObject<MapViewControls | null>;
}

export const MapScene: React.FC<MapSceneProps> = React.memo(({
  trains,
  focusedTrainNumber,
  focusedRouteCursor = null,
  focusedStations,
  journeyStops,
  journeyStatus = 'idle',
  following = false,
  onFollowBreak,
  onTrainClick,
  onStationClick,
  onBackgroundClick,
  focusedStationId,
  focusedStation = null,
  dataset,
  onOsmStatusChange,
  onCanvasStateChange,
  trainsLoaded = false,
  theme = 'light',
  locale = 'sk',
  mapViewRef,
}) => {
  const mapCopy = useMemo(() => copyFor(locale), [locale]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapReadyRef = useRef(false);
  const osmWaysRef = useRef<Map<number, OSMWay>>(new Map());
  const simplifiedWaysRef = useRef<OSMWay[]>([]);
  const osmGraphRef = useRef<OsmGraph>(new Map());
  const [osmGraphTick, setOsmGraphTick] = useState(0);
  const [networkRoute, setNetworkRoute] = useState<Coordinate[][] | null>(null);
  const [osmWayCount, setOsmWayCount] = useState(0);
  const [osmStatus, setOsmStatus] = useState<OsmStatus>({
    tilesLoaded: 0,
    lastFetch: 'never',
    lastStatus: 'idle',
    loading: true,
  });
  const [terrainLoaded, setTerrainLoaded] = useState(false);
  const [overlayEpoch, setOverlayEpoch] = useState(0);
  const themeRef = useRef<MapTheme>(theme);
  themeRef.current = theme;
  const appliedThemeRef = useRef<MapTheme | null>(null);
  const [tileLoadPlan, setTileLoadPlan] = useState({ total: 0, completed: 0 });
  const [svgOutlinePolygons, setSvgOutlinePolygons] = useState<LatLngPolygon[]>([]);
  const [osmRefreshTrigger, setOsmRefreshTrigger] = useState(0);
  const [animationWarnings, setAnimationWarnings] = useState<string[]>([]);
  const pathfinderWorkerRef = useRef<Worker | null>(null);
  const pathfinderGraphReadyRef = useRef(false);
  const pathfinderResolversRef = useRef<Map<string, (result: OsmPathResult) => void>>(new Map());
  const pathfinderRejectorsRef = useRef<Map<string, (message: string) => void>>(new Map());
  const focusedTrainRef = useRef(focusedTrainNumber);
  focusedTrainRef.current = focusedTrainNumber;
  const focusedRouteCursorRef = useRef(focusedRouteCursor);
  focusedRouteCursorRef.current = focusedRouteCursor;
  const focusedStationIdRef = useRef(focusedStationId);
  focusedStationIdRef.current = focusedStationId;
  const trainsRef = useRef(trains);
  trainsRef.current = trains;
  const selectedStationRef = useRef<string | null>(null);
  const trainPointsRef = useRef<TrainPillPoint[]>([]);
  const trainPublishRafRef = useRef(0);
  const rebuildTrainPointsRef = useRef<() => void>(() => undefined);
  const outlineRef = useRef<LatLngPolygon[]>([]);
  const onTrainClickRef = useRef(onTrainClick);
  onTrainClickRef.current = onTrainClick;
  const onStationClickRef = useRef(onStationClick);
  onStationClickRef.current = onStationClick;
  const onBackgroundClickRef = useRef(onBackgroundClick);
  onBackgroundClickRef.current = onBackgroundClick;
  const onFollowBreakRef = useRef(onFollowBreak);
  onFollowBreakRef.current = onFollowBreak;
  const followingRef = useRef(following);
  followingRef.current = following;
  const followPositionRef = useRef<Coordinate | null>(null);
  const userDraggingRef = useRef(false);
  const followDragStartRef = useRef<{ lat: number; lng: number } | null>(null);
  const publishTrainMarkersRef = useRef<() => void>(() => undefined);
  const trainMarkersRef = useRef<Map<string, TrainMarkerEntry>>(new Map());
  const lastTrainPositionsRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const trainNodeStampRef = useRef<Map<string, string>>(new Map());
  const lastScheduledPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const trainMotionRafRef = useRef(0);
  const startTrainMotionLoopRef = useRef<() => void>(() => undefined);

  const appendLoadingMessage = useCallback((_message: string) => {}, []);

  useEffect(() => {
    outlineRef.current = svgOutlinePolygons;
  }, [svgOutlinePolygons]);

  useEffect(() => {
    onOsmStatusChange?.(osmStatus);
  }, [osmStatus, onOsmStatusChange]);

  useEffect(() => {
    let cancelled = false;
    fetchSlovakiaOutline()
      .then((outline) => {
        if (cancelled || outline.points.length <= 8) {
          return;
        }
        setSvgOutlinePolygons([simplifyRing(outline.points)]);
      })
      .catch((error) => {
        console.error('Failed to load Slovakia outline:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/pathfinder.worker.ts', import.meta.url), {
      type: 'module',
    });
    pathfinderWorkerRef.current = worker;
    const handleMessage = (event: MessageEvent<PathfinderWorkerResponse>) => {
      const response = event.data;
      if (response.type === 'graphReady') {
        pathfinderGraphReadyRef.current = response.nodeCount > 0;
      return;
    }
      const resolver = pathfinderResolversRef.current.get(response.requestId);
      const rejector = pathfinderRejectorsRef.current.get(response.requestId);
      pathfinderResolversRef.current.delete(response.requestId);
      pathfinderRejectorsRef.current.delete(response.requestId);
      if (response.type === 'result') {
        resolver?.({
          path: response.path,
          paths: response.paths,
          reason: response.reason,
        });
      } else {
        rejector?.(response.message);
      }
    };
    worker.addEventListener('message', handleMessage);
    return () => {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      pathfinderWorkerRef.current = null;
    };
  }, []);

  const osmGraph = useMemo(() => osmGraphRef.current, [osmGraphTick]);

  useEffect(() => {
    const worker = pathfinderWorkerRef.current;
    if (!worker || osmGraph.size === 0) {
      pathfinderGraphReadyRef.current = false;
      return;
    }
    pathfinderGraphReadyRef.current = false;
    worker.postMessage({
      type: 'initGraph',
      graph: serializeOsmGraph(osmGraph),
    });
  }, [osmGraph, osmGraphTick]);

  useEffect(() => {
    let cancelled = false;
    const loadNetwork = async () => {
      if (svgOutlinePolygons.length === 0) {
          return;
        }
      setOsmStatus((prev) => ({ ...prev, loading: true, lastStatus: 'loading' }));
      setTileLoadPlan({ total: 1, completed: 0 });
      appendLoadingMessage('Loading OSM rails');
      let ways: OSMWay[] = [];
      let meta: OsmProxyMeta | undefined;
      for (let attempt = 0; attempt < 3 && ways.length === 0; attempt += 1) {
        const result = await fetchSimplifiedNetwork();
        ways = result.ways;
        meta = result.meta;
        if (ways.length === 0 && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
        if (cancelled) {
          return;
        }
      const clipped = clipWaysToOutline(ways, svgOutlinePolygons);
      const stitched = closeRailGaps(clipped);
      const filtered = classifyDisplayRails(stitched);
      osmWaysRef.current = new Map();
      simplifiedWaysRef.current = filtered;
      filtered.forEach((way) => osmWaysRef.current.set(way.id, way));
      resetSpatialIndex();
      osmGraphRef.current = new Map();
      extendOsmGraph(osmGraphRef.current, stitched.filter(isPathfindingWay));
      setOsmGraphTick((prev) => prev + 1);
      setOsmWayCount(filtered.length);
      setTileLoadPlan({ total: 1, completed: 1 });
      appendLoadingMessage('Loaded: 1/1 OSM tiles');
      setOsmStatus({
        tilesLoaded: filtered.length > 0 ? 1 : 0,
        lastFetch: new Date().toLocaleTimeString(),
        lastStatus: meta?.status ?? 'network',
        loading: false,
      });
      const map = mapRef.current;
      if (mapReadyRef.current && map) {
        publishSimplifiedRails(map, filtered);
      }
    };
    loadNetwork();
    return () => {
      cancelled = true;
    };
  }, [appendLoadingMessage, osmRefreshTrigger, svgOutlinePolygons]);

  const scheduleTrainMarkers = useCallback(() => {
    if (trainPublishRafRef.current) {
        return;
      }
    trainPublishRafRef.current = window.requestAnimationFrame(() => {
      trainPublishRafRef.current = 0;
      publishTrainMarkersRef.current();
    });
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    if (mapRef.current) {
      const existing = mapRef.current.getContainer();
      if (existing === node || node.contains(existing)) {
        return;
      }
      mapRef.current.remove();
      mapRef.current = null;
      mapReadyRef.current = false;
    }
    let cancelled = false;
    const map = new MapLibreMap({
      container: node,
      style: absoluteAppUrl(`/proxy/style?mode=style&theme=${themeRef.current}`),
      transformRequest: (url) => ({ url: absoluteAppUrl(url) }),
      center: [CENTER_LNG, CENTER_LAT],
      zoom: 7,
      minZoom: 6,
      maxZoom: 16,
      maxBounds: [
        [SLOVAKIA_BOUNDS.minLng - MAP_VIEW_BOUNDS_PAD.lng, SLOVAKIA_BOUNDS.minLat - MAP_VIEW_BOUNDS_PAD.lat],
        [SLOVAKIA_BOUNDS.maxLng + MAP_VIEW_BOUNDS_PAD.lng, SLOVAKIA_BOUNDS.maxLat + MAP_VIEW_BOUNDS_PAD.lat],
      ],
      attributionControl: false,
      fadeDuration: 0,
      maxParallelImageRequests: 12,
      maxTileCacheZoomLevels: 8,
    });
    mapRef.current = map;
    const hydrateOverlay = () => {
      try {
        emphasizeRelief(map, themeRef.current);
        addRailLayers(map, themeRef.current);
      } catch (error) {
        console.error('Failed to add rail layers', error);
        return;
      }
      const simplified = simplifiedWaysRef.current;
      if (simplified.length > 0) {
        publishSimplifiedRails(map, simplified);
      }
    };
    const handleStyleReady = () => {
      if (cancelled) {
        return;
      }
      hydrateOverlay();
      appliedThemeRef.current = themeRef.current;
      if (mapReadyRef.current) {
        rebuildTrainPointsRef.current();
        publishTrainMarkersRef.current();
        setOverlayEpoch((epoch) => epoch + 1);
      return;
    }
      mapReadyRef.current = true;
      setTerrainLoaded(true);
      appendLoadingMessage('Loaded basemap');
      rebuildTrainPointsRef.current();
      publishTrainMarkersRef.current();
    };
    const handleError = (event: { error?: { message?: string } }) => {
      const message = event.error?.message ?? '';
      if (message) {
        console.warn('MapLibre', message);
      }
      if (mapReadyRef.current) {
        return;
      }
      if (/Failed to fetch|AJAXError|style|layer|paint|filter/i.test(message) && !map.getLayer('background_fill') && !map.getLayer('background')) {
        map.setStyle(FALLBACK_STYLE);
      }
    };
    map.on('style.load', handleStyleReady);
    map.on('load', handleStyleReady);
    map.on('styledata', () => {
      if (map.style && map.getLayer('background_fill') && !map.getSource('stations')) {
        handleStyleReady();
      }
    });
    map.on('error', handleError);
    map.on('zoom', () => {
      scheduleTrainMarkers();
    });
    map.on('zoomend', () => {
      scheduleTrainMarkers();
    });
    let hoveredStationId: string | null = null;
    const clearStationHover = () => {
      if (hoveredStationId) {
        try {
          map.setFeatureState({ source: 'stations', id: hoveredStationId }, { hover: false });
        } catch {
          // Source may have been replaced during a style reload.
        }
      }
      hoveredStationId = null;
      setSourceData(map, 'stations-hover', EMPTY_COLLECTION);
      map.getCanvas().style.cursor = '';
    };
    const handleStationMove = (event: MapLayerMouseEvent) => {
      const layers = STATION_HIT_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId)));
      const feature = layers.length > 0 ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
      const id = feature?.properties?.id ?? (feature?.id != null ? String(feature.id) : null);
      const name = feature?.properties?.name;
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof id !== 'string' || typeof name !== 'string' || !coordinates) {
        if (hoveredStationId) {
          clearStationHover();
        }
        return;
      }
      if (hoveredStationId !== id) {
        if (hoveredStationId) {
          try {
            map.setFeatureState({ source: 'stations', id: hoveredStationId }, { hover: false });
          } catch {
            // Ignore stale ids after a data refresh.
          }
        }
        hoveredStationId = id;
        try {
          map.setFeatureState({ source: 'stations', id }, { hover: true });
        } catch {
          // Feature may not be in the source yet.
        }
        setSourceData(
          map,
          'stations-hover',
          pointsToCollection([
            {
              id,
              name,
              lat: Number(coordinates[1]),
              lng: Number(coordinates[0]),
              color: railPalette(themeRef.current).fill,
              rank: Number(feature?.properties?.rank ?? 1),
            },
          ])
        );
      }
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleStationClick = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const id = feature?.properties?.id;
      const name = feature?.properties?.name;
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof id !== 'string' || typeof name !== 'string' || !coordinates) {
        return;
      }
      onStationClickRef.current?.({
        id,
        name,
        lng: Number(coordinates[0]),
        lat: Number(coordinates[1]),
      });
    };
    map.on('mousemove', handleStationMove);
    map.on('mouseout', clearStationHover);
    STATION_HIT_LAYERS.forEach((layerId) => {
      map.on('click', layerId, handleStationClick);
    });
    const handleBackgroundClick = (event: MapLayerMouseEvent) => {
      const layers = STATION_HIT_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId)));
      if (layers.length > 0 && map.queryRenderedFeatures(event.point, { layers }).length > 0) {
          return;
        }
      onBackgroundClickRef.current?.();
    };
    map.on('click', handleBackgroundClick);
    const breakDistancePx = () => {
      const node = map.getContainer();
      return Math.max(72, Math.min(node.clientWidth, node.clientHeight) * 0.18);
    };
    const handleDragStart = (event: { originalEvent?: Event }) => {
      if (!followingRef.current || !event.originalEvent) {
          return;
        }
      userDraggingRef.current = true;
      const origin = map.getCenter();
      followDragStartRef.current = { lat: origin.lat, lng: origin.lng };
      map.stop();
    };
    const handleDragEnd = () => {
      if (!userDraggingRef.current) {
          return;
        }
      userDraggingRef.current = false;
      if (!followingRef.current) {
        followDragStartRef.current = null;
          return;
        }
      const start = followDragStartRef.current;
      followDragStartRef.current = null;
      const end = map.project(map.getCenter());
      const origin = start ? map.project([start.lng, start.lat]) : end;
      const dragged = Math.hypot(end.x - origin.x, end.y - origin.y);
      if (dragged >= breakDistancePx()) {
        onFollowBreakRef.current?.();
        return;
      }
      const position = followPositionRef.current;
      if (position) {
        map.easeTo({
          center: [position.lng, position.lat],
          duration: 450,
        });
      }
    };
    map.on('dragstart', handleDragStart);
    map.on('dragend', handleDragEnd);
    return () => {
      cancelled = true;
      if (trainPublishRafRef.current) {
        window.cancelAnimationFrame(trainPublishRafRef.current);
        trainPublishRafRef.current = 0;
      }
      trainMarkersRef.current.forEach((entry) => {
        entry.marker.remove();
        entry.attached = false;
      });
      trainMarkersRef.current.clear();
      map.remove();
      mapRef.current = null;
      mapReadyRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    if (appliedThemeRef.current === theme) {
      return;
    }
    map.setStyle(absoluteAppUrl(`/proxy/style?mode=style&theme=${theme}`));
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const movement: Record<string, [number, number]> = {
      arrowup: [0, -48],
      arrowdown: [0, 48],
      arrowleft: [-48, 0],
      arrowright: [48, 0],
      w: [0, -48],
      s: [0, 48],
      a: [-48, 0],
      d: [48, 0],
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) {
        return;
      }
      const delta = movement[event.key.toLowerCase()];
      if (!delta) {
                return;
              }
      event.preventDefault();
      map.panBy(delta, { duration: 180 });
    };
    window.addEventListener('keydown', handleKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [terrainLoaded]);

  const focusedInterpolatedPosition = useMemo(() => {
    if (!following || !focusedTrainNumber || !focusedRouteCursor) {
      return null;
    }
    const { from, to, fraction, position } = focusedRouteCursor;
    const routed = (networkRoute ?? []).filter((path) => path.length > 1);
    if (routed.length > 0 && from && to) {
      const path = flattenNetworkRoute(routed);
      return placeOnPath(path, from, to, fraction);
    }
    return position;
  }, [following, focusedTrainNumber, focusedRouteCursor, networkRoute]);
  const focusedInterpolatedPositionRef = useRef(focusedInterpolatedPosition);
  focusedInterpolatedPositionRef.current = focusedInterpolatedPosition;

  const followPosition = useMemo(() => {
    if (!following || !focusedTrainNumber) {
      return null;
    }
    if (focusedInterpolatedPosition) {
      return focusedInterpolatedPosition;
    }
    const live = trains.find((train) => train.trainNumber === focusedTrainNumber)?.position ?? null;
    const routed = (networkRoute ?? []).filter((path) => path.length > 1);
    if (!live) {
      return null;
    }
    if (routed.length === 0) {
      return live;
    }
    return snapToPath(flattenNetworkRoute(routed), live);
  }, [following, focusedTrainNumber, focusedInterpolatedPosition, trains, networkRoute]);
  followPositionRef.current = followPosition;

  const startTrainMotion = useCallback((
    entry: TrainMarkerEntry,
    path: Coordinate[],
    durationOverride?: number
  ) => {
    const durationMs = durationOverride ?? motionDurationMs(path);
    const end = path[path.length - 1];
    if (durationMs <= 0 || readPrefersReducedMotion()) {
      entry.motion = undefined;
      entry.trackLat = end.lat;
      entry.trackLng = end.lng;
      scheduleTrainMarkers();
                return;
              }
    entry.motion = { path, startMs: performance.now(), durationMs };
    startTrainMotionLoopRef.current();
    scheduleTrainMarkers();
  }, [scheduleTrainMarkers]);

  const advanceTrainMotions = useCallback(() => {
    const now = performance.now();
    let animating = 0;
    trainMarkersRef.current.forEach((entry) => {
      if (!entry.motion) {
                  return;
                }
      const { path, startMs, durationMs } = entry.motion;
      const progress = Math.min(1, (now - startMs) / durationMs);
      const pos = positionAlongPath(path, progress);
      entry.trackLat = pos.lat;
      entry.trackLng = pos.lng;
      const lookAhead = positionAlongPath(path, Math.min(1, progress + 0.05));
      entry.heading = headingFromPoints(pos, lookAhead);
      if (progress < 1) {
        animating += 1;
                return;
              }
      entry.motion = undefined;
      entry.trackLat = entry.targetLat;
      entry.trackLng = entry.targetLng;
    });
    return animating > 0;
  }, []);

  useEffect(() => {
    const tick = () => {
      trainMotionRafRef.current = 0;
      const running = advanceTrainMotions();
      publishTrainMarkersRef.current();
      if (running) {
        trainMotionRafRef.current = window.requestAnimationFrame(tick);
      }
    };
    startTrainMotionLoopRef.current = () => {
      if (trainMotionRafRef.current) {
            return;
          }
      trainMotionRafRef.current = window.requestAnimationFrame(tick);
    };
    return () => {
      if (trainMotionRafRef.current) {
        window.cancelAnimationFrame(trainMotionRafRef.current);
        trainMotionRafRef.current = 0;
      }
    };
  }, [advanceTrainMotions]);

  useEffect(() => {
    trains.forEach((train) => {
      const position = train.position;
      if (!position) {
        return;
      }
      const id = train.trainNumber;
      lastTrainPositionsRef.current.set(id, { lat: position.lat, lng: position.lng });
      const entry = trainMarkersRef.current.get(id);
      if (!entry) {
      return;
    }
      const nodeStamp = `${train.currentStation ?? ''}\0${train.nextStation ?? ''}`;
      const nodeStep = trainNodeStampRef.current.get(id) !== nodeStamp;
      trainNodeStampRef.current.set(id, nodeStamp);
      entry.targetLat = position.lat;
      entry.targetLng = position.lng;
      const useFollowSchedule =
        id === focusedTrainRef.current &&
        followingRef.current &&
        Boolean(focusedRouteCursorRef.current);
      if (useFollowSchedule) {
      return;
    }
      if (entry.motionRequestId) {
        pathfinderResolversRef.current.delete(entry.motionRequestId);
        pathfinderRejectorsRef.current.delete(entry.motionRequestId);
        entry.motionRequestId = undefined;
      }
      entry.motion = undefined;
      if (!nodeStep) {
        return;
      }
      entry.trackLat = position.lat;
      entry.trackLng = position.lng;
    });
    scheduleTrainMarkers();
  }, [trains, scheduleTrainMarkers]);

  useEffect(() => {
    if (!following) {
      lastScheduledPositionRef.current = null;
        return;
      }
    const focused = focusedTrainNumber;
    const target = focusedInterpolatedPosition;
    if (!focused || !target || !focusedRouteCursorRef.current) {
      lastScheduledPositionRef.current = null;
        return;
      }
    const entry = trainMarkersRef.current.get(focused);
    if (!entry || !Number.isFinite(entry.trackLat)) {
      return;
    }
    const last = lastScheduledPositionRef.current;
    if (last && last.lat === target.lat && last.lng === target.lng) {
      return;
    }
    lastScheduledPositionRef.current = { lat: target.lat, lng: target.lng };
    entry.targetLat = target.lat;
    entry.targetLng = target.lng;
    const from: Coordinate = {
      lat: entry.trackLat,
      lng: entry.trackLng,
      sequence: 0,
    };
    const moved = haversineDistance(from, target);
    if (moved < 1) {
      return;
    }
    if (readPrefersReducedMotion()) {
      entry.motion = undefined;
      entry.trackLat = target.lat;
      entry.trackLng = target.lng;
      scheduleTrainMarkers();
      return;
    }
    if (entry.motionRequestId) {
      pathfinderResolversRef.current.delete(entry.motionRequestId);
      pathfinderRejectorsRef.current.delete(entry.motionRequestId);
      entry.motionRequestId = undefined;
    }
    entry.motion = undefined;
    const cursor = focusedRouteCursorRef.current;
    const routed = (networkRoute ?? []).filter((path) => path.length > 1);
    let motionPath: Coordinate[] = [from, target];
    if (cursor?.from && cursor.to && routed.length > 0) {
      const flat = flattenNetworkRoute(routed);
      const leg = routeLegPath(flat, cursor.from, cursor.to);
      const onLeg = motionPathToward(leg, from, target);
      if (onLeg.length >= 2) {
        motionPath = onLeg;
      }
    }
    const scheduleDuration = Math.min(motionDurationMs(motionPath), 1_000);
    startTrainMotion(entry, motionPath, scheduleDuration);
    scheduleTrainMarkers();
  }, [
    following,
    focusedInterpolatedPosition,
    focusedTrainNumber,
    networkRoute,
    startTrainMotion,
    scheduleTrainMarkers,
  ]);

  useEffect(() => {
    if (following) {
      return;
    }
    const focused = focusedTrainNumber;
    if (!focused) {
      return;
    }
    const live = trains.find((train) => train.trainNumber === focused)?.position;
    const entry = trainMarkersRef.current.get(focused);
    if (!entry || !live) {
      return;
    }
    if (entry.motionRequestId) {
      pathfinderResolversRef.current.delete(entry.motionRequestId);
      pathfinderRejectorsRef.current.delete(entry.motionRequestId);
      entry.motionRequestId = undefined;
    }
    entry.motion = undefined;
    entry.trackLat = live.lat;
    entry.trackLng = live.lng;
    entry.targetLat = live.lat;
    entry.targetLng = live.lng;
    scheduleTrainMarkers();
  }, [following, focusedTrainNumber, trains, scheduleTrainMarkers]);

  rebuildTrainPointsRef.current = () => {
    const focused = focusedTrainRef.current;
    const scheduled =
      followingRef.current ? focusedInterpolatedPositionRef.current : null;
    trainPointsRef.current = trainsRef.current.flatMap((train) => {
      const position =
        train.trainNumber === focused && scheduled
          ? scheduled
          : train.position;
      if (!position) {
        return [];
      }
      if (
        !isCoordinateInsideOutline(
          { lat: position.lat, lng: position.lng },
          outlineRef.current
        )
      ) {
        return [];
      }
      const type = trainTypeCallout(train.trainType) || 'Os';
      const cursor = focusedRouteCursorRef.current;
      let heading = resolveTrainHeading({
        heading: train.heading,
        position,
      });
      if (
        train.trainNumber === focused &&
        followingRef.current &&
        cursor?.from &&
        cursor.to &&
        scheduled &&
        cursor.fraction > 0 &&
        cursor.fraction < 1
      ) {
        const routed = (networkRoute ?? []).filter((path) => path.length > 1);
        if (routed.length > 0) {
          const path = flattenNetworkRoute(routed);
          const ahead = placeOnPath(
            path,
            cursor.from,
            cursor.to,
            Math.min(1, cursor.fraction + 0.04)
          );
          heading = headingFromPoints(scheduled, ahead);
        }
      }
      return [
        {
          id: train.trainNumber,
          lat: position.lat,
          lng: position.lng,
          color: train.color || getDelayColor(train.delayMinutes),
          selected: train.trainNumber === focused,
          type,
          number: trainNumberLabel(type, train.trainNumber),
          heading,
        },
      ];
    });
  };

  publishTrainMarkersRef.current = () => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    try {
    const points = trainPointsRef.current;
    const live = trainMarkersRef.current;
    const seen = new Set<string>();
    const measured = points.map((point) => {
      seen.add(point.id);
      let entry = live.get(point.id);
      if (!entry) {
        entry = createTrainPill((trainId) => onTrainClickRef.current?.(trainId));
        live.set(point.id, entry);
      }
      entry.el.dataset.trainId = point.id;
      if (entry.lastColor !== point.color) {
        entry.el.style.backgroundColor = point.color;
        entry.el.style.color = contrastInk(point.color);
        entry.lastColor = point.color;
      }
      if (entry.lastSelected !== point.selected) {
        entry.el.classList.toggle('is-selected', point.selected);
        entry.el.style.zIndex = point.selected ? '3' : '1';
        entry.lastSelected = point.selected;
        entry.width = estimateTrainPillWidth(point.type, point.selected);
        entry.lastArrowKey = '';
      }
      if (entry.lastType !== point.type) {
        entry.typeEl.textContent = point.type;
        entry.lastType = point.type;
        entry.width = estimateTrainPillWidth(point.type, point.selected);
        entry.lastArrowKey = '';
      }
      entry.el.setAttribute('aria-label', `${point.type} ${point.number}`);
      if (!Number.isFinite(entry.trackLat)) {
        entry.trackLat = point.lat;
        entry.trackLng = point.lng;
        entry.targetLat = point.lat;
        entry.targetLng = point.lng;
        lastTrainPositionsRef.current.set(point.id, { lat: point.lat, lng: point.lng });
      } else if (!entry.motion) {
        entry.trackLat = point.lat;
        entry.trackLng = point.lng;
      }
      const trackLat = entry.trackLat;
      const trackLng = entry.trackLng;
      entry.heading = entry.motion ? entry.heading : point.heading;
      if (!entry.attached) {
        entry.marker.setLngLat([trackLng, trackLat]);
        entry.lastLng = trackLng;
        entry.lastLat = trackLat;
        entry.marker.addTo(map);
        entry.attached = true;
      }
    return {
        ...point,
        lat: trackLat,
        lng: trackLng,
        heading: entry.heading,
        radius: entry.width / 2 + (point.selected ? 1 : 0),
      };
    });
    const zoom = map.getZoom();
    const packIterations = packingIterationsForZoom(zoom);
    const spread =
      packIterations === 0
        ? measured
        : spreadOverlappingTrainPoints(
            measured,
            (lng, lat) => map.project([lng, lat]),
            (x, y) => {
              const lngLat = map.unproject([x, y]);
              return { lng: lngLat.lng, lat: lngLat.lat };
            },
            {
              radius: trainPillRadius(false),
              selectedRadius: trainPillRadius(true),
              iterations: packIterations,
            }
          );
    spread.forEach((point) => {
      const entry = live.get(point.id);
      if (!entry) {
        return;
      }
      if (entry.lastLng !== point.lng || entry.lastLat !== point.lat) {
        entry.marker.setLngLat([point.lng, point.lat]);
        entry.lastLng = point.lng;
        entry.lastLat = point.lat;
      }
      placeTrainArrow(entry);
    });
    live.forEach((entry, id) => {
      if (seen.has(id)) {
        return;
      }
      entry.marker.remove();
      live.delete(id);
    });
    } catch (error) {
      console.error('Failed to publish train pills', error);
    }
  };

  useEffect(() => {
    rebuildTrainPointsRef.current();
    publishTrainMarkersRef.current();
  }, [
    trains,
    focusedTrainNumber,
    following,
    focusedRouteCursor,
    focusedInterpolatedPosition,
    followPosition,
    networkRoute,
    svgOutlinePolygons,
    terrainLoaded,
    overlayEpoch,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map || !dataset) {
      return;
    }
    const tripCountByStop = new Map<string, number>();
    Object.values(dataset.stopTimes).forEach((list) => {
      list.forEach((entry) => {
        tripCountByStop.set(entry.stopId, (tripCountByStop.get(entry.stopId) ?? 0) + 1);
      });
    });
    const stops = Object.values(dataset.stops).filter((stop) =>
      isCoordinateInsideOutline({ lat: stop.lat, lng: stop.lng }, svgOutlinePolygons)
    );
    setSourceData(
      map,
      'stations',
      pointsToCollection(
        stops.map((stop) => ({
          id: stop.stopId,
          name: stop.name,
          lat: stop.lat,
          lng: stop.lng,
          color: railPalette(themeRef.current).fill,
          rank: stationLabelRank(stop.name, tripCountByStop.get(stop.stopId) ?? 0),
        }))
      )
    );
    selectedStationRef.current = applyStationSelection(
      map,
      focusedStationIdRef.current,
      null
    );
  }, [dataset, svgOutlinePolygons, terrainLoaded, overlayEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    selectedStationRef.current = applyStationSelection(
      map,
      focusedStationId,
      selectedStationRef.current
    );
  }, [focusedStationId, terrainLoaded, overlayEpoch]);

  useEffect(() => {
    setNetworkRoute(null);
    const waypoints = (focusedStations ?? [])
      .map((point, index) => {
        if (!point) {
      return null;
    }
        const name = (journeyStops?.[index]?.name ?? '').trim().toLowerCase();
        if (
          name.startsWith('ah ') ||
          name.startsWith('výh') ||
          name.startsWith('vyh') ||
          name.includes(' výh') ||
          name.startsWith('vlečka') ||
          name.startsWith('vlecka') ||
          name.startsWith('hranica ') ||
          name.startsWith('odb.') ||
          name.startsWith('odb ') ||
          name.endsWith(' odb.')
        ) {
      return null;
    }
        return point;
      })
      .filter((point): point is Coordinate => point != null);
    if (
      journeyStatus !== 'ready' ||
      !focusedTrainNumber ||
      waypoints.length < 2 ||
      osmGraphRef.current.size === 0
    ) {
      return;
    }
    let cancelled = false;
    const requestId = `trace-${focusedTrainNumber}-${Date.now()}`;
    const applyPath = (paths: Coordinate[][]) => {
      const usable = paths.filter((path) => path.length >= 2);
      if (!cancelled && focusedTrainRef.current === focusedTrainNumber && usable.length > 0) {
        setNetworkRoute(usable);
      }
    };
    const postTrace = (attempt: number) => {
      const worker = pathfinderWorkerRef.current;
      if (cancelled) {
        return;
      }
      if (!worker || osmGraphRef.current.size === 0 || !pathfinderGraphReadyRef.current) {
        if (attempt < 12) {
          window.setTimeout(() => postTrace(attempt + 1), 250);
        }
        return;
      }
      const resultPromise = new Promise<Coordinate[][]>((resolve, reject) => {
        pathfinderResolversRef.current.set(requestId, (result) =>
          resolve(result.paths ?? (result.path.length >= 2 ? [result.path] : []))
        );
        pathfinderRejectorsRef.current.set(requestId, reject);
        worker.postMessage({ type: 'trace', requestId, waypoints });
      });
      Promise.race([
        resultPromise,
        new Promise<Coordinate[][]>((_, reject) => {
          window.setTimeout(() => reject(new Error('trace timeout')), 15000);
        }),
      ])
        .then((paths) => {
          applyPath(paths);
        })
        .catch(() => undefined);
    };
    const timer = window.setTimeout(() => postTrace(0), osmStatus.loading ? 400 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      pathfinderResolversRef.current.delete(requestId);
      pathfinderRejectorsRef.current.delete(requestId);
    };
  }, [
    focusedTrainNumber,
    focusedStations,
    journeyStops,
    journeyStatus,
    osmGraphTick,
    osmStatus.loading,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    const routed = (networkRoute ?? []).filter((path) => path.length > 1);
    const collection = routed.length > 0 ? pathsToLineCollection(routed) : EMPTY_COLLECTION;
    const color = trains.find((train) => train.trainNumber === focusedTrainNumber)?.color ?? '#ffffff';
    collection.features.forEach((feature) => {
      feature.properties = { ...(feature.properties ?? {}), color };
    });
    setSourceData(map, 'rails-highlight', collection);
    placeRailsHighlightAboveTracks(map);
  }, [networkRoute, focusedTrainNumber, trains, terrainLoaded, overlayEpoch]);

  const lastFlownTrainRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedTrainNumber) {
      lastFlownTrainRef.current = null;
      return;
    }
    if (following) {
      return;
    }
    const map = mapRef.current;
    const train = trains.find((item) => item.trainNumber === focusedTrainNumber);
    const position = focusedInterpolatedPosition ?? train?.position;
    if (!map || !position || lastFlownTrainRef.current === focusedTrainNumber) {
      return;
    }
    lastFlownTrainRef.current = focusedTrainNumber;
    map.easeTo({
      center: [position.lng, position.lat],
      zoom: Math.max(map.getZoom(), 10),
      duration: 700,
    });
  }, [focusedTrainNumber, following, trains, focusedInterpolatedPosition]);

  useEffect(() => {
    if (!following || !focusedTrainNumber) {
      return;
    }
    const map = mapRef.current;
    const position = followPosition;
    if (!mapReadyRef.current || !map || !position || userDraggingRef.current) {
      return;
    }
    const center = map.getCenter();
    if (Math.hypot(center.lat - position.lat, center.lng - position.lng) < 0.00012) {
      return;
    }
    map.easeTo({
      center: [position.lng, position.lat],
      duration: 500,
    });
  }, [following, focusedTrainNumber, followPosition]);

  const lastFlownStationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedStationId) {
      lastFlownStationRef.current = null;
      return;
    }
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    const fromFocus = focusedStation?.id === focusedStationId ? focusedStation : null;
    const stop =
      fromFocus ??
      (() => {
        const hit =
          dataset?.stops[focusedStationId] ??
          Object.values(dataset?.stops ?? {}).find((item) => item.stopId === focusedStationId);
        return hit ? { lat: hit.lat, lng: hit.lng } : null;
      })();
    if (!stop || lastFlownStationRef.current === focusedStationId) {
      return;
    }
    lastFlownStationRef.current = focusedStationId;
    map.easeTo({
      center: [stop.lng, stop.lat],
      zoom: Math.max(map.getZoom(), 11),
      duration: 600,
    });
  }, [dataset, focusedStation, focusedStationId]);

  useEffect(() => {
    if (!mapViewRef) {
        return;
      }
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) {
      mapViewRef.current = null;
      return;
    }
    mapViewRef.current = {
      zoomIn: () => {
        map.zoomIn({ duration: 220 });
      },
      zoomOut: () => {
        map.zoomOut({ duration: 220 });
      },
      resetToSlovakia: () => {
        map.stop();
        map.easeTo({
          center: [CENTER_LNG, CENTER_LAT],
          zoom: 7,
          duration: 650,
        });
      },
      centerOn: (lng, lat, options) => {
        if (!mapReadyRef.current) {
          return;
        }
        map.stop();
        map.easeTo({
          center: [lng, lat],
          zoom: Math.max(map.getZoom(), options?.minZoom ?? 10),
          duration: 650,
        });
      },
    };
    return () => {
      mapViewRef.current = null;
    };
  }, [mapViewRef, terrainLoaded]);

  const mapReady = terrainLoaded;
  const railsReady = !osmStatus.loading && tileLoadPlan.completed > 0;
  const loadSteps = [
    { id: 'map', label: mapCopy.mapStepMap, ready: mapReady },
    { id: 'rails', label: mapCopy.mapStepRails, ready: railsReady },
    { id: 'trains', label: mapCopy.mapStepTrains, ready: trainsLoaded },
  ];
  const pendingSteps = loadSteps.filter((step) => !step.ready);
  const overlayActive = pendingSteps.length > 0;
  const canvasStateClass = overlayActive ? 'loading' : 'loaded';
  const readyCount = loadSteps.length - pendingSteps.length;
  const progressPercentage = overlayActive
    ? Math.round(((readyCount + 0.18) / loadSteps.length) * 100)
    : 100;
  const loadingLabel = pendingSteps[0]?.label ?? mapCopy.mapReady;
  const loadingRest = pendingSteps
    .slice(1)
    .map((step) => step.label)
    .join(' · ');
  useEffect(() => {
    onCanvasStateChange?.(canvasStateClass);
  }, [canvasStateClass, onCanvasStateChange]);
  
  return (
    <>
      <div className="map-scene-shell">
        <div className={`map-canvas-wrapper ${canvasStateClass}`}>
          <div ref={containerRef} className="map-view-canvas" />
          <div
            className={`map-loading-overlay ${
              overlayActive ? 'map-loading-overlay--visible' : 'map-loading-overlay--hidden'
            }`}
            aria-hidden={!overlayActive}
          >
            <div className="map-loading-card" aria-live="polite">
              <p className="map-loading-copy">
                <span className="map-loading-kicker">{mapCopy.mapLoading}</span>
                <strong className="map-loading-label">{loadingLabel}</strong>
                {loadingRest ? <span className="map-loading-rest">{loadingRest}</span> : null}
              </p>
              <div
                className="map-loading-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercentage}
                aria-valuetext={pendingSteps.map((step) => step.label).join(', ') || mapCopy.mapReady}
              >
                <div className="map-loading-bar__progress" style={{ width: `${progressPercentage}%` }} />
              </div>
              </div>
              </div>
          <div className="map-basemap-credit">
            © OpenStreetMap · © OpenFreeMap · © OpenMapTiles
          </div>
        </div>
      </div>
    {animationWarnings.length > 0 && (
      <div
        style={{
          position: 'absolute',
          top: 70,
          right: 16,
          zIndex: 3,
          padding: '0.75rem 1rem',
          borderRadius: 8,
          background: 'rgba(220, 38, 38, 0.95)',
          color: '#fff',
          fontSize: '0.9rem',
          border: '1px solid #f87171',
          maxWidth: '320px',
        }}
      >
          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{mapCopy.routeWarnings}</div>
        {animationWarnings.map((warning) => (
          <div key={warning} style={{ marginBottom: '0.25rem' }}>
            {warning}
          </div>
        ))}
      </div>
    )}
    </>
  );
});

MapScene.displayName = 'MapScene';
