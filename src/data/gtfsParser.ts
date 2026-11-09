export interface Coordinate {
  lat: number;
  lng: number;
  sequence: number;
}

export interface GtfsShape {
  shapeId: string;
  points: Coordinate[];
}

export interface GtfsTrip {
  tripId: string;
  routeId?: string;
  shapeId?: string;
  serviceId?: string;
  headsign?: string;
  trainNumber?: string;
}

export interface GtfsStop {
  stopId: string;
  name: string;
  code?: string;
  lat: number;
  lng: number;
  uicCode?: string;
}

export interface GtfsStopTime {
  tripId: string;
  stopId: string;
  stopSequence: number;
  arrivalTimeMs?: number;
  departureTimeMs?: number;
}

export interface GtfsDataset {
  shapes: Record<string, GtfsShape>;
  trips: {
    byTripId: Record<string, GtfsTrip>;
    byTrainNumber: Record<string, GtfsTrip>;
  };
  stops: Record<string, GtfsStop>;
  stopTimes: Record<string, GtfsStopTime[]>;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) =>
    cell.trim().replace(/^"(.*)"$/, (_, group) => group.replace(/""/g, '"'))
  );
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => splitCsvLine(line));
  return { headers, rows };
}

function safeIndex(headers: string[], key: string): number {
  const index = headers.findIndex(
    (header) => header.toLowerCase() === key.toLowerCase()
  );
  if (index === -1) {
    throw new Error(`Expected column "${key}" not found in GTFS file`);
  }
  return index;
}

function parseTimeToMs(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [hours = '0', minutes = '0', seconds = '0'] = value.split(':');
  return (
    (parseInt(hours, 10) * 3600 +
      parseInt(minutes, 10) * 60 +
      parseInt(seconds, 10)) *
    1000
  );
}

export function parseGtfsShapes(csvText: string): Record<string, GtfsShape> {
  const { headers, rows } = parseCsv(csvText);
  const shapeIdIdx = safeIndex(headers, 'shape_id');
  const latIdx = safeIndex(headers, 'shape_pt_lat');
  const lonIdx = safeIndex(headers, 'shape_pt_lon');
  const sequenceIdx = safeIndex(headers, 'shape_pt_sequence');

  const shapes: Record<string, GtfsShape> = {};
  rows.forEach((row) => {
    const shapeId = row[shapeIdIdx];
    const lat = parseFloat(row[latIdx]);
    const lng = parseFloat(row[lonIdx]);
    const sequence = parseInt(row[sequenceIdx], 10);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return;
    }
    if (!shapes[shapeId]) {
      shapes[shapeId] = { shapeId, points: [] };
    }
    shapes[shapeId].points.push({ lat, lng, sequence });
  });

  Object.values(shapes).forEach((shape) => {
    shape.points.sort((a, b) => a.sequence - b.sequence);
  });
  return shapes;
}

export function parseGtfsTrips(csvText: string): {
  byTripId: Record<string, GtfsTrip>;
  byTrainNumber: Record<string, GtfsTrip>;
} {
  const { headers, rows } = parseCsv(csvText);
  const tripIdIdx = safeIndex(headers, 'trip_id');
  const routeIdIdx = headers.indexOf('route_id');
  const shapeIdIdx = headers.indexOf('shape_id');
  const serviceIdIdx = headers.indexOf('service_id');
  const headsignIdx = headers.indexOf('trip_headsign');
  const shortNameIdx = headers.indexOf('trip_short_name');

  const byTripId: Record<string, GtfsTrip> = {};
  const byTrainNumber: Record<string, GtfsTrip> = {};

  rows.forEach((row) => {
    const tripId = row[tripIdIdx];
    const shortName = shortNameIdx >= 0 ? row[shortNameIdx] : undefined;
    
    // Extract train number from trip_short_name (e.g., "EC 121" -> "121", "IC 114" -> "114")
    let trainNumber: string | undefined = undefined;
    if (shortName && shortName.trim()) {
      const numbers = shortName.match(/\d+/g);
      if (numbers && numbers.length > 0) {
        trainNumber = numbers[0]; // Take the first number as train number
      }
    }
    
    const trip: GtfsTrip = {
      tripId,
      routeId: routeIdIdx >= 0 ? row[routeIdIdx] : undefined,
      shapeId: shapeIdIdx >= 0 ? row[shapeIdIdx] : undefined,
      serviceId: serviceIdIdx >= 0 ? row[serviceIdIdx] : undefined,
      headsign: headsignIdx >= 0 ? row[headsignIdx] : undefined,
      trainNumber: trainNumber || shortName, // Fallback to full shortName if no number found
    };
    byTripId[tripId] = trip;
    if (trainNumber) {
      // Index by extracted train number
      byTrainNumber[trainNumber] = trip;
    }
    if (shortName && shortName !== trainNumber) {
      // Also index by full shortName for backwards compatibility
      byTrainNumber[shortName] = trip;
    }
  });

  return { byTripId, byTrainNumber };
}

export function parseGtfsStops(csvText: string): Record<string, GtfsStop> {
  const { headers, rows } = parseCsv(csvText);
  const stopIdIdx = safeIndex(headers, 'stop_id');
  const nameIdx = safeIndex(headers, 'stop_name');
  const latIdx = safeIndex(headers, 'stop_lat');
  const lonIdx = safeIndex(headers, 'stop_lon');
  const codeIdx = headers.indexOf('stop_code');
  const uicIdx = headers.indexOf('stop_uic_code');

  const stops: Record<string, GtfsStop> = {};
  rows.forEach((row) => {
    const stopId = row[stopIdIdx];
    const lat = parseFloat(row[latIdx]);
    const lng = parseFloat(row[lonIdx]);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return;
    }
    stops[stopId] = {
      stopId,
      name: row[nameIdx],
      code: codeIdx >= 0 ? row[codeIdx] : undefined,
      lat,
      lng,
      uicCode: uicIdx >= 0 ? row[uicIdx] : undefined,
    };
  });
  return stops;
}

export function parseGtfsStopTimes(
  csvText: string
): Record<string, GtfsStopTime[]> {
  const { headers, rows } = parseCsv(csvText);
  const tripIdIdx = safeIndex(headers, 'trip_id');
  const stopIdIdx = safeIndex(headers, 'stop_id');
  const stopSequenceIdx = safeIndex(headers, 'stop_sequence');
  const arrivalIdx = headers.indexOf('arrival_time');
  const departureIdx = headers.indexOf('departure_time');

  const stopTimes: Record<string, GtfsStopTime[]> = {};
  rows.forEach((row) => {
    const tripId = row[tripIdIdx];
    const stopTime: GtfsStopTime = {
      tripId,
      stopId: row[stopIdIdx],
      stopSequence: parseInt(row[stopSequenceIdx], 10),
      arrivalTimeMs: arrivalIdx >= 0 ? parseTimeToMs(row[arrivalIdx]) : undefined,
      departureTimeMs:
        departureIdx >= 0 ? parseTimeToMs(row[departureIdx]) : undefined,
    };
    if (!stopTimes[tripId]) {
      stopTimes[tripId] = [];
    }
    stopTimes[tripId].push(stopTime);
  });

  Object.values(stopTimes).forEach((list) => {
    list.sort((a, b) => a.stopSequence - b.stopSequence);
  });
  return stopTimes;
}

export function buildGtfsDataset(params: {
  shapesCsv: string;
  tripsCsv: string;
  stopsCsv: string;
  stopTimesCsv?: string;
}): GtfsDataset {
  const shapes = parseGtfsShapes(params.shapesCsv);
  const trips = parseGtfsTrips(params.tripsCsv);
  const stops = parseGtfsStops(params.stopsCsv);
  const stopTimes = params.stopTimesCsv
    ? parseGtfsStopTimes(params.stopTimesCsv)
    : {};
  return { shapes, trips, stops, stopTimes };
}

