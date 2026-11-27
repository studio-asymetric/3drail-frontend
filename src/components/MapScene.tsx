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
  VEHICLE_MAP_PILL_COLOR,
  vehicleInk,
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
  estimatedDelayProfile,
  estimatedDelaySeconds,
  fetchJourneys,
  journeysBuilding,
  isOnBus,
  JourneyAnimator,
  timelineProgress,
} from '../data/journeyService';
import { STATION_FOCUS_ZOOM } from '../data/viewConstants';
import { PILL_HEIGHT, TrainCanvasLayer } from './trainCanvas';
import { screenProjection } from '../data/screenProjection';
import { PERF_HUD, perfAdd, startPerfHud } from '../perfHud';
import { fetchSlovakiaOutline } from '../data/slovakiaOutlineService';
import type { TransitStop } from '../data/transitStops';
import { groupStations } from '../data/stationGroups';
import { REGION, REGION_ID } from '../region';
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

/** What the view may pan over: the region on this page (Slovakia, or Prague with /pid). */
const VIEW_BOUNDS = REGION.bounds;
/**
 * Buses, trams and metro: zoomed in to DOT_ZOOM they are full pills like the trains. Between
 * DOT_MIN_ZOOM and DOT_ZOOM, with more than DOT_DENSITY of them in view (a city), they are tiny
 * dots; with fewer (the countryside) they stay full pills. Further out than DOT_MIN_ZOOM none of
 * them is drawn.
 */
const DOT_ZOOM = 13.4;
/** Also where the tram and metro tracks start to show. */
const DOT_MIN_ZOOM = 11.8;
const DOT_DENSITY = 10;
/** A jump of the opened train bigger than this (metres) is announced with a notice. */
const POSITION_UPDATE_METERS = 700;
/** Extra pan room beyond Slovakia (degrees). */
/** The least the view may pan past Slovakia; zoomed out it grows with the screen (fitViewBounds). */
const MAP_VIEW_BOUNDS_PAD = { lng: 1.5, lat: 1.1 };
/** The view the map opens on: the whole region of this page. */
const INITIAL_VIEW: [[number, number], [number, number]] = [
  [VIEW_BOUNDS.minLng - 0.3, VIEW_BOUNDS.minLat - 0.25],
  [VIEW_BOUNDS.maxLng + 0.3, VIEW_BOUNDS.maxLat + 0.25],
];
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
/**
 * The tiles' main lines take over from our own (simplified) rails, which fade out from 12.4.
 * Below that both were drawn on top of each other: the same line twice, for nothing.
 */
const BASEMAP_RAIL_MIN_ZOOM = 11.8;
const BASEMAP_RAIL_FADE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  BASEMAP_RAIL_MIN_ZOOM,
  0,
  12.5,
  1,
];
/**
 * Sidings, yards and tram lines are only in the tiles from zoom 14 (checked: z12/13 tiles hold
 * the main lines only), so they cannot show earlier; they fade in over the first zoom level.
 */
const DETAIL_RAIL_MIN_ZOOM = 13.9;
const DETAIL_RAIL_FADE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1];
/** The detailed tram tracks fade in to the same grey and strength the simplified ones have (no glow). */
const TRAM_DETAIL_FADE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.7, 16, 0.95];
/** The simplified tram tracks: faint from afar, full in the city, gone once the detailed ones are in. */
const TRAM_SIMPLIFIED_FADE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 11.8, 0.4, 13, 0.6, 14, 0.6, 15, 0];

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
  /** 'tram', 'metro', 'bus'...; absent for trains. */
  mode?: string;
  radius?: number;
};

/** Zoom from which timetable-driven trains move smoothly (below it they update every few seconds). */
const JOURNEY_SMOOTH_ZOOM = 9;
/** Longest the loading card waits for the train timetables before showing the map anyway. */
const JOURNEYS_WAIT_MS = 12_000;
/** A delay rise this big (s) on the open train is worth a notice if it stops the pill… */
const DELAY_RISE_SECONDS = 60;
/** …as long as the pill stops within this long of the rise (ms). */
const DELAY_HOLD_WINDOW_MS = 60_000;
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

const STATION_HIT_LAYERS = ['stations-halo', 'stations-dot'];
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

/** Station features by id, for the one-feature source that draws the selected station. */
const stationFeatureById = new Map<string, Array<FeatureCollection['features'][number]>>();
/** The group circle currently drawn as selected. */
let selectedGroupId: string | null = null;

function applyStationSelection(
  map: MapLibreMap | null,
  nextId: string | null | undefined,
  previousId: string | null
): string | null {
  if (!map) {
    return previousId;
  }
  const selected = nextId ? stationFeatureById.get(nextId) : undefined;
  setSourceData(map, 'station-selected', selected ? { type: 'FeatureCollection', features: selected } : EMPTY_COLLECTION);
  if (selectedGroupId) {
    try {
      map.setFeatureState({ source: 'stations-pill', id: selectedGroupId }, { selected: false });
    } catch {
      // the group may be gone after a data refresh
    }
  }
  const group = selected?.[0]?.properties?.group;
  selectedGroupId = typeof group === 'string' ? group : null;
  if (selectedGroupId) {
    try {
      map.setFeatureState({ source: 'stations-pill', id: selectedGroupId }, { selected: true });
    } catch {
      // retried after the next setData
    }
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

/**
 * Metro tracks in their line colours, visible from a wide view (the base map only draws them when
 * zoomed in). Tram tracks are drawn with the railway's own style in addRailLayers.
 */
function addTransitLayers(map: MapLibreMap, theme: MapTheme = 'light') {
  if (!map.getSource('transit-lines')) {
    map.addSource('transit-lines', { type: 'geojson', data: EMPTY_COLLECTION, tolerance: 0.6, buffer: 16 });
  }
  const remove = (id: string) => {
    if (map.getLayer(id)) map.removeLayer(id);
  };
  remove('transit-metro');
  remove('transit-metro-casing');
  remove('transit-tram-thin');
  // Tram tracks as a hairline at every zoom, so a city's network shows from far out; the full tracks
  // (added with the rails) take over from DOT_MIN_ZOOM.
  map.addLayer({
    id: 'transit-tram-thin',
    type: 'line',
    source: 'transit-lines',
    filter: ['==', ['get', 'mode'], 'tram'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': theme === 'dark' ? '#7d7d85' : '#8f8f94',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 10, 0.75, DOT_MIN_ZOOM, 0.75, DOT_MIN_ZOOM + 1.2, 0],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 10, 0.6, DOT_MIN_ZOOM, 0.9],
    },
  });
  // A dark (light on the light map) edge makes the line stand out once the view is close.
  map.addLayer({
    id: 'transit-metro-casing',
    type: 'line',
    source: 'transit-lines',
    minzoom: 13,
    filter: ['==', ['get', 'mode'], 'metro'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': theme === 'dark' ? '#0a0a0b' : '#f6f6f6',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 0.9],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.6, 14, 4, 17, 7.4],
    },
  });
  map.addLayer({
    id: 'transit-metro',
    type: 'line',
    source: 'transit-lines',
    minzoom: DOT_MIN_ZOOM,
    filter: ['==', ['get', 'mode'], 'metro'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11.8, 0.9, 14, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.7, 11, 1.4, 14, 2.4, 17, 4.2],
    },
  });
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
      minzoom?: number;
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
      minzoom: options.minzoom ?? 8.6,
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
      ...(options.minzoom ? { minzoom: options.minzoom } : {}),
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

  // Prague's tram tracks, drawn like the railway's branch lines. Added first, so every railway is
  // above them (and the metro, added before all of these, is below).
  // They stay until the base map's own tram tracks (zoom 14 to 15) have faded in over them.
  addPair('transit-lines', 'transit-tram', RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, TRAM_SIMPLIFIED_FADE, {
    filter: ['==', ['get', 'mode'], 'tram'],
    // the grey of the side tracks, not the bright main-line white: trams should not glow
    color: sideColor,
    minzoom: DOT_MIN_ZOOM,
    maxzoom: 15.1,
  });

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
    // grey from afar, brighter once close, so the tracks read clearly when zoomed in
    const tramCloseColor = ['interpolate', ['linear'], ['zoom'], 14, sideColor, 16, fillColor] as unknown as string;
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
    // tram tracks first: every railway is drawn above them
    addBasemapPair('basemap-rails-tram', tramFilter, RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, tramCloseColor, TRAM_DETAIL_FADE, {
      minzoom: DETAIL_RAIL_MIN_ZOOM,
    });
    addBasemapPair('basemap-rails-tram-tunnel', tramTunnelFilter, RAIL_BRANCH_FILL, RAIL_BRANCH_CASING, tramCloseColor, TRAM_DETAIL_FADE, {
      dasharray: [2.4, 2.1],
      minzoom: DETAIL_RAIL_MIN_ZOOM,
    });
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
    addBasemapPair('basemap-rails-main', mainFilter, RAIL_MAIN_FILL, RAIL_MAIN_CASING, mainFillColor, BASEMAP_RAIL_FADE);
    addBasemapPair('basemap-rails-tunnel', tunnelFilter, RAIL_MAIN_FILL, RAIL_MAIN_CASING, mainFillColor, BASEMAP_RAIL_FADE, {
      dasharray: [2.6, 2.2],
    });
  }

  ensureSource('stations', { maxzoom: 14, tolerance: 0, buffer: 16, promoteId: 'id' });
  ensureSource('stations-hover', { maxzoom: 16, tolerance: 0, buffer: 64 });
  ensureSource('stations-spots', { maxzoom: 16, tolerance: 0, buffer: 16 });
  ensureSource('stations-pill', { maxzoom: 16, tolerance: 0, buffer: 32, promoteId: 'group' });
  // Just the selected station, so its ring and label do not need a copy of every station.
  ensureSource('station-selected', { maxzoom: 16, tolerance: 0, buffer: 64 });
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
  for (const legacy of ['stations-label-selected', 'stations-label-hover', 'stations-casing', 'stations-fill']) {
    if (map.getLayer(legacy)) {
      map.removeLayer(legacy);
    }
  }
  const labelFont = stationLabelFont(map);
  const labelLayout = {
    'text-font': labelFont,
    'text-field': ['case', ['==', ['get', 'hideLabel'], true], '', ['coalesce', ['get', 'name'], '']],
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

  // Stops of one name that lie apart share one light pill behind their dots: the halo, stretched
  // between them (about a circle when they are close).
  upsertLayer({
    id: 'stations-pill',
    type: 'fill',
    source: 'stations-pill',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'fill-color': fillColor,
      'fill-opacity': stationFade([
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.42,
        ['boolean', ['feature-state', 'selected'], false],
        0.3,
        0.13,
      ]),

    },
  });
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
  // The dark ring and the light dot in one layer (a circle with a stroke): one pass over
  // all stations instead of two.
  upsertLayer({
    id: 'stations-dot',
    type: 'circle',
    source: 'stations',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': stationCircleRadius([2.2, 2.5, 3.35, 1.18]),
      'circle-color': fillColor,
      'circle-opacity': stationFade(1),
      'circle-stroke-width': stationCircleRadius([1.0, 1.1, 1.45, 1.18]),
      'circle-stroke-color': casingColor,
      'circle-stroke-opacity': stationFade(1),
      'circle-pitch-alignment': 'map',
    },
  });
  // Where the platforms of a grouped stop are: small dots round the station dot in the middle.
  upsertLayer({
    id: 'stations-spots',
    type: 'circle',
    source: 'stations-spots',
    minzoom: 14,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.2, 16, 2],
      'circle-color': fillColor,
      'circle-opacity': stationFade(0.8),
      'circle-pitch-alignment': 'map',
    },
  });
  upsertLayer({
    id: 'stations-selected',
    type: 'circle',
    source: 'station-selected',
    minzoom: STATION_DOT_MIN_ZOOM,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], STATION_DOT_MIN_ZOOM, 5, 12.8, 5, 14, 6.2, 16, 8],
      'circle-color': '#fddf57',
      'circle-opacity': 1,
      'circle-stroke-width': 2,
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
      source: 'station-selected',
      minzoom: STATION_DOT_MIN_ZOOM,
      filter: ['==', ['get', 'rank'], rank],
      layout: {
        ...labelLayout,
        'text-size': rankTextSize[rank],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: labelPaint,
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
  /** The opened train's position changed a lot at once (a newer report): it is moving to the latest. */
  onPositionUpdating?: (update: { train: string; meters: number }) => void;
  /** The open train's delay went up and its pill now stands, waiting for the timetable to catch up. */
  onDelayHold?: (update: { train: string; delayMinutes: number }) => void;
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
  /** The visitor's position (from the locate button), drawn as a dot. It never leaves the browser. */
  userLocation?: { lat: number; lng: number } | null;
  /** Tram and metro tracks to draw under the rails (Prague). */
  transitLines?: FeatureCollection | null;
  /** Tram, metro and bus stops to draw (Prague). */
  transitStops?: TransitStop[] | null;
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
  onPositionUpdating,
  onDelayHold,
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
  userLocation = null,
  transitLines = null,
  transitStops = null,
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
  const transitLinesRef = useRef<FeatureCollection | null>(transitLines);
  transitLinesRef.current = transitLines;
  // zoom band the tram / metro / bus stops are shown at (0 none, 1 metro, 2 + tram, 3 + bus)
  const [stopBand, setStopBand] = useState(0);
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
  const onPositionUpdatingRef = useRef(onPositionUpdating);
  onPositionUpdatingRef.current = onPositionUpdating;
  const onDelayHoldRef = useRef(onDelayHold);
  onDelayHoldRef.current = onDelayHold;
  /** The open train's last seen delay, and a raised one waiting to see whether the pill stops. */
  const delayWatchRef = useRef<{ train: string; delay: number; rise: { delay: number; until: number } | null } | null>(null);
  const journeyStopsRef = useRef(journeyStops);
  journeyStopsRef.current = journeyStops;
  const lastTimelineRef = useRef('');
  const followingRef = useRef(following);
  followingRef.current = following;
  const followPositionRef = useRef<Coordinate | null>(null);
  const publishTrainMarkersRef = useRef<() => void>(() => undefined);
  const trainMarkersRef = useRef<Map<string, TrainMarkerEntry>>(new Map());
  const trainCanvasRef = useRef<TrainCanvasLayer | null>(null);
  /** Last overlap-packing result (each pill's push from its true spot, degrees) and when it ran. */
  const trainPackOffsetsRef = useRef<Map<string, { dLng: number; dLat: number }>>(new Map());
  const trainPackAtRef = useRef(0);
  /** Set after a pan or zoom: the next position tick refreshes every train, not just those near the view. */
  const trainSweepDueRef = useRef(true);
  const lastTrainPositionsRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const trainNodeStampRef = useRef<Map<string, string>>(new Map());
  const lastScheduledPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const trainMotionRafRef = useRef(0);
  const journeyAnimatorRef = useRef(new JourneyAnimator());
  const [journeysVersion, setJourneysVersion] = useState(0);
  const [journeysTried, setJourneysTried] = useState(false);
  const startTrainMotionLoopRef = useRef<() => void>(() => undefined);

  const appendLoadingMessage = useCallback((_message: string) => {}, []);

  useEffect(() => {
    outlineRef.current = svgOutlinePolygons;
  }, [svgOutlinePolygons]);

  useEffect(() => {
    onOsmStatusChange?.(osmStatus);
  }, [osmStatus, onOsmStatusChange]);

  useEffect(() => {
    if (REGION_ID !== 'sk') {
      // No country border for this region: its rails are kept inside its bounding box.
      const b = VIEW_BOUNDS;
      setSvgOutlinePolygons([
        [
          { lat: b.minLat - 0.2, lng: b.minLng - 0.2 },
          { lat: b.minLat - 0.2, lng: b.maxLng + 0.2 },
          { lat: b.maxLat + 0.2, lng: b.maxLng + 0.2 },
          { lat: b.maxLat + 0.2, lng: b.minLng - 0.2 },
          { lat: b.minLat - 0.2, lng: b.minLng - 0.2 },
        ],
      ]);
      return undefined;
    }
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
        worker.postMessage({ outline: svgOutlinePolygons, region: REGION_ID });
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
          const result = await fetchSimplifiedNetwork(REGION_ID === 'sk' ? undefined : REGION_ID);
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
      bounds: INITIAL_VIEW,
      fitBoundsOptions: { padding: 24 },
      minZoom: 5.5,
      maxZoom: 16,
      bearing: 0,
      pitch: 0,
      roll: 0,
      minPitch: 0,
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      maxBounds: [
        [VIEW_BOUNDS.minLng - MAP_VIEW_BOUNDS_PAD.lng, VIEW_BOUNDS.minLat - MAP_VIEW_BOUNDS_PAD.lat],
        [VIEW_BOUNDS.maxLng + MAP_VIEW_BOUNDS_PAD.lng, VIEW_BOUNDS.maxLat + MAP_VIEW_BOUNDS_PAD.lat],
      ],
      attributionControl: false,
      pixelRatio: RENDER_PIXEL_RATIO,
      fadeDuration: 0,
      maxParallelImageRequests: 12,
      maxTileCacheZoomLevels: 8,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      const debug = window as unknown as { __railMap?: MapLibreMap; __railEntries?: Map<string, TrainMarkerEntry> };
      debug.__railMap = map;
      debug.__railEntries = trainMarkersRef.current;
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
        [VIEW_BOUNDS.minLng - padWest, VIEW_BOUNDS.minLat - padLat],
        [VIEW_BOUNDS.maxLng + padEast, VIEW_BOUNDS.maxLat + padLat],
      ]);
    };
    map.on('zoom', fitViewBounds);
    // Buses, trams and metro turn into dots (or pills, or nothing) with the zoom level and how many
    // are in view: re-decide when the zoom crosses a limit and whenever the view stops moving.
    let modeBand = -1;
    const modeBandOf = (zoom: number) => (zoom >= DOT_ZOOM ? 2 : zoom >= DOT_MIN_ZOOM ? 1 : 0);
    map.on('zoom', () => {
      const zoomNow = map.getZoom();
      const stopBandNow = zoomNow >= 14.8 ? 3 : zoomNow >= 14 ? 2 : zoomNow >= 12.5 ? 1 : 0;
      setStopBand((current) => (current === stopBandNow ? current : stopBandNow));
      const band = modeBandOf(map.getZoom());
      if (band === modeBand) {
        return;
      }
      modeBand = band;
      publishTrainMarkersRef.current();
    });
    map.on('moveend', () => publishTrainMarkersRef.current());
    map.on('resize', () => fitViewBounds());
    map.once('load', () => fitViewBounds());
    const hydrateOverlay = () => {
      try {
        emphasizeRelief(map, themeRef.current);
        addTransitLayers(map, themeRef.current);
        addRailLayers(map, themeRef.current);
        setSourceData(map, 'transit-lines', transitLinesRef.current ?? EMPTY_COLLECTION);
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
    if (PERF_HUD) {
      // `?perf` only: time MapLibre's own frame (CPU side) next to ours.
      const internal = map as unknown as { _render: (...args: unknown[]) => unknown };
      const render = internal._render.bind(map);
      internal._render = (...args: unknown[]) => {
        const start = performance.now();
        try {
          return render(...args);
        } finally {
          perfAdd('map', performance.now() - start);
        }
      };
      startPerfHud();
    }
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
      trainSweepDueRef.current = true;
      scheduleTrainMarkers();
    });
    // Pills are packed only near the screen: after a pan, pack the ones that came into view.
    map.on('moveend', () => {
      trainSweepDueRef.current = true;
      scheduleTrainMarkers();
    });
    let hoveredStationId: string | null = null;
    let hoveredGroupId: string | null = null;
    const setGroupHover = (groupId: string | null, on: boolean) => {
      if (!groupId) return;
      try {
        map.setFeatureState({ source: 'stations-pill', id: groupId }, { hover: on });
      } catch {
        // stale id after a data refresh
      }
    };
    const clearStationHover = () => {
      setGroupHover(hoveredGroupId, false);
      hoveredGroupId = null;
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
        setGroupHover(hoveredGroupId, false);
        const groupProp = feature?.properties?.group;
        hoveredGroupId = typeof groupProp === 'string' ? groupProp : null;
        setGroupHover(hoveredGroupId, true);
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
    // A train the timetable model moves is already where it should be; putting it on its last
    // reported point here made the pill jump back there until the model's next tick.
    if (entry.journeyActive) {
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
          // Brno's trams wear the colour of their line; the other buses, trams and metro are black pills
          color: train.mode
            ? train.mode === 'tram' && REGION_ID === 'jmk' && train.color
              ? train.color
              : VEHICLE_MAP_PILL_COLOR
            : train.color || getDelayColor(train.delayMinutes),
          selected: train.trainNumber === focused,
          type,
          number: trainNumberLabel(type, train.trainNumber),
          heading,
          mode: train.mode,
        },
      ];
    });
  };

  publishTrainMarkersRef.current = () => {
    const map = mapRef.current;
    if (!mapReadyRef.current || !map) {
      return;
    }
    const perfStart = PERF_HUD ? performance.now() : 0;
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
    // Crowded buses, trams and metro seen from afar: dots, or nothing when far out.
    const viewProjection = screenProjection(map);
    const viewBox = map.getContainer();
    let otherOnScreen = 0;
    measured.forEach((point) => {
      if (!point.mode || point.selected) return;
      const x = viewProjection.projectX(point.lng);
      const y = viewProjection.projectY(point.lat);
      if (x > 0 && y > 0 && x < viewBox.clientWidth && y < viewBox.clientHeight) otherOnScreen += 1;
    });
    const crowded = otherOnScreen > DOT_DENSITY;
    const dotted = new Set<string>();
    const hidden = new Set<string>();
    if (zoom < DOT_MIN_ZOOM) {
      // further out than the dots: no buses, trams or metro at all
      measured.forEach((point) => {
        if (point.mode && !point.selected) hidden.add(point.id);
      });
    } else if (crowded && zoom < DOT_ZOOM) {
      measured.forEach((point) => {
        if (point.mode && !point.selected) dotted.add(point.id);
      });
    }
    const pillPoints = measured.filter((point) => !dotted.has(point.id) && !hidden.has(point.id));
    if (import.meta.env.DEV) {
      (window as unknown as { __pillStats?: unknown }).__pillStats = {
        zoom,
        dots: dotted.size,
        hidden: hidden.size,
        pills: measured.length - dotted.size - hidden.size,
      };
    }
    const dotPoints = measured.filter((point) => dotted.has(point.id));
    const packIterations = packingIterationsForZoom(zoom);
    // Only pills on (or just off) screen can overlap anything the user sees: packing all
    // ~130 trains on every zoom frame and every live tick was the costliest work per frame.
    let spread = pillPoints;
    const packOffsets = trainPackOffsetsRef.current;
    const packNow = performance.now();
    if (packIterations <= 0) {
      packOffsets.clear();
    } else if (map.isZooming() && packOffsets.size > 0 && packNow - trainPackAtRef.current < 150) {
      // Mid-pinch: re-packing every frame was the costliest work on phones. Reuse the last
      // pushes (at most 150 ms old); zoomend packs again and the canvas glides pills there.
      spread = pillPoints.map((point) => {
        const push = packOffsets.get(point.id);
        return push ? { ...point, lng: point.lng + push.dLng, lat: point.lat + push.dLat } : point;
      });
    } else {
      const projection = screenProjection(map);
      const { clientWidth: viewWidth, clientHeight: viewHeight } = map.getContainer();
      const margin = 80;
      const near: typeof measured = [];
      const far: typeof measured = [];
      pillPoints.forEach((point) => {
        const x = projection.projectX(point.lng);
        const y = projection.projectY(point.lat);
        (x > -margin && y > -margin && x < viewWidth + margin && y < viewHeight + margin ? near : far).push(point);
      });
      spread =
        near.length < 2
          ? pillPoints
          : [
              ...spreadOverlappingTrainPoints(near, projection.project, projection.unproject, {
                radius: trainPillRadius(false),
                selectedRadius: trainPillRadius(true),
                iterations: packIterations,
              }),
              ...far,
            ];
      trainPackAtRef.current = packNow;
      packOffsets.clear();
      const homes = new Map(measured.map((point) => [point.id, point]));
      spread.forEach((point) => {
        const home = homes.get(point.id);
        if (home && (point.lng !== home.lng || point.lat !== home.lat)) {
          packOffsets.set(point.id, { dLng: point.lng - home.lng, dLat: point.lat - home.lat });
        }
      });
    }
    if (!trainCanvasRef.current) {
      trainCanvasRef.current = new TrainCanvasLayer(map, (trainId) => onTrainClickRef.current?.(trainId));
    }
    trainCanvasRef.current.setDimmed(Boolean(focusedTrainRef.current));
    const homeOf = new Map(measured.map((item) => [item.id, item]));
    trainCanvasRef.current.setPills(
      [...spread, ...dotPoints].map((point) => {
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
          dot: dotted.has(point.id) || undefined,
          icon: point.mode === 'metro' ? ('metro' as const) : undefined,
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
    } finally {
      if (PERF_HUD) {
        perfAdd('publish', performance.now() - perfStart);
      }
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
    // Prague's tram, metro and bus stops are drawn as stations too (same dot, label, hover and
    // selection); each kind only from the zoom it is wanted at, so the set changes with the band.
    const transitPoints = (transitStops ?? []).flatMap((stop) => {
      const wanted =
        (stop.metro && stopBand >= 1) ||
        (stop.tram && !stop.metro && stopBand >= 2) ||
        (stop.bus && !stop.tram && !stop.metro && stopBand >= 3);
      if (!wanted) {
        return [];
      }
      return stop.spots.map(([lat, lng]) => ({
        id: `stop:${stop.name}`,
        name: stop.name,
        lat,
        lng,
        color: railPalette(themeRef.current).fill,
        rank: stop.metro ? 2 : 1,
      }));
    });
    // Stops of one name that lie apart (platforms, "Bratislava-Vinohrady 2") share one pill.
    const grouped = groupStations([
      ...stops.map((stop) => ({
        id: stop.stopId,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        color: railPalette(themeRef.current).fill,
        rank: stationLabelRank(stop.name, stop.tripCount ?? tripCountByStop.get(stop.stopId) ?? 0),
      })),
      ...transitPoints,
    ]);
    const stationCollection = pointsToCollection(grouped.points);
    setSourceData(map, 'stations-spots', { type: 'FeatureCollection', features: grouped.spots });
    setSourceData(map, 'stations-pill', { type: 'FeatureCollection', features: grouped.pills });
    stationFeatureById.clear();
    stationCollection.features.forEach((feature) => {
      const id = String(feature.properties?.id ?? feature.id);
      const list = stationFeatureById.get(id);
      if (list) list.push(feature);
      else stationFeatureById.set(id, [feature]);
    });
    setSourceData(map, 'stations', stationCollection);
    selectedStationRef.current = applyStationSelection(
      map,
      focusedStationIdRef.current,
      null
    );
  }, [dataset, svgOutlinePolygons, terrainLoaded, overlayEpoch, transitStops, stopBand]);

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
    // A vehicle with its own track line (trams, metro) needs no stations to be found on the map.
    const stored = focusedTrainNumber ? journeyAnimatorRef.current.journey(focusedTrainNumber) : null;
    if (!focusedTrainNumber || (waypoints.length < 2 && !(stored && stored.ok))) {
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

  // A vehicle is open: the others fade so it stands out.
  useEffect(() => {
    trainCanvasRef.current?.setDimmed(Boolean(focusedTrainNumber));
  }, [focusedTrainNumber]);

  // --- Timetable-driven positions -------------------------------------------
  // Load every running train's route + timetable from the proxy, then move the
  // pills along the rails between ZSR's position reports.
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    // While the proxy is still reading the region's timetable (right after it restarts) it
    // answers a placeholder: ask again every 2 s instead of leaving the pills standing still
    // until the next regular poll, 20 s later.
    let haveJourneys = false;
    const startedAt = Date.now();
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const journeys = await fetchJourneys(controller.signal);
        if (cancelled) {
          return;
        }
        haveJourneys = !journeysBuilding();
        // The loading card waits for the timetables, but not forever.
        if (haveJourneys || Date.now() - startedAt > JOURNEYS_WAIT_MS) {
          setJourneysTried(true);
        }
        if (!journeys) {
          return;
        }
        journeyAnimatorRef.current.setJourneys(journeys);
        journeyAnimatorRef.current.update(trainsRef.current);
        setJourneysVersion((value) => value + 1);
      } catch {
        // keep showing reported positions
        if (!cancelled) {
          setJourneysTried(true);
        }
      }
    };
    // Slovakia's timetables change slowly; with Prague on (its live delays move) ask more often.
    // Unchanged answers cost a 304.
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(
        async () => {
          await load();
          if (!cancelled) {
            schedule();
          }
        },
        !haveJourneys ? 2_000 : REGION_ID !== 'sk' ? 20_000 : 2 * 60 * 1000
      );
    };
    load().then(() => {
      if (!cancelled) {
        schedule();
      }
    });
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearTimeout(timer);
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
    const before = animator.modelAlong(focusedTrainNumber);
    animator.setEstimate(focusedTrainNumber, estimatedDelaySeconds(journeyStops));
    // ZSR's estimates at every station and passing point ahead: the map follows them.
    animator.setEstimateProfile(focusedTrainNumber, estimatedDelayProfile(journeyStops));
    // The panel's own estimate is not news: measure delay rises from here.
    delayWatchRef.current = null;
    animator.update(trainsRef.current);
    // Opening a train re-runs it on the delay its panel shows: if that moves it, say so.
    const after = animator.modelAlong(focusedTrainNumber);
    if (before != null && after != null && Math.abs(after - before) > POSITION_UPDATE_METERS) {
      onPositionUpdatingRef.current?.({ train: focusedTrainNumber, meters: after - before });
    }
    return () => {
      animator.setEstimate(focusedTrainNumber, null);
      animator.setEstimateProfile(focusedTrainNumber, null);
    };
  }, [focusedTrainNumber, journeyStatus, journeyStops]);

  useEffect(() => {
    let raf = 0;
    let lastRun = 0;
    let lastSweep = 0;
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
      // Trains well away from the view are only refreshed once a second (or right after a pan
      // or zoom), so each tick works out positions for the few dozen that can be seen.
      const sweep = trainSweepDueRef.current || frameMs - lastSweep >= 1000;
      if (sweep) {
        trainSweepDueRef.current = false;
        lastSweep = frameMs;
      }
      const padLng = (east - west) / 2;
      const padLat = (north - south) / 2;
      const nearView = (lat: number, lng: number) =>
        lat >= south - padLat && lat <= north + padLat && lng >= west - padLng && lng <= east + padLng;
      const visibleStep = degPerPx / 3;
      trainMarkersRef.current.forEach((entry, id) => {
        if (
          !sweep &&
          entry.journeyActive &&
          id !== followed &&
          id !== focusedId &&
          entry.drawnLat != null &&
          entry.drawnLng != null &&
          !nearView(entry.drawnLat, entry.drawnLng)
        ) {
          return;
        }
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
      let focusedCorrected = false;
      for (const correction of animator.takeCorrections()) {
        if (correction.train === focusedId) {
          focusedCorrected = true;
        }
        if (correction.train === followed && Math.abs(correction.meters) > 1500) {
          onFollowCorrectionRef.current?.(correction);
        } else if (correction.train === focusedId && Math.abs(correction.meters) > POSITION_UPDATE_METERS) {
          onPositionUpdatingRef.current?.(correction);
        }
      }
      // The open train's delay went up: if that leaves its pill standing, say why (once per rise).
      // A big rise slides the pill back instead, and the correction notice above covers that.
      if (focusedId) {
        const delay = animator.reportedDelay(focusedId);
        const watch = delayWatchRef.current;
        if (delay == null) {
          // nothing to compare against
        } else if (!watch || watch.train !== focusedId) {
          delayWatchRef.current = { train: focusedId, delay, rise: null };
        } else {
          if (delay >= watch.delay + DELAY_RISE_SECONDS) {
            watch.rise = { delay, until: now + DELAY_HOLD_WINDOW_MS };
          } else if (delay < watch.delay) {
            watch.rise = null;
          }
          watch.delay = delay;
          if (watch.rise && (focusedCorrected || now > watch.rise.until)) {
            watch.rise = null;
          } else if (watch.rise && animator.isWaiting(focusedId, now)) {
            onDelayHoldRef.current?.({ train: focusedId, delayMinutes: Math.round(watch.rise.delay / 60) });
            watch.rise = null;
          }
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
    const color =
      vehicleInk(trains.find((train) => train.trainNumber === focusedTrainNumber)?.color, themeRef.current) ?? '#ffffff';
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
  }, [networkRoute, focusedTrainNumber, trains, terrainLoaded, overlayEpoch, journeysVersion, theme]);

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
        map.fitBounds(INITIAL_VIEW, { padding: 24, duration: 650 });
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

  // tram / metro tracks follow the "Show" switches
  useEffect(() => {
    const map = mapRef.current;
    if (map && terrainLoaded) {
      setSourceData(map, 'transit-lines', transitLines ?? EMPTY_COLLECTION);
    }
  }, [transitLines, terrainLoaded, overlayEpoch]);


  useEffect(() => {
    const map = mapRef.current;
    if (!map || !terrainLoaded || !userLocation) {
      return undefined;
    }
    const element = document.createElement('div');
    element.className = 'user-dot';
    element.setAttribute('aria-hidden', 'true');
    const marker = new Marker({ element }).setLngLat([userLocation.lng, userLocation.lat]).addTo(map);
    return () => {
      marker.remove();
    };
  }, [userLocation, terrainLoaded]);

  const mapReady = terrainLoaded;
  const railsReady = !osmStatus.loading && tileLoadPlan.completed > 0;
  const loadSteps = [
    { id: 'map', label: mapCopy.mapStepMap, ready: mapReady },
    { id: 'rails', label: mapCopy.mapStepRails, ready: railsReady },
    { id: 'stations', label: mapCopy.mapStepStations, ready: dataset != null },
    { id: 'trains', label: mapCopy.mapStepTrains, ready: trainsLoaded },
    { id: 'timetables', label: mapCopy.mapStepTimetables, ready: journeysTried },
  ];
  const pendingSteps = loadSteps.filter((step) => !step.ready);
  const overlayActive = pendingSteps.length > 0;
  const canvasStateClass = overlayActive ? 'loading' : 'loaded';
  const readyCount = loadSteps.length - pendingSteps.length;
  const progressPercentage = overlayActive
    ? Math.round(((readyCount + 0.18) / loadSteps.length) * 100)
    : 100;
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
              <span className="map-loading-kicker">{mapCopy.mapLoading}</span>
              <ul className="map-loading-list">
                {loadSteps.map((step) => (
                  <li
                    key={step.id}
                    className={`map-loading-item ${step.ready ? 'map-loading-item--done' : 'map-loading-item--pending'}`}
                  >
                    <span className="map-loading-icon" aria-hidden="true">
                      {step.ready ? (
                        <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
                          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <span className="map-loading-spinner" />
                      )}
                    </span>
                    <span>{step.label}</span>
                  </li>
                ))}
              </ul>
              <div
                className="map-loading-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercentage}
                aria-valuetext={`${readyCount}/${loadSteps.length}`}
              >
                <div className="map-loading-bar__progress" style={{ width: `${progressPercentage}%` }} />
              </div>
              <span className="map-loading-count">
                {readyCount}/{loadSteps.length}
              </span>
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
