# DEM to Terrain Tiles Conversion Guide

## Quick Start

Your HGT files are located in:
- `public/L33/L33/*.hgt`
- `public/L34/L34/*.hgt`
- `public/M33/M33/*.hgt`
- `public/M34/M34/*.hgt`

These are **standard SRTM HGT files** - perfectly usable! ✅

## Option 1: Python Script (Recommended - No GDAL Required)

### Step 1: Install Python Dependencies

```bash
pip install rasterio numpy pillow
```

### Step 2: Run Conversion

```bash
python scripts/convert_dem_simple.py
```

This will:
1. Find all HGT files in the L33, L34, M33, M34 folders
2. Merge them into a single GeoTIFF
3. Convert to terrain tiles
4. Save to `public/terrain/{z}/{x}/{y}.png`

## Option 2: GDAL Tools (Better Quality, More Tiles)

### Step 1: Install GDAL

**Windows:**
- Download OSGeo4W: https://trac.osgeo.org/osgeo4w/
- Or use conda: `conda install -c conda-forge gdal`

**Mac:**
```bash
brew install gdal
```

**Linux:**
```bash
sudo apt-get install gdal-bin python3-gdal
```

### Step 2: Install Python Tools

```bash
pip install rasterio rio-rgbify
```

### Step 3: Run Conversion

```bash
python scripts/convert_dem_to_tiles.py
```

## Option 3: Node.js Wrapper

```bash
node scripts/convert_dem_to_tiles.js
```

This will automatically detect Python and run the appropriate script.

## Output

Tiles will be saved to: `public/terrain/{z}/{x}/{y}.png`

Where:
- `z` = zoom level (8-14)
- `x` = tile X coordinate
- `y` = tile Y coordinate

## Troubleshooting

### "Python not found"
- Install Python 3 from https://www.python.org/
- Make sure Python is in your PATH

### "rasterio not found"
```bash
pip install rasterio numpy pillow
```

### "GDAL not found"
- Install GDAL (see Option 2 above)
- Or use the simple script (Option 1) which doesn't require GDAL

### "No HGT files found"
- Check that files are in: `public/{L33,L34,M33,M34}/{L33,L34,M33,M34}/*.hgt`
- The script expects nested folders (L33/L33/, etc.)

## File Coverage

Your HGT files cover Slovakia:
- **M33**: N48E012-N48E017, N49E012-N49E017 (covers western Slovakia)
- **M34**: N48E018-N48E023, N49E018-N49E023 (covers eastern Slovakia)
- **L33/L34**: Additional coverage (southern areas)

This covers the entire Slovak railway network! ✅


