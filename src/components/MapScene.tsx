import React, { useMemo, useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import {
  Vector3,
  BufferGeometry,
  BufferAttribute,
  Line,
  LineBasicMaterial,
  Group,
  type Mesh,
  AxesHelper,
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  TorusGeometry,
  EdgesGeometry,
  CircleGeometry,
  Object3D,
  type Camera,
  type InstancedMesh,
  type PerspectiveCamera,
  MeshBasicMaterial,
  CatmullRomCurve3,
  TubeGeometry,
  Texture,
  MOUSE,
  TOUCH,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Coordinate, GtfsDataset } from '../data/gtfsParser';
import type { OsmDetailLevel } from '../types/osm';
import {
  getDelayColor,
  placeOnPath,
  routeCursor,
  type JourneyStop,
  type TrainRenderState,
} from '../data/trainService';
import {
  fetchDisplayRailsInBounds,
  fetchSimplifiedNetwork,
  isBridge,
  isSideRailwayTrack,
  isTunnel,
  type OSMWay,
  type OsmProxyMeta,
  type OsmFetchResult,
} from '../data/osmRailService';
import {
  extendOsmGraph,
  findOsmPath,
  resetSpatialIndex,
  setSimplifyToleranceMeters,
  simplifyGeometryNodes,
  traceWaypoints,
  type OsmGraph,
  type LatLngBounds,
  type OsmPathResult,
} from '../data/trainOsmMapper';
import { RailwayLine } from './RailwayLine';
import { DebugWindow, type DebugInfo } from './DebugWindow';
import { closeRailGaps } from '../data/railStitch';
import { fetchSlovakiaOutline, type SlovakiaOutline } from '../data/slovakiaOutlineService';
import { getCachedBasemapTexture, loadBasemapTexture } from '../data/basemapTextures';
import logoLong from '../logo long.svg';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';

// Slovakia's real-world bounding box (from outline service)
// These are the EXACT geographical bounds of Slovakia
const SLOVAKIA_BOUNDS = {
  minLat: 47.7311798,  // Southernmost point
  maxLat: 49.6138162,  // Northernmost point
  minLng: 16.8331891,  // Westernmost point
  maxLng: 22.5657103,  // Easternmost point
};

// Calculate center of Slovakia
const CENTER_LAT = (SLOVAKIA_BOUNDS.minLat + SLOVAKIA_BOUNDS.maxLat) / 2;
const CENTER_LNG = (SLOVAKIA_BOUNDS.minLng + SLOVAKIA_BOUNDS.maxLng) / 2;

// Calculate Slovakia's dimensions in meters
// At ~48.7°N latitude: 1° longitude ≈ 72km, 1° latitude ≈ 111km
const LAT_SPAN_DEG = SLOVAKIA_BOUNDS.maxLat - SLOVAKIA_BOUNDS.minLat;
const LNG_SPAN_DEG = SLOVAKIA_BOUNDS.maxLng - SLOVAKIA_BOUNDS.minLng;
const LAT_SPAN_M = LAT_SPAN_DEG * 111000; // ~209km
const LNG_SPAN_M = LNG_SPAN_DEG * 72000; // ~413km (at ~48.7°N)

// Scale factor: We want X axis to span from -500 to 500 (1000 units total width)
const DESIRED_X_WIDTH = 1000; // Total width in 3D units
const X_SCALE_FACTOR = DESIRED_X_WIDTH / LNG_SPAN_M; // Scale factor to fit X axis to -500 to 500

// Scale factors for lat/lng conversion
// Latitude: 1 degree = 111km = 111000m
// Longitude: 1 degree = ~72km = 72000m (at ~48.7°N)
// Apply X scale factor to both axes to maintain aspect ratio
const SCALE_LAT = X_SCALE_FACTOR * 111000; // meters per degree latitude (scaled)
const SCALE_LNG = X_SCALE_FACTOR * 72000;  // meters per degree longitude (scaled)
const MAX_CIRCLE_RADIUS_MAP_UNITS = 50;
const MAX_CIRCLE_RADIUS_METERS = MAX_CIRCLE_RADIUS_MAP_UNITS / X_SCALE_FACTOR;

const MAX_SEARCH_DIAMETER_MAP_UNITS = 10;
const MAX_SEARCH_RADIUS_METERS = (MAX_SEARCH_DIAMETER_MAP_UNITS / 2) / X_SCALE_FACTOR;
const OSM_RAIL_BASE_HEIGHT = 0;
const OSM_RAIL_TERRAIN_CLEARANCE = 0;
const TERRAIN_HEIGHT_MARGIN = 0.02;
const ANIMATED_PATH_HEIGHT_OFFSET = TERRAIN_HEIGHT_MARGIN;
const HIGHLIGHT_VERTICAL_OFFSET = 1.5;
const HIGHLIGHT_LINE_WIDTH = 4;
const HIGHLIGHT_LINE_OPACITY = 0.95;
const HIGHLIGHT_RENDER_ORDER = 1300;
const RAIL_FILL_COLOR = '#f4f7fb';
const RAIL_CASING_COLOR = '#0b0d10';
const RAIL_MAIN_FILL_WIDTH = 1.9;
const RAIL_MAIN_CASING_WIDTH = 4.6;
const RAIL_BRANCH_FILL_WIDTH = 1.15;
const RAIL_BRANCH_CASING_WIDTH = 2.9;
const RAIL_CASING_RENDER_ORDER = 1490;
const RAIL_FILL_RENDER_ORDER = 1500;
const RAIL_FINE_FILL_WIDTH = 1.05;
const RAIL_FINE_CASING_WIDTH = 2.4;
const RAIL_SIDE_FILL_WIDTH = 0.8;
const RAIL_SIDE_CASING_WIDTH = 1.85;
const RAIL_SIDE_OPACITY = 0.42;
const RAIL_DISPLAY_TILE_DEG = 0.08;
const RAIL_DISPLAY_LOAD_Y = 520;
type WorldRect = { minX: number; maxX: number; minZ: number; maxZ: number };
type FineRailView = {
  main: Float32Array | null;
  branch: Float32Array | null;
  side: Float32Array | null;
  hideRects: WorldRect[];
};
const STATION_FILL_COLOR = '#f4f7fb';
const STATION_CASING_COLOR = '#0b0d10';
const STATION_DISK_Y = 1.2;
const STATION_LABEL_Y = 1.45;
const STATION_CASING_RENDER_ORDER = 1540;
const STATION_FILL_RENDER_ORDER = 1550;
const STATION_LABEL_RENDER_ORDER = 1560;
const STATION_TINY_LABEL_POOL = 40;
const STATION_DISK_GEOMETRY = (() => {
  const geometry = new CircleGeometry(1, 22);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
})();
const STATION_MATRIX_DUMMY = new Object3D();
type StationRank = 'large' | 'medium' | 'small' | 'tiny';
const STATION_DISK_PIXEL_RADIUS: Record<StationRank, number> = {
  large: 3.1,
  medium: 2.55,
  small: 2.2,
  tiny: 1.85,
};
const STATION_DISK_CASING_SCALE = 1.28;
const STATION_FONT_SIZE: Record<StationRank, number> = {
  large: 9,
  medium: 5.6,
  small: 3.7,
  tiny: 2.45,
};
const STATION_LABEL_MAX_Y: Record<StationRank, number> = {
  large: 9000,
  medium: 2600,
  small: 980,
  tiny: 280,
};
const STATION_TINY_DISK_MAX_Y = 720;
const BASEMAP_RENDER_ORDER = 5;
const BASEMAP_HEIGHT = 0.02;
const BASEMAP_MAX_TILES = 36;
const BASEMAP_RETAIN_TILES = 48;
const TRAIN_BASE_SIZE = 5; // Increase/decrease this constant to scale the train cubes globally.
const TRAIN_SELECTED_SIZE = 8;
const TRAIN_VERTICAL_OFFSET = 20; // Raise the cubes vertically; adjust this constant to tweak altitude.
const TRAIN_BOX_GEOMETRY = new BoxGeometry(1, 1, 1);
// Camera animation controls for the post-loading zoom-in.
const CAMERA_LOAD_START_HEIGHT = 1500; // Initial camera height while loading.
const CAMERA_LOAD_END_HEIGHT = 2200; // Final height after animation completes.
const CAMERA_LOAD_DURATION_MS = 1000; // Duration of the camera height animation.
const CAMERA_LOAD_EASING = cubicBezier(.33,.13,.08,1); // Cubic-bezier easing curve used by CSS. 


function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number) {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleCurveX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleCurveY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleCurveDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveCurveX = (x: number) => {
    let t2 = x;

    for (let i = 0; i < 8; i++) {
      const x2 = sampleCurveX(t2) - x;
      if (Math.abs(x2) < 1e-6) {
        return t2;
      }
      const dx = sampleCurveDerivativeX(t2);
      if (Math.abs(dx) < 1e-6) {
        break;
      }
      t2 -= x2 / dx;
    }

    let t1 = 0;
    let t3 = 1;
    t2 = x;
    while (t1 < t3) {
      const x2 = sampleCurveX(t2);
      if (Math.abs(x2 - x) < 1e-6) {
        return t2;
      }
      if (x > x2) {
        t1 = t2;
      } else {
        t3 = t2;
      }
      t2 = (t3 - t1) * 0.5 + t1;
    }

    return t2;
  };

  return (t: number) => sampleCurveY(solveCurveX(t));
}



const MAX_CAMERA_HEIGHT = 2300;
const TOUCH_PAN = TOUCH.PAN;
const TOUCH_DOLLY_PAN = (TOUCH as typeof TOUCH & { DOLLY_PAN: number }).DOLLY_PAN;
const EMBANKMENT_HEIGHT_OFFSET = -0.06;
const OSM_TRACK_ELEVATION_OFFSET = 8;
const ORBIT_TARGET_HEIGHT_MIN_DISTANCE = 50;
const ORBIT_TARGET_HEIGHT_MAX_DISTANCE = 100;
const ORBIT_TARGET_HEIGHT_BLEND_SPEED = 0.12;
const ORBIT_TARGET_HEIGHT_RESET_SPEED = 0.08;
const terrainHeightCache = new Map<string, number | null>();
const trackLinePositionsCache = new Map<string, Float32Array>();
type CoordinateLike = Coordinate | { lat: number; lng?: number; lon?: number };

function getLongitude(coord: CoordinateLike): number {
  if ('lng' in coord && typeof coord.lng === 'number') {
    return coord.lng;
  }
  if ('lon' in coord && typeof coord.lon === 'number') {
    return coord.lon;
  }
  return 0;
}

function createTrackSignature(path: CoordinateLike[], heightOffset: number): string {
  if (!path || path.length === 0) {
    return `empty:${heightOffset}`;
  }
  const first = path[0];
  const last = path[path.length - 1];
  return `${path.length}:${heightOffset}:${first.lat.toFixed(5)}:${getLongitude(
    first
  ).toFixed(5)}:${last.lat.toFixed(5)}:${getLongitude(last).toFixed(5)}`;
}

/**
 * Projects geographical coordinates (lat/lng) to 3D space
 * Coordinate system (consistent orientation):
 * - X axis: East-West (positive X = East, negative X = West)
 * - Z axis: North-South (FLIPPED: negative Z = North, positive Z = South)
 *   This ensures North appears at the top of the screen when viewing from above
 * - Y axis: Up-Down (positive Y = Up)
 * 
 * Origin (0,0,0) is at the center of Slovakia's bounding box
 */
function project(coord: Coordinate | { lat: number; lng: number }): [number, number, number] {
  // Convert lat/lng to meters from center
  const latMeters = (coord.lat - CENTER_LAT) * SCALE_LAT;
  const lngMeters = (coord.lng - CENTER_LNG) * SCALE_LNG;
  
  // Map to 3D coordinates:
  // X = longitude (east-west): positive = east, negative = west
  // Z = latitude (north-south): FLIPPED so north appears at top of screen
  //    (camera looks from positive Z toward origin, so negative Z = north appears at top)
  // Y = height above ground
  const x = lngMeters;      // East-West
  const z = -latMeters;     // North-South (FLIPPED: north = negative Z to appear at top)
  const y = 1.5;            // Height above ground
  
  return [x, y, z];
}

function unproject(x: number, z: number): { lat: number; lng: number } {
  const latMeters = -z;
  const lngMeters = x;
  const lat = latMeters / SCALE_LAT + CENTER_LAT;
  const lng = lngMeters / SCALE_LNG + CENTER_LNG;
  return { lat, lng };
}

const SVG_OUTLINE_URL = encodeURI('/slovakia outlined simple.svg');

type OsmStatus = {
  tilesLoaded: number;
  lastFetch: string;
  lastStatus: string;
  loading: boolean;
};

type TileBounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

type TileLoadPlan = {
  total: number;
  completed: number;
};

type TileWorkerResponse =
  | {
      type: 'tileResult';
      id: number;
      key: string;
      level: OsmDetailLevel;
      result: OsmFetchResult;
    }
  | {
      type: 'tileError';
      id: number;
      error: string;
    };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RailTile = {
  key: string;
  geometry: BufferGeometry;
  chains?: Float32Array[];
  level: string;
  railwayType: string;
  opacity: number;
};

function routeSegmentColor(key: string): string {
  switch (key) {
    case '10':
      return '#00B800';
    case '20':
    case '40':
      return '#f5f5f5';
    case '30':
      return '#12A5F4';
    case '50':
      return '#22c55e';
    case '60':
      return '#9c9a9a';
    case '70':
      return '#ef4444';
    default:
      return '#facc15';
  }
}

function waysToChains(ways: OSMWay[]): Float32Array[] {
  const elevation = OSM_RAIL_BASE_HEIGHT + OSM_TRACK_ELEVATION_OFFSET;
  const lines = ways
    .map((way) => (way.geometry || []).map((node) => ({ lat: node.lat, lng: node.lon })))
    .filter((line) => line.length >= 2);
  return lines.map((line) => {
    const positions = new Float32Array(line.length * 3);
    line.forEach((node, index) => {
      const [x, , z] = project(node);
      positions[index * 3] = x;
      positions[index * 3 + 1] = elevation;
      positions[index * 3 + 2] = z;
    });
    return positions;
  });
}

type BoundingBox = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
};

function getLatLngBoundsForBox(box: BoundingBox, marginUnits = 25) {
  const minX = box.minX - marginUnits;
  const maxX = box.maxX + marginUnits;
  const minZ = box.minZ - marginUnits;
  const maxZ = box.maxZ + marginUnits;
  const sw = unproject(minX, maxZ);
  const ne = unproject(maxX, minZ);
  return {
    minLat: Math.min(sw.lat, ne.lat),
    maxLat: Math.max(sw.lat, ne.lat),
    minLng: Math.min(sw.lng, ne.lng),
    maxLng: Math.max(sw.lng, ne.lng),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clampNumber(value: number, min = 0, max = 1): number {
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

function normalizeStopName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .trim();
}

function getTodayTimeMs(): number {
  const now = new Date();
  return (
    (now.getHours() * 3600 +
      now.getMinutes() * 60 +
      now.getSeconds()) *
      1000 +
    now.getMilliseconds()
  );
}

function lerpNumber(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

const OrbitTargetHeightFollower: React.FC<{
  controlsRef: React.MutableRefObject<any>;
  terrainSampler?: (worldX: number, worldZ: number) => number | null;
  viewMode: '2d' | '3d';
}> = ({ controlsRef, terrainSampler, viewMode }) => {
  const sampleStateRef = useRef({
    timestamp: -Infinity,
    height: null as number | null,
    x: 0,
    z: 0,
  });
  const adjustTargetHeight = (
    target: Vector3,
    controls: any,
    camera: Camera,
    newY: number
  ) => {
    const oldY = target.y;
    const delta = newY - oldY;
    if (Math.abs(delta) > 0.0005) {
      target.y = newY;
      controls.update();
      camera.position.y += delta;
    }
  };
  useFrame((state) => {
    const controls = controlsRef.current;
    if (!controls) {
      return;
    }
    const target = controls.target as Vector3;
    if (!target) {
      return;
    }
    const camera = state.camera as Camera;

    const distance = state.camera.position.distanceTo(target);
    const hasTerrain = viewMode === '3d' && typeof terrainSampler === 'function';
    const resetHeight = () => {
      const nextY = lerpNumber(target.y, 0, ORBIT_TARGET_HEIGHT_RESET_SPEED);
      adjustTargetHeight(target, controls, camera, nextY);
    };
    const elapsedMs = state.clock.elapsedTime * 1000;
    const shouldSample =
      sampleStateRef.current.timestamp < 0 ||
      elapsedMs - sampleStateRef.current.timestamp >= 1000;
    if (hasTerrain && shouldSample) {
      const sampledHeight = terrainSampler(target.x, target.z);
      if (sampledHeight !== null && sampledHeight !== undefined) {
        sampleStateRef.current = {
          timestamp: elapsedMs,
          height: sampledHeight,
          x: target.x,
          z: target.z,
        };
      }
    }

    const terrainHeightValue = sampleStateRef.current.height;

    if (!hasTerrain) {
      resetHeight();
      return;
    }

    const range = ORBIT_TARGET_HEIGHT_MAX_DISTANCE - ORBIT_TARGET_HEIGHT_MIN_DISTANCE;
    const rawInfluence =
      range <= 0
        ? 1
        : (ORBIT_TARGET_HEIGHT_MAX_DISTANCE - distance) / range;
    const influence = clampNumber(rawInfluence, 0, 1);
    if (influence <= 0) {
      resetHeight();
      return;
    }

    if (terrainHeightValue == null) {
      return;
    }

    const desiredHeight = terrainHeightValue * influence;
    const blendedHeight = lerpNumber(target.y, desiredHeight, ORBIT_TARGET_HEIGHT_BLEND_SPEED);
    adjustTargetHeight(target, controls, camera, blendedHeight);
  });

  return null;
};

function interpolateAnimationCoordinate(
  animation: TrainAnimationState,
  nowMs: number
): Coordinate | null {
  if (!animation || animation.path.length === 0) {
    return null;
  }
  const duration = animation.endTimeMs - animation.startTimeMs;
  if (duration <= 0) {
    return null;
  }
  const progress = clampNumber((nowMs - animation.startTimeMs) / duration);
  const scaled = progress * Math.max(animation.path.length - 1, 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(animation.path.length - 1, lowerIndex + 1);
  const fraction = scaled - lowerIndex;
  const lower = animation.path[lowerIndex];
  const upper = animation.path[upperIndex];
  if (
    !lower ||
    !upper ||
    typeof lower.lat !== 'number' ||
    typeof lower.lng !== 'number' ||
    typeof upper.lat !== 'number' ||
    typeof upper.lng !== 'number'
  ) {
    return null;
  }
  return {
    lat: lerpNumber(lower.lat, upper.lat, fraction),
    lng: lerpNumber(lower.lng, upper.lng, fraction),
    sequence: upper.sequence,
  };
}

function findClosestShapeIndex(
  shape: Coordinate[],
  target: Coordinate
): number {
  if (!shape || shape.length === 0) {
    return -1;
  }
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const coord = shape[i];
    const dx = coord.lat - target.lat;
    const dy = coord.lng - target.lng;
    const dist = dx * dx + dy * dy;
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function sliceShapeBetween(
  shape: Coordinate[],
  start: Coordinate,
  end: Coordinate
): Coordinate[] {
  if (!shape || shape.length === 0) {
    return [];
  }
  const startIndex = findClosestShapeIndex(shape, start);
  const endIndex = findClosestShapeIndex(shape, end);
  if (startIndex === -1 || endIndex === -1) {
    return [];
  }
  if (startIndex <= endIndex) {
    return shape.slice(startIndex, endIndex + 1);
  }
  return shape.slice(endIndex, startIndex + 1).reverse();
}

function isPositionInsideBoundingBox(position: Coordinate, box: BoundingBox): boolean {
  const [x, , z] = project(position);
  return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
}

function estimateTrainBoundingCoordinate(train: TrainRenderState): Coordinate | null {
  if (train.position) {
    return train.position;
  }
  if (train.shapePath && train.shapePath.length > 0) {
    const fallbackIndex = Math.max(
      0,
      Math.min(
        train.shapePath.length - 1,
        Math.round(
          (train.progress ?? 0.5) * (train.shapePath.length - 1)
        )
      )
    );
    return train.shapePath[fallbackIndex];
  }
  if (train.liveRoute && train.liveRoute.length > 0) {
    return train.liveRoute[0];
  }
  return null;
}

function haversineDistance(
  coord1: { lat: number; lng: number },
  coord2: { lat: number; lng: number }
): number {
  const R = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(coord2.lat - coord1.lat);
  const dLng = toRad(coord2.lng - coord1.lng);
  const lat1 = toRad(coord1.lat);
  const lat2 = toRad(coord2.lat);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function circleToBounds(center: { lat: number; lng: number }, radiusMeters: number): LatLngBounds {
  const deltaLat = radiusMeters / SCALE_LAT;
  const deltaLng = radiusMeters / SCALE_LNG;
  return {
    minLat: center.lat - deltaLat,
    maxLat: center.lat + deltaLat,
    minLng: center.lng - deltaLng,
    maxLng: center.lng + deltaLng,
  };
}

type LatLngApprox = { lat: number; lng: number };

function coordsMatch(a: LatLngApprox, b: LatLngApprox, epsilon = 1e-5): boolean {
  return (
    Math.abs(a.lat - b.lat) <= epsilon && Math.abs(a.lng - b.lng) <= epsilon
  );
}

function getNextLiveRoutePoint(train: TrainRenderState): Coordinate | null {
  const route = train.liveRoute;
  if (!route || route.length === 0) {
    return null;
  }
  let bestIndex = 0;
  if (train.position) {
    let bestDistance = Infinity;
    for (let i = 0; i < route.length; i++) {
      const latDiff = route[i].lat - train.position.lat;
      const lngDiff = route[i].lng - train.position.lng;
      const distance = latDiff * latDiff + lngDiff * lngDiff;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
  }

  if (train.position && route.length > 1) {
    let nextIndex = bestIndex + 1;
    while (
      nextIndex < route.length &&
      coordsMatch(train.position, route[nextIndex])
    ) {
      nextIndex += 1;
    }
    if (nextIndex >= route.length) {
      return route[route.length - 1];
    }
    return route[nextIndex];
  }
  if (route.length === 1) {
    return route[0];
  }
  const fallbackIdx = Math.min(
    route.length - 2,
    Math.max(0, Math.floor(train.progress * (route.length - 1)))
  );
  let nextIdx = fallbackIdx + 1;
  while (
    nextIdx < route.length &&
    train.position &&
    coordsMatch(train.position, route[nextIdx])
  ) {
    nextIdx += 1;
  }
  return route[Math.min(nextIdx, route.length - 1)];
}

type LatLngPoint = { lat: number; lng: number };

type LatLngPolygon = LatLngPoint[];

function pointInPolygon(point: LatLngPoint, polygon: LatLngPolygon): boolean {
  if (polygon.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng <
        ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function simplifyRing(points: LatLngPoint[], maxPoints = 120): LatLngPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const step = Math.ceil(points.length / maxPoints);
  const simplified = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  const tail = simplified[simplified.length - 1];
  if (!tail || tail.lat !== last.lat || tail.lng !== last.lng) {
    simplified.push(last);
  }
  return simplified;
}

function isCoordinateInsideOutline(
  coord: LatLngPoint,
  polygons: LatLngPolygon[]
): boolean {
  if (!polygons || polygons.length === 0) {
    return true;
  }
  return polygons.some((polygon) => pointInPolygon(coord, polygon));
}

function lerpLatLng(a: LatLngPoint, b: LatLngPoint, t: number): LatLngPoint {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

function segmentEdgeT(
  a: LatLngPoint,
  b: LatLngPoint,
  c: LatLngPoint,
  d: LatLngPoint
): number | null {
  const rLng = b.lng - a.lng;
  const rLat = b.lat - a.lat;
  const sLng = d.lng - c.lng;
  const sLat = d.lat - c.lat;
  const denom = rLng * sLat - rLat * sLng;
  if (Math.abs(denom) < 1e-18) {
    return null;
  }
  const t = ((c.lng - a.lng) * sLat - (c.lat - a.lat) * sLng) / denom;
  const u = ((c.lng - a.lng) * rLat - (c.lat - a.lat) * rLng) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u < 0 || u > 1) {
    return null;
  }
  return t;
}

function clipPolylineToOutline(
  points: LatLngPoint[],
  polygons: LatLngPolygon[]
): LatLngPoint[][] {
  if (points.length < 2) {
    return [];
  }
  if (polygons.length === 0) {
    return [points];
  }
  const chains: LatLngPoint[][] = [];
  let current: LatLngPoint[] = [];
  const push = (point: LatLngPoint) => {
    const last = current[current.length - 1];
    if (
      last &&
      Math.abs(last.lat - point.lat) < 1e-10 &&
      Math.abs(last.lng - point.lng) < 1e-10
    ) {
      return;
    }
    current.push(point);
  };
  const flush = () => {
    if (current.length >= 2) {
      chains.push(current);
    }
    current = [];
  };

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const crossings = polygons
      .flatMap((polygon) => {
        const hits: number[] = [];
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const t = segmentEdgeT(start, end, polygon[j], polygon[i]);
          if (t != null) {
            hits.push(t);
          }
        }
        return hits;
      })
      .sort((a, b) => a - b)
      .filter((t, i, list) => i === 0 || t - list[i - 1] > 1e-6);
    let inside = isCoordinateInsideOutline(start, polygons);
    if (inside) {
      push(start);
    }
    crossings.forEach((t) => {
      const hit = lerpLatLng(start, end, t);
      push(hit);
      if (inside) {
        flush();
      }
      inside = !inside;
    });
    if (inside) {
      push(end);
    } else {
      flush();
    }
  }
  flush();
  return chains;
}

function clipWaysToOutline(ways: OSMWay[], polygons: LatLngPolygon[]): OSMWay[] {
  if (polygons.length === 0) {
    return ways;
  }
  const clipped: OSMWay[] = [];
  ways.forEach((way) => {
    const points = (way.geometry || []).map((node) => ({
      lat: node.lat,
      lng: node.lon,
    }));
    if (points.length < 2) {
      return;
    }
    let insideCount = 0;
    points.forEach((point) => {
      if (isCoordinateInsideOutline(point, polygons)) {
        insideCount += 1;
      }
    });
    if (insideCount === points.length) {
      clipped.push(way);
      return;
    }
    if (insideCount === 0) {
      return;
    }
    clipPolylineToOutline(points, polygons).forEach((chain, chainIndex) => {
      clipped.push({
        ...way,
        id: way.id * 100 + chainIndex,
        geometry: chain.map((point) => ({ lat: point.lat, lon: point.lng })),
      });
    });
  });
  return clipped;
}

interface TrainAnimationState {
  trainNumber: string;
  path: Coordinate[];
  startTimeMs: number;
  endTimeMs: number;
  delayMinutes: number;
  boundingBoxKey: string;
  startStop: Coordinate;
  endStop: Coordinate;
}

function tileKey(levelName: string, lat: number, lng: number): string {
  return `${levelName}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
}

type SerializedOsmGraphNode = {
  lat: number;
  lng: number;
  neighbors: [string, number][];
};

type SerializedOsmGraph = Record<string, SerializedOsmGraphNode>;

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

type PathfinderWorkerResponse =
  | {
      type: 'result';
      requestId: string;
      path: Coordinate[];
      durationMs: number;
      reason?: string;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'graphReady'; nodeCount: number };

type PathfinderWorkerResult = OsmPathResult;

function normalizeRailwayType(value?: string): string {
  if (!value) return 'rail';
  return value.toLowerCase().replace(/[^a-z_]/g, '_');
}

function groupWaysByRailway(ways: OSMWay[]): Map<string, OSMWay[]> {
  const map = new Map<string, OSMWay[]>();
  ways.forEach((way) => {
    const type = normalizeRailwayType(way.tags.railway);
    if (!map.has(type)) {
      map.set(type, []);
    }
    map.get(type)!.push(way);
  });
  return map;
}

function appendPositionsToType(
  map: Map<string, number[]>,
  type: string,
  data: Float32Array
) {
  if (!map.has(type)) {
    map.set(type, []);
  }
  appendPositions(map.get(type)!, data);
}

function convertWaysToPositions(
  ways: OSMWay[],
  additionalHeight = 0
): Float32Array {
  let segmentCount = 0;
  ways.forEach((way) => {
    const geometry = simplifyGeometryNodes(way.geometry || []);
    if (geometry.length > 1) {
      segmentCount += geometry.length - 1;
    }
  });

  if (segmentCount === 0) {
    return new Float32Array(0);
  }

  const positions = new Float32Array(segmentCount * 6);
  let offset = 0;
  const elevation =
    OSM_RAIL_BASE_HEIGHT + additionalHeight + OSM_TRACK_ELEVATION_OFFSET;

  ways.forEach((way) => {
    const geometry = simplifyGeometryNodes(way.geometry || []);
    for (let i = 0; i < geometry.length - 1; i++) {
      const start = project({ lat: geometry[i].lat, lng: geometry[i].lon });
      const end = project({ lat: geometry[i + 1].lat, lng: geometry[i + 1].lon });

      positions[offset++] = start[0];
      positions[offset++] = elevation;
      positions[offset++] = start[2];

      positions[offset++] = end[0];
      positions[offset++] = elevation;
      positions[offset++] = end[2];
    }
  });

  return positions.subarray(0, offset);
}

function simplifyLineSegments(positions: Float32Array, skipSegments = 2): Float32Array {
  if (skipSegments <= 1) {
    return positions;
  }
  const segments = Math.floor(positions.length / 6);
  if (segments === 0) {
    return positions;
  }
  const simplified: number[] = [];
  for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += skipSegments) {
    const base = segmentIndex * 6;
    for (let i = 0; i < 6; i += 1) {
      simplified.push(positions[base + i]);
    }
  }
  return new Float32Array(simplified);
}

function appendPositions(target: number[], source: Float32Array) {
  for (let i = 0; i < source.length; i += 1) {
    target.push(source[i]);
  }
}

interface TrackLineProps {
  path: Coordinate[];
  color?: string;
  opacity?: number;
  lineWidth?: number;
  heightOffset?: number;
  terrainSampler?: (worldX: number, worldZ: number) => number | null;
  terrainSnap?: boolean;
}

const TrackLine: React.FC<TrackLineProps> = ({
  path,
  color = '#4ade80',
  opacity = 1.0,
  lineWidth = 5,
  heightOffset = 0,
    terrainSampler,
}) => {
  const [positions, setPositions] = useState<Float32Array>(new Float32Array(0));
  const lastSignatureRef = useRef('');

  useEffect(() => {
    if (!path || path.length === 0) {
      setPositions(new Float32Array(0));
      lastSignatureRef.current = '';
      return;
    }
    const signature = createTrackSignature(path, heightOffset);
    const cachedPositions = trackLinePositionsCache.get(signature);
    if (cachedPositions) {
      lastSignatureRef.current = signature;
      setPositions(cachedPositions);
      return;
    }

    const points = new Float32Array(path.length * 3);
    for (let idx = 0; idx < path.length; idx++) {
      const coord = path[idx];
      const [x, , z] = project(coord);
      let height = heightOffset;

      if (terrainSampler) {
        const cacheKey = `${x.toFixed(4)}:${z.toFixed(4)}`;
        let terrainHeight = terrainHeightCache.get(cacheKey);
        if (terrainHeight === undefined) {
          terrainHeight = terrainSampler(x, z);
          terrainHeightCache.set(cacheKey, terrainHeight);
        }
        if (typeof terrainHeight === 'number') {
          height = terrainHeight + TERRAIN_HEIGHT_MARGIN + heightOffset;
        }
      }

      points[idx * 3] = x;
      points[idx * 3 + 1] = height;
      points[idx * 3 + 2] = z;
    }

    trackLinePositionsCache.set(signature, points);
    lastSignatureRef.current = signature;
    setPositions(points);
  }, [path, heightOffset, terrainSampler]);

  const geometry = useMemo(() => {
    if (positions.length === 0) {
      return null;
    }
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(positions, 3));
    return geom;
  }, [positions]);

  const material = useMemo(
    () =>
      new LineBasicMaterial({
        color,
        linewidth: lineWidth,
        transparent: opacity < 1.0,
        opacity: opacity,
        depthTest: true,
        depthWrite: false,
      }),
    [color, opacity, lineWidth]
  );

  const line = useMemo(() => {
    if (!geometry) {
      return null;
    }
    return new Line(geometry, material);
  }, [geometry, material]);

  if (!line) {
    return null;
  }
  line.renderOrder = 2000;

  return <primitive object={line} />;
};

function isMainRailway(way: OSMWay): boolean {
  const kind = way.tags?.railway ?? 'rail';
  return kind === 'rail';
}

const CasedRailLayer: React.FC<{
  positions: Float32Array;
  fillWidth: number;
  casingWidth: number;
  opacity?: number;
}> = ({ positions, fillWidth, casingWidth, opacity = 1 }) => {
  const { size } = useThree();
  const geometry = useMemo(() => {
    const lineGeometry = new LineSegmentsGeometry();
    lineGeometry.setPositions(positions);
    return lineGeometry;
  }, [positions]);
  const casingMaterial = useMemo(() => {
    const material = new LineMaterial({
      color: RAIL_CASING_COLOR,
      linewidth: casingWidth,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    });
    material.resolution.set(size.width, size.height);
    return material;
  }, [casingWidth, opacity, size.width, size.height]);
  const fillMaterial = useMemo(() => {
    const material = new LineMaterial({
      color: RAIL_FILL_COLOR,
      linewidth: fillWidth,
      transparent: true,
      opacity: opacity * 0.98,
      depthTest: false,
      depthWrite: false,
    });
    material.resolution.set(size.width, size.height);
    return material;
  }, [fillWidth, opacity, size.width, size.height]);
  useEffect(() => {
    casingMaterial.resolution.set(size.width, size.height);
    fillMaterial.resolution.set(size.width, size.height);
  }, [casingMaterial, fillMaterial, size.width, size.height]);
  const casing = useMemo(() => {
    const line = new LineSegments2(geometry, casingMaterial);
    line.renderOrder = RAIL_CASING_RENDER_ORDER;
    line.frustumCulled = false;
    return line;
  }, [geometry, casingMaterial]);
  const fill = useMemo(() => {
    const line = new LineSegments2(geometry, fillMaterial);
    line.renderOrder = RAIL_FILL_RENDER_ORDER;
    line.frustumCulled = false;
    return line;
  }, [geometry, fillMaterial]);
  useEffect(() => {
    return () => {
      geometry.dispose();
      casingMaterial.dispose();
      fillMaterial.dispose();
    };
  }, [geometry, casingMaterial, fillMaterial]);
  return (
    <group>
      <primitive object={casing} />
      <primitive object={fill} />
    </group>
  );
};

function convertRawWaysToPositions(ways: OSMWay[]): Float32Array {
  let segmentCount = 0;
  ways.forEach((way) => {
    const geometry = way.geometry || [];
    if (geometry.length > 1) {
      segmentCount += geometry.length - 1;
    }
  });
  if (segmentCount === 0) {
    return new Float32Array(0);
  }
  const positions = new Float32Array(segmentCount * 6);
  let offset = 0;
  const elevation = OSM_RAIL_BASE_HEIGHT + OSM_TRACK_ELEVATION_OFFSET;
  ways.forEach((way) => {
    const geometry = way.geometry || [];
    for (let i = 0; i < geometry.length - 1; i += 1) {
      const start = project({ lat: geometry[i].lat, lng: geometry[i].lon });
      const end = project({ lat: geometry[i + 1].lat, lng: geometry[i + 1].lon });
      positions[offset++] = start[0];
      positions[offset++] = elevation;
      positions[offset++] = start[2];
      positions[offset++] = end[0];
      positions[offset++] = elevation;
      positions[offset++] = end[2];
    }
  });
  return positions.subarray(0, offset);
}

function displayTileKey(minLat: number, minLng: number): string {
  return `${minLat.toFixed(3)}_${minLng.toFixed(3)}`;
}

function displayTileWorldRect(minLat: number, minLng: number): WorldRect {
  const sw = project({ lat: minLat, lng: minLng });
  const ne = project({ lat: minLat + RAIL_DISPLAY_TILE_DEG, lng: minLng + RAIL_DISPLAY_TILE_DEG });
  return {
    minX: Math.min(sw[0], ne[0]),
    maxX: Math.max(sw[0], ne[0]),
    minZ: Math.min(sw[2], ne[2]),
    maxZ: Math.max(sw[2], ne[2]),
  };
}

function pointInWorldRects(x: number, z: number, rects: WorldRect[]): boolean {
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ) {
      return true;
    }
  }
  return false;
}

function omitSegmentsInRects(positions: Float32Array | null, rects: WorldRect[]): Float32Array | null {
  if (!positions || positions.length === 0) {
    return positions;
  }
  if (rects.length === 0) {
    return positions;
  }
  const kept = new Float32Array(positions.length);
  let offset = 0;
  for (let i = 0; i < positions.length; i += 6) {
    const x1 = positions[i];
    const z1 = positions[i + 2];
    const x2 = positions[i + 3];
    const z2 = positions[i + 5];
    if (pointInWorldRects(x1, z1, rects) || pointInWorldRects(x2, z2, rects)) {
      continue;
    }
    kept[offset] = x1;
    kept[offset + 1] = positions[i + 1];
    kept[offset + 2] = z1;
    kept[offset + 3] = x2;
    kept[offset + 4] = positions[i + 4];
    kept[offset + 5] = z2;
    offset += 6;
  }
  if (offset === 0) {
    return null;
  }
  return kept.subarray(0, offset);
}

const FineRailLoader: React.FC<{
  outline: LatLngPolygon[];
  onPositions: (view: FineRailView | null) => void;
}> = ({ outline, onPositions }) => {
  const cacheRef = useRef<Map<string, {
    minLat: number;
    minLng: number;
    main: OSMWay[];
    branch: OSMWay[];
    side: OSMWay[];
  }>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());
  const hiddenRef = useRef(false);
  const neededRef = useRef<string[]>([]);
  const lastPublishRef = useRef('');

  const publish = useCallback((neededKeys: string[]) => {
    const mains: OSMWay[] = [];
    const branches: OSMWay[] = [];
    const sides: OSMWay[] = [];
    const hideRects: WorldRect[] = [];
    const loadedKeys: string[] = [];
    neededKeys.forEach((key) => {
      const tile = cacheRef.current.get(key);
      if (!tile) {
        return;
      }
      loadedKeys.push(key);
      mains.push(...tile.main);
      branches.push(...tile.branch);
      sides.push(...tile.side);
      if (tile.main.length > 0 || tile.branch.length > 0 || tile.side.length > 0) {
        hideRects.push(displayTileWorldRect(tile.minLat, tile.minLng));
      }
    });
    const main = convertRawWaysToPositions(mains);
    const branch = convertRawWaysToPositions(branches);
    const side = convertRawWaysToPositions(sides);
    const signature = `${loadedKeys.join('|')}:${main.length}:${branch.length}:${side.length}`;
    if (signature === lastPublishRef.current) {
      return;
    }
    lastPublishRef.current = signature;
    onPositions({
      main: main.length > 0 ? main : null,
      branch: branch.length > 0 ? branch : null,
      side: side.length > 0 ? side : null,
      hideRects,
    });
  }, [onPositions]);

  useFrame(({ camera, size }) => {
    if (outline.length === 0) {
      return;
    }
    if (camera.position.y > RAIL_DISPLAY_LOAD_Y) {
      if (!hiddenRef.current) {
        hiddenRef.current = true;
        lastPublishRef.current = '';
        onPositions(null);
      }
      return;
    }
    hiddenRef.current = false;
    const persp = camera as PerspectiveCamera;
    const fov = ((Number.isFinite(persp.fov) ? persp.fov : 16) * Math.PI) / 180;
    const halfHeight = Math.tan(fov / 2) * camera.position.y;
    const halfWidth = halfHeight * (size.width / Math.max(size.height, 1));
    const southWest = unproject(camera.position.x - halfWidth, camera.position.z + halfHeight);
    const northEast = unproject(camera.position.x + halfWidth, camera.position.z - halfHeight);
    const viewMinLat = Math.min(southWest.lat, northEast.lat);
    const viewMaxLat = Math.max(southWest.lat, northEast.lat);
    const viewMinLng = Math.min(southWest.lng, northEast.lng);
    const viewMaxLng = Math.max(southWest.lng, northEast.lng);
    const latStart = Math.floor(viewMinLat / RAIL_DISPLAY_TILE_DEG) * RAIL_DISPLAY_TILE_DEG;
    const lngStart = Math.floor(viewMinLng / RAIL_DISPLAY_TILE_DEG) * RAIL_DISPLAY_TILE_DEG;
    const needed: string[] = [];
    const pending: Array<{ key: string; minLat: number; minLng: number }> = [];
    for (let lat = latStart; lat < viewMaxLat + 1e-9; lat += RAIL_DISPLAY_TILE_DEG) {
      for (let lng = lngStart; lng < viewMaxLng + 1e-9; lng += RAIL_DISPLAY_TILE_DEG) {
        const key = displayTileKey(lat, lng);
        needed.push(key);
        if (!cacheRef.current.has(key) && !loadingRef.current.has(key)) {
          pending.push({ key, minLat: lat, minLng: lng });
        }
      }
    }
    if (needed.length > 9) {
      needed.length = 0;
      pending.length = 0;
      const center = unproject(camera.position.x, camera.position.z);
      const centerLat = Math.floor(center.lat / RAIL_DISPLAY_TILE_DEG) * RAIL_DISPLAY_TILE_DEG;
      const centerLng = Math.floor(center.lng / RAIL_DISPLAY_TILE_DEG) * RAIL_DISPLAY_TILE_DEG;
      for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
        for (let lngOffset = -1; lngOffset <= 1; lngOffset += 1) {
          const lat = centerLat + latOffset * RAIL_DISPLAY_TILE_DEG;
          const lng = centerLng + lngOffset * RAIL_DISPLAY_TILE_DEG;
          const key = displayTileKey(lat, lng);
          needed.push(key);
          if (!cacheRef.current.has(key) && !loadingRef.current.has(key)) {
            pending.push({ key, minLat: lat, minLng: lng });
          }
        }
      }
    }
    neededRef.current = needed;
    pending.slice(0, 2).forEach(({ key, minLat, minLng }) => {
      loadingRef.current.add(key);
      fetchDisplayRailsInBounds(
        minLat,
        minLat + RAIL_DISPLAY_TILE_DEG,
        minLng,
        minLng + RAIL_DISPLAY_TILE_DEG
      ).then((result) => {
        loadingRef.current.delete(key);
        const clipped = clipWaysToOutline(result.ways, outline);
        const sideWays = clipped.filter((way) => isSideRailwayTrack(way));
        const runningWays = clipped.filter((way) => !isSideRailwayTrack(way));
        cacheRef.current.set(key, {
          minLat,
          minLng,
          main: runningWays.filter((way) => isMainRailway(way)),
          branch: runningWays.filter((way) => !isMainRailway(way)),
          side: sideWays,
        });
        if (cacheRef.current.size > 16) {
          Array.from(cacheRef.current.keys()).forEach((cachedKey) => {
            if (cacheRef.current.size <= 12) {
              return;
            }
            if (!neededRef.current.includes(cachedKey)) {
              cacheRef.current.delete(cachedKey);
            }
          });
        }
        publish(neededRef.current);
      }).catch(() => {
        loadingRef.current.delete(key);
      });
    });
    publish(needed);
  });

  return null;
};

const HighlightedRouteLine: React.FC<{ positions: number[]; color: string }> = ({
  positions,
  color,
}) => {
  const { size } = useThree();
  const geometry = useMemo(() => {
    const lineGeometry = new LineGeometry();
    lineGeometry.setPositions(positions);
    return lineGeometry;
  }, [positions]);
  const material = useMemo(() => {
    const mat = new LineMaterial({
      color,
      linewidth: HIGHLIGHT_LINE_WIDTH,
      transparent: true,
      opacity: HIGHLIGHT_LINE_OPACITY,
      depthTest: false,
      depthWrite: false,
    });
    mat.resolution.set(size.width, size.height);
    return mat;
  }, [color, size.width, size.height]);
  useEffect(() => {
    material.resolution.set(size.width, size.height);
  }, [material, size.width, size.height]);
  const line = useMemo(() => {
    const line2 = new Line2(geometry, material);
    line2.renderOrder = HIGHLIGHT_RENDER_ORDER;
    return line2;
  }, [geometry, material]);
  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);
  if (!line) {
    return null;
  }
  return <primitive object={line} />;
};

function createEmbankmentGeometry(points: Vector3[]): BufferGeometry | null {
  if (points.length < 2) {
    return null;
  }
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const segments = Math.max(4, points.length * 2);
  return new TubeGeometry(curve, segments, 0.08, 6, false);
}

// Major cities in Slovakia with their coordinates
const MAJOR_CITIES = [
  { name: 'Bratislava', lat: 48.1486, lng: 17.1077, size: 'large' },
  { name: 'Košice', lat: 48.7164, lng: 21.2611, size: 'large' },
  { name: 'Žilina', lat: 49.2194, lng: 18.7408, size: 'medium' },
  { name: 'Banská Bystrica', lat: 48.7363, lng: 19.1451, size: 'medium' },
  { name: 'Nitra', lat: 48.3069, lng: 18.0864, size: 'medium' },
  { name: 'Prešov', lat: 48.9984, lng: 21.2339, size: 'medium' },
  { name: 'Trnava', lat: 48.3774, lng: 17.5872, size: 'small' },
  { name: 'Trenčín', lat: 48.8945, lng: 18.0444, size: 'small' },
  { name: 'Martin', lat: 49.0656, lng: 18.9236, size: 'small' },
  { name: 'Poprad', lat: 49.0614, lng: 20.2980, size: 'small' },
];

const SLOVAK_CITIES = [
  { name: 'Prievidza', lat: 48.7749, lng: 18.6289 },
  { name: 'Považská Bystrica', lat: 48.7113, lng: 18.3488 },
  { name: 'Zvolen', lat: 48.5744, lng: 19.1362 },
  { name: 'Levice', lat: 48.2146, lng: 18.6130 },
  { name: 'Michalovce', lat: 48.7511, lng: 21.9194 },
  { name: 'Humenné', lat: 48.9473, lng: 21.9156 },
  { name: 'Trebišov', lat: 48.6272, lng: 21.7224 },
  { name: 'Nové Zámky', lat: 47.9830, lng: 18.2089 },
  { name: 'Komárno', lat: 47.7533, lng: 18.1241 },
  { name: 'Šaľa', lat: 48.1469, lng: 17.8029 },
  { name: 'Pezinok', lat: 48.3066, lng: 17.2419 },
  { name: 'Senec', lat: 48.2235, lng: 17.3352 },
  { name: 'Malacky', lat: 48.4179, lng: 17.0213 },
  { name: 'Hlohovec', lat: 48.4165, lng: 17.7967 },
  { name: 'Púchov', lat: 48.6015, lng: 18.3010 },
  { name: 'Žiar nad Hronom', lat: 48.6419, lng: 18.8598 },
  { name: 'Ružomberok', lat: 49.0746, lng: 19.3045 },
  { name: 'Spišská Nová Ves', lat: 48.9403, lng: 20.5599 },
  { name: 'Liptovský Mikuláš', lat: 49.0819, lng: 19.6123 },
  { name: 'Kežmarok', lat: 49.1317, lng: 20.4017 },
  { name: 'Svit', lat: 49.0796, lng: 20.4074 },
  { name: 'Sabinov', lat: 49.1001, lng: 21.0222 },
  { name: 'Čadca', lat: 49.3873, lng: 18.8022 },
  { name: 'Levoča', lat: 49.0115, lng: 20.5789 },
  { name: 'Šurany', lat: 48.0862, lng: 18.0033 },
  { name: 'Galanta', lat: 48.2065, lng: 17.6649 },
  { name: 'Sereď', lat: 48.2824, lng: 17.7762 },
  { name: 'Bardejov', lat: 49.2958, lng: 21.2703 },
  { name: 'Myjava', lat: 48.6452, lng: 17.4138 },
  { name: 'Detva', lat: 48.6080, lng: 19.5724 },
  { name: 'Snina', lat: 48.8894, lng: 22.1462 },
  { name: 'Revúca', lat: 48.7341, lng: 20.0225 },
  { name: 'Dolný Kubín', lat: 49.2167, lng: 19.3005 },
  { name: 'Rimavská Sobota', lat: 48.3843, lng: 20.0315 },
  { name: 'Nové Mesto nad Váhom', lat: 48.7164, lng: 17.8268 },
  { name: 'Košťany nad Turcom', lat: 48.8409, lng: 18.7958 },
  { name: 'Veľký Krtíš', lat: 48.1637, lng: 19.0290 },
  { name: 'Žarnovica', lat: 48.3966, lng: 18.5154 },
  { name: 'Štúrovo', lat: 47.8004, lng: 18.4164 },
  { name: 'Tvrdošín', lat: 49.2925, lng: 19.5654 },
];


// Reference train stations for terrain matching
const BRATISLAVA_STATION = { lat: 48.159111, lng: 17.106528 }; // 48°09'32.8"N 17°06'23.5"E
const KOSICE_STATION = { lat: 48.722917, lng: 21.268583 };     // 48°43'22.5"N 21°16'06.9"E
const ZILINA_STATION = { lat: 49.226972, lng: 18.746944 };     // 49°13'37.1"N 18°44'49.0"E

type StationDiskItem = {
  x: number;
  z: number;
  rank: StationRank;
};

function stationWorldPerPixel(camera: Camera, viewportHeight: number): number {
  const height = Math.max(camera.position.y, 1);
  const fovDeg = 'fov' in camera ? Number((camera as PerspectiveCamera).fov) : 75;
  const fov = (Number.isFinite(fovDeg) ? fovDeg : 75) * (Math.PI / 180);
  return (2 * height * Math.tan(fov / 2)) / Math.max(viewportHeight, 1);
}

type NamedStationLabel = {
  key: string;
  name: string;
  x: number;
  z: number;
  rank: Exclude<StationRank, 'tiny'>;
  font: number;
  maxY: number;
  offsetX: number;
};

type TinyStationLabel = {
  key: string;
  name: string;
  x: number;
  z: number;
};

function stationNameKey(name: string): string {
  return normalizeStopName(name);
}

function namedPlaceRank(size: string | undefined): Exclude<StationRank, 'tiny'> {
  if (size === 'large') return 'large';
  if (size === 'medium') return 'medium';
  return 'small';
}

function labelBoxOverlaps(
  x: number,
  z: number,
  w: number,
  h: number,
  boxes: Array<{ x: number; z: number; w: number; h: number }>
): boolean {
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (Math.abs(x - box.x) * 2 < w + box.w && Math.abs(z - box.z) * 2 < h + box.h) {
      return true;
    }
  }
  return false;
}

const StationDiskInstances: React.FC<{
  items: StationDiskItem[];
  visibleMaxY?: number;
}> = ({ items, visibleMaxY }) => {
  const strokeRef = useRef<InstancedMesh>(null);
  const fillRef = useRef<InstancedMesh>(null);
  const groupRef = useRef<Group>(null);
  const last = useRef({ y: Number.NaN, h: 0 });

  const writeMatrices = (camera: Camera, viewportHeight: number) => {
    const stroke = strokeRef.current;
    const fill = fillRef.current;
    if (!stroke || !fill) {
      return;
    }
    const worldPerPixel = stationWorldPerPixel(camera, viewportHeight);
    items.forEach((item, index) => {
      const radius = STATION_DISK_PIXEL_RADIUS[item.rank] * worldPerPixel;
      STATION_MATRIX_DUMMY.position.set(item.x, STATION_DISK_Y, item.z);
      STATION_MATRIX_DUMMY.scale.setScalar(radius * STATION_DISK_CASING_SCALE);
      STATION_MATRIX_DUMMY.updateMatrix();
      stroke.setMatrixAt(index, STATION_MATRIX_DUMMY.matrix);
      STATION_MATRIX_DUMMY.scale.setScalar(radius);
      STATION_MATRIX_DUMMY.updateMatrix();
      fill.setMatrixAt(index, STATION_MATRIX_DUMMY.matrix);
    });
    stroke.instanceMatrix.needsUpdate = true;
    fill.instanceMatrix.needsUpdate = true;
  };

  useLayoutEffect(() => {
    last.current = { y: Number.NaN, h: 0 };
  }, [items]);

  useFrame(({ camera, size }) => {
    if (groupRef.current && visibleMaxY != null) {
      groupRef.current.visible = camera.position.y <= visibleMaxY;
      if (!groupRef.current.visible) {
        return;
      }
    }
    if (
      Math.abs(camera.position.y - last.current.y) < 1 &&
      size.height === last.current.h
    ) {
      return;
    }
    last.current = { y: camera.position.y, h: size.height };
    writeMatrices(camera, size.height);
  });

  if (items.length === 0) {
    return null;
  }

  return (
    <group ref={groupRef}>
      <instancedMesh
        ref={strokeRef}
        args={[STATION_DISK_GEOMETRY, undefined, items.length]}
        frustumCulled={false}
        renderOrder={STATION_CASING_RENDER_ORDER}
      >
        <meshBasicMaterial
          color={STATION_CASING_COLOR}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh
        ref={fillRef}
        args={[STATION_DISK_GEOMETRY, undefined, items.length]}
        frustumCulled={false}
        renderOrder={STATION_FILL_RENDER_ORDER}
      >
        <meshBasicMaterial
          color={STATION_FILL_COLOR}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
};

const NamedStationLabels: React.FC<{ labels: NamedStationLabel[] }> = ({ labels }) => {
  const refs = useRef<Array<Group | null>>([]);
  const last = useRef({ x: Number.NaN, y: Number.NaN, z: Number.NaN });

  useFrame(({ camera }) => {
    const { x, y, z } = camera.position;
    if (
      Math.abs(y - last.current.y) < 10 &&
      Math.abs(x - last.current.x) < 18 &&
      Math.abs(z - last.current.z) < 18
    ) {
      return;
    }
    last.current = { x, y, z };
    const rankWeight: Record<NamedStationLabel['rank'], number> = {
      large: 0,
      medium: 1,
      small: 2,
    };
    const order = labels
      .map((_, index) => index)
      .sort((a, b) => rankWeight[labels[a].rank] - rankWeight[labels[b].rank]);
    const boxes: Array<{ x: number; z: number; w: number; h: number }> = [];
    const visible = new Set<number>();
    for (let n = 0; n < order.length; n += 1) {
      const index = order[n];
      const label = labels[index];
      if (y > label.maxY) {
        continue;
      }
      const width = Math.max(12, label.name.length * label.font * 0.55);
      const height = label.font * 1.6;
      const lx = label.x + label.offsetX + width * 0.5;
      const lz = label.z;
      if (labelBoxOverlaps(lx, lz, width, height, boxes)) {
        continue;
      }
      boxes.push({ x: lx, z: lz, w: width, h: height });
      visible.add(index);
    }
    refs.current.forEach((group, index) => {
      if (group) {
        group.visible = visible.has(index);
      }
    });
  });

  return (
    <group>
      {labels.map((label, index) => (
        <group
          key={label.key}
          ref={(node) => {
            refs.current[index] = node;
          }}
          position={[label.x + label.offsetX, STATION_LABEL_Y, label.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={label.rank === 'large'}
        >
          <Text
            fontSize={label.font}
            color={STATION_FILL_COLOR}
            anchorX="left"
            anchorY="middle"
            outlineWidth={0.08}
            outlineColor={STATION_CASING_COLOR}
            renderOrder={STATION_LABEL_RENDER_ORDER}
            depthOffset={-2}
          >
            {label.name}
          </Text>
        </group>
      ))}
    </group>
  );
};

const TinyStationLabels: React.FC<{ stops: TinyStationLabel[] }> = ({ stops }) => {
  const refs = useRef<Array<Group | null>>([]);
  const last = useRef({ x: Number.NaN, y: Number.NaN, z: Number.NaN });

  useFrame(({ camera, size }) => {
    const { x, y, z } = camera.position;
    if (
      Math.abs(y - last.current.y) < 8 &&
      Math.abs(x - last.current.x) < 12 &&
      Math.abs(z - last.current.z) < 12
    ) {
      return;
    }
    last.current = { x, y, z };
    const slots = refs.current;
    if (y > STATION_LABEL_MAX_Y.tiny) {
      for (let i = 0; i < slots.length; i += 1) {
        const group = slots[i];
        if (group) {
          group.visible = false;
        }
      }
      return;
    }
    const font = STATION_FONT_SIZE.tiny;
    const viewPad = y * 0.85;
    const nearby: Array<{ stop: TinyStationLabel; dist: number }> = [];
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const dx = stop.x - x;
      const dz = stop.z - z;
      if (Math.abs(dx) > viewPad || Math.abs(dz) > viewPad) {
        continue;
      }
      nearby.push({ stop, dist: dx * dx + dz * dz });
    }
    nearby.sort((a, b) => a.dist - b.dist);
    const boxes: Array<{ x: number; z: number; w: number; h: number }> = [];
    let used = 0;
    const offsetX = Math.max(1.1, stationWorldPerPixel(camera, size.height) * 8);
    for (let i = 0; i < nearby.length && used < STATION_TINY_LABEL_POOL; i += 1) {
      const stop = nearby[i].stop;
      const width = Math.max(8, stop.name.length * font * 0.55);
      const height = font * 1.55;
      const lx = stop.x + offsetX + width * 0.5;
      if (labelBoxOverlaps(lx, stop.z, width, height, boxes)) {
        continue;
      }
      boxes.push({ x: lx, z: stop.z, w: width, h: height });
      const group = slots[used];
      if (group) {
        group.visible = true;
        group.position.set(stop.x + offsetX, STATION_LABEL_Y, stop.z);
        const text = group.children[0] as { text?: string } | undefined;
        if (text && text.text !== stop.name) {
          text.text = stop.name;
        }
      }
      used += 1;
    }
    for (let i = used; i < slots.length; i += 1) {
      const group = slots[i];
      if (group) {
        group.visible = false;
      }
    }
  });

  return (
    <group>
      {Array.from({ length: STATION_TINY_LABEL_POOL }, (_, index) => (
        <group
          key={`tiny-stop-${index}`}
          ref={(node) => {
            refs.current[index] = node;
          }}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
        >
          <Text
            fontSize={STATION_FONT_SIZE.tiny}
            color="#d7dde4"
            anchorX="left"
            anchorY="middle"
            outlineWidth={0.06}
            outlineColor={STATION_CASING_COLOR}
            renderOrder={STATION_LABEL_RENDER_ORDER}
            depthOffset={-2}
          >
            {' '}
          </Text>
        </group>
      ))}
    </group>
  );
};

function mercatorLatFromTile(nFraction: number): number {
  const merc = Math.PI * (1 - 2 * nFraction);
  return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
}

function latLngToTile(lat: number, lng: number, zoom: number) {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

function tileLatLngBounds(zoom: number, tileX: number, tileY: number) {
  const n = 2 ** zoom;
  return {
    minLng: (tileX / n) * 360 - 180,
    maxLng: ((tileX + 1) / n) * 360 - 180,
    maxLat: mercatorLatFromTile(tileY / n),
    minLat: mercatorLatFromTile((tileY + 1) / n),
  };
}

function tileOverlapsBounds(
  zoom: number,
  tileX: number,
  tileY: number,
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }
) {
  const tile = tileLatLngBounds(zoom, tileX, tileY);
  return (
    tile.maxLng >= bounds.minLng &&
    tile.minLng <= bounds.maxLng &&
    tile.maxLat >= bounds.minLat &&
    tile.minLat <= bounds.maxLat
  );
}

function zoomForCameraY(height: number) {
  if (height > 1500) {
    return 7;
  }
  if (height > 850) {
    return 8;
  }
  if (height > 480) {
    return 10;
  }
  if (height > 220) {
    return 11;
  }
  return 12;
}

function makeTileGeometry(zoom: number, tileX: number, tileY: number): BufferGeometry {
  const bounds = tileLatLngBounds(zoom, tileX, tileY);
  const northWest = project({ lat: bounds.maxLat, lng: bounds.minLng });
  const northEast = project({ lat: bounds.maxLat, lng: bounds.maxLng });
  const southWest = project({ lat: bounds.minLat, lng: bounds.minLng });
  const southEast = project({ lat: bounds.minLat, lng: bounds.maxLng });
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        northWest[0],
        BASEMAP_HEIGHT,
        northWest[2],
        northEast[0],
        BASEMAP_HEIGHT,
        northEast[2],
        southWest[0],
        BASEMAP_HEIGHT,
        southWest[2],
        southEast[0],
        BASEMAP_HEIGHT,
        southEast[2],
      ]),
      3
    )
  );
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  return geometry;
}

type BasemapTileRef = { zoom: number; x: number; y: number };

function slovakiaTilesAtZoom(zoom: number): BasemapTileRef[] {
  const northWest = latLngToTile(SLOVAKIA_BOUNDS.maxLat, SLOVAKIA_BOUNDS.minLng, zoom);
  const southEast = latLngToTile(SLOVAKIA_BOUNDS.minLat, SLOVAKIA_BOUNDS.maxLng, zoom);
  const tiles: BasemapTileRef[] = [];
  const xMin = Math.min(northWest.x, southEast.x);
  const xMax = Math.max(northWest.x, southEast.x);
  const yMin = Math.min(northWest.y, southEast.y);
  const yMax = Math.max(northWest.y, southEast.y);
  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      if (tileOverlapsBounds(zoom, x, y, SLOVAKIA_BOUNDS)) {
        tiles.push({ zoom, x, y });
      }
    }
  }
  return tiles;
}

const BasemapTileMesh: React.FC<{
  zoom: number;
  tileX: number;
  tileY: number;
  onReady?: () => void;
}> = ({ zoom, tileX, tileY, onReady }) => {
  const [texture, setTexture] = useState<Texture | null>(() =>
    getCachedBasemapTexture(zoom, tileX, tileY)
  );
  const geometry = useMemo(() => makeTileGeometry(zoom, tileX, tileY), [zoom, tileX, tileY]);
  useEffect(() => {
    let cancelled = false;
    if (texture) {
      onReady?.();
      return undefined;
    }
    loadBasemapTexture(zoom, tileX, tileY).then((loaded) => {
      if (!cancelled && loaded) {
        setTexture(loaded);
        onReady?.();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [zoom, tileX, tileY, onReady, texture]);
  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);
  if (!texture) {
    return null;
  }
  return (
    <mesh geometry={geometry} frustumCulled={false} renderOrder={BASEMAP_RENDER_ORDER + zoom}>
      <meshBasicMaterial map={texture} depthTest={false} depthWrite={false} toneMapped={false} />
    </mesh>
  );
};

const BasemapLayer: React.FC<{ onReady?: () => void }> = ({ onReady }) => {
  const [tiles, setTiles] = useState<BasemapTileRef[]>([]);
  const signatureRef = useRef('');
  const retainedRef = useRef<Map<string, BasemapTileRef>>(new Map());
  const readyRef = useRef(false);
  const handleReady = useCallback(() => {
    if (readyRef.current) {
      return;
    }
    readyRef.current = true;
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    slovakiaTilesAtZoom(7).forEach((tile) => {
      loadBasemapTexture(tile.zoom, tile.x, tile.y);
    });
  }, []);

  useFrame(({ camera, size }) => {
    const persp = camera as PerspectiveCamera;
    const zoom = zoomForCameraY(camera.position.y);
    const fov = ((Number.isFinite(persp.fov) ? persp.fov : 16) * Math.PI) / 180;
    const halfHeight = Math.tan(fov / 2) * camera.position.y * 1.15;
    const halfWidth = halfHeight * (size.width / Math.max(size.height, 1));
    const southWest = unproject(camera.position.x - halfWidth, camera.position.z + halfHeight);
    const northEast = unproject(camera.position.x + halfWidth, camera.position.z - halfHeight);
    const viewMinLat = Math.min(southWest.lat, northEast.lat);
    const viewMaxLat = Math.max(southWest.lat, northEast.lat);
    const viewMinLng = Math.min(southWest.lng, northEast.lng);
    const viewMaxLng = Math.max(southWest.lng, northEast.lng);
    const northWest = latLngToTile(viewMaxLat, viewMinLng, zoom);
    const southEast = latLngToTile(viewMinLat, viewMaxLng, zoom);
    const needed: BasemapTileRef[] = [];
    const xMin = Math.min(northWest.x, southEast.x);
    const xMax = Math.max(northWest.x, southEast.x);
    const yMin = Math.min(northWest.y, southEast.y);
    const yMax = Math.max(northWest.y, southEast.y);
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        if (tileOverlapsBounds(zoom, x, y, SLOVAKIA_BOUNDS)) {
          needed.push({ zoom, x, y });
        }
      }
    }
    if (needed.length > BASEMAP_MAX_TILES) {
      const center = unproject(camera.position.x, camera.position.z);
      const mid = latLngToTile(center.lat, center.lng, zoom);
      needed.sort((a, b) => {
        const da = Math.abs(a.x - mid.x) + Math.abs(a.y - mid.y);
        const db = Math.abs(b.x - mid.x) + Math.abs(b.y - mid.y);
        return da - db;
      });
      needed.length = BASEMAP_MAX_TILES;
    }
    const retained = retainedRef.current;
    const neededKeys = new Set(needed.map((tile) => `${tile.zoom}/${tile.x}/${tile.y}`));
    needed.forEach((tile) => {
      retained.set(`${tile.zoom}/${tile.x}/${tile.y}`, tile);
    });
    if (retained.size > BASEMAP_RETAIN_TILES) {
      Array.from(retained.keys()).forEach((key) => {
        if (retained.size <= BASEMAP_RETAIN_TILES) {
          return;
        }
        if (!neededKeys.has(key)) {
          retained.delete(key);
        }
      });
    }
    const next = Array.from(retained.values());
    const signature = next.map((tile) => `${tile.zoom}/${tile.x}/${tile.y}`).join('|');
    if (signature !== signatureRef.current) {
      signatureRef.current = signature;
      setTiles(next);
    }
  });

  return (
    <group>
      {tiles.map((tile) => (
        <BasemapTileMesh
          key={`${tile.zoom}/${tile.x}/${tile.y}`}
          zoom={tile.zoom}
          tileX={tile.x}
          tileY={tile.y}
          onReady={handleReady}
        />
      ))}
    </group>
  );
};


const StationLayer: React.FC<{
  dataset?: GtfsDataset | null;
  isCoordinateVisible: (coord: { lat: number; lng: number }) => boolean;
}> = ({ dataset, isCoordinateVisible }) => {
  const catalog = useMemo(() => {
    const namedPlaces = [
      ...MAJOR_CITIES.map((city) => ({
        name: city.name,
        lat: city.lat,
        lng: city.lng,
        rank: namedPlaceRank(city.size),
      })),
      ...SLOVAK_CITIES.map((city) => ({
        name: city.name,
        lat: city.lat,
        lng: city.lng,
        rank: 'small' as const,
      })),
    ];
    const uniqueNamed: typeof namedPlaces = [];
    const namedKeys = new Set<string>();
    namedPlaces.forEach((place) => {
      const key = stationNameKey(place.name);
      if (namedKeys.has(key)) {
        return;
      }
      namedKeys.add(key);
      uniqueNamed.push(place);
    });

    const stops = dataset
      ? Object.values(dataset.stops).filter((stop) =>
          isCoordinateVisible({ lat: stop.lat, lng: stop.lng })
        )
      : [];

    const namedDisks: StationDiskItem[] = [];
    const namedLabels: NamedStationLabel[] = [];
    const occupied = uniqueNamed.map((place) => {
      let lat = place.lat;
      let lng = place.lng;
      let best = Number.POSITIVE_INFINITY;
      stops.forEach((stop) => {
        const dLat = stop.lat - place.lat;
        const dLng = stop.lng - place.lng;
        const dist = dLat * dLat + dLng * dLng;
        if (dist < best && dist < 0.045 * 0.045) {
          best = dist;
          lat = stop.lat;
          lng = stop.lng;
        }
      });
      const [x, , z] = project({ lat, lng });
      namedDisks.push({
        x,
        z,
        rank: place.rank,
      });
      namedLabels.push({
        key: `named-${place.name}`,
        name: place.name,
        x,
        z,
        rank: place.rank,
        font: STATION_FONT_SIZE[place.rank],
        maxY: STATION_LABEL_MAX_Y[place.rank],
        offsetX: 2.1,
      });
      return { x, z };
    });

    const tinyByName = new Map<string, TinyStationLabel>();
    stops.forEach((stop) => {
      const key = stationNameKey(stop.name);
      if (!key || namedKeys.has(key) || tinyByName.has(key)) {
        return;
      }
      const [x, , z] = project({ lat: stop.lat, lng: stop.lng });
      const tooClose = occupied.some((place) => {
        const dx = place.x - x;
        const dz = place.z - z;
        return dx * dx + dz * dz < 9;
      });
      if (tooClose) {
        return;
      }
      tinyByName.set(key, { key, name: stop.name, x, z });
    });
    const tinyStops = Array.from(tinyByName.values());
    const tinyDisks: StationDiskItem[] = tinyStops.map((stop) => ({
      x: stop.x,
      z: stop.z,
      rank: 'tiny',
    }));

    return { namedDisks, namedLabels, tinyDisks, tinyStops };
  }, [dataset, isCoordinateVisible]);

  return (
    <group>
      <StationDiskInstances items={catalog.namedDisks} />
      <StationDiskInstances items={catalog.tinyDisks} visibleMaxY={STATION_TINY_DISK_MAX_Y} />
      <NamedStationLabels labels={catalog.namedLabels} />
      <TinyStationLabels stops={catalog.tinyStops} />
    </group>
  );
};

const TrainMesh: React.FC<{
  train: TrainRenderState;
  isSelected?: boolean;
  onClick?: (trainNumber: string) => void;
  focusedPositionRef?: React.MutableRefObject<Coordinate | null>;
  tracedRouteRef?: React.MutableRefObject<Coordinate[] | null>;
  focusedStations?: Array<Coordinate | null>;
  journeyStops?: JourneyStop[];
}> = ({
  train,
  isSelected = false,
  onClick,
  focusedPositionRef,
  tracedRouteRef,
  focusedStations,
  journeyStops,
}) => {
  const ref = useRef<Mesh>(null);
  const targetVector = useMemo(() => new Vector3(), []);
  const { camera } = useThree();

  useFrame(() => {
    if (!isSelected || !ref.current) {
      return;
    }
    let liveCoordinate = focusedPositionRef?.current ?? train.position;
    const traced = tracedRouteRef?.current;
    if (
      traced &&
      traced.length > 1 &&
      focusedStations &&
      journeyStops &&
      journeyStops.length > 0
    ) {
      const cursor = routeCursor(focusedStations, journeyStops, new Date());
      if (cursor.from && cursor.to) {
        liveCoordinate = placeOnPath(traced, cursor.from, cursor.to, cursor.fraction);
      }
    }
    if (!liveCoordinate) {
      return;
    }
    const [x, y, z] = project(liveCoordinate);
    targetVector.set(x, y + TRAIN_VERTICAL_OFFSET, z);
    ref.current.position.lerp(targetVector, 0.35);
    if (camera) {
      ref.current.quaternion.copy(camera.quaternion);
    }
  });

  if (!train.position) {
    return null;
  }
  const [initialX, initialY, initialZ] = project(train.position);
  const initialYWithOffset = initialY + TRAIN_VERTICAL_OFFSET;

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (onClick) {
      onClick(isSelected ? '' : train.trainNumber);
    }
  };

  const size = isSelected ? TRAIN_SELECTED_SIZE : TRAIN_BASE_SIZE;

  return (
    <mesh
      ref={ref}
      geometry={TRAIN_BOX_GEOMETRY}
      scale={size}
      position={[initialX, initialYWithOffset, initialZ]}
      onClick={handleClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'default';
      }}
    >
      <meshBasicMaterial color={train.color} />
    </mesh>
  );
};

const StaticTrainMesh: React.FC<{
  train: TrainRenderState;
  onClick?: (trainNumber: string) => void;
}> = ({ train, onClick }) => {
  if (!train.position) {
    return null;
  }
  const [x, y, z] = project(train.position);
  return (
    <mesh
      geometry={TRAIN_BOX_GEOMETRY}
      scale={TRAIN_BASE_SIZE}
      position={[x, y + TRAIN_VERTICAL_OFFSET, z]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(train.trainNumber);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'default';
      }}
    >
      <meshBasicMaterial color={train.color} />
    </mesh>
  );
};

interface MapSceneProps {
  trains: TrainRenderState[];
  focusedTrainNumber?: string | null;
  focusedPositionRef?: React.MutableRefObject<Coordinate | null>;
  focusedStations?: Array<Coordinate | null>;
  journeyStops?: JourneyStop[];
  onTrainClick?: (trainNumber: string) => void;
  dataset?: GtfsDataset | null;
  onOsmStatusChange?: (status: OsmStatus) => void;
  useLiveApi: boolean;
  onToggleLiveApi: (enabled: boolean) => void;
  onCanvasStateChange?: (state: 'loading' | 'loaded') => void;
}

export const MapScene: React.FC<MapSceneProps> = React.memo(({
  trains,
  focusedTrainNumber,
  focusedPositionRef,
  focusedStations,
  journeyStops,
  onTrainClick,
  dataset,
  onOsmStatusChange,
  useLiveApi,
  onToggleLiveApi,
  onCanvasStateChange,
}) => {
  const controlsRef = useRef<any>(null);
  const CAMERA_PAN_FACTOR = 0.02;
  const tileWorkerRef = useRef<Worker | null>(null);
  const tileResponseResolversRef = useRef(new Map<number, (value: OsmFetchResult) => void>());
  const tileResponseRejectorsRef = useRef(new Map<number, (error: Error) => void>());
  const nextTileRequestIdRef = useRef(0);
  const tileLoadVersionRef = useRef(0);
  useEffect(() => {
    const movementMap: Record<string, { dx: number; dz: number }> = {
      arrowup: { dx: 0, dz: -1 },
      arrowdown: { dx: 0, dz: 1 },
      arrowleft: { dx: -1, dz: 0 },
      arrowright: { dx: 1, dz: 0 },
      w: { dx: 0, dz: -1 },
      s: { dx: 0, dz: 1 },
      a: { dx: -1, dz: 0 },
      d: { dx: 1, dz: 0 },
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) {
        return;
      }
      const delta = movementMap[event.key.toLowerCase()];
      if (!delta) {
        return;
      }
      event.preventDefault();
      const controls = controlsRef.current;
      if (!controls) {
        return;
      }
      const cameraObj = controls.object as { position: Vector3 } | undefined;
      const targetVec = controls.target as Vector3 | undefined;
      if (!cameraObj || !targetVec) {
        return;
      }
      const distance = Math.max(1, cameraObj.position.distanceTo(targetVec));
      const panDistance = distance * CAMERA_PAN_FACTOR;
      const movement = new Vector3(delta.dx * panDistance, 0, delta.dz * panDistance);
      cameraObj.position.add(movement);
      targetVec.add(movement);
      controls.update();
    };
    window.addEventListener('keydown', handleKeyDown, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/osmTileLoader.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const handleMessage = (event: MessageEvent<TileWorkerResponse>) => {
      const data = event.data;
      if (data.type === 'tileResult') {
        const resolve = tileResponseResolversRef.current.get(data.id);
        if (resolve) {
          resolve(data.result);
          tileResponseResolversRef.current.delete(data.id);
          tileResponseRejectorsRef.current.delete(data.id);
        }
      } else if (data.type === 'tileError') {
        const reject = tileResponseRejectorsRef.current.get(data.id);
        if (reject) {
          reject(new Error(data.error));
          tileResponseResolversRef.current.delete(data.id);
          tileResponseRejectorsRef.current.delete(data.id);
        }
      }
    };
    worker.addEventListener('message', handleMessage);
    tileWorkerRef.current = worker;
    return () => {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      tileWorkerRef.current = null;
    };
  }, []);
  const requestTile = useCallback(
    (bounds: TileBounds, level: OsmDetailLevel): Promise<OsmFetchResult> => {
      const worker = tileWorkerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Tile worker is not initialized'));
      }
      const id = nextTileRequestIdRef.current++;
      return new Promise<OsmFetchResult>((resolve, reject) => {
        tileResponseResolversRef.current.set(id, resolve);
        tileResponseRejectorsRef.current.set(id, reject);
        worker.postMessage({ type: 'loadTile', id, bounds, level });
      });
    },
    []
  );
  const [debugVisible, setDebugVisible] = useState(false);
  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    osmRailData: { loaded: false, count: 0, sizeKB: 0, loading: false },
    elevationData: { loaded: false, resolution: '0x0', sizeKB: 0, loading: true },
    trainMatching: { totalTrains: 0, matchedTrains: 0, osmRoutes: 0, totalSegments: 0 },
    rendering: { osmLines: 0, gtfsLines: 0, trains: 0 },
    performance: { frameTime: 0 },
    animation: {
      statuses: {},
      warnings: [],
      pendingWorkerRequests: 0,
      pendingResolvers: 0,
      pendingTrains: [],
    },
  });
  
  const wayOccurrencesRef = useRef<Map<number, number>>(new Map());
  const [railTiles, setRailTiles] = useState<RailTile[]>([]);
  const [fineRailPositions, setFineRailPositions] = useState<FineRailView | null>(null);
  const tileCacheRef = useRef<Set<string>>(new Set());
  const duplicateTileLogKeysRef = useRef<Set<string>>(new Set());
  const createdGeometriesRef = useRef<Set<BufferGeometry>>(new Set());
  const osmWaysRef = useRef<Map<number, OSMWay>>(new Map());
  const clippedNetworkRef = useRef<OSMWay[]>([]);
  const osmGraphRef = useRef<OsmGraph>(new Map());
  const [osmGraphTick, setOsmGraphTick] = useState(0);
  const [networkRoute, setNetworkRoute] = useState<Coordinate[] | null>(null);
  const tracedRouteRef = useRef<Coordinate[] | null>(null);
  const [osmWayCount, setOsmWayCount] = useState(0);
  const [osmStatus, setOsmStatus] = useState<OsmStatus>({
    tilesLoaded: 0,
    lastFetch: 'never',
    lastStatus: 'idle',
    loading: true,
  });
  const [terrainLoaded, setTerrainLoaded] = useState(false);
  const plannedTileTotalRef = useRef(0);
  const [tileLoadPlan, setTileLoadPlan] = useState<TileLoadPlan>({
    total: 0,
    completed: 0,
  });
  const [loadingConsole, setLoadingConsole] = useState<string[]>([]);
  const [loadingDismissed, setLoadingDismissed] = useState(false);
  const cameraAnimationRef = useRef({
    animating: false,
    startTime: 0,
  });
  useEffect(() => {
    if (onOsmStatusChange) {
      onOsmStatusChange(osmStatus);
    }
  }, [osmStatus, onOsmStatusChange]);
  const appendLoadingMessage = useCallback((message: string) => {
    setLoadingConsole((prev) => {
      const next = [...prev, message];
      if (next.length > 4) {
        next.shift();
      }
      return next;
    });
  }, []);
  const markTileProgress = useCallback(() => {
    const total = plannedTileTotalRef.current;
    if (total === 0) {
      return;
    }
    setTileLoadPlan((prev) => {
      const nextCompleted = Math.min(total, prev.completed + 1);
      appendLoadingMessage(`Loaded ${nextCompleted}/${total} OSM tiles`);
      return { total, completed: nextCompleted };
    });
  }, [appendLoadingMessage]);
  const handleBasemapReady = useCallback(() => {
    setTerrainLoaded(true);
  }, []);
  const loadingSkippedRef = useRef(false);
  const handleLoadingSkip = useCallback(() => {
    loadingSkippedRef.current = true;
    appendLoadingMessage('Loading skipped by user');
    setLoadingDismissed(true);
  }, [appendLoadingMessage]);
  useEffect(() => {
    if (tileLoadPlan.total > 0) {
      appendLoadingMessage(`Planning ${tileLoadPlan.total} OSM tiles`);
    }
  }, [tileLoadPlan.total, appendLoadingMessage]);
  useEffect(() => {
    if (terrainLoaded) {
      appendLoadingMessage('Loaded basemap');
    }
  }, [terrainLoaded, appendLoadingMessage]);
  const [osmRefreshTrigger, setOsmRefreshTrigger] = useState(0);
  const [osmDetailLevel, setOsmDetailLevel] = useState<OsmDetailLevel>('coarse');
  const [svgOutlinePolygons, setSvgOutlinePolygons] = useState<LatLngPolygon[]>([]);
  const outlineLoadedRef = useRef(false);
  const [viewMode] = useState<'2d' | '3d'>('2d');
  const embankmentMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#ffffff',
      }),
    []
  );
  useEffect(() => {
    let cancelled = false;
    const loadOutline = async () => {
      try {
        const response = await fetch(SVG_OUTLINE_URL);
        if (!response.ok) {
          return;
        }
        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'image/svg+xml');
        const svgElement = doc.querySelector('svg');
        const viewBoxAttr = svgElement?.getAttribute('viewBox');
        const viewBoxValues = viewBoxAttr
          ? viewBoxAttr.split(/[\s,]+/).map((value) => Number(value))
          : [];
        const [vbX = 0, vbY = 0, vbWidth = 678.8, vbHeight = 336.63] =
          viewBoxValues;
        const latSpan = SLOVAKIA_BOUNDS.maxLat - SLOVAKIA_BOUNDS.minLat;
        const lngSpan = SLOVAKIA_BOUNDS.maxLng - SLOVAKIA_BOUNDS.minLng;
        const loader = new SVGLoader();
        const svgData = loader.parse(text);
        const polygons = svgData.paths
          .flatMap((path) =>
            path.subPaths.map((subPath) =>
              subPath.getPoints(24).map((point) => ({
                lat:
                  SLOVAKIA_BOUNDS.maxLat -
                  ((point.y - vbY) / Math.max(vbHeight, 1)) * latSpan,
                lng:
                  SLOVAKIA_BOUNDS.minLng +
                  ((point.x - vbX) / Math.max(vbWidth, 1)) * lngSpan,
              }))
            )
          )
          .filter((polygon) => polygon.length >= 3)
          .sort((a, b) => b.length - a.length)
          .slice(0, 1);
        if (cancelled) {
          return;
        }
        if (polygons.length > 0) {
          setSvgOutlinePolygons(polygons);
          outlineLoadedRef.current = true;
        }
      } catch (error) {
        console.warn('Failed to load SVG outline:', error);
      }
    };

    loadOutline();

    return () => {
      cancelled = true;
    };
  }, [setOsmRefreshTrigger]);
  const terrainSampler = undefined;
  const isCoordinateVisible = useCallback(
    (coord: LatLngPoint) => isCoordinateInsideOutline(coord, svgOutlinePolygons),
    [svgOutlinePolygons]
  );
  const finePositionsRef = useRef<number[]>([]);
  const finePositionsByTypeRef = useRef<Map<string, number[]>>(new Map());
  const pathfinderWorkerRef = useRef<Worker | null>(null);
  const pathfinderGraphReadyRef = useRef(false);
  const pathfinderResolversRef = useRef<Map<string, (result: PathfinderWorkerResult) => void>>(new Map());
  const pathfinderRejectorsRef = useRef<Map<string, (message: string) => void>>(new Map());
  const workerRequestIdByTrainRef = useRef<Map<string, string>>(new Map());
  const workerRequestInfoRef = useRef<Map<string, string>>(new Map());
  const trainsInBoundingBoxRef = useRef<Set<string>>(new Set());
  const [animationStatuses, setAnimationStatuses] = useState<Record<string, 'searching' | 'finished' | 'failed'>>({});
  const osmGraph = useMemo(() => osmGraphRef.current, [osmGraphTick]);
  const railMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: '#38bdf8',
        linewidth: 1,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        depthWrite: false,
      }),
    []
  );
  const bridgeMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: '#f97316',
        linewidth: 2,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    []
  );
  const tunnelMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: '#a855f7',
        linewidth: 2,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    []
  );
  const [bridgeLineGeometries, setBridgeLineGeometries] = useState<BufferGeometry[]>([]);
  const [tunnelLineGeometries, setTunnelLineGeometries] = useState<BufferGeometry[]>([]);
  const handleDetailChange = useCallback(
    (level: OsmDetailLevel) => {
      if (level === osmDetailLevel) {
        return;
      }
      setOsmDetailLevel(level);
      setOsmRefreshTrigger((prev) => prev + 1);
    },
    [osmDetailLevel, setOsmRefreshTrigger]
  );
  const normalizedStops = useMemo(() => {
    if (!dataset) {
      return [];
    }
    return Object.values(dataset.stops).map((stop) => ({
      stop,
      normalized: normalizeStopName(stop.name),
    }));
  }, [dataset]);
  const lookupStopByName = useCallback(
    (value?: string) => {
      if (!value) {
        return undefined;
      }
      const normalizedValue = normalizeStopName(value);
      if (!normalizedValue) {
        return undefined;
      }
      const exact = normalizedStops.find(
        (entry) => entry.normalized === normalizedValue
      );
      if (exact) {
        return exact.stop;
      }
      const includes = normalizedStops.find((entry) =>
        entry.normalized.includes(normalizedValue)
      );
      if (includes) {
        return includes.stop;
      }
      const included = normalizedStops.find((entry) =>
        normalizedValue.includes(entry.normalized)
      );
      if (included) {
        return included.stop;
      }
      return undefined;
    },
    [normalizedStops]
  );
  const [boundingBox] = useState<BoundingBox | null>(null);
  const [boundingBoxActive] = useState(false);
  const [boundingTrains, setBoundingTrains] = useState<Set<string>>(new Set());
  const [cameraDistance, setCameraDistance] = useState(0);

  const cancelAnimationSearch = useCallback(
    (trainNumber: string) => {
      const timer = animationRequestsRef.current.get(trainNumber);
      if (timer) {
        clearTimeout(timer);
        animationRequestsRef.current.delete(trainNumber);
      }
      const requestId = workerRequestIdByTrainRef.current.get(trainNumber);
      if (requestId) {
        workerRequestIdByTrainRef.current.delete(trainNumber);
        workerRequestInfoRef.current.delete(requestId);
        const resolver = pathfinderResolversRef.current.get(requestId);
        pathfinderResolversRef.current.delete(requestId);
        pathfinderRejectorsRef.current.delete(requestId);
        resolver?.({ path: [], reason: 'cancelled' });
      }
      setAnimationStatuses((prev) => {
        if (!prev[trainNumber]) {
          return prev;
        }
        const next = { ...prev };
        delete next[trainNumber];
        return next;
      });
    },
    [setAnimationStatuses]
  );
  const animationStatesRef = useRef<Map<string, TrainAnimationState>>(new Map());
  const [animationVersion, setAnimationVersion] = useState(0);
  const [animatedTrainCount, setAnimatedTrainCount] = useState(0);
  const [animationWarnings, setAnimationWarnings] = useState<string[]>([]);
  const animationRequestsRef = useRef<Map<string, number>>(new Map());
  const [searchCircle, setSearchCircle] = useState<{
    center: LatLngPoint;
    radiusMeters: number;
  } | null>(null);
  const embankmentCacheRef = useRef<Map<string, BufferGeometry>>(new Map());
  const approximateEmbankmentMemory = () => {
    let bytes = 0;
    embankmentCacheRef.current.forEach((geometry) => {
      const positionAttr = geometry.getAttribute('position');
      if (positionAttr) {
        bytes += positionAttr.count * positionAttr.itemSize * 4;
      }
    });
    return bytes;
  };
  const [nextMapPoints, setNextMapPoints] = useState<Record<string, Coordinate>>({});
  const removeNextMapPoint = useCallback((trainNumber: string) => {
    setNextMapPoints((prev) => {
      if (!prev[trainNumber]) {
        return prev;
      }
      const next = { ...prev };
      delete next[trainNumber];
      return next;
    });
  }, []);
  const [simplifyTolerance] = useState<number>(0);
  const rebuildGraphForTolerance = useCallback(() => {
    const storedWays = Array.from(osmWaysRef.current.values());
    if (storedWays.length === 0) {
      return;
    }
    const newGraph: OsmGraph = new Map();
    resetSpatialIndex();
    extendOsmGraph(newGraph, storedWays);
    osmGraphRef.current = newGraph;
    setOsmGraphTick((prev) => prev + 1);
  }, []);
  useEffect(() => {
    setSimplifyToleranceMeters(simplifyTolerance);
    rebuildGraphForTolerance();
  }, [simplifyTolerance, rebuildGraphForTolerance]);
  const cleanupAnimatedTrain = useCallback(
    (trainNumber: string) => {
      cancelAnimationSearch(trainNumber);
      removeNextMapPoint(trainNumber);
      animationStatesRef.current.delete(trainNumber);
    },
    [cancelAnimationSearch, removeNextMapPoint]
  );
  const pathFailureReasons = useRef<Record<string, string>>({});
  const formatReason = useCallback((reason?: string) => {
    if (!reason) return 'no path returned';
    const map: Record<string, string> = {
      start_not_found: 'No nearby start node in graph',
      end_not_found: 'No nearby end node in graph',
      start_and_end_not_found: 'Neither start nor end node found',
      no_route_found: 'Start and end could not be connected',
      disconnected: 'Graph path segment disconnected',
      left_bounding_box: 'Train left bounding box before search finished',
    };
    return map[reason] ?? reason.replace(/_/g, ' ');
  }, []);
  const recordPathFailure = useCallback(
    (trainNumber: string, reason?: string) => {
      const formatted = formatReason(reason);
      pathFailureReasons.current[trainNumber] = formatted;
      const message = `${trainNumber}: ${formatted}`;
      setAnimationWarnings((prev) =>
        Array.from(new Set([...prev, message]))
      );
    },
    [formatReason]
  );

type AnimationParams = {
  trainNumber: string;
  boundingBoxKey: string;
  startTimeMs: number;
  endTimeMs: number;
  delayMinutes: number;
  startStop: Coordinate;
  endStop: Coordinate;
  shapePath: Coordinate[];
  pathLengthHint: number;
  circleCenter: LatLngPoint;
  circleRadiusMeters: number;
  circleAttempt: number;
  liveStart: Coordinate;
  liveEnd: Coordinate;
};
  function prepareAnimationParams(
    train: TrainRenderState,
    boundingBoxKey: string
  ): AnimationParams | null {
    if (!dataset) {
      return null;
    }
      const trip =
        dataset.trips.byTrainNumber[train.trainNumber] ??
        dataset.trips.byTripId[train.trainNumber];
      if (!trip) {
        return null;
      }
      const stopTimes = dataset.stopTimes[trip.tripId];
      if (!stopTimes || stopTimes.length < 2) {
        return null;
      }

      const prevStopGuess =
        lookupStopByName(train.rosterPreviousStation) ?? lookupStopByName(train.currentStation);
      const nextStopGuess =
        lookupStopByName(train.rosterNextStation) ?? lookupStopByName(train.nextStation);

      const fallbackIndex = Math.max(
        0,
        Math.min(
          stopTimes.length - 1,
          Math.round(train.progress * Math.max(stopTimes.length - 1, 1))
        )
      );

      let prevIndex =
        prevStopGuess &&
        stopTimes.findIndex((stopTime) => stopTime.stopId === prevStopGuess.stopId);
      let nextIndex =
        nextStopGuess &&
        stopTimes.findIndex((stopTime) => stopTime.stopId === nextStopGuess.stopId);

      if (train.rosterOrderCurrentStation !== undefined) {
        const orderIndex = stopTimes.findIndex(
          (stopTime) => stopTime.stopSequence === train.rosterOrderCurrentStation
        );
        if (orderIndex !== -1) {
          prevIndex =
            prevIndex === undefined || prevIndex < 0
              ? Math.max(0, orderIndex - 1)
              : prevIndex;
          nextIndex =
            nextIndex === undefined || nextIndex < 0
              ? Math.min(stopTimes.length - 1, orderIndex + 1)
              : nextIndex;
        }
      }

      if (prevIndex === undefined || prevIndex < 0) {
        prevIndex = Math.max(0, fallbackIndex - 1);
      }
      if (nextIndex === undefined || nextIndex < 0) {
        nextIndex = Math.min(stopTimes.length - 1, fallbackIndex + 1);
      }

      if (nextIndex <= prevIndex) {
        nextIndex = Math.min(stopTimes.length - 1, prevIndex + 1);
      }

      const startStopTime = stopTimes[prevIndex];
      const endStopTime = stopTimes[nextIndex];
      const endIndex = nextIndex;
      const startStop = dataset.stops[startStopTime.stopId];
      const endStop = dataset.stops[endStopTime.stopId];
      if (!startStop || !endStop) {
        return null;
      }

      const startTimeMs =
        startStopTime.departureTimeMs ?? startStopTime.arrivalTimeMs ?? 0;
      let endTimeMs =
        endStopTime.arrivalTimeMs ??
        endStopTime.departureTimeMs ??
        startTimeMs +
          30 * 60 * 1000;
      if (endTimeMs <= startTimeMs) {
        endTimeMs += DAY_MS;
      }

      const delayMs = train.delayMinutes * 60_000;
      const startWithDelay = startTimeMs + delayMs;
      const endWithDelay = endTimeMs + delayMs;
      if (endWithDelay <= startWithDelay) {
        return null;
      }

      const startCoord: Coordinate = {
        lat: startStop.lat,
        lng: startStop.lng,
        sequence: startStopTime.stopSequence,
      };
      const endCoord: Coordinate = {
        lat: endStop.lat,
        lng: endStop.lng,
        sequence: endStopTime.stopSequence,
      };
      const shapePath = train.shapePath ?? [];
      const liveStart: Coordinate = train.position ?? startCoord;
      const liveEnd: Coordinate = getNextLiveRoutePoint(train) ?? endCoord;
      const circleCenter = {
        lat: (liveStart.lat + liveEnd.lat) / 2,
        lng: (liveStart.lng + liveEnd.lng) / 2,
      };
      const rawCircleRadiusMeters = Math.max(
        80,
        haversineDistance(circleCenter, liveStart) || 80
      );
    const circleRadiusMeters = Math.min(
      rawCircleRadiusMeters,
      MAX_SEARCH_RADIUS_METERS,
      MAX_CIRCLE_RADIUS_METERS
    );
      const circleBasis = train.position ? 'livePosition' : 'gtfsFallback';
      return {
        trainNumber: train.trainNumber,
        boundingBoxKey,
        startTimeMs: startWithDelay,
        endTimeMs: endWithDelay,
        delayMinutes: train.delayMinutes,
        startStop: startCoord,
        endStop: endCoord,
        shapePath,
        pathLengthHint: Math.max(2, endIndex - prevIndex + 1),
        circleCenter,
        circleRadiusMeters,
        circleAttempt: 0,
        liveStart,
        liveEnd,
      };
  }

  const requestPathFromWorker = useCallback(
    (
      searchParams: AnimationParams,
      bounds: LatLngBounds
    ): Promise<PathfinderWorkerResult> => {
      const worker = pathfinderWorkerRef.current;
      const graph = osmGraphRef.current;
      if (!worker || graph.size === 0 || !pathfinderGraphReadyRef.current) {
        return Promise.resolve(
          findOsmPath(graph, searchParams.liveStart, searchParams.liveEnd, bounds)
        );
      }
      const trainNumber = searchParams.trainNumber;
      return new Promise<PathfinderWorkerResult>((resolve, reject) => {
        const requestId = `${searchParams.trainNumber}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;
        workerRequestIdByTrainRef.current.set(trainNumber, requestId);
        workerRequestInfoRef.current.set(requestId, trainNumber);
        pathfinderResolversRef.current.set(requestId, resolve);
        pathfinderRejectorsRef.current.set(requestId, reject);
        worker.postMessage({
          type: 'search',
          requestId,
          start: searchParams.liveStart,
          end: searchParams.liveEnd,
          bounds,
        });
      });
    },
    []
  );

  const queueAnimationPath = useCallback(
    (params: AnimationParams, boundingBox?: BoundingBox) => {
      const trainNumber = params.trainNumber;
      if (animationRequestsRef.current.has(trainNumber)) {
        return;
      }
      setAnimationStatuses((prev) => ({ ...prev, [trainNumber]: 'searching' }));
      const performSearch = async (searchParams: AnimationParams) => {
        animationRequestsRef.current.delete(trainNumber);
        setSearchCircle({
          center: searchParams.circleCenter,
          radiusMeters: searchParams.circleRadiusMeters,
        });
        const bounds = circleToBounds(
          searchParams.circleCenter,
          searchParams.circleRadiusMeters
        );
      if (!trainsInBoundingBoxRef.current.has(trainNumber)) {
        return;
      }
      const pathSearchStart = performance.now();
        if (!trainsInBoundingBoxRef.current.has(trainNumber)) {
          pathFailureReasons.current[trainNumber] = formatReason('left_bounding_box');
          recordPathFailure(trainNumber, 'left_bounding_box');
          setAnimationStatuses((prev) => {
            if (!prev[trainNumber]) {
              return prev;
            }
            return { ...prev, [trainNumber]: 'failed' };
          });
          return;
        }
        const result = await requestPathFromWorker(searchParams, bounds).catch(
          (error) => {
            console.error('Pathfinder worker failed', error);
            return {
              path: [],
              reason: error instanceof Error ? error.message : 'worker_error',
            };
          }
        );
        const { path, reason } = result;
        const duration = performance.now() - pathSearchStart;
        if (!trainsInBoundingBoxRef.current.has(trainNumber)) {
          return;
        }
        if (path.length > 0) {
          const sampleStart = path[0];
          const sampleEnd = path[path.length - 1];
          const newState: TrainAnimationState = {
            trainNumber,
            path,
            startTimeMs: searchParams.startTimeMs,
            endTimeMs: searchParams.endTimeMs,
            delayMinutes: searchParams.delayMinutes,
            boundingBoxKey: searchParams.boundingBoxKey,
            startStop: searchParams.startStop,
            endStop: searchParams.endStop,
          };
          animationStatesRef.current.set(trainNumber, newState);
          setAnimatedTrainCount(animationStatesRef.current.size);
          setAnimationVersion((prev) => prev + 1);
          setAnimationStatuses((prev) => ({ ...prev, [trainNumber]: 'finished' }));
          return;
        }
        if (searchParams.circleAttempt === 0) {
          const retryParams = {
            ...searchParams,
            circleAttempt: 1,
            circleRadiusMeters: searchParams.circleRadiusMeters * 2,
          };
          performSearch(retryParams);
          return;
        }
        recordPathFailure(trainNumber, reason ?? 'no_route_found');
        setAnimationStatuses((prev) => ({ ...prev, [trainNumber]: 'failed' }));
      };

      const timer = window.setTimeout(() => {
        animationRequestsRef.current.delete(trainNumber);
        performSearch(params).catch((error) => {
          console.error('Animation path search failed', error);
        });
      }, 0);
      animationRequestsRef.current.set(trainNumber, timer);
    },
    [requestPathFromWorker, recordPathFailure]
  );

  const handleWorkerMessage = useCallback(
    (event: MessageEvent<PathfinderWorkerResponse>) => {
      const response = event.data;
      if (response.type === 'graphReady') {
        pathfinderGraphReadyRef.current = response.nodeCount > 0;
        return;
      }
      const trainNumber = workerRequestInfoRef.current.get(response.requestId);
      workerRequestInfoRef.current.delete(response.requestId);
      if (trainNumber) {
        workerRequestIdByTrainRef.current.delete(trainNumber);
      }
      const resolver = pathfinderResolversRef.current.get(response.requestId);
      const rejector = pathfinderRejectorsRef.current.get(response.requestId);
      pathfinderResolversRef.current.delete(response.requestId);
      pathfinderRejectorsRef.current.delete(response.requestId);
      if (response.type === 'result') {
        resolver?.({ path: response.path, reason: response.reason });
      } else {
        const graph = osmGraphRef.current;
        if (response.message === 'Graph not initialized' && graph.size > 0) {
          pathfinderGraphReadyRef.current = false;
          resolver?.({ path: [], reason: 'graph_not_ready' });
          return;
        }
        rejector?.(response.message);
      }
    },
    []
  );

  useEffect(() => {
    const worker = new Worker(new URL('../workers/pathfinder.worker.ts', import.meta.url), { type: 'module' });
    pathfinderWorkerRef.current = worker;
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', (event) => {
      console.error('Pathfinder worker error', event);
    });
    return () => {
      worker.removeEventListener('message', handleWorkerMessage);
      worker.terminate();
      pathfinderWorkerRef.current = null;
      pathfinderResolversRef.current.clear();
      pathfinderRejectorsRef.current.clear();
    };
  }, [handleWorkerMessage]);

  useEffect(() => {
    const worker = pathfinderWorkerRef.current;
    if (!worker || osmGraph.size === 0) {
      pathfinderGraphReadyRef.current = false;
      return;
    }
    pathfinderGraphReadyRef.current = false;
    try {
      worker.postMessage({
        type: 'initGraph',
        graph: serializeOsmGraph(osmGraph),
      });
    } catch (error) {
      console.error('Failed to send graph to worker', error);
      pathfinderGraphReadyRef.current = false;
    }
  }, [osmGraph, osmGraphTick]);

  useEffect(() => {
    let cancelled = false;

    const loadTiles = async () => {
      if (svgOutlinePolygons.length === 0) {
        return;
      }
      const loadVersion = ++tileLoadVersionRef.current;
      tileCacheRef.current.clear();
      wayOccurrencesRef.current = new Map();
      clippedNetworkRef.current = [];
      osmWaysRef.current = new Map();
      osmGraphRef.current = new Map();
      resetSpatialIndex();
      pathfinderGraphReadyRef.current = false;
      setRailTiles([]);
      setBridgeLineGeometries([]);
      setTunnelLineGeometries([]);
      finePositionsRef.current = [];
      finePositionsByTypeRef.current.clear();
      setOsmStatus((prev) => ({
        ...prev,
        tilesLoaded: 0,
        lastStatus: 'loading',
        loading: true,
      }));
      if (!loadingSkippedRef.current) {
        setLoadingDismissed(false);
      }
      setLoadingConsole(['Loading terrain...']);
      plannedTileTotalRef.current = 0;

      plannedTileTotalRef.current = 1;
      setTileLoadPlan({ total: 1, completed: 0 });
      const bridgeGeometries: BufferGeometry[] = [];
      const tunnelGeometries: BufferGeometry[] = [];
      let ways: OSMWay[] = [];
      let meta: OsmProxyMeta | undefined;
      let fetched = false;
      for (let attempt = 0; attempt < 3 && !fetched; attempt += 1) {
        if (cancelled || loadVersion !== tileLoadVersionRef.current) {
          return;
        }
        try {
          const result = await fetchSimplifiedNetwork();
          if (loadVersion !== tileLoadVersionRef.current || cancelled) {
            return;
          }
          ways = result.ways;
          meta = result.meta;
          fetched = ways.length > 0 || Boolean(meta);
        } catch (err) {
          console.error('Simplified railway fetch failed:', err);
        }
        if (!fetched && attempt < 2) {
          await sleep(600 * (attempt + 1));
        }
      }
      if (meta) {
        setOsmStatus((prev) => ({
          ...prev,
          tilesLoaded: ways.length > 0 ? 1 : 0,
          lastStatus: meta.status ?? prev.lastStatus,
          lastFetch: new Date().toLocaleTimeString(),
        }));
      }
      tileCacheRef.current.add('network');
      markTileProgress();

      if (!cancelled && ways.length > 0) {
        const filteredWays: OSMWay[] = [];
        ways.forEach((way) => {
          const seen = wayOccurrencesRef.current.get(way.id) ?? 0;
          if (seen === 0) {
            filteredWays.push(way);
          }
          wayOccurrencesRef.current.set(way.id, seen + 1);
        });
        const clipped = clipWaysToOutline(filteredWays, svgOutlinePolygons);
        clippedNetworkRef.current.push(...clipped);
        const filtered = closeRailGaps(clippedNetworkRef.current);
        filtered.forEach((way) => osmWaysRef.current.set(way.id, way));
        extendOsmGraph(osmGraphRef.current, filtered);
        setOsmGraphTick((prev) => prev + 1);
        setOsmWayCount(osmWaysRef.current.size);
        const bridgeWays = clippedNetworkRef.current.filter((way) => isBridge(way));
        if (bridgeWays.length > 0) {
          const positions = convertWaysToPositions(bridgeWays);
          if (positions.length > 0) {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(positions, 3));
            createdGeometriesRef.current.add(geometry);
            bridgeGeometries.push(geometry);
          }
        }
        const tunnelWays = clippedNetworkRef.current.filter((way) => isTunnel(way));
        if (tunnelWays.length > 0) {
          const positions = convertWaysToPositions(tunnelWays);
          if (positions.length > 0) {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(positions, 3));
            createdGeometriesRef.current.add(geometry);
            tunnelGeometries.push(geometry);
          }
        }
        const publishGroup = (groupWays: OSMWay[], railwayType: string) => {
          const positions = convertWaysToPositions(groupWays);
          if (positions.length === 0) {
            return null;
          }
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(positions, 3));
          createdGeometriesRef.current.add(geometry);
          return {
            key: `network-${railwayType}`,
            geometry,
            level: 'coarse',
            railwayType,
            opacity: 0.95,
          } satisfies RailTile;
        };
        const mainWays = filtered.filter((way) => isMainRailway(way));
        const branchWays = filtered.filter((way) => !isMainRailway(way));
        const tiles = [
          publishGroup(mainWays, 'rail'),
          publishGroup(branchWays, 'light_rail'),
        ].filter((tile): tile is RailTile => tile != null);
        if (tiles.length > 0) {
          setRailTiles(tiles);
        }
      }

      if (finePositionsByTypeRef.current.size > 0 && !cancelled) {
        finePositionsByTypeRef.current.forEach((coords, railwayType) => {
          if (coords.length === 0) {
            return;
          }
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(new Float32Array(coords), 3));
          createdGeometriesRef.current.add(geometry);
          setRailTiles((prev) => [
            ...prev,
            {
              key: `fine-agg-${railwayType}`,
              geometry,
              level: 'fine',
              railwayType,
              opacity: 1,
            },
          ]);
        });
        finePositionsByTypeRef.current.clear();
        finePositionsRef.current = [];
      }

      if (bridgeGeometries.length > 0) {
        setBridgeLineGeometries(bridgeGeometries);
      }
      if (tunnelGeometries.length > 0) {
        setTunnelLineGeometries(tunnelGeometries);
      }

      if (!cancelled) {
        setOsmStatus((prev) => ({ ...prev, loading: false }));
      }
    };

    loadTiles();

    return () => {
      cancelled = true;
    };
  }, [osmRefreshTrigger, osmDetailLevel, svgOutlinePolygons.length]);

  const purgeOsmCache = async () => {
    setOsmStatus((prev) => ({
      ...prev,
      lastStatus: 'purging',
      loading: true,
    }));
    try {
      await fetch('/proxy?mode=osm&purge=1');
      setOsmRefreshTrigger((prev) => prev + 1);
    } catch (error) {
      console.error('Failed to purge osm cache:', error);
      setOsmStatus((prev) => ({
        ...prev,
        lastStatus: 'purge_failed',
        loading: false,
      }));
    }
  };

  useEffect(() => {
    return () => {
      createdGeometriesRef.current.forEach((geometry) => geometry.dispose());
      createdGeometriesRef.current.clear();
      embankmentCacheRef.current.forEach((geometry) => geometry.dispose());
      embankmentCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const states = animationStatesRef.current;
    if (!dataset || !boundingBox || !boundingBoxActive) {
      if (states.size > 0) {
        const statesToClear = states.size;
        states.clear();
        setAnimatedTrainCount(0);
        setAnimationVersion((prev) => prev + 1);
      }
      setAnimationWarnings([]);
      setSearchCircle(null);
      setNextMapPoints({});
      return;
    }

    if (osmGraph.size === 0) {
      return;
    }

    const nowTime = getTodayTimeMs();
    const SNAP_GRID = 25;
    const snapValue = (value: number) => Math.round(value / SNAP_GRID);
    const boundingBoxKey = `${snapValue(boundingBox.centerX)}:${snapValue(
      boundingBox.centerZ
    )}`;
    let mutated = false;

    const effectStart = performance.now();
    const boundingCenter = { x: boundingBox.centerX, z: boundingBox.centerZ };
    const trainsInBox = trains.filter((train) => {
      const coordinate = estimateTrainBoundingCoordinate(train);
      const inside =
        coordinate && isPositionInsideBoundingBox(coordinate, boundingBox);
      return inside;
    });
    const activeTrainNumbers = new Set(trainsInBox.map((train) => train.trainNumber));
    trainsInBoundingBoxRef.current = activeTrainNumbers;
    setBoundingTrains(activeTrainNumbers);

    const toRemove: string[] = [];
    const statesCountBeforeCleanup = states.size;
    states.forEach((_, trainNumber) => {
      if (!activeTrainNumbers.has(trainNumber)) {
        toRemove.push(trainNumber);
      }
    });
    toRemove.forEach((trainNumber) => {
      cleanupAnimatedTrain(trainNumber);
      mutated = true;
    });

    const pendingTrainRequests = Array.from(workerRequestIdByTrainRef.current.keys());
    pendingTrainRequests.forEach((trainNumber) => {
      if (!activeTrainNumbers.has(trainNumber)) {
        cancelAnimationSearch(trainNumber);
        mutated = true;
      }
    });

    trainsInBox.forEach((train) => {
      if (states.has(train.trainNumber)) {
        return;
      }
      if (animationRequestsRef.current.has(train.trainNumber)) {
        return;
      }
      const params = prepareAnimationParams(train, boundingBoxKey);
      if (params) {
        setNextMapPoints((prev) => ({
          ...prev,
          [train.trainNumber]: params.liveEnd,
        }));
        queueAnimationPath(params, boundingBox);
      }
    });

    if (mutated) {
      setAnimatedTrainCount(states.size);
      setAnimationVersion((prev) => prev + 1);
    }
    const effectDuration = performance.now() - effectStart;
  }, [boundingBox, boundingBoxActive, trains, dataset, osmGraphTick, queueAnimationPath, cleanupAnimatedTrain]);

  const osmGraphNodeCount = osmGraph.size;
  useEffect(() => {
    setDebugInfo((prev) => ({
      ...prev,
      osmRailData: {
        ...prev.osmRailData,
        count: osmWayCount,
        sizeKB: Math.max(prev.osmRailData.sizeKB, osmGraphNodeCount),
      },
      rendering: {
        ...prev.rendering,
        osmLines: railTiles.length,
        trains: animatedTrainCount,
      },
      performance: {
        ...prev.performance,
        memoryUsage:
          Array.from(trackLinePositionsCache.values()).reduce(
            (sum, array) => sum + array.byteLength,
            0
          ) +
          approximateEmbankmentMemory() +
          terrainHeightCache.size * 8,
      },
    }));
  }, [osmGraphNodeCount, osmWayCount, railTiles.length, animatedTrainCount]);

  useEffect(() => {
    const pendingWorkerRequests = pathfinderResolversRef.current.size;
    const pendingResolvers = pathfinderResolversRef.current.size;
    const pendingTrains = Array.from(workerRequestIdByTrainRef.current.keys());
    setDebugInfo((prev) => ({
      ...prev,
      animation: {
        statuses: animationStatuses,
        warnings: animationWarnings,
        pendingWorkerRequests,
        pendingResolvers,
        pendingTrains,
      },
    }));
  }, [animationStatuses, animationWarnings]);
  
  // Slovakia outline state
  const [slovakiaOutline, setSlovakiaOutline] = useState<SlovakiaOutline | null>(null);
  
  // Fetch Slovakia outline on mount
  useEffect(() => {
    let cancelled = false;
    
    const loadOutline = async () => {
      try {
        
        const outline = await fetchSlovakiaOutline();
        
        if (!cancelled) {
          setSlovakiaOutline(outline);
          if (outline.points.length > 8) {
            setSvgOutlinePolygons([simplifyRing(outline.points)]);
            setOsmRefreshTrigger((prev) => prev + 1);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load Slovakia outline:', error);
        }
      }
    };
    
    loadOutline();
    
    return () => {
      cancelled = true;
    };
  }, []); // Only run once on mount
  
  const searchCirclePrimitive = useMemo(() => {
    if (!searchCircle || !isCoordinateVisible(searchCircle.center)) {
      return null;
    }
    const segments = 160;
    const points = new Float32Array((segments + 1) * 3);
    const latRadius = searchCircle.radiusMeters / SCALE_LAT;
    const lngRadius = searchCircle.radiusMeters / SCALE_LNG;
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const lat = searchCircle.center.lat + Math.sin(angle) * latRadius;
      const lng = searchCircle.center.lng + Math.cos(angle) * lngRadius;
      const [x, y, z] = project({ lat, lng });
      points[i * 3] = x;
      points[i * 3 + 1] = Math.max(1, y);
      points[i * 3 + 2] = z;
    }
    const circleGeometry = new BufferGeometry();
    circleGeometry.setAttribute('position', new BufferAttribute(points, 3));
    const circleLine = new Line(
      circleGeometry,
      new LineBasicMaterial({ color: '#ff00ff', linewidth: 10, transparent: true, opacity: 0.9 })
    );
    return <primitive object={circleLine} />;
  }, [searchCircle]);

  useEffect(() => {
    tracedRouteRef.current = null;
    setNetworkRoute(null);
    const waypoints = (focusedStations ?? []).filter(
      (point): point is Coordinate => point != null
    );
    if (!focusedTrainNumber || waypoints.length < 2 || osmGraphRef.current.size === 0) {
      return;
    }
    let cancelled = false;
    const requestId = `trace-${focusedTrainNumber}-${Date.now()}`;
    const applyPath = (path: Coordinate[]) => {
      if (cancelled || path.length < 2) {
        return;
      }
      tracedRouteRef.current = path;
      setNetworkRoute(path);
    };
    const timer = window.setTimeout(() => {
      const worker = pathfinderWorkerRef.current;
      const graph = osmGraphRef.current;
      if (!worker || graph.size === 0 || !pathfinderGraphReadyRef.current) {
        applyPath(traceWaypoints(graph, waypoints));
        return;
      }
      const resultPromise = new Promise<Coordinate[]>((resolve, reject) => {
        pathfinderResolversRef.current.set(requestId, (result) => resolve(result.path));
        pathfinderRejectorsRef.current.set(requestId, reject);
        worker.postMessage({
          type: 'trace',
          requestId,
          waypoints,
        });
      });
      const timeoutPromise = new Promise<Coordinate[]>((_, reject) => {
        window.setTimeout(() => reject(new Error('trace timeout')), 8000);
      });
      Promise.race([resultPromise, timeoutPromise])
        .then((path) => {
          if (path.length >= 2) {
            applyPath(path);
            return;
          }
          applyPath(traceWaypoints(graph, waypoints));
        })
        .catch(() => {
          if (!cancelled) {
            applyPath(traceWaypoints(graph, waypoints));
          }
        });
    }, osmStatus.loading ? 400 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      pathfinderResolversRef.current.delete(requestId);
      pathfinderRejectorsRef.current.delete(requestId);
    };
  }, [focusedTrainNumber, focusedStations, journeyStops, osmGraphTick, osmStatus.loading]);

  const routes: React.ReactNode[] = [];

  const focusedAnimationState = useMemo<TrainAnimationState | null>(() => {
    if (!focusedTrainNumber) return null;
    return animationStatesRef.current.get(focusedTrainNumber) ?? null;
  }, [focusedTrainNumber, animationVersion]);

  function trainColorForHighlight(
    trains: TrainRenderState[],
    focusedTrainNumber?: string | null
  ): string {
    if (!focusedTrainNumber) {
      return '#ffffff';
    }
    return trains.find((t) => t.trainNumber === focusedTrainNumber)?.color ?? '#ffffff';
  }

  const highlightedRoute = useMemo(() => {
    const path =
      networkRoute && networkRoute.length > 1
        ? networkRoute
        : trains.find((train) => train.trainNumber === focusedTrainNumber)?.shapePath ?? [];
    if (!path || path.length < 2) {
      return null;
    }
    const highlightHeight = TERRAIN_HEIGHT_MARGIN + 1 + HIGHLIGHT_VERTICAL_OFFSET;
    const positions: number[] = [];
    path.forEach((coord) => {
      const [x, , z] = project(coord);
      positions.push(x, highlightHeight, z);
    });
    const highlightColor = trainColorForHighlight(trains, focusedTrainNumber);
    return {
      positions,
      color: highlightColor,
    };
  }, [focusedAnimationState, focusedTrainNumber, trains, networkRoute]);

  const highlightedAnimationPaths = useMemo(() => {
    return [];
  }, []);

  const animationEmbankments = useMemo(() => {
    const states = Array.from(animationStatesRef.current.values()).filter(
      (state) => state.path && state.path.length > 1
    );
    const usedKeys = new Set<string>();
    const items: Array<{ key: string; geometry: BufferGeometry }> = [];
    const sampler = terrainSampler;
    if (!sampler) {
      return items;
    }
    states.forEach((state) => {
      if (state.trainNumber === focusedTrainNumber) {
        return;
      }
      const key = state.trainNumber;
      usedKeys.add(key);
      let geometry: BufferGeometry | null | undefined = embankmentCacheRef.current.get(key);
      const storedSignature = geometry?.userData?.signature;
      const newSignature = createTrackSignature(state.path, EMBANKMENT_HEIGHT_OFFSET);
      if (!geometry || storedSignature !== newSignature) {
        geometry?.dispose();
        const points = state.path.map((coord) => {
          const [x, , z] = project(coord);
          const terrainHeight = sampler(x, z);
          const height =
            terrainHeight != null
              ? terrainHeight + TERRAIN_HEIGHT_MARGIN + EMBANKMENT_HEIGHT_OFFSET
              : TERRAIN_HEIGHT_MARGIN + EMBANKMENT_HEIGHT_OFFSET;
          return new Vector3(x, height, z);
        });
        const newGeometry = createEmbankmentGeometry(points);
        if (newGeometry) {
          (newGeometry.userData as any) = { signature: newSignature };
          embankmentCacheRef.current.set(key, newGeometry);
          geometry = newGeometry;
        } else {
          embankmentCacheRef.current.delete(key);
          geometry = null;
        }
      }
      if (geometry) {
        items.push({ key, geometry });
      }
    });
    embankmentCacheRef.current.forEach((geom, key) => {
      if (!usedKeys.has(key)) {
        geom.dispose();
        embankmentCacheRef.current.delete(key);
      }
    });
    return items;
  }, [animationVersion, focusedTrainNumber]);

  const animatedLiveRouteLines = useMemo(() => {
    const animatedTrainNumbers = new Set(animationStatesRef.current.keys());
    const trainsWithLiveRoutes = trains.filter(
      (train) =>
        animatedTrainNumbers.has(train.trainNumber) &&
        train.liveRoute &&
        train.liveRoute.length > 1
    );
    return trainsWithLiveRoutes.map((train) => {
      if (train.trainNumber === focusedTrainNumber) {
        return null;
      }
      return (
        <TrackLine
          key={`live-route-${train.trainNumber}`}
          path={train.liveRoute!}
          color="#facc15"
          opacity={0.7}
          lineWidth={8}
        />
      );
    });
  }, [trains, animationVersion, focusedTrainNumber, networkRoute]);

  const animatedLiveRoutePoints = useMemo(() => {
    const animatedTrainNumbers = new Set(animationStatesRef.current.keys());
    const trainsWithPoints = trains.filter(
      (train) =>
        animatedTrainNumbers.has(train.trainNumber) &&
        train.liveRoute &&
        train.liveRoute.length > 0
    );
    if (trainsWithPoints.length === 0) {
      return null;
    }
    const totalPoints = trainsWithPoints.reduce(
      (sum, train) => sum + (train.liveRoute?.length ?? 0),
      0
    );
    const positions = new Float32Array(totalPoints * 3);
    let offset = 0;
    trainsWithPoints.forEach((train) => {
      train.liveRoute?.forEach((coord) => {
        const [x, , z] = project(coord);
        positions[offset++] = x;
        positions[offset++] = 1;
        positions[offset++] = z;
      });
    });
    return (
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#facc15"
          size={2.5}
          sizeAttenuation
          depthWrite={false}
          transparent
          opacity={0.9}
        />
      </points>
    );
  }, [trains, animationVersion]);

  const nextPointMarkers = useMemo(() => {
    const entries = Object.entries(nextMapPoints);
    if (entries.length === 0) {
      return null;
    }
    const delayByTrain = new Map(trains.map((train) => [train.trainNumber, train.delayMinutes]));
    return (
      <group>
        {entries.map(([trainNumber, coord]) => {
          if (!isCoordinateVisible(coord)) {
            return null;
          }
          const delayMinutes = delayByTrain.get(trainNumber) ?? 0;
          const color = getDelayColor(delayMinutes);
          const [x, y, z] = project(coord);
          return (
            <mesh key={`next-map-point-${trainNumber}`} position={[x, y + 2, z]}>
              <sphereGeometry args={[2.5, 12, 12]} />
              <meshBasicMaterial color={color} transparent opacity={0.95} />
            </mesh>
          );
        })}
      </group>
    );
  }, [nextMapPoints, trains, isCoordinateVisible]);

  const railLayerPositions = useMemo(() => {
    const collect = (railwayType: string) => {
      let floatCount = 0;
      railTiles.forEach((tile) => {
        if (tile.railwayType !== railwayType) {
          return;
        }
        const attribute = tile.geometry.getAttribute('position');
        if (attribute) {
          floatCount += attribute.array.length;
        }
      });
      if (floatCount === 0) {
        return null;
      }
      const positions = new Float32Array(floatCount);
      let offset = 0;
      railTiles.forEach((tile) => {
        if (tile.railwayType !== railwayType) {
          return;
        }
        const attribute = tile.geometry.getAttribute('position');
        if (!attribute) {
          return;
        }
        positions.set(attribute.array as Float32Array, offset);
        offset += attribute.array.length;
      });
      return positions;
    };
    return {
      main: collect('rail'),
      branch: collect('light_rail'),
    };
  }, [railTiles]);

  const hideRects = fineRailPositions?.hideRects ?? [];
  const simplifiedMain = omitSegmentsInRects(railLayerPositions.main, hideRects);
  const simplifiedBranch = omitSegmentsInRects(railLayerPositions.branch, hideRects);
  const railLineElements = (
    <group>
      {simplifiedMain ? (
        <CasedRailLayer
          positions={simplifiedMain}
          fillWidth={RAIL_MAIN_FILL_WIDTH}
          casingWidth={RAIL_MAIN_CASING_WIDTH}
        />
      ) : null}
      {simplifiedBranch ? (
        <CasedRailLayer
          positions={simplifiedBranch}
          fillWidth={RAIL_BRANCH_FILL_WIDTH}
          casingWidth={RAIL_BRANCH_CASING_WIDTH}
        />
      ) : null}
      {fineRailPositions?.side ? (
        <CasedRailLayer
          positions={fineRailPositions.side}
          fillWidth={RAIL_SIDE_FILL_WIDTH}
          casingWidth={RAIL_SIDE_CASING_WIDTH}
          opacity={RAIL_SIDE_OPACITY}
        />
      ) : null}
      {fineRailPositions?.branch ? (
        <CasedRailLayer
          positions={fineRailPositions.branch}
          fillWidth={RAIL_BRANCH_FILL_WIDTH}
          casingWidth={RAIL_BRANCH_CASING_WIDTH}
        />
      ) : null}
      {fineRailPositions?.main ? (
        <CasedRailLayer
          positions={fineRailPositions.main}
          fillWidth={RAIL_FINE_FILL_WIDTH}
          casingWidth={RAIL_FINE_CASING_WIDTH}
        />
      ) : null}
    </group>
  );

  const bridgeLineElements = useMemo(() => {
    if (bridgeLineGeometries.length === 0) {
      return null;
    }
    return bridgeLineGeometries.map((geometry, idx) => (
      <lineSegments
        key={`bridge-highlight-${idx}`}
        geometry={geometry}
        material={bridgeMaterial}
        renderOrder={1600}
      />
    ));
  }, [bridgeLineGeometries, bridgeMaterial]);

  const tunnelLineElements = useMemo(() => {
    if (tunnelLineGeometries.length === 0) {
      return null;
    }
    return tunnelLineGeometries.map((geometry, idx) => (
      <lineSegments
        key={`tunnel-highlight-${idx}`}
        geometry={geometry}
        material={tunnelMaterial}
        renderOrder={1600}
      />
    ));
  }, [tunnelLineGeometries, tunnelMaterial]);

  const trainMeshes = useMemo(() => {
    return trains
      .filter((train) => train.position)
      .filter((train) => {
        if (!boundingBoxActive) return true;
        return !boundingTrains.has(train.trainNumber);
      })
      .map((train) => {
        const isSelected = train.trainNumber === focusedTrainNumber;
        if (isSelected) {
          return (
            <TrainMesh
              key={train.trainNumber}
              train={train}
              isSelected
              onClick={onTrainClick}
              focusedPositionRef={focusedPositionRef}
              tracedRouteRef={tracedRouteRef}
              focusedStations={focusedStations}
              journeyStops={journeyStops}
            />
          );
        }
        return (
          <StaticTrainMesh
            key={train.trainNumber}
            train={train}
            onClick={onTrainClick}
          />
        );
      });
  }, [
    trains,
    focusedTrainNumber,
    onTrainClick,
    boundingBoxActive,
    boundingTrains,
    focusedPositionRef,
    focusedStations,
    journeyStops,
  ]);

  // Debug: Calculate actual map bounds from all train coordinates
  // Stabilize mapBounds - only recalculate when train count changes significantly or trains are added/removed
  // Use a ref to track previous train count and only recalculate when it changes by more than 10%
  const previousTrainCountRef = useRef(0);
  const stableMapBoundsRef = useRef<{ minX: number; maxX: number; minZ: number; maxZ: number; mapWidth: number; mapHeight: number } | null>(null);
  
  const mapBounds = useMemo(() => {
    const trainCount = trains.length;
    const trainCountChanged = Math.abs(trainCount - previousTrainCountRef.current) > Math.max(10, previousTrainCountRef.current * 0.1);
    
    // Only recalculate if train count changed significantly or bounds haven't been calculated yet
    if (!stableMapBoundsRef.current || trainCountChanged) {
      previousTrainCountRef.current = trainCount;
      
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      trains.forEach(train => {
        train.shapePath.forEach(coord => {
          const [x, , z] = project(coord);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        });
      });
      const mapWidth = maxX - minX;
      const mapHeight = maxZ - minZ;
      
      
      const newBounds = { minX, maxX, minZ, maxZ, mapWidth, mapHeight };
      stableMapBoundsRef.current = newBounds;
      return newBounds;
    }
    
    // Return cached bounds if train count hasn't changed significantly
    return stableMapBoundsRef.current;
  }, [trains.length]); // Only depend on train count, not the entire trains array
  
  // Camera positioned closer to see the map better
  const cameraPosition: [number, number, number] = [0, CAMERA_LOAD_START_HEIGHT, 0];
  const overlayActive = !loadingDismissed;
  const canvasStateClass = overlayActive ? 'loading' : 'loaded';
  useEffect(() => {
    if (onCanvasStateChange) {
      onCanvasStateChange(canvasStateClass);
    }
  }, [canvasStateClass, onCanvasStateChange]);
  const tileProgressPercent =
    tileLoadPlan.total > 0 ? (tileLoadPlan.completed / tileLoadPlan.total) * 100 : 0;
  const progressPercentage = Math.min(100, Math.max(0, tileProgressPercent));
  const progressLabel = terrainLoaded
    ? tileLoadPlan.total > 0
      ? `Loaded: ${tileLoadPlan.completed}/${tileLoadPlan.total} OSM tiles`
      : 'Loaded OSM tiles'
    : 'Loading basemap...';
  const tileStepComplete =
    tileLoadPlan.total > 0 && tileLoadPlan.completed >= tileLoadPlan.total;
  const allLoaded = terrainLoaded && tileStepComplete;
  const buttonLabel = allLoaded ? 'Accept' : 'Skip and Accept';
  const latestLoadingMessage = loadingConsole[loadingConsole.length - 1] ?? '';
  useEffect(() => {
    if (!overlayActive) {
      cameraAnimationRef.current = {
        animating: true,
        startTime: performance.now(),
      };
    }
  }, [overlayActive]);

  const CameraLoadAnimator: React.FC = () => {
    const camera = useThree((state) => state.camera as PerspectiveCamera);
    useFrame(() => {
      if (!cameraAnimationRef.current.animating) {
        return;
      }
      const elapsed = performance.now() - cameraAnimationRef.current.startTime;
      const rawProgress = Math.min(1, elapsed / CAMERA_LOAD_DURATION_MS);
      const easedProgress = CAMERA_LOAD_EASING(rawProgress);
      camera.position.y =
        CAMERA_LOAD_START_HEIGHT +
        (CAMERA_LOAD_END_HEIGHT - CAMERA_LOAD_START_HEIGHT) * easedProgress;
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      if (rawProgress >= 1) {
        cameraAnimationRef.current.animating = false;
      }
    });
    return null;
  };
  
  return (
    <>
      <div className="map-scene-shell">
        <div className={`map-canvas-wrapper ${canvasStateClass}`}>
          <Canvas
            className="map-view-canvas"
            dpr={1}
            flat
            style={{ pointerEvents: overlayActive ? 'none' : 'auto' }}
            camera={{
              position: cameraPosition,
              fov: 16,
              near: 0.005,
            far: 10000,
            }}
            gl={{
              antialias: false,
              powerPreference: 'high-performance',
              stencil: false,
              depth: true,
            }}
            onCreated={({ camera, gl }) => {
              camera.up.set(0, 0, -1);
              camera.lookAt(0, 0, 0);
              gl.setPixelRatio(1);
            }}
      >
        <color attach="background" args={['#000000']} />
      {/* OrbitControls for mouse navigation - drag to rotate, scroll to zoom, right-click OR middle-click to pan */}
      <OrbitControls 
        ref={controlsRef}
        enablePan={true}
        enableZoom={true}
        enableRotate={false}
        target={[0, 0, 0]}
        minDistance={1}
        maxDistance={MAX_CAMERA_HEIGHT * 10}
        minPolarAngle={Math.PI / 2}
        maxPolarAngle={Math.PI / 2}
        zoomSpeed={1.0}
        panSpeed={1.2}
        screenSpacePanning={true}
        enableDamping={false}
        dampingFactor={0.05}
        mouseButtons={{
          LEFT: MOUSE.PAN,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.DOLLY,
        }}
        touches={{
          ONE: TOUCH_PAN,
          TWO: TOUCH_DOLLY_PAN,
        }}
      />
      <ambientLight intensity={1.1} />
      <directionalLight position={[1000, 2000, 1000]} intensity={0.8} />
      
      <BasemapLayer onReady={handleBasemapReady} />
      <FineRailLoader outline={svgOutlinePolygons} onPositions={setFineRailPositions} />
      <StationLayer dataset={dataset} isCoordinateVisible={isCoordinateVisible} />

      {/* Render OSM rail tiles */}
      {railLineElements}
      {bridgeLineElements && (
        <group>
          {bridgeLineElements}
        </group>
      )}
      {tunnelLineElements && (
        <group>
          {tunnelLineElements}
        </group>
      )}

      {/* Render animated live-route highlighting */}
      {animatedLiveRouteLines.length > 0 && (
        <group>
          {animatedLiveRouteLines}
        </group>
      )}
      {animatedLiveRoutePoints}

      {/* Render animated paths */}
      {highlightedAnimationPaths.length > 0 && (
        <group>
          {highlightedAnimationPaths}
        </group>
      )}
      {animationEmbankments.length > 0 && (
        <group>
          {animationEmbankments.map(({ key, geometry }) => (
            <mesh
              key={`embankment-${key}`}
              geometry={geometry}
              material={embankmentMaterial}
              renderOrder={1400}
            />
          ))}
        </group>
      )}

      <OrbitTargetHeightFollower
        controlsRef={controlsRef}
        terrainSampler={terrainSampler}
        viewMode={viewMode}
      />

      {highlightedRoute && (
        <HighlightedRouteLine
          positions={highlightedRoute.positions}
          color={highlightedRoute.color}
        />
      )}

      {/* Search circle visualization */}
      {searchCirclePrimitive}
      {nextPointMarkers}

      {/* Render GTFS routes (fallback/low-poly tracks) */}
      {routes.length > 0 && (
        <group>
          {routes}
        </group>
      )}
      
      {/* Render trains */}
      {trainMeshes}
        <CameraLoadAnimator />
    </Canvas>
          <div
            className={`map-loading-overlay ${
              overlayActive
                ? 'map-loading-overlay--visible'
                : 'map-loading-overlay--hidden'
            }`}
            aria-hidden={!overlayActive}
          >
            <div className="map-loading-card">
              <img src={logoLong} alt="3D Railmap" className="map-loading-logo" />
              <div className="map-loading-steps">
                <span
                  className={`map-loading-step ${terrainLoaded ? 'is-complete' : 'is-active'}`}
                >
                  <strong>1.</strong>
                  <span>Basemap</span>
                </span>
                <span className={`map-loading-step ${tileStepComplete ? 'is-complete' : ''}`}>
                  <strong>2.</strong>
                  <span>OSM tiles</span>
                </span>
              </div>
              <div className="map-loading-bar">
                <div className="map-loading-bar__progress" style={{ width: `${progressPercentage}%` }} />
              </div>
              <div className="map-loading-text">{progressLabel}</div>
              <div className="map-loading-console">
                <span>{latestLoadingMessage}</span>
              </div>
              <p className="map-loading-note">
                This project shows live train positions in Slovakia on top of real railway infrastructure from OpenStreetMap. The Open Data Directive (EU) 2019/1024 promotes public access to this information.
              </p>

              <p className="map-loading-note">
                Instead, the data is locked away; despite being technically reachable through the platform’s public-facing systems. The result is an interactive 3D map that makes railway traffic understandable and exposes limits of current data transparency.
              </p>
              <div className="map-loading-actions">
                <button type="button" className="map-loading-skip" onClick={handleLoadingSkip}>
                  {buttonLabel}
                </button>
                <a
                  className="map-loading-terms"
                  href="/terms-and-conditions"
                  target="_blank"
                  rel="noreferrer"
                >
                  Terms and Conditions
                </a>
              </div>
            </div>
          </div>
          <div className="map-basemap-credit">
            © SBB/CFF/FFS · © geOps Tiles · © OpenStreetMap · © imagico
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
        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Route warnings</div>
        {animationWarnings.map((warning) => (
          <div key={warning} style={{ marginBottom: '0.25rem' }}>
            {warning}
          </div>
        ))}
      </div>
    )}

    {/* Debug Window */}
    <DebugWindow
      debugInfo={debugInfo}
      visible={debugVisible}
      onToggle={() => setDebugVisible(!debugVisible)}
      osmStatus={osmStatus}
      cameraDistance={cameraDistance}
      boundingBoxActive={boundingBoxActive}
      animatedTrainCount={animatedTrainCount}
      purgeOsmCache={purgeOsmCache}
      useLiveApi={useLiveApi}
      onToggleLiveApi={onToggleLiveApi}
    />
    </>
  );
});

