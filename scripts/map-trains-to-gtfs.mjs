/**
 * Train Mapping Script
 * 
 * Maps live train data from mapa.zsr.sk to GTFS routes
 * and creates a unified data structure for the 3D map.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GTFS_DIR = path.join(__dirname, '../public/gtfs');
const MIRROR_DIR = path.join(__dirname, '../../mapa.zsr.sk/mapa.zsr.sk/api');

// Load GTFS data
function loadGTFS() {
  console.log('📦 Loading GTFS data...\n');
  
  const trips = readCsvFile('trips.txt');
  const stops = readCsvFile('stops.txt');
  const shapes = readCsvFile('shapes.txt');
  const stopTimes = readCsvFile('stop_times.txt');
  
  // Build lookup structures
  const tripsByTrainNumber = {};
  const shapesById = {};
  const stopsById = {};
  const stopsByName = {};
  
  // Index trips by train number (extract number from trip_short_name like "EC 121" -> "121")
  if (trips) {
    const shortNameIdx = trips.headers.indexOf('trip_short_name');
    const shapeIdIdx = trips.headers.indexOf('shape_id');
    const tripIdIdx = trips.headers.indexOf('trip_id');
    
    trips.rows.forEach(row => {
      const shortName = row[shortNameIdx];
      if (shortName && shortName.trim()) {
        // Extract train number (e.g., "EC 121" -> "121", "IC 114" -> "114", "44" -> "44")
        // Try to find the main train number (usually the last number in the string)
        const numbers = shortName.match(/\d+/g);
        if (numbers && numbers.length > 0) {
          // Take the first significant number (usually the train number)
          const trainNumber = numbers[0];
          tripsByTrainNumber[trainNumber] = {
            tripId: row[tripIdIdx],
            shapeId: row[shapeIdIdx],
            shortName: shortName.trim(),
            routeId: row[trips.headers.indexOf('route_id')],
          };
        }
      }
    });
    
    console.log(`  ✓ Loaded ${Object.keys(tripsByTrainNumber).length} trips indexed by train number`);
    if (Object.keys(tripsByTrainNumber).length > 0) {
      const sampleKeys = Object.keys(tripsByTrainNumber).slice(0, 5);
      console.log(`  Sample train numbers: ${sampleKeys.join(', ')}`);
    }
  }
  
  // Index shapes
  if (shapes) {
    const shapeIdIdx = shapes.headers.indexOf('shape_id');
    const latIdx = shapes.headers.indexOf('shape_pt_lat');
    const lonIdx = shapes.headers.indexOf('shape_pt_lon');
    const seqIdx = shapes.headers.indexOf('shape_pt_sequence');
    
    shapes.rows.forEach(row => {
      const shapeId = row[shapeIdIdx];
      if (!shapesById[shapeId]) {
        shapesById[shapeId] = [];
      }
      shapesById[shapeId].push({
        lat: parseFloat(row[latIdx]),
        lng: parseFloat(row[lonIdx]),
        sequence: parseInt(row[seqIdx], 10),
      });
    });
    
    // Sort by sequence
    Object.keys(shapesById).forEach(shapeId => {
      shapesById[shapeId].sort((a, b) => a.sequence - b.sequence);
    });
    
    console.log(`  ✓ Loaded ${Object.keys(shapesById).length} route shapes`);
  }
  
  // Index stops
  if (stops) {
    const stopIdIdx = stops.headers.indexOf('stop_id');
    const nameIdx = stops.headers.indexOf('stop_name');
    const latIdx = stops.headers.indexOf('stop_lat');
    const lonIdx = stops.headers.indexOf('stop_lon');
    
    stops.rows.forEach(row => {
      const stopId = row[stopIdIdx];
      const name = row[nameIdx];
      stopsById[stopId] = {
        stopId,
        name,
        lat: parseFloat(row[latIdx]),
        lng: parseFloat(row[lonIdx]),
      };
      
      // Also index by name (normalized)
      if (name) {
        const normalizedName = normalizeStationName(name);
        if (!stopsByName[normalizedName]) {
          stopsByName[normalizedName] = [];
        }
        stopsByName[normalizedName].push(stopsById[stopId]);
      }
    });
    
    console.log(`  ✓ Loaded ${Object.keys(stopsById).length} stops`);
  }
  
  return {
    tripsByTrainNumber,
    shapesById,
    stopsById,
    stopsByName,
  };
}

function normalizeStationName(name) {
  if (!name || typeof name !== 'string') {
    return '';
  }
  // Normalize station names for fuzzy matching
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .trim();
}

function readCsvFile(filename) {
  const filePath = path.join(GTFS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return null;
  
  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = i < line.length - 1 ? line[i + 1] : null;
      
      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current); // Add last field
    
    return result;
  }
  
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(line => parseCSVLine(line));
  
  return { headers, rows };
}

// Load live train data from mapa.zsr.sk
function loadLiveTrainData() {
  console.log('\n🚂 Loading live train data from mapa.zsr.sk...\n');
  
  const actionPath = path.join(MIRROR_DIR, 'action.html');
  if (!fs.existsSync(actionPath)) {
    console.log('  ✗ action.html not found in mirror directory');
    return [];
  }
  
  let content = fs.readFileSync(actionPath, 'utf-8');
  
  // Fix common JSON issues (control characters, etc.)
  content = content
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
    .trim();
  
  let trains;
  
  try {
    trains = JSON.parse(content);
  } catch (e) {
    console.log('  ✗ Failed to parse JSON:', e.message);
    console.log('  First 500 chars:', content.substring(0, 500));
    return [];
  }
  
  console.log(`  ✓ Loaded ${trains.length} live trains`);
  return trains;
}

// Map live train to GTFS route (always returns a result, even without GTFS match)
function mapTrainToGTFS(liveTrain, gtfsData) {
  const trainNumber = liveTrain.CisloVlaku;
  const gtfsTrip = gtfsData.tripsByTrainNumber[trainNumber];
  
  // Get GTFS shape (route coordinates) - prefer GTFS for tracks since they don't change
  let gtfsRoute = null;
  if (gtfsTrip && gtfsTrip.shapeId && gtfsData.shapesById[gtfsTrip.shapeId]) {
    gtfsRoute = gtfsData.shapesById[gtfsTrip.shapeId].map(pt => ({
      lat: pt.lat,
      lng: pt.lng,
    }));
  }
  
  // Get live route from mapa.zsr.sk (flatten Trasa segments)
  let liveRoute = [];
  if (liveTrain.Trasa && Array.isArray(liveTrain.Trasa)) {
    liveTrain.Trasa.forEach(segment => {
      if (segment.Value && Array.isArray(segment.Value)) {
        segment.Value.forEach(coord => {
          liveRoute.push({
            lat: coord[0],
            lng: coord[1],
          });
        });
      }
    });
  }
  
  // Strategy: Use GTFS route for tracks (static, doesn't change year to year)
  // Fallback to live route if GTFS not available
  // Live route is more detailed but GTFS is more stable for track rendering
  const finalRoute = gtfsRoute && gtfsRoute.length > 0 ? gtfsRoute : liveRoute;
  
  // Find matching station
  let currentStation = null;
  if (liveTrain.InfoZoStanice) {
    const normalizedName = normalizeStationName(liveTrain.InfoZoStanice);
    const matches = gtfsData.stopsByName[normalizedName] || [];
    if (matches.length > 0) {
      currentStation = matches[0]; // Take first match
    }
  }
  
  return {
    // Live data (always available)
    trainNumber: trainNumber,
    trainName: liveTrain.NazovVlaku,
    trainType: liveTrain.TypVlaku,
    delay: liveTrain.Meska || 0,
    delayColor: liveTrain.MeskaColor || 'green',
    currentPosition: liveTrain.Position ? {
      lat: liveTrain.Position[0],
      lng: liveTrain.Position[1],
    } : null,
    currentStation: liveTrain.InfoZoStanice,
    nextStation: liveTrain.NextStation,
    
    // GTFS data (may be null if train not in GTFS)
    gtfsTripId: gtfsTrip?.tripId || null,
    gtfsShapeId: gtfsTrip?.shapeId || null,
    gtfsRoute: gtfsRoute,
    
    // Combined route (prefer GTFS for tracks, fallback to live)
    route: finalRoute,
    matchedStation: currentStation,
    
    // Metadata
    hasLiveRoute: liveRoute.length > 0,
    hasGtfsRoute: gtfsRoute !== null && gtfsRoute.length > 0,
    hasGtfsMatch: gtfsTrip !== undefined,
  };
}

// Main analysis
function analyzeMapping() {
  console.log('🗺️  Mapping Live Trains to GTFS Routes');
  console.log('═'.repeat(60));
  
  const gtfsData = loadGTFS();
  const liveTrains = loadLiveTrainData();
  
  console.log('\n🔗 Mapping trains...\n');
  
  // Map ALL trains (even without GTFS match, we still have live route data)
  const mapped = liveTrains.map(train => mapTrainToGTFS(train, gtfsData));
  
  const withGtfsMatch = mapped.filter(t => t.hasGtfsMatch).length;
  const withoutGtfsMatch = mapped.filter(t => !t.hasGtfsMatch).length;
  
  console.log(`  ✓ Processed ALL ${mapped.length} trains`);
  console.log(`  • Trains with GTFS match: ${withGtfsMatch}`);
  console.log(`  • Trains without GTFS match: ${withoutGtfsMatch} (using live route data)`);
  
  if (withoutGtfsMatch > 0 && withoutGtfsMatch <= 20) {
    console.log('\n  Trains without GTFS match (using live route):');
    mapped.filter(t => !t.hasGtfsMatch).slice(0, 20).forEach(t => {
      console.log(`    - ${t.trainNumber} ${t.trainName}`);
    });
  }
  
  // Statistics
  const withLiveRoute = mapped.filter(t => t.hasLiveRoute).length;
  const withGtfsRoute = mapped.filter(t => t.hasGtfsRoute).length;
  const withBoth = mapped.filter(t => t.hasLiveRoute && t.hasGtfsRoute).length;
  const withAnyRoute = mapped.filter(t => t.route && t.route.length > 0).length;
  
  console.log('\n📊 Route Data Statistics:');
  console.log(`  • Trains with live route data: ${withLiveRoute}`);
  console.log(`  • Trains with GTFS route (for tracks): ${withGtfsRoute}`);
  console.log(`  • Trains with both: ${withBoth}`);
  console.log(`  • Trains with any route data: ${withAnyRoute}`);
  
  // Save results
  const outputDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const outputPath = path.join(outputDir, 'mapped-trains.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    mapped,
    stats: {
      total: liveTrains.length,
      withGtfsMatch,
      withoutGtfsMatch,
      withLiveRoute,
      withGtfsRoute,
      withBoth,
      withAnyRoute,
    },
  }, null, 2));
  
  console.log(`\n💾 Results saved to: ${outputPath}`);
  
  // Sample output
  if (mapped.length > 0) {
    console.log('\n📋 Sample mapped train:');
    const sample = mapped[0];
    console.log(`  Train: ${sample.trainNumber} ${sample.trainName}`);
    console.log(`  Delay: ${sample.delay} minutes (${sample.delayColor})`);
    console.log(`  Route points: ${sample.route?.length || 0}`);
    console.log(`  Current station: ${sample.currentStation || 'unknown'}`);
    console.log(`  Has live route: ${sample.hasLiveRoute}`);
    console.log(`  Has GTFS route: ${sample.hasGtfsRoute}`);
  }
}

try {
  analyzeMapping();
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}

