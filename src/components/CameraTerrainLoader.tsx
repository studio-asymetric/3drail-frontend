// Component that tracks camera height and loads terrain tiles dynamically based on LOD

import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { getTerrainTilesForBounds, latLngToTile, getTileBounds } from '../data/terrainTileService';
import type { TerrainTile } from '../data/terrainTileService';

// ===== CONFIGURABLE CONSTANTS =====
// Maximum tile distance from camera for Z2 (default zoom)
const MAX_TILE_DISTANCE_Z2 = 4; // TWEAK THIS: How many tiles away from camera to render at Z2

// Maximum tile distance from camera for Z3 (close-up zoom)
const MAX_TILE_DISTANCE_Z3 = 1; // TWEAK THIS: How many tiles away from camera to render at Z3

// Maximum tile distance from camera for Z4 (train level zoom)
const MAX_TILE_DISTANCE_Z4 = 1; // TWEAK THIS: How many tiles away from camera to render at Z4
// ===================================

interface CameraTerrainLoaderProps {
  cameraHeight: number;
  setCameraHeight: (height: number) => void;
  lodSettings: {
    highLODHeight: number;
    mediumLODHeight: number;
    lowLODHeight: number;
    detailedRadius: number;
    highLODZoom: number;
    mediumLODZoom: number;
    lowLODZoom: number;
  };
  setTerrainTiles: (tiles: TerrainTile[]) => void;
  setLoadingElevation: (loading: boolean) => void;
  setCurrentLODZoom: (zoom: number) => void;
  manualLODOverride?: number | null;
  manualLODHeight?: number;
}

export const CameraTerrainLoader: React.FC<CameraTerrainLoaderProps> = ({
  cameraHeight,
  setCameraHeight,
  lodSettings,
  setTerrainTiles,
  setLoadingElevation,
  setCurrentLODZoom,
  manualLODOverride = null,
  manualLODHeight = 500,
}) => {
  const { camera } = useThree();
  const loadingRef = useRef(false);
  const lastCameraHeightRef = useRef(0);
  const lastCameraPosRef = useRef({ x: 0, y: 0, z: 0 });
  const lastLoadTimeRef = useRef(0);
  const LOAD_THROTTLE_MS = 3000; // TWEAK THIS: Minimum time between loads (ms) - increased to prevent freezing
  const pendingLoadRef = useRef<Promise<void> | null>(null);
  
  // Determine LOD zoom level based on camera height
  // Maps camera height to zoom levels 0-4:
  // Z0: 500+ units (overview) - ALWAYS LOAD FIRST
  // Z1: 200-500 units (medium overview)
  // Z2: 50-200 units (default, sharp at 500)
  // Z3: 5-50 units (close-up)
  // Z4: 0.1-5 units (train level, sharp at 0.1)
  const getLODZoom = (height: number): number => {
    // Manual override: if enabled and camera is below threshold, use override
    if (manualLODOverride !== null && height < manualLODHeight) {
      return manualLODOverride;
    }
    
    let zoom: number;
    if (height >= 500) {
      zoom = 0; // Overview - start here
    } else if (height >= 200) {
      zoom = 1; // Medium overview
    } else if (height >= 50) {
      zoom = 2; // Default (sharp at 500)
    } else if (height >= 5) {
      zoom = 3; // Close-up
    } else {
      zoom = 4; // Train level (sharp at 0.1)
    }
    
    
    return zoom;
  };
  
  // Track if Z0 has been loaded
  const z0LoadedRef = useRef(false);
  
  // Convert camera position to lat/lng (approximate)
  const cameraToLatLng = (cameraPos: { x: number; y: number; z: number }): { lat: number; lng: number } => {
    // Reverse the project() function
    // x = (lng - CENTER_LNG) * SCALE_LNG * SCALE_X_MULTIPLIER * SCALE_X_FLIP
    // z = (lat - CENTER_LAT) * SCALE_LAT
    // Note: Removed 180° rotation, so no need to reverse it
    
    const SCALE_LAT = 200;
    const SCALE_LNG = 200 * Math.cos((48.7 * Math.PI) / 180);
    const SCALE_X_MULTIPLIER = 1.0;
    const SCALE_X_FLIP = 1;
    const CENTER_LAT = 48.7;
    const CENTER_LNG = 19.5;
    
    // Reverse the projection (no rotation to reverse)
    const lng = (cameraPos.x / (SCALE_LNG * SCALE_X_MULTIPLIER * SCALE_X_FLIP)) + CENTER_LNG;
    const lat = (cameraPos.z / SCALE_LAT) + CENTER_LAT;
    
    return { lat, lng };
  };
  
  // Load terrain based on camera position and height
  const loadTerrain = async (forceZoom?: number) => {
    // Cancel any pending load
    if (pendingLoadRef.current) {
      console.log('⏸️ Cancelling pending terrain load');
      // Note: We can't actually cancel the promise, but we can ignore its result
    }
    
    if (loadingRef.current) {
      console.log('⏸️ Terrain load already in progress, skipping');
      return;
    }
    
    // Throttle loads
    const now = Date.now();
    if (now - lastLoadTimeRef.current < LOAD_THROTTLE_MS) {
      console.log(`⏸️ Throttled: ${LOAD_THROTTLE_MS - (now - lastLoadTimeRef.current)}ms remaining`);
      return;
    }
    lastLoadTimeRef.current = now;
    
    loadingRef.current = true;
    setLoadingElevation(true);
    
    // Create a promise for this load
    const currentLoadPromise = (async () => {
      try {
      const cameraPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      const height = cameraPos.y;
      const lodZoom = forceZoom ?? getLODZoom(height);
      
      
      setCameraHeight(height);
      setCurrentLODZoom(lodZoom);
      
      // ALWAYS load Z0 first if not already loaded (but don't block)
      if (!z0LoadedRef.current && lodZoom !== 0) {
        console.log('🗻 Loading Z0 first (overview)...');
        // Load Z0 in background without blocking
        getTerrainTilesForBounds(48.0, 49.5, 16.8, 22.6, 0).then(z0Tiles => {
          if (z0Tiles.length > 0) {
            setTerrainTiles(z0Tiles);
            z0LoadedRef.current = true;
            console.log(`✅ Z0 loaded: ${z0Tiles.length} tiles`);
          }
        }).catch(err => {
          console.error('❌ Failed to load Z0:', err);
        });
      }
      
      // Convert camera position to lat/lng
      const { lat, lng } = cameraToLatLng(cameraPos);
      
      // Map our custom zoom to Web Mercator zoom
      const WEB_MERCATOR_ZOOM_MAP: Record<number, number> = {
        0: 0, 1: 3, 2: 6, 3: 9, 4: 12
      };
      const webMercatorZoom = WEB_MERCATOR_ZOOM_MAP[lodZoom] ?? 6;
      
      // Get camera tile coordinates
      const cameraTile = latLngToTile(lat, lng, webMercatorZoom);
      
      // Calculate bounds
      // For low LOD: load entire Slovakia
      // For high LOD (Z2, Z3, Z4): calculate precise tile bounds BEFORE loading
      let minLat, maxLat, minLng, maxLng;
      
      if (lodZoom >= 2 && lodZoom <= 4) {
        // High detail: calculate precise tile bounds based on maxTileDistance
        const maxTileDistance = lodZoom === 2 ? MAX_TILE_DISTANCE_Z2 
                              : lodZoom === 3 ? MAX_TILE_DISTANCE_Z3 
                              : MAX_TILE_DISTANCE_Z4;
        
        // Calculate tile bounds directly
        let tileMinX = cameraTile.x - maxTileDistance;
        let tileMaxX = cameraTile.x + maxTileDistance;
        let tileMinY = cameraTile.y - maxTileDistance;
        let tileMaxY = cameraTile.y + maxTileDistance;
        
        // Clamp tile bounds to Slovakia's actual coverage to avoid requesting non-existent tiles
        // Slovakia bounds: 48.0-49.5°N, 16.8-22.6°E
        const slovakiaSW = latLngToTile(48.0, 16.8, webMercatorZoom);
        const slovakiaNE = latLngToTile(49.5, 22.6, webMercatorZoom);
        // Note: In Web Mercator, Y increases southward, so minY is north (higher lat) and maxY is south (lower lat)
        const slovakiaMinX = slovakiaSW.x;
        const slovakiaMaxX = slovakiaNE.x;
        const slovakiaMinY = slovakiaNE.y; // North (higher lat) = lower Y
        const slovakiaMaxY = slovakiaSW.y; // South (lower lat) = higher Y
        
        // Clamp requested bounds to Slovakia's coverage
        tileMinX = Math.max(tileMinX, slovakiaMinX);
        tileMaxX = Math.min(tileMaxX, slovakiaMaxX);
        tileMinY = Math.max(tileMinY, slovakiaMinY);
        tileMaxY = Math.min(tileMaxY, slovakiaMaxY);
        
        // Convert tile coordinates to lat/lng using getTileBounds
        // IMPORTANT: getTileBounds expects customZoom (0-4), not webMercatorZoom!
        // It will convert lodZoom to webMercatorZoom internally
        // Get SW corner (minX, maxY) and NE corner (maxX, minY)
        
        
        const swBounds = getTileBounds(tileMinX, tileMaxY, lodZoom); // SW corner - pass lodZoom, not webMercatorZoom
        const neBounds = getTileBounds(tileMaxX, tileMinY, lodZoom); // NE corner - pass lodZoom, not webMercatorZoom
        
        
        // Use the clamped bounds
        minLat = swBounds.minLat;
        maxLat = neBounds.maxLat;
        minLng = swBounds.minLng;
        maxLng = neBounds.maxLng;
        
        
        console.log(`🗻 Loading HIGH detail terrain (zoom ${lodZoom}) around camera: lat=${lat.toFixed(2)}, lng=${lng.toFixed(2)}, max tile distance: ${maxTileDistance}`);
        console.log(`   Camera tile: [${cameraTile.x}, ${cameraTile.y}]`);
        console.log(`   Tile bounds (clamped to Slovakia): X [${tileMinX}, ${tileMaxX}], Y [${tileMinY}, ${tileMaxY}] (expected ${(tileMaxX - tileMinX + 1) * (tileMaxY - tileMinY + 1)} tiles)`);
        console.log(`   Slovakia tile bounds: X [${slovakiaMinX}, ${slovakiaMaxX}], Y [${slovakiaMinY}, ${slovakiaMaxY}]`);
        console.log(`   Lat/Lng bounds: [${minLat.toFixed(2)}, ${minLng.toFixed(2)}] to [${maxLat.toFixed(2)}, ${maxLng.toFixed(2)}]`);
      } else if (lodZoom >= 3) {
        // Legacy fallback for Z3+ (shouldn't reach here, but keep for safety)
        const SCALE_LAT = 200;
        const SCALE_LNG = 200 * Math.cos((lat * Math.PI) / 180);
        const radiusDegreesLat = lodSettings.detailedRadius / SCALE_LAT;
        const radiusDegreesLng = lodSettings.detailedRadius / SCALE_LNG;
        
        minLat = Math.max(48.0, lat - radiusDegreesLat);
        maxLat = Math.min(49.5, lat + radiusDegreesLat);
        minLng = Math.max(16.8, lng - radiusDegreesLng);
        maxLng = Math.min(22.6, lng + radiusDegreesLng);
        
        console.log(`🗻 Loading HIGH detail terrain (zoom ${lodZoom}) around camera: lat=${lat.toFixed(2)}, lng=${lng.toFixed(2)}, radius=${lodSettings.detailedRadius} units`);
        console.log(`   Bounds: [${minLat.toFixed(2)}, ${minLng.toFixed(2)}] to [${maxLat.toFixed(2)}, ${maxLng.toFixed(2)}]`);
      } else {
        // Low/Medium detail: load entire Slovakia
        minLat = 48.0;
        maxLat = 49.5;
        minLng = 16.8;
        maxLng = 22.6;
        
        console.log(`🗻 Loading ${lodZoom === 0 ? 'OVERVIEW' : lodZoom === 1 ? 'MEDIUM' : 'DEFAULT'} detail terrain (zoom ${lodZoom}) for entire Slovakia`);
      }
      
      const startTime = performance.now();
      let tiles = await getTerrainTilesForBounds(minLat, maxLat, minLng, maxLng, lodZoom);
      const loadTime = performance.now() - startTime;
      
      
      // For Z2, Z3, Z4: double-check tiles are within bounds (safety filter)
      if (lodZoom >= 2 && lodZoom <= 4) {
        const maxTileDistance = lodZoom === 2 ? MAX_TILE_DISTANCE_Z2 
                              : lodZoom === 3 ? MAX_TILE_DISTANCE_Z3 
                              : MAX_TILE_DISTANCE_Z4;
        
        const beforeFilter = tiles.length;
        const filteredTiles = tiles.filter(tile => {
          const distanceX = Math.abs(tile.x - cameraTile.x);
          const distanceY = Math.abs(tile.y - cameraTile.y);
          const maxDistance = Math.max(distanceX, distanceY);
          return maxDistance <= maxTileDistance;
        });
        
        
        if (filteredTiles.length < beforeFilter) {
          console.log(`✂️ Filtered tiles: ${beforeFilter} → ${filteredTiles.length} (removed ${beforeFilter - filteredTiles.length}) at zoom ${lodZoom}`);
        }
        
        tiles = filteredTiles;
      }
      
      if (tiles.length > 0) {
        setTerrainTiles(tiles);
        console.log(`✅ Terrain loaded: ${tiles.length} tiles at zoom ${lodZoom} in ${loadTime.toFixed(0)}ms`);
        if (lodZoom === 0) {
          z0LoadedRef.current = true;
        }
      } else {
        console.warn('⚠️ No terrain tiles found');
        // Don't clear tiles if we have Z0 loaded
        if (lodZoom === 0) {
          setTerrainTiles([]);
        }
      }
    } catch (error) {
      console.error('❌ Failed to load terrain:', error);
      if (!z0LoadedRef.current) {
        setTerrainTiles([]);
      }
      } finally {
        setLoadingElevation(false);
        loadingRef.current = false;
        // Clear pending load ref if this is still the current load
        pendingLoadRef.current = null;
      }
    })();
    
    pendingLoadRef.current = currentLoadPromise;
    await currentLoadPromise;
  };
  
  // Track camera position and reload terrain when it changes significantly
  useFrame(() => {
    const cameraPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    const height = cameraPos.y;
    
    // Check if camera moved significantly
    const heightDiff = Math.abs(height - lastCameraHeightRef.current);
    const posDiff = Math.sqrt(
      Math.pow(cameraPos.x - lastCameraPosRef.current.x, 2) +
      Math.pow(cameraPos.z - lastCameraPosRef.current.z, 2)
    );
    
    // Reload if:
    // 1. Camera height changed enough to switch LOD levels
    // 2. Camera moved horizontally significantly (for high detail mode)
    const currentLOD = getLODZoom(height);
    const lastLOD = getLODZoom(lastCameraHeightRef.current);
    const lodChanged = currentLOD !== lastLOD;
    
    // For high detail (Z3, Z4), require more movement before reloading
    const movedEnough = currentLOD >= 3 
      ? posDiff > lodSettings.detailedRadius * 0.7  // Higher threshold for high detail
      : posDiff > lodSettings.detailedRadius * 0.5;
    
    // Only trigger load if significant change AND not already loading
    if ((lodChanged || movedEnough) && !loadingRef.current) {
      lastCameraHeightRef.current = height;
      lastCameraPosRef.current = cameraPos;
      // Use requestIdleCallback to defer loading if browser is busy
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(() => {
          loadTerrain();
        }, { timeout: 1000 });
      } else {
        // Fallback: use setTimeout to defer
        setTimeout(() => loadTerrain(), 0);
      }
    } else {
      // Still update height for UI
      setCameraHeight(height);
    }
  });
  
  // Initial load - ALWAYS start with Z0
  useEffect(() => {
    if (!z0LoadedRef.current) {
      loadTerrain(0); // Force Z0 first
    } else {
      loadTerrain();
    }
  }, [lodSettings]); // Reload when LOD settings change
  
  return null; // This component doesn't render anything
};

