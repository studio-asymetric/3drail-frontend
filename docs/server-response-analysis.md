# Server Response Analysis

## Overview
The server response from `/gtfs/train-data.json` (static fallback) contains an array of **129 active trains** with comprehensive real-time information.

## Response Structure
The response is a JSON array where each element represents one active train:

```json
[
  {
    // Train data fields...
  },
  // ... 128 more trains
]
```

## Data Fields Available

### Train Identification
- **`CisloVlaku`** (string): Train number (e.g., "44")
- **`NazovVlaku`** (string): Train name (e.g., "TATRAN")
- **`Nazov`** (string): Full train name with type (e.g., "Ex 44 TATRAN")
- **`TypVlaku`** (string): Train type (e.g., "Ex", "R", "Os", etc.)
- **`Popis`** (string): Route description with times (e.g., "(08.01.2026 08:07) Košice -> Bratislava hlavná stanica (08.01.2026 13:27)")

### Station Information
- **`StanicaZCislo`** (string): UIC code of origin station (e.g., "13600200")
- **`StanicaDoCislo`** (string): UIC code of destination station (e.g., "13206800")
- **`InfoZoStanice`** (string): Current station name (e.g., "Poprad-Tatry")
- **`NextStation`** (string): UIC code of next station (e.g., "13230800")
- **`OrderCurrentStation`** (number): Order/index of current station in route (e.g., 34)
- **`OrderInStation`** (number): Order/position within current station

### Delay Information
- **`Meska`** (number): Delay in minutes (e.g., 7)
- **`MeskaSkutocne`** (number): Actual delay (may differ from Meska)
- **`MeskaSkutocneZoStanice`** (number | null): Actual delay from specific station
- **`MeskaColor`** (string): Color indicator for delay ("orange", "red", "green", etc.)
- **`MeskaText`** (string): Delay description in Slovak (e.g., "V\nstanici Poprad-Tatry meškal 7 minút")
- **`MeskaTextEn`** (string): Delay description in English (e.g., "At station Poprad-Tatry was 7 min late")
- **`MeskaTextColor`** (string): Color code for delay text (e.g., "#ff0000")

### Time Information
- **`Cas`** (string): Actual/current time (e.g., "08.01.2026 09:42")
- **`CasPlan`** (string): Planned/scheduled time (e.g., "08.01.2026 09:35")

### Location Data
- **`Position`** (array): Current position `[lat, lng]` (e.g., `[49.06002, 20.29486]`)
- **`PositionNext`** (array | null): Next position `[lat, lng]` or null
- **`Angle`** (number): Train heading angle in degrees (e.g., -85)
- **`Trasa`** (array): Route segments array - **KEY DATA STRUCTURE**

### Route Data (`Trasa`)
The `Trasa` field contains an array of route segments, each with:
- **`Key`** (string): Segment identifier (e.g., "30", "50", "10")
- **`Value`** (array): Array of coordinate pairs `[[lat, lng], [lat, lng], ...]`

Example structure:
```json
"Trasa": [
  {
    "Key": "30",
    "Value": [
      [48.72291, 21.26872],
      [48.75592, 21.25324],
      // ... more coordinates
    ]
  },
  {
    "Key": "50",
    "Value": [
      [49.06002, 20.29486],
      // ... more coordinates
    ]
  }
]
```

**Key Observations:**
- Each segment represents a portion of the route (possibly different track sections)
- Segments are connected (end of one segment = start of next)
- Total route points can be substantial (e.g., 151 points across 3 segments)
- Coordinates are in `[latitude, longitude]` format

### Additional Fields
- **`Dopravca`** (string): Operator/company name (e.g., "Železničná spoločnosť Slovensko, a.s.")
- **`Poznamka`** (string): Notes/comments (usually empty)
- **`PoznamkaLangKey`** (string): Language key for notes
- **`NadOd`**, **`NadDo`**, **`BNadOd`**, **`BNadDo`** (null): Additional station/route identifiers (typically null)
- **`Narusenie`** (boolean): Indicates disruption/interruption
- **`NarusenieKod`** (number): Disruption code (0 = no disruption)
- **`PotvrdenyOdj`** (boolean): Confirmed departure status
- **`TrasaBody`** (null): Additional route body data (typically null)

## Comparison with Current Implementation

### Current `MapaZsrTrain` Interface
The current interface in `trainService.ts` matches most fields but is missing some:

**Currently mapped:**
- ✅ `CisloVlaku` → `train.number`
- ✅ `NazovVlaku` → `train.name`
- ✅ `TypVlaku` → `train.type`
- ✅ `Position` → `position`
- ✅ `Trasa` → `route` (flattened)
- ✅ `Meska` → `trainDelay.delayMinutes`
- ✅ `InfoZoStanice` → `trainDelay.currentName`
- ✅ `NextStation` → `trainDelay.nextStationName`

**Missing/Not fully utilized:**
- ❌ `MeskaSkutocne` - Actual delay (more accurate than `Meska`)
- ❌ `MeskaColor` - Pre-calculated delay color
- ❌ `MeskaText` / `MeskaTextEn` - Human-readable delay descriptions
- ❌ `Cas` / `CasPlan` - Time information
- ❌ `Angle` - Train heading/direction
- ❌ `OrderCurrentStation` - Station order in route
- ❌ `PositionNext` - Next position prediction
- ❌ `Narusenie` / `NarusenieKod` - Disruption information
- ❌ `PotvrdenyOdj` - Departure confirmation status
- ❌ `Dopravca` - Operator information

## Recommendations

### 1. Enhanced Delay Information
The response provides more detailed delay information than currently used:
- Use `MeskaSkutocne` for more accurate delay calculations
- Use `MeskaColor` directly instead of calculating from delay minutes
- Display `MeskaText` or `MeskaTextEn` for user-friendly delay messages

### 2. Route Segments
The `Trasa` segments with `Key` values might represent:
- Different track sections/railway lines
- Different speed zones
- Different route segments

Consider preserving segment information instead of flattening, as it might be useful for:
- Visualizing different route sections
- Understanding route structure
- Potential optimization/rendering improvements

### 3. Time Information
The `Cas` and `CasPlan` fields provide actual vs planned times, which could be used for:
- More accurate progress calculations
- Displaying schedule adherence
- Better time-based predictions

### 4. Train Direction
The `Angle` field provides train heading, which could be used for:
- Rotating train icons/models in the correct direction
- Better visual representation
- Direction-based filtering/display

### 5. Station Order
The `OrderCurrentStation` field indicates position in route, useful for:
- Progress calculations
- Understanding route structure
- Displaying "Train X of Y stations" information

## Data Quality Notes

1. **Encoding Issues**: Some text fields show encoding problems (e.g., "Ko��ice" instead of "Košice") - may need UTF-8 handling
2. **Null Values**: Many fields can be null, requiring proper null checks
3. **Route Segments**: Segments are connected sequentially (end of one = start of next)
4. **Position Accuracy**: `Position` appears to be real-time GPS/tracking data
5. **Delay Calculation**: `MeskaSkutocne` might be more accurate than `Meska` for actual delays

## Summary

The server response provides **comprehensive real-time train data** including:
- ✅ Train identification and metadata
- ✅ Current position and heading
- ✅ Detailed route information (segmented)
- ✅ Delay information with multiple representations
- ✅ Station information and progress
- ✅ Time information (actual vs planned)
- ✅ Disruption/status information

The current implementation uses most of the core fields but could benefit from utilizing additional fields for enhanced functionality and accuracy.







