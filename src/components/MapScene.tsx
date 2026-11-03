import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree, useLoader } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import {
  Vector3,
  BufferGeometry,
  BufferAttribute,
  Line,
  LineBasicMaterial,
  Raycaster,
  Group,
  type Mesh,
  PlaneGeometry,
  AxesHelper,
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  TorusGeometry,
  EdgesGeometry,
  Box3,
  type Camera,
  type PerspectiveCamera,
  MeshStandardMaterial,
  CatmullRomCurve3,
  TubeGeometry,
  MOUSE,
  TOUCH,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry';
import type { Coordinate, GtfsDataset } from '../data/gtfsParser';
import type { OsmDetailLevel } from '../types/osm';
import { getDelayColor, type TrainRenderState } from '../data/trainService';
import type { OSMWay, OsmProxyMeta, OsmFetchResult } from '../data/osmRailService';
import { isBridge, isTunnel } from '../data/osmRailService';
import {
  extendOsmGraph,
  findOsmPath,
  setSimplifyToleranceMeters,
  simplifyGeometryNodes,
  type OsmGraph,
  type LatLngBounds,
  type OsmPathResult,
} from '../data/trainOsmMapper';
import { RailwayLine } from './RailwayLine';
import { VectorRailTile } from './VectorRailTile';
import { DebugWindow, type DebugInfo } from './DebugWindow';
import { fetchSlovakiaOutline, type SlovakiaOutline } from '../data/slovakiaOutlineService';
import logoLong from '../logo long.svg';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader';

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
const TRAIN_BASE_SIZE = 5; // Increase/decrease this constant to scale the train cubes globally.
const TRAIN_SELECTED_SIZE = 8;
const TRAIN_VERTICAL_OFFSET = 20; // Raise the cubes vertically; adjust this constant to tweak altitude.
const ROUTE_LIGHT_SAMPLE_STEP = 4;
const ROUTE_LIGHT_INTENSITY = 600;
const ROUTE_LIGHT_DISTANCE = 100;
const ROUTE_LIGHT_DECAY = 1.5;
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

const SLOVAKIA_PROJECTED_SW = project({
  lat: SLOVAKIA_BOUNDS.minLat,
  lng: SLOVAKIA_BOUNDS.minLng,
});

const SLOVAKIA_PROJECTED_NE = project({
  lat: SLOVAKIA_BOUNDS.maxLat,
  lng: SLOVAKIA_BOUNDS.maxLng,
});

const SLOVAKIA_MAP_CENTER_X = (SLOVAKIA_PROJECTED_SW[0] + SLOVAKIA_PROJECTED_NE[0]) / 2;
const SLOVAKIA_MAP_CENTER_Z = (SLOVAKIA_PROJECTED_SW[2] + SLOVAKIA_PROJECTED_NE[2]) / 2;
const SLOVAKIA_MAP_WIDTH = Math.abs(SLOVAKIA_PROJECTED_NE[0] - SLOVAKIA_PROJECTED_SW[0]);
const SLOVAKIA_MAP_DEPTH = Math.abs(SLOVAKIA_PROJECTED_NE[2] - SLOVAKIA_PROJECTED_SW[2]);

const TERRAIN_GLB_URL = encodeURI('/slovakia terrain V2.glb');
const SVG_OUTLINE_URL = encodeURI('/slovakia outlined simple.svg');
const TERRAIN_RAY_SOURCE_HEIGHT = 800;

function sampleTerrainHeightFromGroup(
  terrainGroup: Group | null,
  worldX: number,
  worldZ: number
): number | null {
  if (!terrainGroup) {
    return null;
  }
  terrainRayOrigin.set(worldX, TERRAIN_RAY_SOURCE_HEIGHT, worldZ);
  terrainRaycaster.set(terrainRayOrigin, terrainDownVector);
  const intersections = terrainRaycaster.intersectObject(terrainGroup, true);
  if (intersections.length === 0) {
    return null;
  }
  return intersections[0].point.y;
}
const terrainRaycaster = new Raycaster();
const terrainDownVector = new Vector3(0, -1, 0);
const terrainRayOrigin = new Vector3();

const DETAIL_LEVEL_ORDER: OsmDetailLevel[] = ['coarse', 'medium', 'fine'];

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

const TILE_LEVELS: { name: OsmDetailLevel; tileSize: number; bounds: typeof SLOVAKIA_BOUNDS | { minLat: number; maxLat: number; minLng: number; maxLng: number }; pause: number }[] = [
  {
    name: 'coarse',
    tileSize: 1.0,
    bounds: SLOVAKIA_BOUNDS,
    pause: 150,
  },
  {
    name: 'medium',
    tileSize: 0.5,
    bounds: SLOVAKIA_BOUNDS,
    pause: 100,
  },
  {
    name: 'fine',
    tileSize: 0.25,
    bounds: {
      minLat: 48.3,
      maxLat: 49.2,
      minLng: 17.3,
      maxLng: 21.4,
    },
    pause: 80,
  },
];

function countTiles(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, tileSize: number): number {
  const latSteps = Math.ceil((bounds.maxLat - bounds.minLat) / tileSize);
  const lngSteps = Math.ceil((bounds.maxLng - bounds.minLng) / tileSize);
  return Math.max(0, latSteps * lngSteps);
}

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
  const chains: Float32Array[] = [];
  ways.forEach((way) => {
    const geometry = simplifyGeometryNodes(way.geometry || []);
    if (geometry.length < 2) {
      return;
    }
    const positions = new Float32Array(geometry.length * 3);
    geometry.forEach((node, index) => {
      const [x, , z] = project({ lat: node.lat, lng: node.lon });
      positions[index * 3] = x;
      positions[index * 3 + 1] = elevation;
      positions[index * 3 + 2] = z;
    });
    chains.push(positions);
  });
  return chains;
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

function isCoordinateInsideOutline(
  coord: LatLngPoint,
  polygons: LatLngPolygon[]
): boolean {
  if (!polygons || polygons.length === 0) {
    return true;
  }
  return polygons.some((polygon) => pointInPolygon(coord, polygon));
}

function doesWayIntersectOutline(
  way: OSMWay,
  polygons: LatLngPolygon[]
): boolean {
  const geometry = way.geometry ?? [];
  if (geometry.length === 0) {
    return false;
  }
  return geometry.some((node) =>
    isCoordinateInsideOutline({ lat: node.lat, lng: node.lon }, polygons)
  );
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
  | { type: 'error'; requestId: string; message: string };

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

// City label component
const CityLabel: React.FC<{ name: string; lat: number; lng: number; size: string }> = ({ name, lat, lng, size }) => {
  const groupRef = useRef<Group>(null);
  const { camera } = useThree();
  const [x, y, z] = project({ lat, lng });
  const fontSize = size === 'large' ? 8 : size === 'medium' ? 6 : 4;

  useFrame(() => {
    if (!groupRef.current) {
      return;
    }
    // Lock the label orientation so up always follows north (world -Z) instead of camera rotation
    groupRef.current.rotation.set(-Math.PI / 2, 0, 0);
  });

  return (
    <group ref={groupRef} position={[x, y + 5, z]}>
      <Text
        position={[0, 0, 0]}
        fontSize={fontSize}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.5}
        outlineColor="#000000"
      >
        {name}
      </Text>
    </group>
  );
};

// Simple house shape
const House: React.FC<{ lat: number; lng: number }> = ({ lat, lng }) => {
  const [x, y, z] = project({ lat, lng });
  
  return (
    <group position={[x, y + 2, z]}>
      {/* House base */}
      <mesh>
        <boxGeometry args={[3, 2, 3]} />
        <meshStandardMaterial color="#8b7355" />
      </mesh>
      {/* Roof */}
      <mesh position={[0, 1.5, 0]}>
        <coneGeometry args={[2.5, 1.5, 4]} />
        <meshStandardMaterial color="#6b4e3d" />
      </mesh>
    </group>
  );
};

interface TerrainModelProps {
  terrainRef?: React.MutableRefObject<Group | null>;
  onLoaded?: () => void;
}

const TerrainModel: React.FC<TerrainModelProps> = ({ terrainRef, onLoaded }) => {
  const gltf = useLoader(
    GLTFLoader,
    TERRAIN_GLB_URL,
    (loader) => {
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
      if ('setDRACOLoader' in loader) {
        (loader as GLTFLoader).setDRACOLoader(dracoLoader);
      }
    }
  ) as GLTF;

  useEffect(() => {
    onLoaded?.();
  }, [gltf, onLoaded]);

  const terrainMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#2b2b2b',
        roughness: 0.8,
        metalness: 0.1,
        emissive: '#000000',
      }),
    []
  );
  const { normalizedScene, size, normalizedMinY } = useMemo(() => {
    const boundingBox = new Box3().setFromObject(gltf.scene);
    const center = boundingBox.getCenter(new Vector3());
    const normalizedScene = gltf.scene.clone(true);
    normalizedScene.position.set(-center.x, -center.y, -center.z);
    const normalizedMinY = boundingBox.min.y - center.y;
    normalizedScene.traverse((child: any) => {
      if (child.isMesh) {
        child.material = terrainMaterial;
        child.castShadow = false;
        child.receiveShadow = true;
      }
    });
    return {
      normalizedScene,
      size: boundingBox.getSize(new Vector3()),
      normalizedMinY,
    };
  }, [gltf.scene, terrainMaterial]);

  const widthScale = SLOVAKIA_MAP_WIDTH / Math.max(size.x, 0.0001);
  const depthScale = SLOVAKIA_MAP_DEPTH / Math.max(size.z, 0.0001);
  const verticalScale = (widthScale + depthScale) / 2;
  const verticalLift = -normalizedMinY * verticalScale;
  const groupRef = useRef<Group | null>(null);
  useEffect(() => {
    if (terrainRef && groupRef.current) {
      terrainRef.current = groupRef.current;
    }
  }, [terrainRef]);

  return (
    <group
      ref={groupRef}
      position={[SLOVAKIA_MAP_CENTER_X, verticalLift, SLOVAKIA_MAP_CENTER_Z]}
      scale={[widthScale, verticalScale, depthScale]}
      rotation={[0, 0, 0]}
    >
      <primitive object={normalizedScene} />
    </group>
  );
};

const TrainMesh: React.FC<{
  train: TrainRenderState;
  isSelected?: boolean;
  onClick?: (trainNumber: string) => void;
  animationState?: TrainAnimationState | null;
}> = ({ train, isSelected = false, onClick, animationState }) => {
  const ref = useRef<Mesh>(null);
  const targetVector = useMemo(() => new Vector3(), []);
  const { camera } = useThree();

  useFrame(() => {
    if (!ref.current) {
      return;
    }
    const liveCoordinate =
      animationState !== undefined && animationState !== null
        ? interpolateAnimationCoordinate(animationState, getTodayTimeMs())
        : train.position;
    if (!liveCoordinate) {
      return;
    }
    const [x, y, z] = project(liveCoordinate);
    targetVector.set(x, y + TRAIN_VERTICAL_OFFSET, z);
    ref.current.position.lerp(targetVector, 0.05);
    if (camera) {
      ref.current.quaternion.copy(camera.quaternion);
    }
  });

  const initialCoordinate =
    animationState !== undefined && animationState !== null
      ? interpolateAnimationCoordinate(animationState, getTodayTimeMs())
      : train.position;
  if (!initialCoordinate) {
    return null;
  }
  const [initialX, initialY, initialZ] = project(initialCoordinate);
  const initialYWithOffset = initialY + TRAIN_VERTICAL_OFFSET;

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (onClick) {
      // Toggle: if clicking the same train, deselect it; otherwise select the new train
      if (isSelected) {
        onClick(''); // Deselect - parent will handle converting to null
      } else {
        onClick(train.trainNumber);
      }
    }
  };

  // Make selected train larger and brighter
  const size = isSelected ? TRAIN_SELECTED_SIZE : TRAIN_BASE_SIZE;
  const emissiveIntensity = isSelected ? 1.0 : 0.5;

  return (
    <mesh 
      ref={ref} 
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
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial
        color={train.color}
        emissive={train.color}
        emissiveIntensity={emissiveIntensity}
      />
    </mesh>
  );
};

interface MapSceneProps {
  trains: TrainRenderState[];
  focusedTrainNumber?: string | null;
  onTrainClick?: (trainNumber: string) => void;
  dataset?: GtfsDataset | null;
  onOsmStatusChange?: (status: OsmStatus) => void;
  useLiveApi: boolean;
  onToggleLiveApi: (enabled: boolean) => void;
  onCanvasStateChange?: (state: 'loading' | 'loaded') => void;
}

export const MapScene: React.FC<MapSceneProps> = ({
  trains,
  focusedTrainNumber,
  onTrainClick,
  dataset,
  onOsmStatusChange,
  useLiveApi,
  onToggleLiveApi,
  onCanvasStateChange,
}) => {
  console.log(`🗺️ MapScene received ${trains.length} trains`);
  
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
  const tileCacheRef = useRef<Set<string>>(new Set());
  const duplicateTileLogKeysRef = useRef<Set<string>>(new Set());
  const createdGeometriesRef = useRef<Set<BufferGeometry>>(new Set());
  const osmWaysRef = useRef<Map<number, OSMWay>>(new Map());
  const osmGraphRef = useRef<OsmGraph>(new Map());
  const [osmGraphTick, setOsmGraphTick] = useState(0);
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
  const [canvasDpr, setCanvasDpr] = useState(() => {
    if (typeof window === 'undefined') {
      return 1;
    }
    return Math.min(1.25, Math.max(0.75, window.devicePixelRatio * 0.75));
  });
  useEffect(() => {
    const handleResize = () => {
      const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
      setCanvasDpr(Math.min(1.25, Math.max(0.75, deviceDpr * 0.75)));
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);
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
  const handleTerrainLoaded = useCallback(() => {
    setTerrainLoaded(true);
  }, []);
  const handleLoadingSkip = useCallback(() => {
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
      appendLoadingMessage('Loaded terrain');
    }
  }, [terrainLoaded, appendLoadingMessage]);
  const [osmRefreshTrigger, setOsmRefreshTrigger] = useState(0);
  const [osmDetailLevel, setOsmDetailLevel] = useState<OsmDetailLevel>('coarse');
  const [svgOutlinePolygons, setSvgOutlinePolygons] = useState<LatLngPolygon[]>([]);
  const outlineLoadedRef = useRef(false);
  const terrainGroupRef = useRef<Group | null>(null);
  const [viewMode] = useState<'2d' | '3d'>('3d');
  const embankmentMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.9,
        metalness: 0.1,
        flatShading: true,
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
              subPath.getPoints().map((point) => ({
                lat:
                  SLOVAKIA_BOUNDS.maxLat -
                  ((point.y - vbY) / Math.max(vbHeight, 1)) * latSpan,
                lng:
                  SLOVAKIA_BOUNDS.minLng +
                  ((point.x - vbX) / Math.max(vbWidth, 1)) * lngSpan,
              }))
            )
          )
          .filter((polygon) => polygon.length >= 3);
        if (cancelled) {
          return;
        }
        if (polygons.length > 0) {
          setSvgOutlinePolygons(polygons);
          if (!outlineLoadedRef.current) {
            outlineLoadedRef.current = true;
            setOsmRefreshTrigger((prev) => prev + 1);
          }
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
  const is3DView = viewMode === '3d';
  const terrainSampler = useMemo(() => {
    if (!is3DView) {
      return undefined;
    }
    return (worldX: number, worldZ: number) =>
      sampleTerrainHeightFromGroup(terrainGroupRef.current, worldX, worldZ);
  }, [is3DView]);
  const isCoordinateVisible = useCallback(
    (coord: LatLngPoint) => isCoordinateInsideOutline(coord, svgOutlinePolygons),
    [svgOutlinePolygons]
  );
  const finePositionsRef = useRef<number[]>([]);
  const finePositionsByTypeRef = useRef<Map<string, number[]>>(new Map());
  const pathfinderWorkerRef = useRef<Worker | null>(null);
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
      if (!worker || graph.size === 0) {
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
      const trainNumber = workerRequestInfoRef.current.get(response.requestId);
      workerRequestInfoRef.current.delete(response.requestId);
      if (trainNumber) {
        workerRequestIdByTrainRef.current.delete(trainNumber);
      }
      const resolver = pathfinderResolversRef.current.get(response.requestId);
      const rejector = pathfinderRejectorsRef.current.get(response.requestId);
      pathfinderResolversRef.current.delete(response.requestId);
      pathfinderRejectorsRef.current.delete(response.requestId);
      if (!trainNumber) {
        return;
      }
      if (response.type === 'result') {
        resolver?.({ path: response.path, reason: response.reason });
      } else {
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
      return;
    }
    try {
      worker.postMessage({
        type: 'initGraph',
        graph: serializeOsmGraph(osmGraph),
      });
    } catch (error) {
      console.error('Failed to send graph to worker', error);
    }
  }, [osmGraph, osmGraphTick]);

  useEffect(() => {
    let cancelled = false;

    const loadTiles = async () => {
      const loadVersion = ++tileLoadVersionRef.current;
      tileCacheRef.current.clear();
      wayOccurrencesRef.current = new Map();
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
      setLoadingDismissed(false);
      setLoadingConsole(['Loading terrain...']);
      plannedTileTotalRef.current = 0;

      const detailIndex = DETAIL_LEVEL_ORDER.indexOf(osmDetailLevel);
      const levelsToLoad = TILE_LEVELS.filter(
        (level) => DETAIL_LEVEL_ORDER.indexOf(level.name) <= detailIndex
      );
      const plannedTiles = levelsToLoad.reduce(
        (sum, level) => sum + countTiles(level.bounds, level.tileSize),
        0
      );
      plannedTileTotalRef.current = plannedTiles;
      setTileLoadPlan({ total: plannedTiles, completed: 0 });
      const bridgeGeometries: BufferGeometry[] = [];
      const tunnelGeometries: BufferGeometry[] = [];
      for (const level of levelsToLoad) {
        const { bounds, tileSize, name, pause } = level;
        for (let lat = bounds.minLat; lat < bounds.maxLat; lat += tileSize) {
          for (let lng = bounds.minLng; lng < bounds.maxLng; lng += tileSize) {
            if (cancelled) return;
            const maxLat = Math.min(lat + tileSize, bounds.maxLat);
            const maxLng = Math.min(lng + tileSize, bounds.maxLng);
            const key = tileKey(name, lat, lng);
            if (tileCacheRef.current.has(key)) {
              if (!duplicateTileLogKeysRef.current.has(key)) {
                duplicateTileLogKeysRef.current.add(key);
              }
              continue;
            }
            let ways: OSMWay[] = [];
            let meta: OsmProxyMeta | undefined;
            try {
              const result = await requestTile(
                { minLat: lat, maxLat, minLng: lng, maxLng },
                name
              );
              if (loadVersion !== tileLoadVersionRef.current || cancelled) {
                return;
              }
              ways = result.ways;
              meta = result.meta;
              if (meta) {
                const metaStatus = meta.status;
                setOsmStatus((prev) => ({
                  ...prev,
                  tilesLoaded: prev.tilesLoaded + (ways.length > 0 ? 1 : 0),
                  lastStatus: metaStatus ?? prev.lastStatus,
                  lastFetch: new Date().toLocaleTimeString(),
                }));
              }
            } catch (err) {
              console.error('Rail tile fetch failed:', err);
            }
            tileCacheRef.current.add(key);
            markTileProgress();

            if (cancelled) return;
            if (ways.length === 0) {
              continue;
            }

            let duplicates = 0;
            const filteredWays: OSMWay[] = [];
            ways.forEach((way) => {
              const seen = wayOccurrencesRef.current.get(way.id) ?? 0;
              if (seen > 0) {
                duplicates++;
              } else {
                filteredWays.push(way);
              }
              wayOccurrencesRef.current.set(way.id, seen + 1);
            });
            const newGraphWays = filteredWays.filter(
              (way) => !osmWaysRef.current.has(way.id)
            );
            if (newGraphWays.length > 0) {
              newGraphWays.forEach((way) => osmWaysRef.current.set(way.id, way));
              extendOsmGraph(osmGraphRef.current, newGraphWays);
              setOsmGraphTick((prev) => prev + 1);
              setOsmWayCount(osmWaysRef.current.size);
            }
            const filtered = filteredWays;
            if (filtered.length === 0) {
              continue;
            }
            const bridgeWays = filtered.filter((way) => isBridge(way));
            if (bridgeWays.length > 0) {
              const positions = convertWaysToPositions(bridgeWays);
              if (positions.length > 0) {
                const geometry = new BufferGeometry();
                geometry.setAttribute('position', new BufferAttribute(positions, 3));
                createdGeometriesRef.current.add(geometry);
                bridgeGeometries.push(geometry);
              }
            }
            const tunnelWays = filtered.filter((way) => isTunnel(way));
            if (tunnelWays.length > 0) {
              const positions = convertWaysToPositions(tunnelWays);
              if (positions.length > 0) {
                const geometry = new BufferGeometry();
                geometry.setAttribute('position', new BufferAttribute(positions, 3));
                createdGeometriesRef.current.add(geometry);
                tunnelGeometries.push(geometry);
              }
            }
            const insideWays = filtered.filter((way) =>
              svgOutlinePolygons.length === 0
                ? true
                : doesWayIntersectOutline(way, svgOutlinePolygons)
            );
            const outsideWays = filtered.filter(
              (way) =>
                svgOutlinePolygons.length === 0
                  ? false
                  : !doesWayIntersectOutline(way, svgOutlinePolygons)
            );
            const renderWayGroup = (
              waySet: OSMWay[],
              tag: 'inside' | 'outside'
            ) => {
              if (waySet.length === 0) {
                return;
              }
              const grouped = groupWaysByRailway(waySet);
              const newTiles: RailTile[] = [];
              grouped.forEach((groupWays, railwayType) => {
                const conversionStart = Date.now();
                const positions = convertWaysToPositions(groupWays);
                if (positions.length === 0) {
                  return;
                }
                const processed = positions;
                if (name === 'fine') {
                  appendPositions(finePositionsRef.current, processed);
                  appendPositionsToType(
                    finePositionsByTypeRef.current,
                    railwayType,
                    processed
                  );
                } else {
                  const geometryStart = Date.now();
                  const geometry = new BufferGeometry();
                  geometry.setAttribute('position', new BufferAttribute(processed, 3));
                  createdGeometriesRef.current.add(geometry);
                  const geometryDuration = Date.now() - geometryStart;
                newTiles.push({
                  key: `${key}-${railwayType}-${tag}`,
                  geometry,
                  chains: waysToChains(groupWays),
                  level: name,
                  railwayType,
                  opacity: tag === 'outside' ? 0.35 : 0.95,
                });
                }
              });
              if (newTiles.length === 0) {
                return;
              }
              const setTilesStart = Date.now();
              setRailTiles((prev) => {
                const nextTiles = [...prev, ...newTiles];
                return nextTiles;
              });
            };

            renderWayGroup(insideWays, 'inside');
            renderWayGroup(outsideWays, 'outside');

            const wait = pause ?? 100;
            await sleep(wait);
          }
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
  }, [osmRefreshTrigger, osmDetailLevel]);

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
          console.log(`🗺️ Slovakia outline loaded: ${outline.points.length} points`);
          console.log(`   Bounds: [${outline.bounds.minLat.toFixed(4)}, ${outline.bounds.minLng.toFixed(4)}] to [${outline.bounds.maxLat.toFixed(4)}, ${outline.bounds.maxLng.toFixed(4)}]`);
          
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

  const routes = useMemo(() => {
    const trainsWithRoutes = trains.filter(
      (train) => train.shapePath && train.shapePath.length > 0
    );
    if (trainsWithRoutes.length > 0) {
      console.log(`📊 ${trainsWithRoutes.length} trains have routes (out of ${trains.length})`);
      console.log(`Sample route length: ${trainsWithRoutes[0].shapePath.length} points`);
    }
    return trainsWithRoutes.flatMap((train) => {
      const isSelected = train.trainNumber === focusedTrainNumber;
      if (isSelected && train.routeSegments && train.routeSegments.length > 0) {
        return train.routeSegments.map((segment, index) => (
          <TrackLine
            key={`${train.trainNumber}-${segment.key}-${index}`}
            path={segment.points}
            color={routeSegmentColor(segment.key)}
            opacity={1}
            lineWidth={segment.key === '50' || segment.key === '60' ? 6 : 4}
            heightOffset={ANIMATED_PATH_HEIGHT_OFFSET}
          />
        ));
      }
      return (
        <TrackLine
          key={train.trainNumber}
          path={train.shapePath}
          color={train.color}
          opacity={isSelected ? 1 : 0}
          lineWidth={isSelected ? 8 : 3}
          heightOffset={ANIMATED_PATH_HEIGHT_OFFSET}
        />
      );
    });
  }, [trains, focusedTrainNumber]);

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
      focusedAnimationState?.path?.length
        ? focusedAnimationState.path
        : trains.find((train) => train.trainNumber === focusedTrainNumber)
            ?.shapePath ?? [];
    if (!path || path.length < 2) {
      return null;
    }
    const highlightHeight = TERRAIN_HEIGHT_MARGIN + 1 + HIGHLIGHT_VERTICAL_OFFSET;
    const positions: number[] = [];
    const samplePoints: Vector3[] = [];
    path.forEach((coord) => {
      const [x, , z] = project(coord);
      const y = highlightHeight;
      positions.push(x, y, z);
      samplePoints.push(new Vector3(x, y, z));
    });
    const highlightColor = trainColorForHighlight(trains, focusedTrainNumber);
    return {
      positions,
      samplePoints,
      color: highlightColor,
    };
  }, [focusedAnimationState, focusedTrainNumber, trains]);

  const highlightedAnimationPaths = useMemo(() => {
    const states = Array.from(animationStatesRef.current.values()).filter(
      (state) => state.path && state.path.length > 1
    );
    return states.map((state) => (
      <TrackLine
        key={`anim-path-${state.trainNumber}-${state.boundingBoxKey}`}
        path={state.path}
        color="#ff1a1a"
        opacity={1}
        lineWidth={18}
      heightOffset={ANIMATED_PATH_HEIGHT_OFFSET}
      terrainSampler={terrainSampler}
      />
    ));
  }, [animationVersion]);

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
  }, [animationVersion]);

  const animatedLiveRouteLines = useMemo(() => {
    const animatedTrainNumbers = new Set(animationStatesRef.current.keys());
    const trainsWithLiveRoutes = trains.filter(
      (train) =>
        animatedTrainNumbers.has(train.trainNumber) &&
        train.liveRoute &&
        train.liveRoute.length > 1
    );
    return trainsWithLiveRoutes.map((train) => (
      <TrackLine
        key={`live-route-${train.trainNumber}`}
        path={train.liveRoute!}
        color="#facc15"
        opacity={0.7}
        lineWidth={8}
      />
    ));
  }, [trains, animationVersion]);

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
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.8}
                transparent
                opacity={0.95}
              />
            </mesh>
          );
        })}
      </group>
    );
  }, [nextMapPoints, trains, isCoordinateVisible]);

  const stationPoints = useMemo(() => {
    if (!dataset) {
      return null;
    }

    const stops = Object.values(dataset.stops);
    if (stops.length === 0) {
      return null;
    }
    const filteredStops = stops.filter((stop) =>
      isCoordinateVisible({ lat: stop.lat, lng: stop.lng })
    );
    if (filteredStops.length === 0) {
      return null;
    }

    const positions = new Float32Array(filteredStops.length * 3);

    filteredStops.forEach((stop, index) => {
      const [x, , z] = project({ lat: stop.lat, lng: stop.lng });
      positions[index * 3] = x;
      positions[index * 3 + 1] = 1;
      positions[index * 3 + 2] = z;
    });

    return (
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#ffffff"
          size={1}
          sizeAttenuation={true}
          depthWrite={false}
          transparent={true}
          opacity={0.9}
        />
      </points>
    );
  }, [dataset]);

  const railLineElements = useMemo(() => {
    if (railTiles.length === 0) {
      return null;
    }
    const tileCount = railTiles.length;
    const buildStart = performance.now();
    const elements = railTiles.map((tile) => {
      if (tile.chains && tile.chains.length > 0) {
        return (
          <VectorRailTile
            key={tile.key}
            chains={tile.chains}
            opacity={tile.opacity ?? 1}
          />
        );
      }
      const material = new LineBasicMaterial({
        color: '#f4f7fb',
        linewidth: 1,
        transparent: true,
        opacity: tile.opacity ?? 1,
        depthTest: false,
        depthWrite: false,
      });
      return (
        <lineSegments
          key={tile.key}
          geometry={tile.geometry}
          material={material}
          renderOrder={1500}
        />
      );
    });
    const buildDuration = performance.now() - buildStart;
    return elements;
  }, [railTiles]);

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

  const visibleMajorCities = useMemo(
    () =>
      MAJOR_CITIES.filter((city) =>
        isCoordinateVisible({ lat: city.lat, lng: city.lng })
      ),
    [isCoordinateVisible]
  );
  const visibleHouseCities = useMemo(
    () =>
      visibleMajorCities.filter(
        (city) => city.size === 'large' || city.size === 'medium'
      ),
    [visibleMajorCities]
  );
  const slovakCityLabels = useMemo(
    () =>
      SLOVAK_CITIES.filter((city) =>
        isCoordinateVisible({ lat: city.lat, lng: city.lng })
      ).map((city) => (
        <CityLabel
          key={`slovak-city-${city.name}`}
          name={city.name}
          lat={city.lat}
          lng={city.lng}
          size="small"
        />
      )),
    [isCoordinateVisible]
  );

  const trainMeshes = useMemo(() => {
    const trainsWithPosition = trains.filter((train) => train.position);
    console.log(`🚂 ${trainsWithPosition.length} trains have positions (out of ${trains.length})`);
    return trainsWithPosition
      .filter((train) => {
        if (!boundingBoxActive) return true;
        return !boundingTrains.has(train.trainNumber);
      })
      .map((train) => (
      <TrainMesh 
        key={train.trainNumber} 
        train={train}
        isSelected={train.trainNumber === focusedTrainNumber}
        onClick={onTrainClick}
        animationState={animationStatesRef.current.get(train.trainNumber) ?? null}
      />
    ));
  }, [
    trains,
    focusedTrainNumber,
    onTrainClick,
    animationVersion,
    boundingBoxActive,
    boundingTrains,
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
  
  // Debug: Log sample coordinates to verify projection
  if (trains.length > 0 && trains[0].shapePath.length > 0) {
    const sampleCoord = trains[0].shapePath[0];
    const [x, y, z] = project(sampleCoord);
    console.log(`📍 Sample coordinate: lat=${sampleCoord.lat}, lng=${sampleCoord.lng} -> [${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}]`);
    
    // Log a few more points to see the range
    if (trains[0].shapePath.length > 10) {
      const midCoord = trains[0].shapePath[Math.floor(trains[0].shapePath.length / 2)];
      const [mx, my, mz] = project(midCoord);
      console.log(`📍 Mid coordinate: lat=${midCoord.lat}, lng=${midCoord.lng} -> [${mx.toFixed(1)}, ${my.toFixed(1)}, ${mz.toFixed(1)}]`);
    }
  }
  
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
    : 'Loading terrain...';
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
            dpr={canvasDpr}
            style={{ pointerEvents: overlayActive ? 'none' : 'auto' }}
            camera={{
              position: cameraPosition,
              fov: 16,
              near: 0.005,
            far: 10000,
            }}
            gl={{ antialias: true }}
            onCreated={({ camera }) => {
              camera.up.set(0, 0, -1);
              camera.lookAt(0, 0, 0);
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
      <ambientLight intensity={1.2} />
      <directionalLight position={[1000, 2000, 1000]} intensity={1.5} />
      <pointLight position={[0, 1000, 0]} intensity={0.5} />
      
      {/* Terrain model */}
      {is3DView && (
        <TerrainModel terrainRef={terrainGroupRef} onLoaded={handleTerrainLoaded} />
      )}

      {/* Simple ground plane */}
      {slovakiaOutline && (() => {
        const [minX, , minZ] = project({ lat: slovakiaOutline.bounds.minLat, lng: slovakiaOutline.bounds.minLng });
        const [maxX, , maxZ] = project({ lat: slovakiaOutline.bounds.maxLat, lng: slovakiaOutline.bounds.maxLng });
        const width = maxX - minX;
        const height = maxZ - minZ;
        const centerX = (minX + maxX) / 2;
        const centerZ = (minZ + maxZ) / 2;
        
        return (
          <mesh rotation-x={-Math.PI / 2} position={[centerX, 0, centerZ]}>
            <planeGeometry args={[width, height]} />
            <meshStandardMaterial color="#3a5a3a" opacity={0.3} transparent={true} />
          </mesh>
        );
      })()}
      
      {/* City labels - show based on zoom level (for now, show all) */}
      {visibleMajorCities.map((city) => (
        <CityLabel 
          key={city.name} 
          name={city.name} 
          lat={city.lat} 
          lng={city.lng} 
          size={city.size} 
        />
      ))}
      
      {/* Simple houses at major cities */}
      {visibleHouseCities.map((city) => (
        <House key={`house-${city.name}`} lat={city.lat} lng={city.lng} />
      ))}

      {slovakCityLabels}
      
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
      {highlightedRoute &&
        highlightedRoute.samplePoints
          .filter((_, index) => index % ROUTE_LIGHT_SAMPLE_STEP === 0)
          .map((position, index) => {
            return (
              <pointLight
                key={`route-light-${index}`}
                position={[position.x, position.y + 12, position.z]}
                color={highlightedRoute.color}
                intensity={ROUTE_LIGHT_INTENSITY}
                distance={ROUTE_LIGHT_DISTANCE}
                decay={ROUTE_LIGHT_DECAY}
              />
            );
          })}

      {/* Search circle visualization */}
      {searchCirclePrimitive}
      {nextPointMarkers}

      {/* Render GTFS routes (fallback/low-poly tracks) */}
      {routes.length > 0 && (
        <group>
          {routes}
        </group>
      )}
      
      {/* Render station dots */}
      {stationPoints}

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
                  <span>Terrain GLB</span>
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
};

