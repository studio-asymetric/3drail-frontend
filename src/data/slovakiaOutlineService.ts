// Service to fetch Slovakia's country outline/border polygon
// Uses Nominatim API to get administrative boundary (Overpass API removed due to timeouts)

export interface SlovakiaOutlinePoint {
  lat: number;
  lng: number;
}

export interface SlovakiaOutline {
  points: SlovakiaOutlinePoint[];
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

// Cache for the outline
let cachedOutline: SlovakiaOutline | null = null;
// Promise cache to prevent concurrent fetches
let fetchPromise: Promise<SlovakiaOutline> | null = null;

/**
 * Fetches Slovakia's country outline polygon from OpenStreetMap
 * Uses Nominatim API to get administrative boundary
 */
export async function fetchSlovakiaOutline(): Promise<SlovakiaOutline> {
  // Return cached outline if available
  if (cachedOutline) {
    return cachedOutline;
  }
  
  // If a fetch is already in progress, return that promise
  if (fetchPromise) {
    return fetchPromise;
  }

  // Create the fetch promise and cache it
  fetchPromise = (async () => {
    try {

      // Use Nominatim API directly (removed Overpass API due to timeouts)
      const outline = await fetchSlovakiaOutlineFromNominatim();
      
      // Cache the result
      cachedOutline = outline;
      fetchPromise = null; // Clear the promise cache
      

      return outline;
    } catch (error) {
      fetchPromise = null; // Clear the promise cache on error
      console.error('Failed to fetch Slovakia outline from Nominatim API, using fallback bounds...', error);
      
      // Final fallback: Return approximate bounds
      const fallbackOutline = getFallbackSlovakiaOutline();
      cachedOutline = fallbackOutline; // Cache the fallback too
      return fallbackOutline;
    }
  })();
  
  return fetchPromise;
}

/**
 * Alternative method: Fetch Slovakia outline from Nominatim API
 */
async function fetchSlovakiaOutlineFromNominatim(): Promise<SlovakiaOutline> {
  try {

    // Use Nominatim API to get Slovakia's boundary
    const nominatimUrl =
      'https://nominatim.openstreetmap.org/search?country=Slovakia&format=geojson&polygon_geojson=1&polygon_threshold=0.002&limit=1';
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(nominatimUrl, {
      headers: {
        'User-Agent': '3D-Railmap/1.0', // Required by Nominatim
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status}`);
    }

    const geojson = await response.json();
    

    // Parse GeoJSON to extract boundary polygon
    const outline = parseGeoJSONResponse(geojson);
    
    // Cache the result
    cachedOutline = outline;
    fetchPromise = null; // Clear the promise cache
    

    return outline;
  } catch (error) {
    console.error('Failed to fetch Slovakia outline from Nominatim API, using fallback bounds...', error);
    
    // Final fallback: Return approximate bounds based on known coordinates
    return getFallbackSlovakiaOutline();
  }
}

/**
 * Parse Overpass API response to extract boundary polygon
 */
function parseOverpassResponse(data: any): SlovakiaOutline {
  const nodes = new Map<number, { lat: number; lon: number }>();
  const ways: number[][] = [];
  let relation: any = null;

  // Extract nodes and ways from Overpass response
  for (const element of data.elements || []) {
    if (element.type === 'node') {
      nodes.set(element.id, { lat: element.lat, lon: element.lon });
    } else if (element.type === 'way') {
      ways.push(element.nodes || []);
    } else if (element.type === 'relation') {
      relation = element;
    }
  }

  // Find the outer boundary way from the relation
  if (relation && relation.members) {
    // Look for outer boundary way
    const outerWay = relation.members.find((m: any) => m.role === 'outer' && m.type === 'way');
    if (outerWay) {
      const wayNodes = ways.find(w => w[0] === outerWay.ref) || [];
      const points: SlovakiaOutlinePoint[] = wayNodes
        .map((nodeId: number) => {
          const node = nodes.get(nodeId);
          return node ? { lat: node.lat, lng: node.lon } : null;
        })
        .filter((p): p is SlovakiaOutlinePoint => p !== null);

      if (points.length > 0) {
        return calculateBounds(points);
      }
    }
  }

  // Fallback: collect all nodes from all ways
  const allPoints: SlovakiaOutlinePoint[] = [];
  for (const way of ways) {
    for (const nodeId of way) {
      const node = nodes.get(nodeId);
      if (node) {
        allPoints.push({ lat: node.lat, lng: node.lon });
      }
    }
  }

  if (allPoints.length === 0) {
    throw new Error('No boundary points found in Overpass response');
  }

  return calculateBounds(allPoints);
}

/**
 * Parse GeoJSON response to extract boundary polygon
 */
function parseGeoJSONResponse(geojson: any): SlovakiaOutline {
  // Find the first Polygon or MultiPolygon feature
  const feature = geojson.features?.find((f: any) => 
    f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
  );

  if (!feature) {
    throw new Error('No polygon feature found in GeoJSON');
  }

  const geometry = feature.geometry;
  let coordinates: number[][][] = [];

  if (geometry.type === 'Polygon') {
    coordinates = geometry.coordinates;
  } else if (geometry.type === 'MultiPolygon') {
    coordinates = (geometry.coordinates as number[][][][]).reduce(
      (largest, polygon) =>
        (polygon[0]?.length ?? 0) > (largest[0]?.length ?? 0) ? polygon : largest,
      [] as number[][][]
    );
  }

  // Extract points from the outer ring (first array)
  const outerRing = coordinates[0] || [];
  const points: SlovakiaOutlinePoint[] = outerRing.map((coord: number[]) => ({
    lng: coord[0], // GeoJSON uses [lng, lat]
    lat: coord[1],
  }));

  if (points.length === 0) {
    throw new Error('No coordinates found in GeoJSON polygon');
  }

  return calculateBounds(points);
}

/**
 * Calculate bounds from points array
 */
function calculateBounds(points: SlovakiaOutlinePoint[]): SlovakiaOutline {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  }

  return {
    points,
    bounds: {
      minLat,
      maxLat,
      minLng,
      maxLng,
    },
  };
}

/**
 * Fallback: Return approximate Slovakia outline based on known bounds
 * Uses the 3 station coordinates to create a rough bounding box
 */
function getFallbackSlovakiaOutline(): SlovakiaOutline {
  // Known station coordinates
  const BRATISLAVA_STATION = { lat: 48.159111, lng: 17.106528 };
  const KOSICE_STATION = { lat: 48.722917, lng: 21.268583 };
  const ZILINA_STATION = { lat: 49.226972, lng: 18.746944 };

  // Slovakia approximate bounds: 48.0-49.5°N, 16.8-22.6°E
  // Create a simple rectangular outline
  const points: SlovakiaOutlinePoint[] = [
    { lat: 48.0, lng: 16.8 }, // SW
    { lat: 48.0, lng: 22.6 }, // SE
    { lat: 49.5, lng: 22.6 }, // NE
    { lat: 49.5, lng: 16.8 }, // NW
    { lat: 48.0, lng: 16.8 }, // Close polygon
  ];

  return {
    points,
    bounds: {
      minLat: 48.0,
      maxLat: 49.5,
      minLng: 16.8,
      maxLng: 22.6,
    },
  };
}

