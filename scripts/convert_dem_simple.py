#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Simplified DEM to terrain tiles converter
Uses rasterio and numpy directly (no GDAL command-line tools required)

Requirements:
    pip install rasterio numpy pillow

This creates Terrarium-format tiles directly from HGT files.
"""

import os
import sys
import math
from pathlib import Path
import numpy as np
from PIL import Image
import rasterio
from rasterio.merge import merge
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.crs import CRS

# Fix Windows console encoding for emojis
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def find_hgt_files(base_dir):
    """Find all HGT files"""
    hgt_files = []
    dem_folders = ['L33', 'L34', 'M33', 'M34']
    
    for folder in dem_folders:
        folder_path = Path(base_dir) / 'public' / folder / folder
        if folder_path.exists():
            files = list(folder_path.glob('*.hgt'))
            hgt_files.extend([str(f) for f in files])
            print(f"📁 Found {len(files)} HGT files in {folder}/")
    
    return hgt_files

def merge_hgt_files(hgt_files, output_tif):
    """Merge HGT files using rasterio"""
    print(f"\n🔄 Merging {len(hgt_files)} HGT files...")
    
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

def elevation_to_terrarium_rgb(elevation_array):
    """
    Convert elevation (meters) to Terrarium RGB encoding
    Formula: height = (R * 256 + G + B / 256) - 32768
    Reverse encoding:
    """
    # Add offset
    height = elevation_array.astype(np.float32) + 32768
    
    # Clamp to valid range (0-65535)
    height = np.clip(height, 0, 65535)
    
    # Extract RGB components
    R = np.floor(height / 256).astype(np.uint8)
    G = np.floor(height % 256).astype(np.uint8)
    B = np.floor((height * 256) % 256).astype(np.uint8)
    
    # Create RGBA image (alpha = 255)
    rgba = np.stack([R, G, B, np.full_like(R, 255, dtype=np.uint8)], axis=-1)
    
    return rgba

def lat_lng_to_tile(lat, lng, zoom):
    """Convert lat/lng to tile coordinates (Web Mercator)"""
    n = 2.0 ** zoom
    lat_rad = math.radians(lat)
    x = int((lng + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return x, y

def generate_tiles_simple(input_tif, output_dir, min_zoom=8, max_zoom=12):
    """
    Generate terrain tiles using simple approach
    Creates proper multi-level tiles for zoom levels 8-12
    """
    print(f"\n🔄 Generating terrain tiles (zoom {min_zoom}-{max_zoom})...")
    
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    with rasterio.open(input_tif) as src:
        bounds = src.bounds
        print(f"   Bounds: {bounds}")
        
        # Reproject to Web Mercator
        dst_crs = CRS.from_epsg(3857)
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *bounds
        )
        
        # Read and reproject data
        data = np.empty((height, width), dtype=src.dtypes[0])
        reproject(
            source=rasterio.band(src, 1),
            destination=data,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=transform,
            dst_crs=dst_crs,
            resampling=Resampling.cubic
        )
        
        print(f"   ✅ Reprojected to Web Mercator: {width}x{height}")
        
        # Convert to Terrarium RGB
        rgb_data = elevation_to_terrarium_rgb(data)
        
        # Convert bounds to lat/lng for tile calculation
        # Web Mercator bounds to lat/lng
        min_lng = bounds.left / 20037508.34 * 180.0
        max_lng = bounds.right / 20037508.34 * 180.0
        min_lat = math.atan(math.exp((bounds.bottom / 20037508.34) * math.pi)) * 360.0 / math.pi - 90.0
        max_lat = math.atan(math.exp((bounds.top / 20037508.34) * math.pi)) * 360.0 / math.pi - 90.0
        
        tile_count = 0
        
        # Generate tiles for each zoom level
        for zoom in range(min_zoom, max_zoom + 1):
            print(f"   Generating zoom level {zoom}...")
            
            # Calculate tile range
            min_x, max_y = lat_lng_to_tile(max_lat, min_lng, zoom)
            max_x, min_y = lat_lng_to_tile(min_lat, max_lng, zoom)
            
            # Calculate pixels per tile at this zoom
            pixels_per_tile = 256
            total_tiles_x = max_x - min_x + 1
            total_tiles_y = max_y - min_y + 1
            
            # Calculate data pixels per tile
            data_pixels_per_tile_x = width / total_tiles_x
            data_pixels_per_tile_y = height / total_tiles_y
            
            # Generate each tile
            for tile_x in range(min_x, max_x + 1):
                for tile_y in range(min_y, max_y + 1):
                    # Calculate source region in data array
                    src_x_start = int((tile_x - min_x) * data_pixels_per_tile_x)
                    src_x_end = int((tile_x - min_x + 1) * data_pixels_per_tile_x)
                    src_y_start = int((tile_y - min_y) * data_pixels_per_tile_y)
                    src_y_end = int((tile_y - min_y + 1) * data_pixels_per_tile_y)
                    
                    # Clamp to array bounds
                    src_x_start = max(0, min(src_x_start, width - 1))
                    src_x_end = max(1, min(src_x_end, width))
                    src_y_start = max(0, min(src_y_start, height - 1))
                    src_y_end = max(1, min(src_y_end, height))
                    
                    # Extract tile region
                    tile_data = rgb_data[src_y_start:src_y_end, src_x_start:src_x_end]
                    
                    if tile_data.size == 0:
                        continue
                    
                    # Resize to 256x256
                    img = Image.fromarray(tile_data, 'RGBA')
                    img_resized = img.resize((pixels_per_tile, pixels_per_tile), Image.Resampling.LANCZOS)
                    
                    # Save tile
                    tile_dir = output_path / str(zoom) / str(tile_x)
                    tile_dir.mkdir(parents=True, exist_ok=True)
                    img_resized.save(tile_dir / f'{tile_y}.png')
                    tile_count += 1
            
            print(f"      Created {total_tiles_x * total_tiles_y} tiles for zoom {zoom}")
    
    print(f"\n✅ Generated {tile_count} tiles total in {output_dir}")
    return True

def main():
    base_dir = Path(__file__).parent.parent
    public_dir = base_dir / 'public'
    
    print("🗻 SRTM HGT to Terrain Tiles Converter (Simple)")
    print("=" * 50)
    
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
    
    # Merge files
    if not merge_hgt_files(hgt_files, str(merged_tif)):
        return 1
    
    # Generate tiles
    terrain_dir = public_dir / 'terrain'
    if not generate_tiles_simple(str(merged_tif), str(terrain_dir)):
        return 1
    
    print("\n" + "=" * 50)
    print("✅ Conversion complete!")
    print(f"📁 Terrain tiles in: {terrain_dir}")
    
    return 0

if __name__ == '__main__':
    sys.exit(main())

