# Terrain LOD System Refactor Plan

## Goal
Create a terrain LOD system that loads appropriate terrain tiles based on camera height:
- **Z0 (500+ units)**: Overview - one tile covering all Slovakia (~500km span)
- **Z4 (0.1 units)**: Train level - detailed tiles covering only visible area

## Current Problem
The code is trying to stitch tiles into a 256x256 grid, but it should use tiles directly:
- Tiles are already the right resolution for their zoom level
- At Z0: One 256x256 tile covers all Slovakia (low detail)
- At Z4: Multiple 256x256 tiles cover visible area (high detail)

## Required Changes

### 1. `terrainTileService.ts` - Simplify tile loading

**Current**: Creates a 256x256 grid by sampling from tiles
**Needed**: Return tile data directly, let terrain component use it

```typescript
// Instead of getElevationGridFromTiles() creating a grid:
// - Return the loaded tiles directly
// - Or return a single elevation array if only one tile needed (Z0-Z3)
// - For Z4, return multiple tiles and let terrain component stitch them

export async function getTerrainTilesForBounds(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  zoom: number
): Promise<TerrainTile[]> {
  // Load all tiles in bounds
  // Return tiles array directly
}
```

### 2. `CameraTerrainLoader.tsx` - Load based on camera view

**Current**: Loads entire Slovakia bounds
**Needed**: 
- At low zoom (Z0-Z2): Load all Slovakia (one tile)
- At high zoom (Z3-Z4): Load only visible area (camera frustum)

```typescript
// Calculate visible bounds from camera frustum
const getVisibleBounds = (camera, controls) => {
  // Calculate what lat/lng area is visible in viewport
  // Return minLat, maxLat, minLng, maxLng
}

// Load tiles for visible area only
if (height < 50) {
  // High detail: load visible area only
  const visibleBounds = getVisibleBounds(camera, controls);
  tiles = await getTerrainTilesForBounds(...visibleBounds, zoom);
} else {
  // Low detail: load all Slovakia
  tiles = await getTerrainTilesForBounds(48.0, 49.5, 16.8, 22.6, zoom);
}
```

### 3. `MapScene.tsx` - Terrain component refactor

**Current**: Creates terrain from a 256x256 elevation grid
**Needed**: Create terrain directly from tile(s) data

```typescript
const Terrain: React.FC<{ tiles: TerrainTile[], cameraHeight: number }> = ({ tiles, cameraHeight }) => {
  // Determine mesh resolution based on camera height
  // Z0 (500 units): Low resolution mesh (e.g., 100x100 vertices)
  // Z4 (0.1 units): High resolution mesh (e.g., 500x500 vertices)
  
  const meshResolution = cameraHeight > 200 ? 100 : 500;
  
  // Calculate terrain bounds
  // At low zoom: Use Slovakia bounds
  // At high zoom: Use visible tile bounds
  
  // Create mesh vertices
  for each vertex:
    - Calculate lat/lng for this vertex
    - Find which tile contains it
    - Get elevation from tile using getElevationFromTile()
    - Project to 3D coordinates
}
```

### 4. Tile usage strategy

**Z0 (500+ units)**:
- Load: 1 tile (Z0/0/0.png) - covers all Slovakia
- Mesh: Low resolution (100x100 vertices)
- Coverage: All Slovakia (~500km)

**Z1 (200-500 units)**:
- Load: 1 tile (Z1/1/0.png) - covers all Slovakia
- Mesh: Medium resolution (150x150 vertices)
- Coverage: All Slovakia

**Z2 (50-200 units)**:
- Load: 1 tile (Z2/2/1.png) - covers all Slovakia
- Mesh: Medium-high resolution (200x200 vertices)
- Coverage: All Slovakia

**Z3 (5-50 units)**:
- Load: 1 tile (Z3/4/2.png) - covers all Slovakia
- Mesh: High resolution (300x300 vertices)
- Coverage: All Slovakia

**Z4 (0.1-5 units)**:
- Load: Multiple tiles covering visible area only
- Mesh: Very high resolution (500x500+ vertices)
- Coverage: Only visible area (~few km)

### 5. Key changes summary

1. **Remove grid creation**: Don't create 256x256 grids from tiles
2. **Use tiles directly**: Pass tile objects to terrain component
3. **Dynamic mesh resolution**: Adjust mesh vertices based on camera height
4. **View frustum culling**: At high zoom, only load visible tiles
5. **Tile stitching**: Only needed at Z4, stitch multiple tiles for visible area

## Implementation Steps

1. Refactor `getElevationGridFromTiles()` → `getTerrainTilesForBounds()` (return tiles, not grid)
2. Add `getVisibleBounds()` helper to calculate camera view frustum
3. Update `CameraTerrainLoader` to load visible area at high zoom
4. Refactor `Terrain` component to use tiles directly
5. Add dynamic mesh resolution based on camera height
6. Implement tile stitching only for Z4 (high zoom)


