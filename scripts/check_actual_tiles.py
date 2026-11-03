#!/usr/bin/env python3
"""Check actual tiles generated vs what Slovakia needs"""
from pathlib import Path

terrain = Path('public/terrain')

print("Actual tiles generated:\n")

for z in [0, 1, 2, 3, 4]:
    zoom_path = terrain / str(z)
    if not zoom_path.exists():
        print(f"Z{z}: No tiles generated")
        print()
        continue
    
    x_dirs = [d for d in zoom_path.iterdir() if d.is_dir()]
    tiles = []
    for x_dir in x_dirs:
        for y_file in x_dir.glob('*.png'):
            tiles.append((int(x_dir.name), int(y_file.stem)))
    
    if tiles:
        x_coords = sorted(set([t[0] for t in tiles]))
        y_coords = sorted(set([t[1] for t in tiles]))
        print(f"Z{z}:")
        print(f"  X axis: {len(x_coords)} tiles (range: {min(x_coords)} to {max(x_coords)})")
        print(f"  Y axis: {len(y_coords)} tiles (range: {min(y_coords)} to {max(y_coords)})")
        print(f"  Total: {len(tiles)} tiles")
        print(f"  Tile coordinates: {sorted(tiles)}")
    else:
        print(f"Z{z}: No tiles found")
    print()


