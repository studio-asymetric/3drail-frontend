#!/usr/bin/env python3
"""Verify generated terrain tiles contain valid elevation data"""
from PIL import Image
import numpy as np
from pathlib import Path

def decode_terrarium(rgb_data):
    """Decode Terrarium RGB to elevation"""
    r = rgb_data[:,:,0].astype(np.float32)
    g = rgb_data[:,:,1].astype(np.float32)
    b = rgb_data[:,:,2].astype(np.float32)
    height = (r * 256 + g + b / 256) - 32768
    return height

terrain_dir = Path('public/terrain')
print("Verifying terrain tiles...\n")

for zoom in sorted([0, 1, 2, 3, 4]):
    zoom_dir = terrain_dir / str(zoom)
    if not zoom_dir.exists():
        continue
    
    # Find first tile
    tile_files = list(zoom_dir.rglob('*.png'))
    if not tile_files:
        continue
    
    tile_file = tile_files[0]
    img = Image.open(tile_file)
    data = np.array(img)
    
    heights = decode_terrarium(data)
    valid_heights = heights[heights > -32700]  # Filter out no-data
    
    if len(valid_heights) > 0:
        print(f"Z{zoom} ({tile_file.name}):")
        print(f"  Elevation range: {valid_heights.min():.1f}m to {valid_heights.max():.1f}m")
        print(f"  Valid pixels: {len(valid_heights)}/{heights.size} ({100*len(valid_heights)/heights.size:.1f}%)")
        print(f"  Mean elevation: {valid_heights.mean():.1f}m")
    else:
        print(f"Z{zoom}: ⚠️ No valid elevation data!")
    print()


