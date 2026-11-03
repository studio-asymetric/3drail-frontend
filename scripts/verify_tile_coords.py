#!/usr/bin/env python3
"""Verify tile coordinate calculations match between Python and TypeScript"""
import math

def lat_lng_to_tile_py(lat, lng, zoom):
    """Python version (using asinh)"""
    n = 2.0 ** zoom
    lat_rad = math.radians(lat)
    x = int((lng + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return x, y

def lat_lng_to_tile_js(lat, lng, zoom):
    """TypeScript version (using log)"""
    n = 2.0 ** zoom
    lat_rad = math.radians(lat)
    x = int((lng + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1/math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y

# Test points
test_points = [
    (48.7, 19.5, "Center"),
    (49.5, 16.8, "NW corner"),
    (48.0, 22.6, "SE corner"),
    (48.159111, 17.106528, "Bratislava"),
    (48.722917, 21.268583, "Košice"),
    (49.226972, 18.746944, "Žilina"),
]

print("Comparing tile coordinate calculations:\n")
for lat, lng, name in test_points:
    for zoom in [0, 1, 2, 3, 4]:
        py_coords = lat_lng_to_tile_py(lat, lng, zoom)
        js_coords = lat_lng_to_tile_js(lat, lng, zoom)
        match = "OK" if py_coords == js_coords else "MISMATCH"
        if zoom == 0 or py_coords != js_coords:
            print(f"  {name} ({lat}°N {lng}°E) @ Z{zoom}: Python={py_coords}, JS={js_coords} {match}")

