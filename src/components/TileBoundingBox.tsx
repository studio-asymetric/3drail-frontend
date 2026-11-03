// Component to visualize tile bounding boxes
import { useMemo } from 'react';
import { BufferGeometry, BufferAttribute, LineSegments, LineBasicMaterial } from 'three';
import { getTileBounds } from '../data/terrainTileService';
import type { TerrainTile } from '../data/terrainTileService';

interface TileBoundingBoxProps {
  tile: TerrainTile;
  project: (coord: { lat: number; lng: number }) => [number, number, number];
}

export const TileBoundingBox: React.FC<TileBoundingBoxProps> = ({ tile, project }) => {
  const line = useMemo(() => {
    // Get tile bounds in lat/lng
    const bounds = getTileBounds(tile.x, tile.y, tile.z);
    
    // Project corners to 3D
    const corners = [
      project({ lat: bounds.minLat, lng: bounds.minLng }), // SW
      project({ lat: bounds.minLat, lng: bounds.maxLng }), // SE
      project({ lat: bounds.maxLat, lng: bounds.maxLng }), // NE
      project({ lat: bounds.maxLat, lng: bounds.minLng }), // NW
    ];
    
    // Create a box outline at ground level (Y=0)
    const positions = new Float32Array([
      // Bottom rectangle (ground level)
      corners[0][0], 0, corners[0][2], // SW
      corners[1][0], 0, corners[1][2], // SE
      corners[1][0], 0, corners[1][2], // SE
      corners[2][0], 0, corners[2][2], // NE
      corners[2][0], 0, corners[2][2], // NE
      corners[3][0], 0, corners[3][2], // NW
      corners[3][0], 0, corners[3][2], // NW
      corners[0][0], 0, corners[0][2], // SW
      
      // Top rectangle (slightly above ground for visibility)
      corners[0][0], 5, corners[0][2], // SW
      corners[1][0], 5, corners[1][2], // SE
      corners[1][0], 5, corners[1][2], // SE
      corners[2][0], 5, corners[2][2], // NE
      corners[2][0], 5, corners[2][2], // NE
      corners[3][0], 5, corners[3][2], // NW
      corners[3][0], 5, corners[3][2], // NW
      corners[0][0], 5, corners[0][2], // SW
      
      // Vertical edges
      corners[0][0], 0, corners[0][2], // SW bottom
      corners[0][0], 5, corners[0][2], // SW top
      corners[1][0], 0, corners[1][2], // SE bottom
      corners[1][0], 5, corners[1][2], // SE top
      corners[2][0], 0, corners[2][2], // NE bottom
      corners[2][0], 5, corners[2][2], // NE top
      corners[3][0], 0, corners[3][2], // NW bottom
      corners[3][0], 5, corners[3][2], // NW top
    ]);
    
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    
    // Color based on zoom level
    const colors: Record<number, number> = {
      0: 0xff0000, // Red for Z0
      1: 0xff8800, // Orange for Z1
      2: 0xffff00, // Yellow for Z2
      3: 0x00ff00, // Green for Z3
      4: 0x00ffff, // Cyan for Z4
    };
    
    const material = new LineBasicMaterial({ 
      color: colors[tile.z] ?? 0xffffff,
      linewidth: 2,
      transparent: true,
      opacity: 0.7
    });
    
    return new LineSegments(geometry, material);
  }, [tile, project]);
  
  return <primitive object={line} />;
};

