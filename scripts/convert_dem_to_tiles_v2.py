#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SRTM HGT to Terrain Tiles Converter v2
Generates 5 zoom levels optimized for camera heights 0.1 to 500 units

Requirements:
    pip install rasterio numpy pillow

This creates Terrarium-format tiles for 5 zoom levels:
- Z0: 500+ units camera height (overview)
- Z1: 200-500 units (medium overview)
- Z2: 50-200 units (default, sharp at 500 units)
- Z3: 5-50 units (close-up)
- Z4: 0.1-5 units (train level, sharp at 0.1 units)
"""

import os
import sys
import math
from pathlib import Path
import numpy as np
from PIL import Image
import rasterio
from rasterio.merge import merge
from rasterio.warp import reproject, Resampling
from rasterio.crs import CRS
from rasterio.coords import BoundingBox
from rasterio.transform import from_bounds
from rasterio.enums import Resampling as RasterioResampling

# Fix Windows console encoding
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Slovakia bounds
SLOVAKIA_BOUNDS = {
    'min_lat': 48.0,
    'max_lat': 49.5,
    'min_lng': 16.8,
    'max_lng': 22.6
}

# Zoom level configurations
# Maps our custom zoom levels (Z0-Z4) to Web Mercator zoom levels
# Web Mercator zoom determines actual tile resolution
ZOOM_LEVELS = {
    0: {
        'web_mercator_zoom': 0,  # ~9,784 m/pixel, covers entire world
        'target_resolution': 500, 
        'description': 'Overview (500+ units)'
    },
    1: {
        'web_mercator_zoom': 3,  # ~1,223 m/pixel
        'target_resolution': 200, 
        'description': 'Medium overview (200-500 units)'
    },
    2: {
        'web_mercator_zoom': 6,  # ~153 m/pixel
        'target_resolution': 50, 
        'description': 'Default (50-200 units, sharp at 500)'
    },
    3: {
        'web_mercator_zoom': 9,  # ~19 m/pixel
        'target_resolution': 10, 
        'description': 'Close-up (5-50 units)'
    },
    4: {
        'web_mercator_zoom': 12,  # ~38 m/pixel (closest to 30m/pixel for heightmap)
        'target_resolution': 30,  # Updated to match heightmap resolution
        'description': 'Train level (0.1-5 units, sharp at 0.1)'
    }
}

def find_hgt_files(base_dir):
    """Find all HGT files"""
    hgt_files = []
    dem_folders = ['L33', 'L34', 'M33', 'M34']
    
    for folder in dem_folders:
        folder_path = Path(base_dir) / 'public' / folder / folder
        if folder_path.exists():
            files = list(folder_path.glob('*.hgt'))
            hgt_files.extend([str(f) for f in files])
            print(f"Found {len(files)} HGT files in {folder}/")
    
    return hgt_files

def merge_hgt_files(hgt_files, output_tif):
    """Merge HGT files using rasterio"""
    print(f"\nMerging {len(hgt_files)} HGT files...")
    
    src_files_to_mosaic = []
    for hgt_file in hgt_files:
        src = rasterio.open(hgt_file)
        src_files_to_mosaic.append(src)
    
    # Merge all files
    mosaic, out_trans = merge(src_files_to_mosaic)
    
    # Get metadata from first file
    out_meta = src_files_to_mosaic[0].meta.copy()
    out_meta.update({
        "driver": "GTiff",
        "height": mosaic.shape[1],
        "width": mosaic.shape[2],
        "transform": out_trans,
        "compress": "lzw"
    })
    
    # Write merged file
    with rasterio.open(output_tif, "w", **out_meta) as dest:
        dest.write(mosaic)
    
    # Close all source files
    for src in src_files_to_mosaic:
        src.close()
    
    print(f"✅ Merged GeoTIFF: {output_tif}")
    return True

def elevation_to_terrarium_rgb(elevation_array, nodata=-32768):
    """
    Convert elevation (meters) to Terrarium RGB encoding
    Formula: height = (R * 256 + G + B / 256) - 32768
    
    Reverse encoding:
    - height + 32768 = R * 256 + G + B / 256
    - Let h = height + 32768
    - R = floor(h / 256)
    - G = floor(h % 256)
    - B = floor((h - R*256 - G) * 256)
    """
    # Handle no-data values: set them to 0 (sea level) for encoding
    # No-data pixels will be encoded as (128, 0, 0) which decodes to 0m
    height_clean = elevation_array.copy().astype(np.float32)
    height_clean[height_clean == nodata] = 0  # Replace no-data with 0 (sea level)
    
    # Add offset
    height = height_clean + 32768
    
    # Clamp to valid range (0-65535)
    height = np.clip(height, 0, 65535)
    
    # Extract RGB components correctly
    # Terrarium: height = (R * 256 + G + B / 256) - 32768
    # So: height + 32768 = R * 256 + G + B / 256
    # Let h = height + 32768 (already done above)
    # R = floor(h / 256)
    # G = floor(h mod 256)
    # B = floor((h - R*256 - G) * 256) mod 256
    R = np.floor(height / 256).astype(np.uint8)
    G = np.floor(height % 256).astype(np.uint8)
    # B is the fractional part: floor((h - R*256 - G) * 256) mod 256
    fractional = (height - R.astype(np.float32) * 256 - G.astype(np.float32)) * 256
    B = np.floor(fractional % 256).astype(np.uint8)
    
    # Create RGBA image (alpha = 255 for valid data, 0 for no-data)
    alpha = np.where(elevation_array == nodata, 0, 255).astype(np.uint8)
    rgba = np.stack([R, G, B, alpha], axis=-1)
    
    return rgba

def lat_lng_to_tile(lat, lng, zoom):
    """Convert lat/lng to tile coordinates (Web Mercator)"""
    n = 2.0 ** zoom
    lat_rad = math.radians(lat)
    x = int((lng + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return x, y

def tile_to_lat_lng(x, y, zoom):
    """Convert tile coordinates to lat/lng of top-left corner"""
    n = 2.0 ** zoom
    lng = x / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    lat = math.degrees(lat_rad)
    return lat, lng

def generate_tiles_for_zoom(input_tif, output_dir, zoom, target_resolution_meters):
    """
    Generate terrain tiles for a specific zoom level
    
    This function generates ALL tiles that Slovakia spans at the given zoom level.
    Tiles are saved in the structure: public/terrain/{z}/{x}/{y}.png
    
    The frontend requests tiles using the same lat_lng_to_tile() calculation,
    so tiles generated here will match frontend requests exactly.
    
    Processes tiles incrementally to avoid memory issues.
    """
    # Get Web Mercator zoom level for this custom zoom level
    web_mercator_zoom = ZOOM_LEVELS[zoom]['web_mercator_zoom']
    
    print(f"\n{'='*60}")
    print(f"Generating zoom level {zoom} ({ZOOM_LEVELS[zoom]['description']})")
    print(f"Web Mercator zoom: {web_mercator_zoom}")
    print(f"Target resolution: {target_resolution_meters}m/pixel")
    
    output_path = Path(output_dir) / str(zoom)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Calculate tile range for Slovakia bounds using Web Mercator zoom
    # This ensures we generate ALL tiles that Slovakia spans
    # Frontend will request tiles using the same lat_lng_to_tile() function with web_mercator_zoom
    
    # Get tile coordinates for all corners
    nw = lat_lng_to_tile(SLOVAKIA_BOUNDS['max_lat'], SLOVAKIA_BOUNDS['min_lng'], web_mercator_zoom)
    ne = lat_lng_to_tile(SLOVAKIA_BOUNDS['max_lat'], SLOVAKIA_BOUNDS['max_lng'], web_mercator_zoom)
    sw = lat_lng_to_tile(SLOVAKIA_BOUNDS['min_lat'], SLOVAKIA_BOUNDS['min_lng'], web_mercator_zoom)
    se = lat_lng_to_tile(SLOVAKIA_BOUNDS['min_lat'], SLOVAKIA_BOUNDS['max_lng'], web_mercator_zoom)
    
    # Find min/max tile coordinates
    min_x = min(nw[0], ne[0], sw[0], se[0])
    max_x = max(nw[0], ne[0], sw[0], se[0])
    min_y = min(nw[1], ne[1], sw[1], se[1])
    max_y = max(nw[1], ne[1], sw[1], se[1])
    
    print(f"  Slovakia bounds: {SLOVAKIA_BOUNDS['min_lat']}°-{SLOVAKIA_BOUNDS['max_lat']}°N, {SLOVAKIA_BOUNDS['min_lng']}°-{SLOVAKIA_BOUNDS['max_lng']}°E")
    print(f"  Corner tiles: NW{nw}, NE{ne}, SW{sw}, SE{se}")
    print(f"  Tile range: X [{min_x}, {max_x}], Y [{min_y}, {max_y}]")
    print(f"  Total tiles to generate: {(max_x - min_x + 1) * (max_y - min_y + 1)}")
    print(f"  Output structure: {output_path}/{{x}}/{{y}}.png")
    
    pixels_per_tile = 256
    tile_count = 0
    
    # Process each tile individually to avoid memory issues
    with rasterio.open(input_tif) as src:
        dst_crs = CRS.from_epsg(3857)
        
        for tile_x in range(min_x, max_x + 1):
            for tile_y in range(min_y, max_y + 1):
                # Get tile bounds in lat/lng using Web Mercator zoom
                n = 2 ** web_mercator_zoom
                tile_min_lng = tile_x / n * 360.0 - 180.0
                tile_max_lng = (tile_x + 1) / n * 360.0 - 180.0
                tile_max_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * tile_y / n))))
                tile_min_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (tile_y + 1) / n))))
                
                # Create tile bounding box
                tile_bounds = BoundingBox(
                    left=tile_min_lng,
                    bottom=tile_min_lat,
                    right=tile_max_lng,
                    top=tile_max_lat
                )
                
                # Calculate meters per tile at this Web Mercator zoom level
                meters_per_tile = 40075017 / n
                
                # Create transform for 256x256 tile in Web Mercator
                # Tile bounds in Web Mercator
                def lat_to_mercator_y(lat):
                    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * 6378137
                
                def lng_to_mercator_x(lng):
                    return math.radians(lng) * 6378137
                
                tile_merc_min_x = lng_to_mercator_x(tile_min_lng)
                tile_merc_max_x = lng_to_mercator_x(tile_max_lng)
                tile_merc_min_y = lat_to_mercator_y(tile_min_lat)
                tile_merc_max_y = lat_to_mercator_y(tile_max_lat)
                
                # Create transform: pixel size = tile_size / pixels_per_tile
                pixel_size = meters_per_tile / pixels_per_tile
                from rasterio.transform import from_bounds
                transform = from_bounds(
                    tile_merc_min_x, tile_merc_min_y,
                    tile_merc_max_x, tile_merc_max_y,
                    pixels_per_tile, pixels_per_tile
                )
                
                # Read and reproject directly into 256x256 array
                tile_data = np.empty((pixels_per_tile, pixels_per_tile), dtype=src.dtypes[0])
                # Initialize with no-data value
                tile_data.fill(src.nodata if src.nodata is not None else -32768)
                
                reproject(
                    source=rasterio.band(src, 1),
                    destination=tile_data,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    src_nodata=src.nodata,
                    dst_transform=transform,
                    dst_crs=dst_crs,
                    dst_nodata=src.nodata,
                    resampling=RasterioResampling.cubic if target_resolution_meters < 30 else RasterioResampling.average
                )
                
                # Debug: Check if we got any valid data
                valid_mask = tile_data != (src.nodata if src.nodata is not None else -32768)
                if np.any(valid_mask):
                    valid_data = tile_data[valid_mask]
                    if tile_count == 0:  # Log first tile only
                        print(f"    Sample tile data: min={valid_data.min()}, max={valid_data.max()}, valid_pixels={np.sum(valid_mask)}/{pixels_per_tile*pixels_per_tile}")
                else:
                    print(f"    ⚠️ Warning: Tile {zoom}/{tile_x}/{tile_y} has no valid data!")
                
                # Convert to Terrarium RGB (already 256x256)
                rgb_data = elevation_to_terrarium_rgb(tile_data, nodata=src.nodata if src.nodata is not None else -32768)
                
                # Save tile in structure: public/terrain/{z}/{x}/{y}.png
                # This matches the frontend's fetchLocalTerrainTile() path structure
                tile_dir = output_path / str(tile_x)
                tile_dir.mkdir(parents=True, exist_ok=True)
                tile_file = tile_dir / f'{tile_y}.png'
                img = Image.fromarray(rgb_data, 'RGBA')
                img.save(tile_file)
                tile_count += 1
                
                # Verify tile was saved correctly
                if not tile_file.exists():
                    print(f"    ERROR: Failed to save tile {zoom}/{tile_x}/{tile_y}")
                
                if tile_count % 10 == 0:
                    print(f"  Progress: {tile_count} tiles created...")
        
        print(f"  ✅ Created {tile_count} tiles for zoom {zoom}")
        print(f"  Tiles saved to: {output_path}/{{x}}/{{y}}.png")
        print(f"  Frontend will request these as: /terrain/{zoom}/{{x}}/{{y}}.png")
        return tile_count

def main():
    base_dir = Path(__file__).parent.parent
    public_dir = base_dir / 'public'
    
    print("="*60)
    print("SRTM HGT to Terrain Tiles Converter v2")
    print("5 Zoom Levels: Z0 (overview) to Z4 (train level)")
    print("="*60)
    
    # Find HGT files
    hgt_files = find_hgt_files(base_dir)
    
    if not hgt_files:
        print("❌ No HGT files found!")
        return 1
    
    print(f"\n✅ Found {len(hgt_files)} HGT files")
    
    # Create temp directory
    temp_dir = base_dir / 'temp_dem'
    temp_dir.mkdir(exist_ok=True)
    merged_tif = temp_dir / 'slovakia_merged.tif'
    
    # Merge files (skip if already exists)
    if not merged_tif.exists():
        if not merge_hgt_files(hgt_files, str(merged_tif)):
            return 1
    else:
        print(f"\n✅ Using existing merged GeoTIFF: {merged_tif}")
    
    # Generate tiles for each zoom level
    terrain_dir = public_dir / 'terrain'
    total_tiles = 0
    
    for zoom in sorted(ZOOM_LEVELS.keys()):
        target_res = ZOOM_LEVELS[zoom]['target_resolution']
        tiles = generate_tiles_for_zoom(str(merged_tif), str(terrain_dir), zoom, target_res)
        total_tiles += tiles
    
    print("\n" + "="*60)
    print(f"✅ Conversion complete!")
    print(f"📁 Terrain tiles in: {terrain_dir}")
    print(f"📊 Total tiles generated: {total_tiles}")
    print(f"📦 Zoom levels: {', '.join([f'Z{z}' for z in sorted(ZOOM_LEVELS.keys())])}")
    print("="*60)
    
    return 0

if __name__ == '__main__':
    sys.exit(main())

