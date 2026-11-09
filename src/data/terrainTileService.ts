// Terrain tile service using Mapbox Terrain-RGB tiles
// These tiles handle LOD automatically and only load visible tiles

import type { Coordinate } from './gtfsParser';

export interface TerrainTile {
  x: number;
  y: number;
  z: number; // Zoom level
  data: ImageData | null;
  elevation: number[][] | null;
}

// Cache for loaded tiles
const tileCache = new Map<string, TerrainTile>();

// Performance tracking for cache
let cacheHits = 0;
let cacheMisses = 0;
let cacheSizeBytes = 0;

// Estimate tile memory size
function estimateTileMemory(tile: TerrainTile): number {
  let bytes = 0;
  // ImageData memory (RGBA, 4 bytes per pixel)
  if (tile.data) {
    bytes += tile.data.width * tile.data.height * 4;
  }
  // Elevation array memory (number[][], ~8 bytes per number in JS)
  if (tile.elevation) {
    const rows = tile.elevation.length;
    const cols = tile.elevation[0]?.length || 0;
    bytes += rows * cols * 8; // Rough estimate
  }
  // Object overhead (~100 bytes)
  bytes += 100;
  return bytes;
}

function getTileKey(x: number, y: number, z: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Convert lat/lng to tile coordinates
 */
export function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * Decode Mapbox Terrain-RGB tile to elevation values
 * Formula: height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
 */
function decodeTerrainRGB(imageData: ImageData): number[][] {
  const { width, height, data } = imageData;
  const elevations: number[][] = [];
  
  for (let y = 0; y < height; y++) {
    elevations[y] = [];
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const R = data[idx];
      const G = data[idx + 1];
      const B = data[idx + 2];
      
      // Decode elevation from RGB
      const height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1);
      elevations[y][x] = height;
    }
  }
  
  return elevations;
}

/**
 * Decode Terrarium-format tile to elevation values
 * Formula: height = (R * 256 + G + B / 256) - 32768
 */
function decodeTerrarium(imageData: ImageData): number[][] {
  
  const { width, height, data } = imageData;
  const elevations: number[][] = [];
  
  let validPixels = 0;
  let invalidPixels = 0;
  
  for (let y = 0; y < height; y++) {
    elevations[y] = [];
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const R = data[idx];
      const G = data[idx + 1];
      const B = data[idx + 2];
      const A = data[idx + 3]; // Alpha channel
      
      // Check if pixel is valid (alpha > 0 means valid data)
      if (A === 0) {
        // No-data pixel (transparent)
        elevations[y][x] = -32768;
        invalidPixels++;
      } else {
        // Decode Terrarium format: height = (R * 256 + G + B / 256) - 32768
        const height = (R * 256 + G + B / 256) - 32768;
        elevations[y][x] = height;
        validPixels++;
      }
    }
  }
  
  
  if (validPixels > 0) {
    console.log(`✅ Decoded Terrarium tile: ${validPixels} valid pixels, ${invalidPixels} no-data pixels`);
  } else {
    console.warn(`⚠️ Decoded Terrarium tile: All pixels are no-data!`);
  }
  
  return elevations;
}

/**
 * Fetch a terrain tile from local server (public/terrain folder)
 * Falls back to Mapbox if local tile not found
 */
async function fetchLocalTerrainTile(
  x: number,
  y: number,
  z: number // This is customZoom (0-4) - used for folder path AND cache key
): Promise<TerrainTile | null> {
  // Use customZoom directly for cache key (matches old working version)
  const cacheKey = getTileKey(x, y, z);
  
  // Check cache
  if (tileCache.has(cacheKey)) {
    return tileCache.get(cacheKey)!;
  }
  
  try {
    const url = `/terrain/${z}/${x}/${y}.png`;
    console.log(`🗻 Fetching local terrain tile: ${url}`);
    
    // Fetch with timeout to avoid hanging on slow/blocked requests
    // Reduced to 1000ms for faster 404 detection (old version used 2000ms)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000); // 1 second timeout - fast 404 detection
    
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        // Timeout - assume tile doesn't exist (common for 404s that take too long)
        console.warn(`⚠️ Tile fetch timeout (likely 404): ${url}`);
        return null;
      }
      throw error;
    }
    
    if (!response.ok) {
      if (response.status === 404) {
        // Tile doesn't exist locally - return null immediately
        return null;
      }
      throw new Error(`Local terrain tile fetch failed: ${response.status}`);
    }
    
    
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);
    
    
    // Create canvas to get ImageData
    const canvas = document.createElement('canvas');
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    
    ctx.drawImage(imageBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    
    // Decode Terrarium format
    const elevation = decodeTerrarium(imageData);
    
    
    const tile: TerrainTile = {
      x,
      y,
      z, // Store customZoom in tile (matches old working version)
      data: imageData,
      elevation,
    };
    
    tileCache.set(cacheKey, tile);
    cacheSizeBytes += estimateTileMemory(tile);
    
    
    console.log(`✅ Local terrain tile loaded: ${z}/${x}/${y}, size: ${elevation.length}x${elevation[0]?.length || 0}`);
    
    return tile;
  } catch (error) {
    console.warn(`⚠️ Failed to fetch local terrain tile ${z}/${x}/${y}:`, error);
    return null;
  }
}

/**
 * Fetch a terrain tile from Mapbox Terrain-RGB (fallback)
 */
async function fetchMapboxTerrainTile(
  x: number,
  y: number,
  z: number,
  accessToken?: string
): Promise<TerrainTile | null> {
  const cacheKey = getTileKey(x, y, z);
  
  // Check cache
  if (tileCache.has(cacheKey)) {
    return tileCache.get(cacheKey)!;
  }
  
  try {
    // Use Mapbox Terrain-RGB tiles
    const token = accessToken || import.meta.env.VITE_MAPBOX_TOKEN || '';
    if (!token) {
      return null;
    }
    
    const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${token}`;
    
    console.log(`🗻 Fetching Mapbox terrain tile: z=${z}, x=${x}, y=${y}`);
    
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 401) {
        console.warn('⚠️ Mapbox token invalid');
        return null;
      }
      throw new Error(`Mapbox terrain tile fetch failed: ${response.status}`);
    }
    
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);
    
    // Create canvas to get ImageData
    const canvas = document.createElement('canvas');
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    
    ctx.drawImage(imageBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Decode to elevation (Mapbox format)
    const elevation = decodeTerrainRGB(imageData);
    
    const tile: TerrainTile = {
      x,
      y,
      z,
      data: imageData,
      elevation,
    };
    
    tileCache.set(cacheKey, tile);
    console.log(`✅ Mapbox terrain tile loaded: ${z}/${x}/${y}`);
    
    return tile;
  } catch (error) {
    console.error(`❌ Failed to fetch Mapbox terrain tile ${z}/${x}/${y}:`, error);
    return null;
  }
}

/**
 * Fetch a terrain tile - LOCAL ONLY (no fallback)
 * 
 * Local tiles (Terrarium format):
 * - Self-hosted in public/terrain/{z}/{x}/{y}.png
 * - No API limits
 * - Generated from your SRTM HGT files
 */
export async function fetchTerrainTile(
  x: number,
  y: number,
  z: number,
  accessToken?: string
): Promise<TerrainTile | null> {
  // Use ONLY local tiles - no fallback
  return await fetchLocalTerrainTile(x, y, z);
}

/**
 * Get elevation at a specific point from a tile
 */
export function getElevationFromTile(
  tile: TerrainTile,
  lat: number,
  lng: number,
  zoom: number
): number {
  if (!tile || !tile.elevation) {
    return -32768; // No data
  }
  
  // Get pixel coordinates within tile
  const n = Math.pow(2, zoom);
  const tileLng = (tile.x / n) * 360 - 180;
  const tileMaxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n))) * 180 / Math.PI;
  const tileMinLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 1) / n))) * 180 / Math.PI;
  
  // Calculate pixel coordinates
  const pixelX = Math.floor(((lng - tileLng) / (360 / n)) * tile.elevation[0].length);
  const pixelY = Math.floor(((tileMaxLat - lat) / (tileMaxLat - tileMinLat)) * tile.elevation.length);
  
  if (pixelY >= 0 && pixelY < tile.elevation.length && 
      pixelX >= 0 && pixelX < tile.elevation[0].length) {
    const elevation = tile.elevation[pixelY][pixelX];
    return elevation === -32768 ? -32768 : elevation; // Return no-data if it's no-data
  }
  
  return -32768; // No data
}

/**
 * Get elevation at a specific point using terrain tiles
 * Automatically selects appropriate zoom level based on area
 */
export async function getElevationFromTiles(
  lat: number,
  lng: number,
  zoom: number = 12
): Promise<number> {
  const { x, y } = latLngToTile(lat, lng, zoom);
  const tile = await fetchTerrainTile(x, y, zoom);
  
  if (!tile) {
    return 0; // Fallback
  }
  
  return getElevationFromTile(tile, lat, lng, zoom);
}

/**
 * Map our custom zoom level (0-4) to Web Mercator zoom level
 */
function getWebMercatorZoom(customZoom: number): number {
  const WEB_MERCATOR_ZOOM_MAP: Record<number, number> = {
    0: 0,   // Overview
    1: 3,   // Medium overview
    2: 6,   // Default
    3: 9,   // Close-up
    4: 12   // Train level
  };
  return WEB_MERCATOR_ZOOM_MAP[customZoom] ?? 6;
}

/**
 * Get terrain tiles for a bounding box using LOCAL terrain tiles ONLY
 * Returns tiles array directly instead of creating a grid
 */
export async function getTerrainTilesForBounds(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  customZoom: number // Our custom zoom level (0-4)
): Promise<TerrainTile[]> {
  const webMercatorZoom = getWebMercatorZoom(customZoom);
  
  // Calculate tile coordinates using Web Mercator zoom
  const minTile = latLngToTile(minLat, minLng, webMercatorZoom);
  const maxTile = latLngToTile(maxLat, maxLng, webMercatorZoom);
  
  const tileMinX = Math.min(minTile.x, maxTile.x);
  const tileMaxX = Math.max(minTile.x, maxTile.x);
  const tileMinY = Math.min(minTile.y, maxTile.y);
  const tileMaxY = Math.max(minTile.y, maxTile.y);
  
  console.log(`🗻 Loading terrain tiles: custom zoom=${customZoom}, web mercator zoom=${webMercatorZoom}`);
  console.log(`   Bounds: [${minLat.toFixed(2)}, ${minLng.toFixed(2)}] to [${maxLat.toFixed(2)}, ${maxLng.toFixed(2)}]`);
  console.log(`   Tile range: X [${tileMinX}, ${tileMaxX}], Y [${tileMinY}, ${tileMaxY}]`);
  console.log(`   Total tiles: ${(tileMaxX - tileMinX + 1)} × ${(tileMaxY - tileMinY + 1)} = ${(tileMaxX - tileMinX + 1) * (tileMaxY - tileMinY + 1)}`);
  
  // Load tiles lazily in batches (don't create all promises upfront)
  const CONCURRENT_TILES = 5; // TWEAK THIS: Number of tiles to load concurrently (default: 5)
  const tiles: TerrainTile[] = [];
  let tilesNotFound = 0;
  
  
  // Create tile coordinates array
  const tileCoords: Array<{ x: number; y: number }> = [];
  for (let x = tileMinX; x <= tileMaxX; x++) {
    for (let y = tileMinY; y <= tileMaxY; y++) {
      tileCoords.push({ x, y });
    }
  }
  
  // Process tiles in batches (lazy promise creation)
  for (let i = 0; i < tileCoords.length; i += CONCURRENT_TILES) {
    const batch = tileCoords.slice(i, i + CONCURRENT_TILES);
    
    // Create promises only for this batch
    const batchPromises = batch.map(({ x, y }) => fetchLocalTerrainTile(x, y, customZoom));
    const batchResults = await Promise.all(batchPromises);
    const batchTiles = batchResults.filter((tile): tile is TerrainTile => tile !== null);
    tiles.push(...batchTiles);
    tilesNotFound += batchResults.length - batchTiles.length;
    
    
    // Yield to browser between batches
    if (i + CONCURRENT_TILES < tileCoords.length) {
      await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
    }
  }
  
  
  console.log(`✅ Loaded ${tiles.length} tiles in batches, ${tilesNotFound} not found`);
  
  
  return tiles;
}

/**
 * Get tile bounds in lat/lng coordinates
 */
export function getTileBounds(x: number, y: number, customZoom: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const webMercatorZoom = getWebMercatorZoom(customZoom);
  const n = Math.pow(2, webMercatorZoom);
  
  const minLng = (x / n) * 360 - 180;
  const maxLng = ((x + 1) / n) * 360 - 180;
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  
  
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Get elevation grid for a bounding box using LOCAL terrain tiles ONLY
 * DEPRECATED: Use getTerrainTilesForBounds() instead
 * Kept for backward compatibility
 */
export async function getElevationGridFromTiles(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  zoom: number = 2 // Zoom levels 0-4: Z0 (overview), Z1 (medium), Z2 (default), Z3 (close), Z4 (train level)
): Promise<number[][] | null> {
  
  const minTile = latLngToTile(minLat, minLng, zoom);
  const maxTile = latLngToTile(maxLat, maxLng, zoom);
  
  // In Web Mercator, Y increases as latitude decreases (southward)
  // So minLat (south) has higher Y than maxLat (north)
  // We need to swap Y coordinates to iterate correctly
  const tileMinX = Math.min(minTile.x, maxTile.x);
  const tileMaxX = Math.max(minTile.x, maxTile.x);
  const tileMinY = Math.min(minTile.y, maxTile.y); // Lower Y value (north)
  const tileMaxY = Math.max(minTile.y, maxTile.y); // Higher Y value (south)
  
  
  console.log(`🗻 Loading local terrain tiles: zoom=${zoom}, tiles=${(tileMaxX - tileMinX + 1)}x${(tileMaxY - tileMinY + 1)}`);
  
  // Fetch all tiles in bounding box (LOCAL ONLY)
  const tiles: TerrainTile[] = [];
  let tilesFound = 0;
  let tilesNotFound = 0;
  
  for (let x = tileMinX; x <= tileMaxX; x++) {
    for (let y = tileMinY; y <= tileMaxY; y++) {
      const tile = await fetchLocalTerrainTile(x, y, zoom);
      if (tile) {
        tiles.push(tile);
        tilesFound++;
        console.log(`  ✅ Loaded local tile: ${zoom}/${x}/${y}`);
      } else {
        tilesNotFound++;
        console.warn(`  ⚠️ Local tile not found: ${zoom}/${x}/${y}`);
      }
    }
  }
  
  
  if (tiles.length === 0) {
    console.error('❌ No local terrain tiles found! Make sure tiles are in public/terrain/');
    return null;
  }
  
  // Stitch tiles together and extract Slovakia portion
  if (tiles.length === 0) {
    return null;
  }
  
  // Calculate the bounding box of all loaded tiles in lat/lng
  const n = Math.pow(2, zoom);
  
  // Find min/max tile coordinates
  let minTileX = Infinity, maxTileX = -Infinity;
  let minTileY = Infinity, maxTileY = -Infinity;
  tiles.forEach(tile => {
    minTileX = Math.min(minTileX, tile.x);
    maxTileX = Math.max(maxTileX, tile.x);
    minTileY = Math.min(minTileY, tile.y);
    maxTileY = Math.max(maxTileY, tile.y);
  });
  
  // Calculate lat/lng bounds of the tile coverage
  const tileMinLng = (minTileX / n) * 360 - 180;
  const tileMaxLng = ((maxTileX + 1) / n) * 360 - 180;
  const tileMaxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * minTileY / n))) * 180 / Math.PI;
  const tileMinLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (maxTileY + 1) / n))) * 180 / Math.PI;
  
  // Create a map of tiles by their coordinates
  const tileMap = new Map<string, TerrainTile>();
  tiles.forEach(tile => {
    tileMap.set(`${tile.x}/${tile.y}`, tile);
  });
  
  // Calculate resolution for the output grid (use requested bounds)
  const resolution = 256; // Use 256x256 for now, can be made configurable
  
  // Create output elevation grid covering the requested bounds
  const outputGrid: number[][] = [];
  const latStep = (maxLat - minLat) / (resolution - 1);
  const lngStep = (maxLng - minLng) / (resolution - 1);
  
  for (let row = 0; row < resolution; row++) {
    outputGrid[row] = [];
    const lat = maxLat - row * latStep; // Start from north (maxLat)
    
    for (let col = 0; col < resolution; col++) {
      const lng = minLng + col * lngStep;
      
      // Find which tile contains this lat/lng
      const tileCoords = latLngToTile(lat, lng, zoom);
      const tileKey = `${tileCoords.x}/${tileCoords.y}`;
      const tile = tileMap.get(tileKey);
      
      if (tile && tile.elevation) {
        // Get elevation from tile
        const elevation = getElevationFromTile(tile, lat, lng, zoom);
        outputGrid[row][col] = elevation;
      } else {
        // No data
        outputGrid[row][col] = -32768;
      }
    }
  }
  
  // Count valid pixels
  let validPixels = 0;
  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      if (outputGrid[row][col] !== -32768) {
        validPixels++;
      }
    }
  }
  
  console.log(`✅ Stitched ${tiles.length} tiles into ${resolution}x${resolution} grid`);
  console.log(`   Valid pixels: ${validPixels}/${resolution * resolution} (${(100 * validPixels / (resolution * resolution)).toFixed(1)}%)`);
  
  
  return outputGrid;
  
  
  return null;
}

