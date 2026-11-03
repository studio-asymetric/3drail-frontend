#!/usr/bin/env python3
"""Check how many tiles Slovakia spans at each zoom level"""
import math

def lat_lng_to_tile(lat, lng, zoom):
    n = 2 ** zoom
    x = int((lng + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_rad) + 1/math.cos(lat_rad)) / math.pi) / 2 * n)
    return x, y

# Slovakia bounds
SLOVAKIA_BOUNDS = {
    'min_lat': 48.0,
    'max_lat': 49.5,
    'min_lng': 16.8,
    'max_lng': 22.6
}

print("Slovakia tile coverage at each zoom level:\n")

for zoom in [0, 1, 2, 3, 4]:
    # Calculate tile coordinates for all corners
    nw = lat_lng_to_tile(SLOVAKIA_BOUNDS['max_lat'], SLOVAKIA_BOUNDS['min_lng'], zoom)
    ne = lat_lng_to_tile(SLOVAKIA_BOUNDS['max_lat'], SLOVAKIA_BOUNDS['max_lng'], zoom)
    sw = lat_lng_to_tile(SLOVAKIA_BOUNDS['min_lat'], SLOVAKIA_BOUNDS['min_lng'], zoom)
    se = lat_lng_to_tile(SLOVAKIA_BOUNDS['min_lat'], SLOVAKIA_BOUNDS['max_lng'], zoom)
    
    # Find min/max tile coordinates
    min_x = min(nw[0], ne[0], sw[0], se[0])
    max_x = max(nw[0], ne[0], sw[0], se[0])
    min_y = min(nw[1], ne[1], sw[1], se[1])
    max_y = max(nw[1], ne[1], sw[1], se[1])
    
    tile_count = (max_x - min_x + 1) * (max_y - min_y + 1)
    
    print(f"Z{zoom}:")
    print(f"  NW corner: {nw}, NE corner: {ne}")
    print(f"  SW corner: {sw}, SE corner: {se}")
    print(f"  Tile range: X [{min_x}, {max_x}], Y [{min_y}, {max_y}]")
    print(f"  Total tiles needed: {tile_count}")
    print()


