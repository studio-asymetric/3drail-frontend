/**
 * GTFS Data Analyzer
 * 
 * Analyzes the GTFS files in public/gtfs and explores how to map
 * live train data from mapa.zsr.sk to GTFS routes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GTFS_DIR = path.join(__dirname, '../public/gtfs');

function readCsvFile(filename) {
  const filePath = path.join(GTFS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return null;
  
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    // Simple CSV parsing (handles quoted fields)
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
        inQuotes = !inQuotes;
        continue;
      }
      if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    result.push(current.trim());
    
    return result;
  });
  
  return { headers, rows };
}

function analyzeFile(filename, description) {
  console.log(`\n📄 ${filename} - ${description}`);
  console.log('─'.repeat(60));
  
  const data = readCsvFile(filename);
  if (!data) {
    console.log(`  ✗ File not found or empty`);
    return null;
  }
  
  console.log(`  Columns: ${data.headers.length}`);
  console.log(`  Rows: ${data.rows.length}`);
  console.log(`  Headers: ${data.headers.join(', ')}`);
  
  // Show sample rows
  if (data.rows.length > 0) {
    console.log(`\n  Sample data (first 3 rows):`);
    data.rows.slice(0, 3).forEach((row, idx) => {
      const preview = row.slice(0, 5).map((cell, i) => 
        `${data.headers[i]}: ${cell.substring(0, 30)}`
      ).join(' | ');
      console.log(`    Row ${idx + 1}: ${preview}${row.length > 5 ? '...' : ''}`);
    });
  }
  
  return data;
}

function analyzeGTFS() {
  console.log('🔍 Analyzing GTFS Dataset');
  console.log('═'.repeat(60));
  console.log(`Directory: ${GTFS_DIR}\n`);
  
  // Analyze each GTFS file
  const agency = analyzeFile('agency.txt', 'Transit agencies');
  const routes = analyzeFile('routes.txt', 'Transit routes');
  const trips = analyzeFile('trips.txt', 'Train trips');
  const stops = analyzeFile('stops.txt', 'Station stops');
  const stopTimes = analyzeFile('stop_times.txt', 'Stop arrival/departure times');
  const shapes = analyzeFile('shapes.txt', 'Route shape coordinates');
  const calendar = analyzeFile('calendar.txt', 'Service calendar');
  const calendarDates = analyzeFile('calendar_dates.txt', 'Service date exceptions');
  const feedInfo = analyzeFile('feed_info.txt', 'Feed metadata');
  
  // Key insights
  console.log('\n\n📊 Key Insights for 3D Map');
  console.log('═'.repeat(60));
  
  if (shapes) {
    // Analyze shapes
    const shapeIds = new Set();
    shapes.rows.forEach(row => {
      const shapeIdIdx = shapes.headers.indexOf('shape_id');
      if (shapeIdIdx >= 0) {
        shapeIds.add(row[shapeIdIdx]);
      }
    });
    console.log(`\n  • Unique route shapes: ${shapeIds.size}`);
    
    // Count coordinates per shape
    const shapePointCounts = {};
    shapes.rows.forEach(row => {
      const shapeIdIdx = shapes.headers.indexOf('shape_id');
      if (shapeIdIdx >= 0) {
        const shapeId = row[shapeIdIdx];
        shapePointCounts[shapeId] = (shapePointCounts[shapeId] || 0) + 1;
      }
    });
    const avgPoints = Object.values(shapePointCounts).reduce((a, b) => a + b, 0) / Object.keys(shapePointCounts).length;
    console.log(`  • Average coordinates per shape: ${avgPoints.toFixed(1)}`);
  }
  
  if (stops) {
    console.log(`\n  • Total stations/stops: ${stops.rows.length}`);
    
    // Check for UIC codes
    const uicIdx = stops.headers.indexOf('stop_code');
    if (uicIdx >= 0) {
      const stopsWithCode = stops.rows.filter(row => row[uicIdx] && row[uicIdx].trim()).length;
      console.log(`  • Stops with codes: ${stopsWithCode}`);
    }
  }
  
  if (trips) {
    console.log(`\n  • Total trips: ${trips.rows.length}`);
    
    // Check for train numbers
    const shortNameIdx = trips.headers.indexOf('trip_short_name');
    if (shortNameIdx >= 0) {
      const tripsWithNumber = trips.rows.filter(row => row[shortNameIdx] && row[shortNameIdx].trim()).length;
      console.log(`  • Trips with train numbers: ${tripsWithNumber}`);
      
      // Sample train numbers
      const sampleNumbers = trips.rows
        .filter(row => row[shortNameIdx] && row[shortNameIdx].trim())
        .slice(0, 10)
        .map(row => row[shortNameIdx]);
      console.log(`  • Sample train numbers: ${sampleNumbers.join(', ')}`);
    }
  }
  
  if (routes) {
    console.log(`\n  • Total routes: ${routes.rows.length}`);
    
    // Route types
    const routeTypeIdx = routes.headers.indexOf('route_type');
    if (routeTypeIdx >= 0) {
      const routeTypes = {};
      routes.rows.forEach(row => {
        const type = row[routeTypeIdx] || 'unknown';
        routeTypes[type] = (routeTypes[type] || 0) + 1;
      });
      console.log(`  • Route types: ${JSON.stringify(routeTypes)}`);
    }
  }
  
  // Mapping strategy
  console.log('\n\n🗺️  Mapping Strategy: mapa.zsr.sk → GTFS');
  console.log('═'.repeat(60));
  console.log(`
  To map live train data from mapa.zsr.sk to GTFS routes:
  
  1. Train Number Matching:
     • mapa.zsr.sk provides: CisloVlaku (train number)
     • GTFS provides: trip_short_name in trips.txt
     • Match: CisloVlaku === trip_short_name
  
  2. Route Matching:
     • mapa.zsr.sk provides: Trasa (route coordinates array)
     • GTFS provides: shapes.txt with shape_id → trips.txt with shape_id
     • Strategy: Find closest matching shape by comparing coordinates
  
  3. Station Matching:
     • mapa.zsr.sk provides: InfoZoStanice, NextStation (station names)
     • GTFS provides: stops.txt with stop_name
     • Match: Fuzzy match station names
  
  4. Delay Application:
     • mapa.zsr.sk provides: Meska (delay in minutes)
     • GTFS provides: stop_times.txt with arrival_time, departure_time
     • Apply: Add delay to scheduled times for visualization
  `);
  
  // Save summary
  const summary = {
    files: {
      agency: agency?.rows.length || 0,
      routes: routes?.rows.length || 0,
      trips: trips?.rows.length || 0,
      stops: stops?.rows.length || 0,
      stopTimes: stopTimes?.rows.length || 0,
      shapes: shapes?.rows.length || 0,
      calendar: calendar?.rows.length || 0,
      calendarDates: calendarDates?.rows.length || 0,
    },
    headers: {
      agency: agency?.headers || [],
      routes: routes?.headers || [],
      trips: trips?.headers || [],
      stops: stops?.headers || [],
      stopTimes: stopTimes?.headers || [],
      shapes: shapes?.headers || [],
    }
  };
  
  const summaryPath = path.join(__dirname, '../data/gtfs-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n💾 Summary saved to: ${summaryPath}`);
}

try {
  analyzeGTFS();
} catch (error) {
  console.error('Error:', error);
  process.exit(1);
}

