// Terrain component that uses tiles directly instead of elevation grids
import { useState, useEffect, useRef, useMemo } from 'react';
import { PlaneGeometry, BufferGeometry, BufferAttribute, MeshStandardMaterial } from 'three';
import type { TerrainTile } from '../data/terrainTileService';
import { getTileBounds } from '../data/terrainTileService';

// ===== CONFIGURABLE CONSTANTS =====
// Number of vertices to process per chunk (chunking for async processing)
const VERTICES_PER_FRAME = 1000; // TWEAK THIS: Higher = faster but more blocking, Lower = smoother but slower (default: 1000)

// Debounce delay for geometry updates (ms)
const GEOMETRY_UPDATE_DEBOUNCE_MS = 300; // TWEAK THIS: Delay before starting geometry creation after tiles change (default: 300ms)
// ===================================

interface TerrainParams {
  elevationScale: number;
  minElevation: number;
  opacity: number;
}

interface TerrainFromTilesProps {
  tiles: TerrainTile[];
  params: TerrainParams;
  project: (coord: { lat: number; lng: number }) => [number, number, number];
  cameraPosition: [number, number, number];
  currentLODZoom: number;
}

export const TerrainFromTiles: React.FC<TerrainFromTilesProps> = ({ tiles, params, project, cameraPosition, currentLODZoom }) => {
  // Async geometry creation state
  const [tileMeshes, setTileMeshes] = useState<Array<{ tile: TerrainTile; geometry: PlaneGeometry }>>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const debounceTimerRef = useRef<number | null>(null);
  const processingRef = useRef(false);
  const cancelProcessingRef = useRef(false);
  
  // Performance monitoring
  const frameTimeRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef<number>(performance.now());
  const performanceReportIntervalRef = useRef<number | null>(null);
  
  // Render tracking
  const renderCountRef = useRef(0);
  const lastRenderTimeRef = useRef<number>(performance.now());
  const renderTimesRef = useRef<number[]>([]);
  
  // Cache for tile bounds to avoid repeated calculations
  const tileBoundsCacheRef = useRef<Map<string, ReturnType<typeof getTileBounds>>>(new Map());
  
  // Get memory info if available (Chrome/Edge)
  const getMemoryInfo = () => {
    const mem = (performance as any).memory;
    if (mem) {
      return {
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
        usedMB: (mem.usedJSHeapSize / 1048576).toFixed(2),
        totalMB: (mem.totalJSHeapSize / 1048576).toFixed(2),
        limitMB: (mem.jsHeapSizeLimit / 1048576).toFixed(2),
        usagePercent: ((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1)
      };
    }
    return null;
  };
  
  // Calculate geometry memory usage
  const calculateGeometryMemory = (geometries: PlaneGeometry[]): number => {
    let totalBytes = 0;
    geometries.forEach(geom => {
      // Position buffer (Float32Array, 3 components per vertex)
      if (geom.attributes.position) {
        totalBytes += geom.attributes.position.array.byteLength;
      }
      // Color buffer (Float32Array, 3 components per vertex)
      if (geom.attributes.color) {
        totalBytes += geom.attributes.color.array.byteLength;
      }
      // Normal buffer (Float32Array, 3 components per vertex)
      if (geom.attributes.normal) {
        totalBytes += geom.attributes.normal.array.byteLength;
      }
      // Index buffer (Uint16Array or Uint32Array)
      if (geom.index) {
        totalBytes += geom.index.array.byteLength;
      }
    });
    return totalBytes;
  };
  
  // Process a single tile's geometry (chunked for async processing)
  const processTileGeometry = async (
    tile: TerrainTile,
    tileIndex: number,
    totalTiles: number
  ): Promise<{ tile: TerrainTile; geometry: PlaneGeometry } | null> => {
    if (!tile.elevation || tile.elevation.length === 0) {
      return null;
    }
    
    
    // Use cached bounds if available
    const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    let bounds = tileBoundsCacheRef.current.get(tileKey);
    if (!bounds) {
      bounds = getTileBounds(tile.x, tile.y, tile.z);
      tileBoundsCacheRef.current.set(tileKey, bounds);
    }
    const elevationData = tile.elevation;
    const dataWidth = elevationData[0].length;
    const dataHeight = elevationData.length;
    
    // Create geometry
    // PlaneGeometry(width, height, widthSegments, heightSegments)
    // Note: widthSegments = number of divisions along width (X axis)
    //       heightSegments = number of divisions along height (Y axis)
    // For our data: dataWidth = columns (longitude/X), dataHeight = rows (latitude/Z)
    // We want: widthSegments = dataWidth - 1 (columns along X), heightSegments = dataHeight - 1 (rows along Z)
    // FIXED: Was dataHeight-1, dataWidth-1 (backwards) - this caused 90-degree rotation
    const geom = new PlaneGeometry(1, 1, dataWidth - 1, dataHeight - 1);
    const positions = geom.attributes.position.array as Float32Array;
    const colors = new Float32Array(positions.length);
    
    
    // Project corners to 3D for interpolation
    const sw = project({ lat: bounds.minLat, lng: bounds.minLng });
    const se = project({ lat: bounds.minLat, lng: bounds.maxLng });
    const ne = project({ lat: bounds.maxLat, lng: bounds.maxLng });
    const nw = project({ lat: bounds.maxLat, lng: bounds.minLng });
    
    // Calculate tile center for positioning
    const centerLat = (bounds.minLat + bounds.maxLat) / 2;
    const centerLng = (bounds.minLng + bounds.maxLng) / 2;
    const [centerX, centerY, centerZ] = project({ lat: centerLat, lng: centerLng });
    
    
    // Process vertices in chunks to avoid blocking
    const totalVertices = positions.length / 3;
    let processedVertices = 0;
    
    
    // Process vertices in chunks with proper yielding
    // PlaneGeometry creates vertices in row-major order, starting from top-left (in XY plane)
    // After rotation to XZ plane: top-left becomes... we need to verify the mapping
    const processChunk = (startVertex: number, endVertex: number) => {
      for (let i = startVertex * 3; i < endVertex * 3; i += 3) {
        const vertexIndex = i / 3;
        // PlaneGeometry orders vertices: row by row, left to right, top to bottom (in XY plane)
        // After rotation-x={-PI/2}: XY plane → XZ plane (horizontal)
        // In XY: top-left is (x=-0.5, y=0.5), bottom-left is (x=-0.5, y=-0.5)
        // After rotation: top-left becomes (x=-0.5, z=0.5), bottom-left becomes (x=-0.5, z=-0.5)
        // Our data: row 0 = minLat (south/bottom), row max = maxLat (north/top)
        // Try without row flip first to fix Z axis mirroring
        const planeRow = Math.floor(vertexIndex / dataWidth);
        const col = vertexIndex % dataWidth;
        // No row flip: PlaneGeometry's row order matches our data order
        const row = planeRow;
        
        // Normalized coordinates (0-1) for bilinear interpolation
        // u: 0 = west (minLng), 1 = east (maxLng) - matches col order ✓
        // v: 0 = south (minLat), 1 = north (maxLat) - after row flip, this should match
        const u = col / (dataWidth - 1);
        const v = row / (dataHeight - 1);
        
        // Calculate expected lat/lng for this vertex
        const expectedLat = bounds.minLat + (bounds.maxLat - bounds.minLat) * v;
        const expectedLng = bounds.minLng + (bounds.maxLng - bounds.minLng) * u;
        
        // Bilinear interpolation for X/Z position from corners (in world coordinates)
        const worldX = sw[0] * (1 - u) * (1 - v) + se[0] * u * (1 - v) + nw[0] * (1 - u) * v + ne[0] * u * v;
        const worldZ = sw[2] * (1 - u) * (1 - v) + se[2] * u * (1 - v) + nw[2] * (1 - u) * v + ne[2] * u * v;
        
        // Convert to relative coordinates (relative to tile center)
        const x = worldX - centerX;
        const z = worldZ - centerZ;
        
        
        // Get elevation directly from pixel
        const elevation = elevationData[row]?.[col] ?? 0;
        const adjustedElevation = Math.max(0, elevation - params.minElevation);
        const height = adjustedElevation * params.elevationScale;
        
        
        // Set position after rotation-x={-PI/2}: X→X, Y→Z, Z→-Y
        // So: positions[i] = X (east-west), positions[i+1] = Z (north-south), positions[i+2] = Y (elevation, becomes -Y after rotation = UP)
        positions[i] = x;
        positions[i + 1] = z;
        positions[i + 2] = height; // Positive height, which becomes -Y after rotation (UP)
        
        // Simple color based on elevation
        const normalizedHeight = adjustedElevation / 2500;
        if (normalizedHeight > 0.7) {
          colors[i] = 0.95; colors[i + 1] = 0.95; colors[i + 2] = 0.95;
        } else if (normalizedHeight > 0.4) {
          colors[i] = 0.5; colors[i + 1] = 0.4; colors[i + 2] = 0.3;
        } else if (normalizedHeight > 0.2) {
          colors[i] = 0.3; colors[i + 1] = 0.5; colors[i + 2] = 0.2;
        } else {
          colors[i] = 0.2; colors[i + 1] = 0.6; colors[i + 2] = 0.1;
        }
      }
    };
    
    // Process in chunks with frame-based yielding
    let chunkCount = 0;
    while (processedVertices < totalVertices && !cancelProcessingRef.current) {
      const chunkStart = processedVertices;
      const chunkEnd = Math.min(processedVertices + VERTICES_PER_FRAME, totalVertices);
      
      
      // Process this chunk synchronously
      processChunk(chunkStart, chunkEnd);
      processedVertices = chunkEnd;
      chunkCount++;
      
      
      // Yield to browser between chunks - use MessageChannel for true async yielding
      if (processedVertices < totalVertices) {
        
        await new Promise<void>(resolve => {
          // Use MessageChannel for immediate async yielding (faster than setTimeout)
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            resolve();
          };
          channel.port2.postMessage(null);
        });
      }
    }
    
    if (cancelProcessingRef.current) {
      return null;
    }
    
    
    geom.setAttribute('color', new BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    
    
    return { tile, geometry: geom };
  };
  
  // Track previous tile keys to prevent unnecessary recreation
  const previousTileKeysRef = useRef<string>('');
  
  // Debounced async geometry creation
  useEffect(() => {
    // Create tile key string for comparison
    const tileKeys = tiles.map(t => `${t.z}/${t.x}/${t.y}`).sort().join(',');
    
    // Skip if tiles haven't actually changed
    if (tileKeys === previousTileKeysRef.current && tileMeshes.length > 0) {
      return;
    }
    
    previousTileKeysRef.current = tileKeys;
    
    // Cancel any pending debounce
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    
    // Cancel any ongoing processing
    cancelProcessingRef.current = true;
    
    if (tiles.length === 0) {
      setTileMeshes([]);
      setIsProcessing(false);
      previousTileKeysRef.current = '';
      return;
    }
    
    // Debounce geometry creation
    debounceTimerRef.current = setTimeout(async () => {
      
      cancelProcessingRef.current = false;
      processingRef.current = true;
      setIsProcessing(true);
      
      // Process tiles sequentially (but with chunked vertex processing)
      const results: Array<{ tile: TerrainTile; geometry: PlaneGeometry }> = [];
      
      for (let i = 0; i < tiles.length; i++) {
        if (cancelProcessingRef.current) {
          break;
        }
        
        const result = await processTileGeometry(tiles[i], i, tiles.length);
        if (result) {
          results.push(result);
        }
      }
      
      if (!cancelProcessingRef.current) {
        setTileMeshes(results);
        
      }
      
      processingRef.current = false;
      setIsProcessing(false);
    }, GEOMETRY_UPDATE_DEBOUNCE_MS);
    
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      cancelProcessingRef.current = true;
    };
  }, [tiles, params, project]);
  
  // Performance monitoring effect - periodic reports
  useEffect(() => {
    // Clear any existing interval
    if (performanceReportIntervalRef.current !== null) {
      clearInterval(performanceReportIntervalRef.current);
    }
    
    // Report performance every 5 seconds
    performanceReportIntervalRef.current = window.setInterval(() => {
      const memoryInfo = getMemoryInfo();
      const geometries = tileMeshes.map(m => m.geometry);
      const geometryMemoryBytes = calculateGeometryMemory(geometries);
      const totalVertices = geometries.reduce((sum, geom) => sum + (geom.attributes.position.array.length / 3), 0);
      
      // Calculate frame time stats
      const frameTimes = frameTimeRef.current;
      const avgFrameTime = frameTimes.length > 0 
        ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length 
        : 0;
      const maxFrameTime = frameTimes.length > 0 ? Math.max(...frameTimes) : 0;
      const minFrameTime = frameTimes.length > 0 ? Math.min(...frameTimes) : 0;
      const fps = avgFrameTime > 0 ? (1000 / avgFrameTime).toFixed(1) : 0;
      
      // Clear frame times (keep last 60 frames)
      if (frameTimes.length > 60) {
        frameTimeRef.current = frameTimes.slice(-60);
      }
      
    }, 5000); // Every 5 seconds
    
    return () => {
      if (performanceReportIntervalRef.current !== null) {
        clearInterval(performanceReportIntervalRef.current);
        performanceReportIntervalRef.current = null;
      }
    };
  }, [tileMeshes, currentLODZoom]);
  
  // Frame time tracking
  useEffect(() => {
    const trackFrame = () => {
      const now = performance.now();
      const frameTime = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      
      if (frameTime > 0 && frameTime < 1000) { // Sanity check: frame time between 0-1000ms
        frameTimeRef.current.push(frameTime);
      }
      
      requestAnimationFrame(trackFrame);
    };
    
    const rafId = requestAnimationFrame(trackFrame);
    return () => cancelAnimationFrame(rafId);
  }, []);
  
  // Store project function in ref to prevent memoization recalculation
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  
  // Memoize tile positions - only recalculate when tiles change, NOT when project or cameraPosition changes
  const tilePositions = useMemo(() => {
    
    // Cache tile bounds to avoid repeated calculations
    const boundsCache = new Map<string, ReturnType<typeof getTileBounds>>();
    
    return tileMeshes.map(({ tile }) => {
      const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
      let bounds = boundsCache.get(tileKey);
      if (!bounds) {
        bounds = getTileBounds(tile.x, tile.y, tile.z);
        boundsCache.set(tileKey, bounds);
      }
      
      const centerLat = (bounds.minLat + bounds.maxLat) / 2;
      const centerLng = (bounds.minLng + bounds.maxLng) / 2;
      const [centerX, , centerZ] = projectRef.current({ lat: centerLat, lng: centerLng });
      
      return {
        tile,
        position: [centerX, 0, centerZ] as [number, number, number],
        bounds
      };
    });
  }, [tileMeshes]); // ONLY recalculate when tileMeshes changes, NOT project or cameraPosition
  
  return (
    <>
      {tilePositions.map(({ tile, position }) => {
        const meshData = tileMeshes.find(m => m.tile === tile);
        if (!meshData) return null;
        
        return (
          <mesh
            key={`${tile.z}/${tile.x}/${tile.y}`}
            geometry={meshData.geometry}
            rotation-x={-Math.PI / 2}
            position={position}
          >
            <meshStandardMaterial
              vertexColors
              transparent
              opacity={params.opacity}
              side={2} // DoubleSide
            />
          </mesh>
        );
      })}
    </>
  );
};
