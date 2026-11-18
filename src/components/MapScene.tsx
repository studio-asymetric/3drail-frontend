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
// The worker as its own file (was inlined as an ~800 kB string in the main bundle).
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Coordinate, GtfsDataset } from '../data/gtfsParser';
import {
  contrastInk,
  getDelayColor,
  isPassengerStop,
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
import { FOLLOW_FRAME_MS, LITE_MODE, RENDER_PIXEL_RATIO, TRAIN_FRAME_MS } from '../perf';
import { decodePolyline, encodePolyline, fetchTrainRoute } from '../data/routeService';
import {
  estimatedDelaySeconds,
  fetchJourneys,
  isOnBus,
  JourneyAnimator,
  timelineProgress,
} from '../data/journeyService';
import { STATION_FOCUS_ZOOM } from '../data/viewConstants';
import { PILL_HEIGHT, TrainCanvasLayer } from './trainCanvas';
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
  mergeNearbyStations,
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
/** The least the view may pan past Slovakia; zoomed out it grows with the screen (fitViewBounds). */
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
/** The full track network (sidings, yards, tunnels) starts fading in here. */
const BASEMAP_RAIL_MIN_ZOOM = 7;
const BASEMAP_RAIL_FADE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  BASEMAP_RAIL_MIN_ZOOM,
  0,
  11,
  1,
];
/**
 * Sidings, yards and tram lines are only in the tiles from zoom 14 (checked: z12/13 tiles hold
 * the main lines only), so they cannot show earlier; they fade in over the first zoom level.
 */
const DETAIL_RAIL_MIN_ZOOM = 13.9;
const DETAIL_RAIL_FADE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1];

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

/** Zoom from which timetable-driven trains move smoothly (below it they update every few seconds). */
const JOURNEY_SMOOTH_ZOOM = 9;
/** Zoom the camera moves to when a train is opened (close enough for smooth motion). */
const TRAIN_FOCUS_ZOOM = 12;
/** Extra pixels around a station dot that still hover or select it. */
const STATION_HIT_PX = 14;

type TrainMarkerEntry = {
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
  /** Position comes from the timetable model (journeyService), not the reported point. */
  journeyActive?: boolean;
  /** The train is on a replacement-bus stretch right now. */
  onBus?: boolean;
  lastSelected: boolean;
  lastType: string;
  width: number;
  /** Position handed to the canvas at the last publish (before overlap spreading). */
  drawnLat?: number;
  drawnLng?: number;
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

function createTrainEntry(): TrainMarkerEntry {
  return {
    heading: null,
    lastLng: Number.NaN,
    lastLat: Number.NaN,
    trackLat: Number.NaN,
    trackLng: Number.NaN,
    targetLat: Number.NaN,
    targetLng: Number.NaN,
    lastSelected: false,
    lastType: '',
    width: 26,
  };
}

/**
 * Cut the highlighted route where replacement buses take over: rail stretches
 * stay solid, bus stretches go to their own dashed layer. `cum` is the metres
 * along the line at each vertex of `path`.
 */
function splitRouteAtBus(
  path: Coordinate[],
  cum: ArrayLike<number>,
  ranges: Array<[number, number]>
): { solid: Coordinate[][]; bus: Coordinate[][] } {
  if (ranges.length === 0 || path.length !== cum.length || path.length < 2) {
    return { solid: [path], bus: [] };
  }
  const total = cum[cum.length - 1];
  const pointAt = (along: number): Coordinate => {
    let low = 0;
    let high = cum.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (cum[mid] <= along) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const span = cum[high] - cum[low];
    const t = span > 0 ? Math.min(1, Math.max(0, (along - cum[low]) / span)) : 0;
    return {
      lat: path[low].lat + (path[high].lat - path[low].lat) * t,
      lng: path[low].lng + (path[high].lng - path[low].lng) * t,
      sequence: 0,
    };
  };
  const slice = (from: number, to: number): Coordinate[] => {
    const points: Coordinate[] = [pointAt(from)];
    for (let index = 0; index < path.length; index += 1) {
      if (cum[index] > from && cum[index] < to) {
        points.push(path[index]);
      }
    }
    points.push(pointAt(to));
    return points.map((point, index) => ({ ...point, sequence: index + 1 }));
  };
  const solid: Coordinate[][] = [];
  const bus: Coordinate[][] = [];
  let cursor = 0;
  [...ranges]
    .sort((a, b) => a[0] - b[0])
    .forEach(([from, to]) => {
      const start = Math.max(cursor, Math.min(from, total));
      const end = Math.min(total, Math.max(to, start));
      if (start - cursor > 1) {
        solid.push(slice(cursor, start));
      }
      if (end - start > 1) {
        bus.push(slice(start, end));
      }
      cursor = end;
    });
  if (total - cursor > 1) {
    solid.push(slice(cursor, total));
  }
  return { solid, bus };
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
/** Geometry simplification when the rails are tiled (px at tile scale): under half a pixel, invisible. */
const RAIL_TILE_TOLERANCE = 0.3;

setWorkerUrl(new URL(maplibreWorkerUrl, window.location.href).href);
try {
  setWorkerCount(LITE_MODE ? 2 : Math.max(2, Math.min(4, navigator.hardwareConcurrency || 2)));
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

/** Keep the basemap north-up: no bearing, pitch, or roll from pointer or keyboard. */
function lockMapNorthUp(map: MapLibreMap) {
  map.dragRotate.disable();
  map.touchPitch.disable();
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
}

const STATION_HIT_LAYERS = [
  'stations-halo',
  'stations-casing',
  'stations-fill',
  'stations-selected',
];
const STATION_DOT_MIN_ZOOM = 10.6;
/** Dots and labels go from invisible to full over this many zoom levels. */
const STATION_FADE_ZOOM = 0.8;

/** `opacity` once the map is past the dots' minzoom, ramping up from zero. */
function stationFade(opacity: number | ExpressionSpecification): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], STATION_DOT_MIN_ZOOM, 0, STATION_DOT_MIN_ZOOM + STATION_FADE_ZOOM, opacity] as ExpressionSpecification;
}

/**
 * Pixel offset from the map's centre to the centre of the part of the map the
 * dock does not cover: to the right of the side panel on desktop, above the
 * push-up sheet on mobile. Aim the camera with it so a followed train sits in
 * the middle of what the user can actually see.
 */
function visibleOffset(map: MapLibreMap): { x: number; y: number } {
  const box = map.getContainer().getBoundingClientRect();
  const dock = document.querySelector<HTMLElement>('aside.dock:not(.is-leave)');
  if (!dock || box.width === 0 || box.height === 0) {
    return { x: 0, y: 0 };
  }
  const rect = dock.getBoundingClientRect();
  let left = 0;
  let top = 0;
  let right = box.width;
  let bottom = box.height;
  if (rect.width >= box.width * 0.85) {
    // Bottom sheet spanning the screen.
    bottom = Math.min(bottom, Math.max(top, rect.top - box.top));
  } else if (rect.right > box.left) {
    left = Math.min(right, Math.max(left, rect.right - box.left));
  }
  return { x: (left + right) / 2 - box.width / 2, y: (top + bottom) / 2 - box.height / 2 };
}

/**
 * Part of the map the dock covers, as map padding: the side panel on desktop,
 * the push-up sheet on mobile. With this padding the map's own centre (and so
 * every zoom around the centre) is the middle of what the user can see.
 */
function dockPadding(map: MapLibreMap): { top: number; bottom: number; left: number; right: number } {
  const padding = { top: 0, bottom: 0, left: 0, right: 0 };
  const box = map.getContainer().getBoundingClientRect();
  const dock = document.querySelector<HTMLElement>('aside.dock:not(.is-leave)');
  if (!dock || box.width === 0 || box.height === 0) {
    return padding;
  }
  const rect = dock.getBoundingClientRect();
  if (rect.width >= box.width * 0.85) {
    padding.bottom = Math.min(box.height * 0.9, Math.max(0, box.bottom - rect.top));
  } else if (rect.right > box.left) {
    padding.left = Math.min(box.width * 0.9, Math.max(0, rect.right - box.left));
  }
  return padding;
}

/** Apply map padding without moving the picture: the same ground stays under the same pixels. */
function setPaddingKeepView(
  map: MapLibreMap,
  padding: { top: number; bottom: number; left: number; right: number }
) {
  const box = map.getContainer();
  const cx = padding.left + (box.clientWidth - padding.left - padding.right) / 2;
  const cy = padding.top + (box.clientHeight - padding.top - padding.bottom) / 2;
  map.jumpTo({ center: map.unproject([cx, cy]), padding });
}

const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** A single pointer dragged this far (px) while following means the user is steering away. */
const FOLLOW_BREAK_SLOP_PX = 12;
/** Seconds the follow camera takes to close most of a small gap to the train. */
const FOLLOW_TAU_SECONDS = 0.22;

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
    STATION_DOT_MIN_ZOOM,
    ['case', ['boolean', ['feature-state', 'hover'], false], close * hoverGain, close],
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
  if (LITE_MODE && map.getLayer('background_relief')) {
    // Hillshade is the heaviest layer to render; weak devices go without (no DEM tiles load).
    map.setLayoutProperty('background_relief', 'visibility', 'none');
    return;
  }
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

/** The basemap style's text layers; the rails we add would otherwise be drawn over them. */
const BASEMAP_LABEL_LAYERS = ['label_water', 'label_place_names'];

function placeRailsHighlightAboveTracks(map: MapLibreMap) {
  if (!map.getLayer('rails-highlight')) {
    return;
  }
  const layers = map.getStyle()?.layers;
  if (!layers?.length) {
    return;
  }
  const isHighlight = (id: string) =>
    id === 'rails-highlight' || id === 'rails-highlight-bus-gap' || id === 'rails-highlight-bus';
  let beforeId: string | undefined;
  for (const layer of layers) {
    if (isHighlight(layer.id)) {
      continue;
    }
    if (layer.id === 'stations-halo' || layer.id.startsWith('stations-')) {
      beforeId = layer.id;
      break;
    }
  }
  try {
    map.moveLayer('rails-highlight', beforeId);
    if (map.getLayer('rails-highlight-bus-gap')) {
      map.moveLayer('rails-highlight-bus-gap', beforeId);
    }
    if (map.getLayer('rails-highlight-bus')) {
      map.moveLayer('rails-highlight-bus', beforeId);
    }
    // Place and water names read on top of every rail line, the highlighted route included.
    for (const id of BASEMAP_LABEL_LAYERS) {
      if (map.getLayer(id)) {
        map.moveLayer(id, beforeId);
      }
    }
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
      options: { dasharray?: number[]; minzoom?: number } = {}
    ) => {
      const minzoom = options.minzoom ?? BASEMAP_RAIL_MIN_ZOOM;
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
        minzoom,
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
        minzoom,
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
    addBasemapPair('basemap-rails-side', sideFilter, RAIL_SIDE_FILL, RAIL_SIDE_CASING, sideColor, DETAIL_RAIL_FADE, {
      minzoom: DETAIL_RAIL_MIN_ZOOM,
    });
    addBasemapPair(
      'basemap-rails-branch',
      branchFilter,
      RAIL_BRANCH_FILL,
      RAIL_BRANCH_CASING,
      fillColor,
      productOpacity(DETAIL_RAIL_FADE, RAIL_BRANCH_OPACITY),
      { minzoom: DETAIL_RAIL_MIN_ZOOM }
    );
    addBasemapPair('basemap-rails-tram', tramFilter, RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, fillColor, DETAIL_RAIL_FADE, {
      minzoom: DETAIL_RAIL_MIN_ZOOM,
    });
    addBasemapPair('basemap-rails-tram-tunnel', tramTunnelFilter, RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, fillColor, DETAIL_RAIL_FADE, {
      dasharray: [2.4, 2.1],
      minzoom: DETAIL_RAIL_MIN_ZOOM,
    });
    addBasemapPair('basemap-rails-main', mainFilter, RAIL_MAIN_FILL, RAIL_MAIN_CASING, mainFillColor, BASEMAP_RAIL_FADE);
    addBasemapPair('basemap-rails-tunnel', tunnelFilter, RAIL_MAIN_FILL, RAIL_MAIN_CASING, mainFillColor, BASEMAP_RAIL_FADE, {
      dasharray: [2.6, 2.2],
    });
  }

  ensureSource('stations', { maxzoom: 14, tolerance: 0, buffer: 16, promoteId: 'id' });
  ensureSource('stations-hover', { maxzoom: 16, tolerance: 0, buffer: 64 });
  ensureSource('rails-highlight', { maxzoom: 16, tolerance: 0.35 });
  ensureSource('rails-highlight-bus', { maxzoom: 16, tolerance: 0.35 });
  ensureSource('rails-simplified-main', { maxzoom: 14, tolerance: RAIL_TILE_TOLERANCE });
  ensureSource('rails-simplified-branch', { maxzoom: 14, tolerance: RAIL_TILE_TOLERANCE });
  ensureSource('rails-simplified-side', { maxzoom: 14, tolerance: RAIL_TILE_TOLERANCE });

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
  for (const legacy of ['stations-label-selected', 'stations-label-hover']) {
    if (map.getLayer(legacy)) {
      map.removeLayer(legacy);
    }
  }
  const labelFont = stationLabelFont(map);
  const labelLayout = {
    'text-font': labelFont,
    'text-field': ['coalesce', ['get', 'name'], ''],
    'text-size': ['interpolate', ['linear'], ['zoom'], STATION_DOT_MIN_ZOOM, 10, 12.8, 10.5, 14, 12, 16, 13],
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
      'circle-radius': stationCircleRadius([6.4, 8.4, 12, 1.35]),
      'circle-color': fillColor,
      'circle-opacity': stationFade([
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.42,
        ['boolean', ['feature-state', 'selected'], false],
        0.3,
        0.13,
      ]),
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
      'circle-radius': stationCircleRadius([3.2, 3.6, 4.8, 1.18]),
      'circle-color': casingColor,
      'circle-opacity': stationFade(1),
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-fill',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([2.2, 2.5, 3.35, 1.18]),
      'circle-color': fillColor,
      'circle-opacity': stationFade(1),
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-selected',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([5, 6.2, 8, 1.08]),
      'circle-color': '#fddf57',
      'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2, 0],
      'circle-stroke-color': casingColor,
      'circle-pitch-alignment': 'map',
    },
  });
  // One size per rank, shared by the resting, selected and hover labels, so a label
  // that swaps to its hover copy never changes size or reveals another one behind it.
  const rankTextSize: Record<1 | 2 | 3, ExpressionSpecification> = {
    3: ['interpolate', ['linear'], ['zoom'], STATION_DOT_MIN_ZOOM, 10.5, 13, 11, 14, 13, 16, 14],
    2: ['interpolate', ['linear'], ['zoom'], STATION_DOT_MIN_ZOOM, 10, 12.8, 10.5, 14, 12, 16, 13],
    1: ['interpolate', ['linear'], ['zoom'], STATION_DOT_MIN_ZOOM, 9.5, 13, 10.5, 15, 12],
  };
  const labelRanks: Array<[1 | 2 | 3, string]> = [
    [3, 'major'],
    [2, 'mid'],
    [1, 'minor'],
  ];
  labelRanks.forEach(([rank, name]) => {
    upsertLayer({
      id: `stations-label-${name}`,
      type: 'symbol',
      source: 'stations',
      minzoom: STATION_DOT_MIN_ZOOM,
      filter: ['==', ['get', 'rank'], rank],
      layout: { ...labelLayout, 'text-size': rankTextSize[rank] },
      paint: { ...labelPaint, 'text-opacity': stationFade(hideLabelWhenHovered) },
    });
  });
  labelRanks.forEach(([rank, name]) => {
    upsertLayer({
      id: `stations-label-selected-${name}`,
      type: 'symbol',
      source: 'stations',
      minzoom: STATION_DOT_MIN_ZOOM,
      filter: ['==', ['get', 'rank'], rank],
      layout: {
        ...labelLayout,
        'text-size': rankTextSize[rank],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { ...labelPaint, 'text-opacity': showSelectedUnlessHovered },
    });
  });
  labelRanks.forEach(([rank, name]) => {
    upsertLayer({
      id: `stations-label-hover-${name}`,
      type: 'symbol',
      source: 'stations-hover',
      minzoom: STATION_DOT_MIN_ZOOM,
      filter: ['==', ['get', 'rank'], rank],
      layout: {
        ...labelLayout,
        'text-size': rankTextSize[rank],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-optional': false,
      },
      paint: labelPaint,
    });
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
  // Replacement-bus stretches of the highlighted route: dashed, same colour, with white
  // between the dashes (a solid white line underneath hides the track that runs there).
  upsertLayer({
    id: 'rails-highlight-bus-gap',
    type: 'line',
    source: 'rails-highlight-bus',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': HIGHLIGHT_LINE_WIDTH,
      'line-opacity': 0.95,
    },
  });
  upsertLayer({
    id: 'rails-highlight-bus',
    type: 'line',
    source: 'rails-highlight-bus',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ffffff'],
      'line-width': HIGHLIGHT_LINE_WIDTH,
      'line-opacity': 0.95,
      'line-dasharray': [1.1, 1.3],
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
  /** Where the focused train is on the stop list (passenger stops), for the timeline. */
  onTimelineProgress?: (progress: { train: string; from: number; fraction: number } | null) => void;
  /** A report moved the followed train far from where it was shown. */
  onFollowCorrection?: (correction: { train: string; meters: number }) => void;
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
  onTimelineProgress,
  onFollowCorrection,
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
  // Ways for the in-browser fallback graph. The graph is only built (and sent to
  // the worker) if the server route call fails, so normal loads skip it.
  const pathfindingWaysRef = useRef<OSMWay[]>([]);
  const workerGraphPostedRef = useRef(false);
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
  const onTimelineProgressRef = useRef(onTimelineProgress);
  onTimelineProgressRef.current = onTimelineProgress;
  const onFollowCorrectionRef = useRef(onFollowCorrection);
  onFollowCorrectionRef.current = onFollowCorrection;
  const journeyStopsRef = useRef(journeyStops);
  journeyStopsRef.current = journeyStops;
  const lastTimelineRef = useRef('');
  const followingRef = useRef(following);
  followingRef.current = following;
  const followPositionRef = useRef<Coordinate | null>(null);
  const publishTrainMarkersRef = useRef<() => void>(() => undefined);
  const trainMarkersRef = useRef<Map<string, TrainMarkerEntry>>(new Map());
  const trainCanvasRef = useRef<TrainCanvasLayer | null>(null);
  const lastTrainPositionsRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const trainNodeStampRef = useRef<Map<string, string>>(new Map());
  const lastScheduledPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const trainMotionRafRef = useRef(0);
  const journeyAnimatorRef = useRef(new JourneyAnimator());
  const [journeysVersion, setJourneysVersion] = useState(0);
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

  /** Build the fallback graph and hand it to the worker, once per network load. */
  const ensureWorkerGraph = useCallback((): boolean => {
    const worker = pathfinderWorkerRef.current;
    if (!worker || pathfindingWaysRef.current.length === 0) {
      return false;
    }
    if (workerGraphPostedRef.current) {
      return true;
    }
    if (osmGraphRef.current.size === 0) {
      resetSpatialIndex();
      extendOsmGraph(osmGraphRef.current, pathfindingWaysRef.current);
    }
    pathfinderGraphReadyRef.current = false;
    worker.postMessage({
      type: 'initGraph',
      graph: serializeOsmGraph(osmGraphRef.current),
    });
    workerGraphPostedRef.current = true;
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadNetwork = async () => {
      if (svgOutlinePolygons.length === 0) {
          return;
        }
      setOsmStatus((prev) => ({ ...prev, loading: true, lastStatus: 'loading' }));
      setTileLoadPlan({ total: 1, completed: 0 });
      appendLoadingMessage('Loading OSM rails');
      // Download, clip, stitch and classify in a worker: on the page this froze the UI for
      // about a second at startup. Falls back to doing it here if workers are unavailable.
      const prepared = await new Promise<
        { display: OSMWay[]; pathfinding: OSMWay[]; meta?: OsmProxyMeta } | null
      >((resolve) => {
        let worker: Worker;
        try {
          worker = new Worker(new URL('../workers/railPrep.worker.ts', import.meta.url), { type: 'module' });
        } catch {
          resolve(null);
          return;
        }
        worker.onmessage = (event) => {
          worker.terminate();
          resolve(event.data?.ok ? event.data : null);
        };
        worker.onerror = () => {
          worker.terminate();
          resolve(null);
        };
        worker.postMessage({ outline: svgOutlinePolygons });
      });
      if (cancelled) {
        return;
      }
      let filtered: OSMWay[];
      let pathfinding: OSMWay[];
      let meta: OsmProxyMeta | undefined;
      if (prepared) {
        filtered = prepared.display;
        pathfinding = prepared.pathfinding;
        meta = prepared.meta;
      } else {
        let ways: OSMWay[] = [];
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
        const stitched = closeRailGaps(clipWaysToOutline(ways, svgOutlinePolygons));
        filtered = classifyDisplayRails(stitched);
        pathfinding = stitched.filter(isPathfindingWay);
      }
      osmWaysRef.current = new Map();
      simplifiedWaysRef.current = filtered;
      filtered.forEach((way) => osmWaysRef.current.set(way.id, way));
      osmGraphRef.current = new Map();
      pathfindingWaysRef.current = pathfinding;
      workerGraphPostedRef.current = false;
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
      bearing: 0,
      pitch: 0,
      roll: 0,
      minPitch: 0,
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      maxBounds: [
        [SLOVAKIA_BOUNDS.minLng - MAP_VIEW_BOUNDS_PAD.lng, SLOVAKIA_BOUNDS.minLat - MAP_VIEW_BOUNDS_PAD.lat],
        [SLOVAKIA_BOUNDS.maxLng + MAP_VIEW_BOUNDS_PAD.lng, SLOVAKIA_BOUNDS.maxLat + MAP_VIEW_BOUNDS_PAD.lat],
      ],
      attributionControl: false,
      pixelRatio: RENDER_PIXEL_RATIO,
      fadeDuration: 0,
      maxParallelImageRequests: 12,
      maxTileCacheZoomLevels: 8,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      (window as unknown as { __railMap?: MapLibreMap }).__railMap = map;
    }
    lockMapNorthUp(map);
    // The further out the map is, the wider the screen is compared to the country: let the
    // view slide far enough to bring any train out from behind the side panel / mobile sheet.
    // Recomputed only when the zoom moved a quarter level (or on resize), not every zoom frame.
    let boundsZoom = -1;
    const fitViewBounds = (event?: { type?: string }) => {
      const { clientWidth: width, clientHeight: height } = node;
      if (!width || !height) {
        return;
      }
      const zoomNow = map.getZoom();
      if (event?.type === 'zoom' && Math.abs(zoomNow - boundsZoom) < 0.25) {
        return;
      }
      boundsZoom = zoomNow;
      const spanLng = Math.abs(map.unproject([width, height / 2]).lng - map.unproject([0, height / 2]).lng);
      const spanLat = Math.abs(map.unproject([width / 2, 0]).lat - map.unproject([width / 2, height]).lat);
      const padWest = Math.max(MAP_VIEW_BOUNDS_PAD.lng, spanLng * 0.45);
      const padEast = Math.max(MAP_VIEW_BOUNDS_PAD.lng, spanLng * 0.8);
      const padLat = Math.max(MAP_VIEW_BOUNDS_PAD.lat, spanLat * 0.55);
      map.setMaxBounds([
        [SLOVAKIA_BOUNDS.minLng - padWest, SLOVAKIA_BOUNDS.minLat - padLat],
        [SLOVAKIA_BOUNDS.maxLng + padEast, SLOVAKIA_BOUNDS.maxLat + padLat],
      ]);
    };
    map.on('zoom', fitViewBounds);
    map.on('resize', () => fitViewBounds());
    map.once('load', () => fitViewBounds());
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
    /** Nearest station within STATION_HIT_PX of the pointer (dots are tiny on their own). */
    const stationNear = (point: { x: number; y: number }) => {
      const layers = STATION_HIT_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId)));
      if (layers.length === 0) {
        return undefined;
      }
      const hits = map.queryRenderedFeatures(
        [
          [point.x - STATION_HIT_PX, point.y - STATION_HIT_PX],
          [point.x + STATION_HIT_PX, point.y + STATION_HIT_PX],
        ],
        { layers }
      );
      let best: (typeof hits)[number] | undefined;
      let bestDistance = Infinity;
      hits.forEach((hit) => {
        if (hit.geometry?.type !== 'Point') {
          return;
        }
        const [lng, lat] = hit.geometry.coordinates as [number, number];
        const projected = map.project([lng, lat]);
        const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (distance <= STATION_HIT_PX && distance < bestDistance) {
          best = hit;
          bestDistance = distance;
        }
      });
      return best;
    };
    const handleStationMove = (event: MapLayerMouseEvent) => {
      const feature = stationNear(event.point);
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
      const feature = stationNear(event.point);
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
    const handleBackgroundClick = (event: MapLayerMouseEvent) => {
      if (stationNear(event.point)) {
        handleStationClick(event);
        return;
      }
      onBackgroundClickRef.current?.();
    };
    map.on('click', handleBackgroundClick);
    const breakDistancePx = () => {
      const node = map.getContainer();
      return Math.max(72, Math.min(node.clientWidth, node.clientHeight) * 0.18);
    };
    // A drag the user starts ends following right away (the camera is then free).
    const handleDragStart = (event: { originalEvent?: Event }) => {
      if (followingRef.current && event.originalEvent) {
        onFollowBreakRef.current?.();
      }
    };
    map.on('dragstart', handleDragStart);
    return () => {
      cancelled = true;
      if (trainPublishRafRef.current) {
        window.cancelAnimationFrame(trainPublishRafRef.current);
        trainPublishRafRef.current = 0;
      }
      trainCanvasRef.current?.destroy();
      trainCanvasRef.current = null;
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
    // Trains with a stored journey are moved (and followed) by the journey loop.
    if (journeyAnimatorRef.current.isActive(focusedTrainNumber)) {
      return null;
    }
    const { from, to, fraction, position } = focusedRouteCursor;
    const routed = (networkRoute ?? []).filter((path) => path.length > 1);
    if (routed.length > 0 && from && to) {
      const path = flattenNetworkRoute(routed);
      return placeOnPath(path, from, to, fraction);
    }
    return position;
  }, [following, focusedTrainNumber, focusedRouteCursor, networkRoute, journeysVersion, trains]);
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
      if (!nodeStep || entry.journeyActive) {
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
        entry = createTrainEntry();
        live.set(point.id, entry);
      }
      if (entry.lastSelected !== point.selected || entry.lastType !== point.type) {
        entry.lastSelected = point.selected;
        entry.lastType = point.type;
        entry.width = estimateTrainPillWidth(point.type, point.selected);
      }
      if (!Number.isFinite(entry.trackLat)) {
        entry.trackLat = point.lat;
        entry.trackLng = point.lng;
        entry.targetLat = point.lat;
        entry.targetLng = point.lng;
        lastTrainPositionsRef.current.set(point.id, { lat: point.lat, lng: point.lng });
      } else if (!entry.motion && !entry.journeyActive) {
        entry.trackLat = point.lat;
        entry.trackLng = point.lng;
      }
      const trackLat = entry.trackLat;
      const trackLng = entry.trackLng;
      entry.drawnLat = trackLat;
      entry.drawnLng = trackLng;
      entry.heading = entry.motion || entry.journeyActive ? entry.heading : point.heading;
    return {
        ...point,
        lat: trackLat,
        lng: trackLng,
        heading: entry.heading,
        radius: entry.width / 2 + (point.selected ? 1 : 0),
        halfHeight: PILL_HEIGHT / 2 + (point.selected ? 1 : 0),
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
    if (!trainCanvasRef.current) {
      trainCanvasRef.current = new TrainCanvasLayer(map, (trainId) => onTrainClickRef.current?.(trainId));
    }
    const homeOf = new Map(measured.map((item) => [item.id, item]));
    trainCanvasRef.current.setPills(
      spread.map((point) => {
        const entry = live.get(point.id);
        const home = homeOf.get(point.id);
        if (entry) {
          entry.lastLng = point.lng;
          entry.lastLat = point.lat;
        }
        // A train running by replacement bus shows BUS on its pill.
        const shownType = entry?.onBus ? 'BUS' : point.type;
        return {
          id: point.id,
          lng: point.lng,
          lat: point.lat,
          homeLng: home?.lng,
          homeLat: home?.lat,
          type: shownType,
          color: point.color,
          selected: point.selected,
          heading: point.heading ?? null,
          label: `${shownType} ${point.number}`,
        };
      })
    );
    live.forEach((_, id) => {
      if (!seen.has(id)) {
        live.delete(id);
      }
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
    const stops = mergeNearbyStations(
      Object.values(dataset.stops).filter((stop) =>
        isCoordinateInsideOutline({ lat: stop.lat, lng: stop.lng }, svgOutlinePolygons)
      ),
      (stop) => stop.tripCount ?? tripCountByStop.get(stop.stopId) ?? 0
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
          rank: stationLabelRank(
            stop.name,
            stop.tripCount ?? tripCountByStop.get(stop.stopId) ?? 0
          ),
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

  // Waypoints for the traced route. Prefer the points mapa.zsr.sk lists for the
  // train (stations and junctions, exact coordinates); fall back to matching the
  // journey's station names against the station list.
  const focusedStopPath = useMemo(
    () => trains.find((train) => train.trainNumber === focusedTrainNumber)?.stopPath ?? null,
    [trains, focusedTrainNumber]
  );
  const focusedStopPathKey = useMemo(
    () => (focusedStopPath && focusedStopPath.length >= 2 ? encodePolyline(focusedStopPath) : ''),
    [focusedStopPath]
  );
  const traceKey = useMemo(() => {
    if (!focusedTrainNumber) {
      return '';
    }
    if (focusedStopPathKey) {
      return focusedStopPathKey;
    }
    if (journeyStatus !== 'ready') {
      return '';
    }
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
    return waypoints.length >= 2 ? encodePolyline(waypoints) : '';
  }, [focusedTrainNumber, focusedStopPathKey, focusedStations, journeyStops, journeyStatus]);

  useEffect(() => {
    setNetworkRoute(null);
    const waypoints = traceKey ? decodePolyline(traceKey) : [];
    if (!focusedTrainNumber || waypoints.length < 2) {
      return;
    }
    let cancelled = false;
    const requestId = `trace-${focusedTrainNumber}-${Date.now()}`;
    const routeAbort = new AbortController();
    const applyPath = (paths: Coordinate[][]) => {
      const usable = paths.filter((path) => path.length >= 2);
      if (!cancelled && focusedTrainRef.current === focusedTrainNumber && usable.length > 0) {
        setNetworkRoute(usable);
      }
    };
    // Fallback: trace in the browser worker when the proxy cannot answer.
    const postTrace = (attempt: number) => {
      const worker = pathfinderWorkerRef.current;
      if (cancelled) {
        return;
      }
      const posted = ensureWorkerGraph();
      if (!worker || !posted || !pathfinderGraphReadyRef.current) {
        if (attempt < 40) {
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
    const stored = journeyAnimatorRef.current.journey(focusedTrainNumber);
    if (stored && stored.ok) {
      const line: Coordinate[] = [];
      for (let index = 0; index < stored.lat.length; index += 1) {
        line.push({ lat: stored.lat[index], lng: stored.lng[index], sequence: index + 1 });
      }
      applyPath([line]);
      return () => {
        cancelled = true;
        routeAbort.abort();
      };
    }
    fetchTrainRoute(waypoints, routeAbort.signal)
      .then((route) => {
        if (cancelled) {
          return;
        }
        if (route.segments.length === 0) {
          throw new Error('empty route');
        }
        applyPath(route.segments);
      })
      .catch(() => {
        if (!cancelled) {
          postTrace(0);
        }
      });
    return () => {
      cancelled = true;
      routeAbort.abort();
      pathfinderResolversRef.current.delete(requestId);
      pathfinderRejectorsRef.current.delete(requestId);
    };
  }, [focusedTrainNumber, traceKey, ensureWorkerGraph, journeysVersion]);

  // --- Timetable-driven positions -------------------------------------------
  // Load every running train's route + timetable from the proxy, then move the
  // pills along the rails between ZSR's position reports.
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const journeys = await fetchJourneys(controller.signal);
        if (cancelled || !journeys) {
          return;
        }
        journeyAnimatorRef.current.setJourneys(journeys);
        journeyAnimatorRef.current.update(trainsRef.current);
        setJourneysVersion((value) => value + 1);
      } catch {
        // keep showing reported positions
      }
    };
    load();
    const timer = window.setInterval(load, 2 * 60 * 1000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    journeyAnimatorRef.current.update(trains);
  }, [trains, journeysVersion]);

  // The opened train: run it on the delay its side panel shows (ZSR's estimated times).
  useEffect(() => {
    const animator = journeyAnimatorRef.current;
    if (!focusedTrainNumber || journeyStatus !== 'ready' || !journeyStops?.length) {
      return;
    }
    animator.setEstimate(focusedTrainNumber, estimatedDelaySeconds(journeyStops));
    animator.update(trainsRef.current);
    return () => {
      animator.setEstimate(focusedTrainNumber, null);
    };
  }, [focusedTrainNumber, journeyStatus, journeyStops]);

  useEffect(() => {
    let raf = 0;
    let lastRun = 0;
    const tick = (frameMs: number) => {
      raf = window.requestAnimationFrame(tick);
      const map = mapRef.current;
      if (!mapReadyRef.current || !map) {
        return;
      }
      const zoom = map.getZoom();
      // Smooth motion only when zoomed in; far out, refresh positions every few seconds.
      // Every frame while following, so the pill and the camera move together.
      const interval = followingRef.current
        ? FOLLOW_FRAME_MS
        : zoom >= 11
          ? TRAIN_FRAME_MS
          : zoom >= JOURNEY_SMOOTH_ZOOM
            ? 200
            : 4000;
      if (frameMs - lastRun < interval) {
        return;
      }
      lastRun = frameMs;
      const animator = journeyAnimatorRef.current;
      const now = Date.now();
      const followed = followingRef.current ? focusedTrainRef.current : null;
      let changed = false;
      const focusedId = focusedTrainRef.current;
      // Only redraw when a train on screen moved a visible amount (a third of a pixel), so
      // zoomed in the ~130 pills are not re-packed and re-drawn 25 times a second for nothing.
      const view = map.getBounds();
      const degPerPx = 360 / (512 * 2 ** zoom);
      const margin = degPerPx * 60;
      const west = view.getWest() - margin;
      const east = view.getEast() + margin;
      const south = view.getSouth() - margin;
      const north = view.getNorth() + margin;
      const onScreen = (lat: number, lng: number) => lat >= south && lat <= north && lng >= west && lng <= east;
      const visibleStep = degPerPx / 3;
      trainMarkersRef.current.forEach((entry, id) => {
        const position = animator.position(id, now);
        if (position && id === followed) {
          followPositionRef.current = { lat: position.lat, lng: position.lng, sequence: 0 };
        }
        if (position && id === focusedId) {
          const journey = animator.journey(id);
          const rows = (journeyStopsRef.current ?? []).filter(isPassengerStop);
          const progress = journey ? timelineProgress(journey, rows, position.along) : null;
          // Quantised, so the panel only re-renders when the line visibly moves.
          const key = progress ? `${id}:${progress.from}:${Math.round(progress.fraction * 200)}` : `${id}:none`;
          if (key !== lastTimelineRef.current) {
            lastTimelineRef.current = key;
            onTimelineProgressRef.current?.(progress ? { train: id, ...progress } : null);
          }
        }
        if (position) {
          const ownJourney = animator.journey(id);
          const onBus = ownJourney ? isOnBus(ownJourney, position.along) : false;
          const moved =
            !entry.journeyActive ||
            entry.onBus !== onBus ||
            entry.drawnLat == null ||
            entry.drawnLng == null ||
            ((onScreen(position.lat, position.lng) || onScreen(entry.drawnLat, entry.drawnLng)) &&
              (Math.abs(position.lat - entry.drawnLat) > visibleStep ||
                Math.abs(position.lng - entry.drawnLng) > visibleStep ||
                (position.heading != null && Math.abs(position.heading - (entry.heading ?? 0)) > 2)));
          entry.onBus = onBus;
          entry.trackLat = position.lat;
          entry.trackLng = position.lng;
          if (position.heading != null) {
            entry.heading = position.heading;
          }
          entry.motion = undefined;
          entry.journeyActive = true;
          if (moved || id === followed) {
            changed = true;
          }
        } else if (entry.journeyActive) {
          entry.journeyActive = false;
          entry.trackLat = entry.targetLat;
          entry.trackLng = entry.targetLng;
          changed = true;
        }
      });
      if (changed) {
        publishTrainMarkersRef.current();
      }
      for (const correction of animator.takeCorrections()) {
        if (correction.train === followed && Math.abs(correction.meters) > 1500) {
          onFollowCorrectionRef.current?.(correction);
        }
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    let routed = (networkRoute ?? []).filter((path) => path.length > 1);
    let busPaths: Coordinate[][] = [];
    const stored = focusedTrainNumber ? journeyAnimatorRef.current.journey(focusedTrainNumber) : undefined;
    if (stored && stored.bus.length > 0 && routed.length === 1) {
      const split = splitRouteAtBus(routed[0], stored.cum, stored.bus);
      routed = split.solid.filter((path) => path.length > 1);
      busPaths = split.bus;
    }
    const color = trains.find((train) => train.trainNumber === focusedTrainNumber)?.color ?? '#ffffff';
    const painted = (paths: Coordinate[][]) => {
      const collection = paths.length > 0 ? pathsToLineCollection(paths) : EMPTY_COLLECTION;
      collection.features.forEach((feature) => {
        feature.properties = { ...(feature.properties ?? {}), color };
      });
      return collection;
    };
    setSourceData(map, 'rails-highlight', painted(routed));
    setSourceData(map, 'rails-highlight-bus', painted(busPaths));
    placeRailsHighlightAboveTracks(map);
  }, [networkRoute, focusedTrainNumber, trains, terrainLoaded, overlayEpoch, journeysVersion]);

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
    // Where the pill is drawn (timetable model), not the last station ZSR reported.
    const modelled = journeyAnimatorRef.current.peek(focusedTrainNumber);
    const position = modelled ?? focusedInterpolatedPosition ?? train?.position;
    if (!map || !position || lastFlownTrainRef.current === focusedTrainNumber) {
      return;
    }
    lastFlownTrainRef.current = focusedTrainNumber;
    const duration = 700;
    // Aim where the train will be when the camera arrives.
    const ahead = modelled ? journeyAnimatorRef.current.lookahead(focusedTrainNumber, duration / 1000) : null;
    const target = ahead ?? position;
    const offset = visibleOffset(map);
    map.easeTo({
      center: [target.lng, target.lat],
      zoom: Math.max(map.getZoom(), TRAIN_FOCUS_ZOOM),
      // Land the train in the middle of the area the dock leaves free.
      offset: [offset.x, offset.y],
      duration,
    });
  }, [focusedTrainNumber, following, trains, focusedInterpolatedPosition]);

  // Follow camera. Every frame the camera eases a little closer to the train, so
  // it glides back after a drag or when following starts far from the train
  // instead of snapping. The map is padded by what the dock covers, so its centre
  // (and every zoom around the centre) is the middle of the visible area.
  useEffect(() => {
    if (!following || !focusedTrainNumber) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const trainId = focusedTrainNumber;
    // Scroll, pinch, keyboard and buttons zoom around the train, not the pointer.
    map.scrollZoom.disable();
    map.scrollZoom.enable({ around: 'center' });
    map.touchZoomRotate.disable();
    map.touchZoomRotate.enable({ around: 'center' });
    map.touchZoomRotate.disableRotation();
    map.doubleClickZoom.disable();
    const handleDoubleClick = (event: { preventDefault: () => void }) => {
      event.preventDefault();
      map.zoomIn({ duration: 300 });
    };
    map.on('dblclick', handleDoubleClick);

    // jumpTo() stops any gesture in progress, so while a finger or mouse button is down
    // the camera must be left alone, or the user could never steer away from the train.
    const surface = map.getCanvasContainer();
    // Pressed pointers and where each went down. One pointer that travels past the slop is
    // the user steering away: following ends at once (two fingers are a pinch, which keeps it).
    const pressed = new Map<number, { x: number; y: number }>();
    let pointerDown = false;
    let broke = false;
    const onPointerDown = (event: PointerEvent) => {
      pressed.set(event.pointerId, { x: event.clientX, y: event.clientY });
      pointerDown = true;
    };
    const onPointerMove = (event: PointerEvent) => {
      const start = pressed.get(event.pointerId);
      if (!start || pressed.size !== 1 || broke) {
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > FOLLOW_BREAK_SLOP_PX) {
        broke = true;
        onFollowBreakRef.current?.();
      }
    };
    const onPointerUp = (event?: PointerEvent) => {
      if (event && 'pointerId' in event) {
        pressed.delete(event.pointerId);
      } else {
        pressed.clear();
      }
      pointerDown = pressed.size > 0;
    };
    surface.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    const onBlur = () => onPointerUp();
    window.addEventListener('blur', onBlur);

    let raf = 0;
    let lastFrame = performance.now();
    // Time not yet spent on a camera move: small moves are skipped (a whole map redraw for a
    // fraction of a pixel) and the time carries over until the step is worth drawing.
    let pendingDt = 0;
    // The dock's size is read from the DOM; it only changes on open/resize/sheet drag.
    let cachedPadding = dockPadding(map);
    let paddingReadAt = 0;
    const step = (frameMs: number) => {
      raf = window.requestAnimationFrame(step);
      const frameDt = Math.min(0.1, Math.max(0, (frameMs - lastFrame) / 1000));
      lastFrame = frameMs;
      if (!mapReadyRef.current || pointerDown || map.isMoving()) {
        pendingDt = 0;
        return;
      }
      pendingDt = Math.min(0.25, pendingDt + frameDt);
      const dt = pendingDt;
      if (frameMs - paddingReadAt > 200) {
        cachedPadding = dockPadding(map);
        paddingReadAt = frameMs;
      }
      const padding = cachedPadding;
      const current = map.getPadding();
      const paddingChanged =
        Math.abs(padding.top - (current.top ?? 0)) > 0.5 ||
        Math.abs(padding.bottom - (current.bottom ?? 0)) > 0.5 ||
        Math.abs(padding.left - (current.left ?? 0)) > 0.5 ||
        Math.abs(padding.right - (current.right ?? 0)) > 0.5;
      const box = map.getContainer();
      // Where the camera looks now; a padding change keeps the picture where it is.
      const here = paddingChanged
        ? map.unproject([
            padding.left + (box.clientWidth - padding.left - padding.right) / 2,
            padding.top + (box.clientHeight - padding.top - padding.bottom) / 2,
          ])
        : map.getCenter();
      const animator = journeyAnimatorRef.current;
      // Aim a moment ahead: the smoothing lags by about that long, so the pill stays centred.
      const target = animator.isActive(trainId)
        ? animator.lookahead(trainId, FOLLOW_TAU_SECONDS)
        : followPositionRef.current;
      if (!target) {
        if (paddingChanged) {
          map.jumpTo({ center: here, padding });
        }
        pendingDt = 0;
        return;
      }
      const targetPx = map.project([target.lng, target.lat]);
      const herePx = map.project(here);
      const gap = Math.hypot(targetPx.x - herePx.x, targetPx.y - herePx.y);
      if (gap < 0.15) {
        if (paddingChanged) {
          map.jumpTo({ center: [target.lng, target.lat], padding });
        }
        pendingDt = 0;
        return;
      }
      // Far away: a longer, softer glide. Close: tight enough to track at speed.
      const tau = FOLLOW_TAU_SECONDS + Math.min(0.7, gap / 2500);
      const k = 1 - Math.exp(-dt / tau);
      if (!paddingChanged && (gap * k < 0.5 || dt * 1000 < FOLLOW_FRAME_MS)) {
        return;
      }
      pendingDt = 0;
      map.jumpTo({
        center: [here.lng + (target.lng - here.lng) * k, here.lat + (target.lat - here.lat) * k],
        padding,
      });
    };
    raf = window.requestAnimationFrame(step);

    return () => {
      window.cancelAnimationFrame(raf);
      map.off('dblclick', handleDoubleClick);
      surface.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('blur', onBlur);
      try {
        map.scrollZoom.disable();
        map.scrollZoom.enable();
        map.touchZoomRotate.disable();
        map.touchZoomRotate.enable();
        map.touchZoomRotate.disableRotation();
        map.doubleClickZoom.enable();
      } catch {
        // the map was already removed
      }
      // Give the map its own centre back without moving the picture. jumpTo cancels a
      // drag in progress, so when the user is steering away it waits for the release
      // (and for the drag's coasting to finish).
      const resetPadding = () => {
        try {
          const padding = map.getPadding();
          if ((padding.top ?? 0) || (padding.bottom ?? 0) || (padding.left ?? 0) || (padding.right ?? 0)) {
            setPaddingKeepView(map, NO_PADDING);
          }
        } catch {
          // the map was already removed
        }
      };
      if (pointerDown) {
        const afterRelease = () => {
          window.removeEventListener('pointerup', afterRelease, true);
          window.removeEventListener('pointercancel', afterRelease, true);
          window.setTimeout(() => {
            if (map.isMoving()) {
              map.once('moveend', resetPadding);
            } else {
              resetPadding();
            }
          }, 60);
        };
        window.addEventListener('pointerup', afterRelease, true);
        window.addEventListener('pointercancel', afterRelease, true);
      } else {
        resetPadding();
      }
    };
  }, [following, focusedTrainNumber]);

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
    const offset = visibleOffset(map);
    map.easeTo({
      center: [stop.lng, stop.lat],
      // Close enough to see side tracks and the station's layout.
      zoom: Math.max(map.getZoom(), STATION_FOCUS_ZOOM),
      // Centre it in the part of the map the dock leaves free.
      offset: [offset.x, offset.y],
      duration: 700,
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
        const offset = visibleOffset(map);
        map.easeTo({
          center: [lng, lat],
          zoom: Math.max(map.getZoom(), options?.minZoom ?? 10),
          offset: [offset.x, offset.y],
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
