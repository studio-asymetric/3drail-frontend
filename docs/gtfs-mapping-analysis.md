# GTFS Data Mapping Analysis

## Summary

Successfully analyzed the Slovak Railway GTFS dataset and mapped it to live train data from mapa.zsr.sk.

## GTFS Dataset Overview

**Location:** `public/gtfs/`

**Files:**
- `agency.txt` - 1 agency (Železničná spoločnosť Slovensko)
- `routes.txt` - 360 routes
- `trips.txt` - 2,608 trips
- `stops.txt` - 925 stations/stops
- `stop_times.txt` - 35,117 stop times
- `shapes.txt` - 48,462 shape points (2,608 unique route shapes)
- `calendar_dates.txt` - 173,882 service date exceptions
- `feed_info.txt` - Feed metadata (valid from 2025-04-08 to 2025-12-13)

## Live Train Data (mapa.zsr.sk)

**Source:** `mapa.zsr.sk/api/action.html` (mirror at `mapa.zsr.sk/mapa.zsr.sk/api/action.html`)

**Format:** JSON array of train objects

**Key Fields:**
- `CisloVlaku` - Train number (e.g., "44", "121")
- `NazovVlaku` - Train name (e.g., "TATRAN", "VALAŠSKÝ EXPRES")
- `TypVlaku` - Train type (e.g., "Ex", "EC", "IC")
- `Meska` - Delay in minutes
- `MeskaColor` - Delay color ("green", "orange", "red")
- `Position` - Current position [lat, lng]
- `Trasa` - Route segments with coordinates
- `InfoZoStanice` - Current station name
- `NextStation` - Next station code

## Mapping Results

**Success Rate:** 80% (103 out of 129 trains mapped)

**Statistics:**
- ✅ Trains with live route: 103
- ✅ Trains with GTFS route: 103
- ✅ Trains with both: 103
- ❌ Unmapped trains: 26

## Mapping Strategy

### 1. Train Number Matching
- **mapa.zsr.sk:** `CisloVlaku` (e.g., "44", "121")
- **GTFS:** Extract number from `trip_short_name` (e.g., "EC 121" → "121")
- **Match:** Direct number comparison

### 2. Route Data Priority
1. **Primary:** Use live route from `Trasa` (more accurate, real-time)
2. **Fallback:** Use GTFS `shapes.txt` route if live route unavailable

### 3. Station Matching
- **mapa.zsr.sk:** `InfoZoStanice` (station name)
- **GTFS:** `stops.txt` with `stop_name`
- **Method:** Normalized name matching (lowercase, remove diacritics)

## Implementation Notes

### CSV Parsing
GTFS files use standard CSV format with quoted fields. The parser handles:
- Quoted fields with commas
- Escaped quotes (`""`)
- Empty fields

### Train Number Extraction
GTFS `trip_short_name` format examples:
- `"IC 114 Cracovia /131"` → train number `"114"`
- `"EC 121 Valašský expres"` → train number `"121"`
- `"44"` → train number `"44"`

Extraction uses regex `/\d+/g` to find the first number sequence.

### Route Coordinate Format

**Live Route (mapa.zsr.sk):**
```json
"Trasa": [
  {
    "Key": "30",
    "Value": [[lat, lng], [lat, lng], ...]
  },
  ...
]
```

**GTFS Route:**
```csv
shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
114,49.78359,22.77641,1
114,49.79295,22.77280,2
...
```

## Unmapped Trains

26 trains could not be mapped, likely because:
1. Train numbers don't exist in GTFS dataset
2. Train numbers are formatted differently
3. Trains are new/seasonal and not in static GTFS

## Next Steps

1. ✅ **GTFS Data Loaded** - All files parsed and indexed
2. ✅ **Live Data Fetched** - Train data from mapa.zsr.sk loaded
3. ✅ **Mapping Implemented** - 80% success rate
4. 🔄 **Integration** - Update `trainService.ts` to use GTFS + live data
5. 🔄 **3D Visualization** - Use mapped routes for 3D track rendering
6. 🔄 **Real-time Updates** - Poll mapa.zsr.sk and update positions

## Files Created

- `scripts/analyze-gtfs-data.mjs` - GTFS data analyzer
- `scripts/map-trains-to-gtfs.mjs` - Mapping script
- `data/gtfs-summary.json` - GTFS dataset summary
- `data/mapped-trains.json` - Mapping results

## Usage

```bash
# Analyze GTFS data
node scripts/analyze-gtfs-data.mjs

# Map live trains to GTFS routes
node scripts/map-trains-to-gtfs.mjs
```


