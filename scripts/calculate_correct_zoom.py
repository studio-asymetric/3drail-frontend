#!/usr/bin/env python3
"""Calculate what zoom level is needed for 30m/pixel resolution"""
import math

# Constants
EARTH_CIRCUMFERENCE_METERS = 40075017  # Equatorial circumference
PIXELS_PER_TILE = 256
TARGET_METERS_PER_PIXEL = 30

# Calculate what zoom level gives us 30m/pixel
# At zoom level z, meters per pixel at equator = EARTH_CIRCUMFERENCE / (256 * 2^z)
# We want: EARTH_CIRCUMFERENCE / (256 * 2^z) = 30
# So: 2^z = EARTH_CIRCUMFERENCE / (256 * 30)
# z = log2(EARTH_CIRCUMFERENCE / (256 * 30))

target_zoom = math.log2(EARTH_CIRCUMFERENCE_METERS / (PIXELS_PER_TILE * TARGET_METERS_PER_PIXEL))
print(f"To get {TARGET_METERS_PER_PIXEL}m/pixel resolution:")
print(f"  Required zoom level: {target_zoom:.2f}")
print(f"  Rounded up: {math.ceil(target_zoom)}")
print()

# Check what resolution we get at different zoom levels
print("Resolution at different zoom levels:")
for z in [4, 8, 10, 11, 12, 13]:
    meters_per_pixel = EARTH_CIRCUMFERENCE_METERS / (PIXELS_PER_TILE * (2 ** z))
    meters_per_tile = PIXELS_PER_TILE * meters_per_pixel
    print(f"  Z{z}: {meters_per_pixel:.1f}m/pixel, {meters_per_tile/1000:.1f}km per tile")

print()
print("For Slovakia (166.5km N-S, 424.9km E-W) at 30m/pixel:")
slovakia_ns_km = 166.5
slovakia_ew_km = 424.9
meters_per_tile_30m = PIXELS_PER_TILE * 30 / 1000  # km per tile
tiles_ns = math.ceil(slovakia_ns_km / meters_per_tile_30m)
tiles_ew = math.ceil(slovakia_ew_km / meters_per_tile_30m)
print(f"  Tiles needed: {tiles_ew} × {tiles_ns} = {tiles_ew * tiles_ns} tiles")
print(f"  At zoom level {math.ceil(target_zoom)} (30m/pixel)")


