// Service to fetch real elevation data for Slovakia
// Using OpenElevation API (free, no API key required)

export interface ElevationPoint {
  lat: number;
  lng: number;
  elevation: number; // in meters
}

// Cache for elevation data to avoid repeated API calls
const elevationCache = new Map<string, number>();

function getCacheKey(lat: number, lng: number, precision: number = 3): string {
  return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
}

/**
 * Fetch elevation for a single point using OpenElevation API
 */
export async function fetchElevation(lat: number, lng: number): Promise<number> {
  const cacheKey = getCacheKey(lat, lng);
  
  if (elevationCache.has(cacheKey)) {
    return elevationCache.get(cacheKey)!;
  }

  try {
    const response = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locations: [{ latitude: lat, longitude: lng }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Elevation API error: ${response.status}`);
    }

    const data = await response.json();
    const elevation = data.results[0]?.elevation || 0;
    
    elevationCache.set(cacheKey, elevation);
    return elevation;
  } catch (error) {
    console.warn(`Failed to fetch elevation for ${lat}, ${lng}:`, error);
    return 0; // Default to sea level
  }
}

/**
 * Fetch elevation data for a grid of points covering Slovakia
 * Slovakia bounds: ~48-49.5°N, 16.8-22.6°E
 */
export async function fetchElevationGrid(
  centerLat: number,
  centerLng: number,
  width: number,
  height: number,
  resolution: number = 50 // Number of points per dimension
): Promise<number[][]> {
  // Calculate bounds
  const latSpan = height / 111000; // 1 degree ≈ 111km
  const lngSpan = width / (111000 * Math.cos((centerLat * Math.PI) / 180));
  
  const minLat = centerLat - latSpan / 2;
  const maxLat = centerLat + latSpan / 2;
  const minLng = centerLng - lngSpan / 2;
  const maxLng = centerLng + lngSpan / 2;

  const elevations: number[][] = [];
  const batchSize = 100; // OpenElevation allows up to 100 locations per request
  
  // Create grid of points
  const points: Array<{ lat: number; lng: number; i: number; j: number }> = [];
  for (let i = 0; i < resolution; i++) {
    elevations[i] = [];
    for (let j = 0; j < resolution; j++) {
      const lat = minLat + (maxLat - minLat) * (i / (resolution - 1));
      const lng = minLng + (maxLng - minLng) * (j / (resolution - 1));
      points.push({ lat, lng, i, j });
    }
  }

  // Fetch in batches
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    
    try {
      const response = await fetch('https://api.open-elevation.com/api/v1/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          locations: batch.map(p => ({ latitude: p.lat, longitude: p.lng })),
        }),
      });

      if (!response.ok) {
        throw new Error(`Elevation API error: ${response.status}`);
      }

      const data = await response.json();
      
      batch.forEach((point, idx) => {
        const elevation = data.results[idx]?.elevation || 0;
        elevations[point.i][point.j] = elevation;
        elevationCache.set(getCacheKey(point.lat, point.lng), elevation);
      });
    } catch (error) {
      console.warn(`Failed to fetch elevation batch ${i}-${i + batchSize}:`, error);
      // Fill with 0s if batch fails
      batch.forEach(point => {
        elevations[point.i][point.j] = 0;
      });
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return elevations;
}

/**
 * Fetch high-resolution elevation data around a specific point
 * Useful for detailed terrain when zoomed in on a train
 */
export async function fetchElevationAroundPoint(
  centerLat: number,
  centerLng: number,
  radiusKm: number = 5,
  resolution: number = 100
): Promise<number[][]> {
  // Convert radius to meters
  const radiusM = radiusKm * 1000;
  
  return fetchElevationGrid(
    centerLat,
    centerLng,
    radiusM * 2, // Width = 2 * radius
    radiusM * 2, // Height = 2 * radius
    resolution
  );
}

/**
 * Get elevation at a specific point from elevation grid
 * Uses bilinear interpolation for smooth results
 */
export function getElevationAtPoint(
  lat: number,
  lng: number,
  elevationGrid: number[][] | null,
  gridBounds?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  }
): number {
  if (!elevationGrid || elevationGrid.length === 0) {
    return 0;
  }
  
  if (!gridBounds) {
    // Default to Slovakia bounds if not provided
    gridBounds = {
      minLat: 48.0,
      maxLat: 49.5,
      minLng: 16.8,
      maxLng: 22.6,
    };
  }
  
  const rows = elevationGrid.length;
  const cols = elevationGrid[0]?.length || 0;
  
  if (cols === 0) return 0;
  
  // Normalize coordinates to grid indices
  const latRatio = (lat - gridBounds.minLat) / (gridBounds.maxLat - gridBounds.minLat);
  const lngRatio = (lng - gridBounds.minLng) / (gridBounds.maxLng - gridBounds.minLng);
  
  const i = Math.max(0, Math.min(rows - 1, Math.floor(latRatio * (rows - 1))));
  const j = Math.max(0, Math.min(cols - 1, Math.floor(lngRatio * (cols - 1))));
  
  // Bilinear interpolation
  const i1 = Math.min(rows - 1, i + 1);
  const j1 = Math.min(cols - 1, j + 1);
  
  const z00 = elevationGrid[i][j] || 0;
  const z01 = elevationGrid[i][j1] || 0;
  const z10 = elevationGrid[i1][j] || 0;
  const z11 = elevationGrid[i1][j1] || 0;
  
  const di = (latRatio * (rows - 1)) - i;
  const dj = (lngRatio * (cols - 1)) - j;
  
  const z0 = z00 * (1 - dj) + z01 * dj;
  const z1 = z10 * (1 - dj) + z11 * dj;
  const elevation = z0 * (1 - di) + z1 * di;
  
  return elevation;
}

