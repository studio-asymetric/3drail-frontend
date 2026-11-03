#!/usr/bin/env python3
"""Check if generated tiles match Slovakia bounds"""
import math
import os
from pathlib import Path

def lat_lng_to_tile(lat, lng, zoom):
    n = 2 ** zoom
    x = int((lng + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_rad) + 1/math.cos(lat_rad)) / math.pi) / 2 * n)
    return x, y

print("Slovakia bounds:")
print(f"  NW (49.5°N, 16.8°E): {lat_lng_to_tile(49.5, 16.8, 2)}")
print(f"  SE (48.0°N, 22.6°E): {lat_lng_to_tile(48.0, 22.6, 2)}")
print(f"  Center (48.7°N, 19.5°E): {lat_lng_to_tile(48.7, 19.5, 2)}")

print("\nGenerated tiles:")
terrain_dir = Path('public/terrain')
for zoom in sorted([0, 1, 2, 3, 4]):
    zoom_path = terrain_dir / str(zoom)
    if not zoom_path.exists():
        continue
    
    tiles = []
    for x_dir in zoom_path.iterdir():
        if x_dir.is_dir():
            x = int(x_dir.name)
            for y_file in x_dir.glob('*.png'):
                y = int(y_file.stem)
                tiles.append((x, y))
    
    print(f"  Z{zoom}: {sorted(tiles)}")
    
    # Check if center tile exists
    center_x, center_y = lat_lng_to_tile(48.7, 19.5, zoom)
    if (center_x, center_y) in tiles:
        print(f"    OK: Center tile exists: {center_x}/{center_y}")
    else:
        print(f"    WARNING: Center tile missing: {center_x}/{center_y}")

