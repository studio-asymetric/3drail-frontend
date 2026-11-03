#!/usr/bin/env python3
"""Calculate how many tiles Slovakia needs at Z4 if 1 pixel = 30m"""
import math

# Slovakia bounds
SLOVAKIA_BOUNDS = {
    'min_lat': 48.0,
    'max_lat': 49.5,
    'min_lng': 16.8,
    'max_lng': 22.6
}

# Constants
PIXELS_PER_TILE = 256
METERS_PER_PIXEL_Z4 = 30  # User says heightmap resolution is 30m/pixel

# Calculate Slovakia dimensions in meters
# 1 degree latitude ≈ 111,000 meters
# 1 degree longitude ≈ 111,000 * cos(latitude) meters
CENTER_LAT = 48.7  # Approximate center

lat_span_degrees = SLOVAKIA_BOUNDS['max_lat'] - SLOVAKIA_BOUNDS['min_lat']
lng_span_degrees = SLOVAKIA_BOUNDS['max_lng'] - SLOVAKIA_BOUNDS['min_lng']

lat_span_meters = lat_span_degrees * 111000
lng_span_meters = lng_span_degrees * 111000 * math.cos(math.radians(CENTER_LAT))

print("Slovakia dimensions:")
print(f"  Latitude span: {lat_span_degrees:.2f}° = {lat_span_meters/1000:.1f} km")
print(f"  Longitude span: {lng_span_degrees:.2f}° = {lng_span_meters/1000:.1f} km")
print()

# Calculate tile coverage
meters_per_tile = PIXELS_PER_TILE * METERS_PER_PIXEL_Z4
tiles_x = math.ceil(lng_span_meters / meters_per_tile)
tiles_y = math.ceil(lat_span_meters / meters_per_tile)

print(f"At Z4 (1 pixel = {METERS_PER_PIXEL_Z4}m):")
print(f"  Meters per tile: {PIXELS_PER_TILE} pixels × {METERS_PER_PIXEL_Z4}m = {meters_per_tile/1000:.1f} km")
print(f"  X axis (East-West): {tiles_x} tiles needed")
print(f"  Y axis (North-South): {tiles_y} tiles needed")
print(f"  Total tiles: {tiles_x} × {tiles_y} = {tiles_x * tiles_y} tiles")
print()

# Calculate what tile coordinates Slovakia spans
def lat_lng_to_tile(lat, lng, zoom):
    n = 2.0 ** zoom
    lat_rad = math.radians(lat)
    x = int((lng + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1/math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y

nw = lat_lng_to_tile(SLOVAKIA_BOUNDS['max_lat'], SLOVAKIA_BOUNDS['min_lng'], 4)
ne = lat_lng_to_tile(SLOVAKIA_BOUNDS['max_lat'], SLOVAKIA_BOUNDS['max_lng'], 4)
sw = lat_lng_to_tile(SLOVAKIA_BOUNDS['min_lat'], SLOVAKIA_BOUNDS['min_lng'], 4)
se = lat_lng_to_tile(SLOVAKIA_BOUNDS['min_lat'], SLOVAKIA_BOUNDS['max_lng'], 4)

min_x = min(nw[0], ne[0], sw[0], se[0])
max_x = max(nw[0], ne[0], sw[0], se[0])
min_y = min(nw[1], ne[1], sw[1], se[1])
max_y = max(nw[1], ne[1], sw[1], se[1])

actual_tiles_x = max_x - min_x + 1
actual_tiles_y = max_y - min_y + 1

print("Actual tile coordinates at Z4:")
print(f"  NW: {nw}, NE: {ne}")
print(f"  SW: {sw}, SE: {se}")
print(f"  X range: [{min_x}, {max_x}] = {actual_tiles_x} tiles")
print(f"  Y range: [{min_y}, {max_y}] = {actual_tiles_y} tiles")
print(f"  Total: {actual_tiles_x} × {actual_tiles_y} = {actual_tiles_x * actual_tiles_y} tiles")
print()
print(f"MISMATCH:")
print(f"  Calculated from resolution: {tiles_x} × {tiles_y} = {tiles_x * tiles_y} tiles")
print(f"  Actual tile coordinates: {actual_tiles_x} × {actual_tiles_y} = {actual_tiles_x * actual_tiles_y} tiles")


