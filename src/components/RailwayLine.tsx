// Component to render railway lines from OSM data with tunnel/bridge support

import React, { useMemo } from 'react';
import { BufferGeometry, BufferAttribute, Line, LineBasicMaterial, Vector3 } from 'three';
import type { OSMWay } from '../data/osmRailService';
import { isTunnel, isBridge, osmWayToCoordinates } from '../data/osmRailService';
import { getElevationAtPoint } from '../data/elevationService';
import type { Coordinate } from '../data/gtfsParser';

interface RailwayLineProps {
  osmWay: OSMWay;
  elevationData: number[][] | null;
  project: (coord: Coordinate | { lat: number; lng: number }) => [number, number, number];
  gridBounds?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

export const RailwayLine: React.FC<RailwayLineProps> = ({ 
  osmWay, 
  elevationData, 
  project,
  gridBounds 
}) => {
  const tunnel = isTunnel(osmWay);
  const bridge = isBridge(osmWay);
  
  const line = useMemo(() => {
    const coordinates = osmWayToCoordinates(osmWay);
    // Only log if there's an issue
    if (coordinates.length < 2) {
      console.warn(`⚠️ RailwayLine: way ${osmWay.id} has insufficient coordinates (${coordinates.length})`);
      return null;
    }
    
    const positions = new Float32Array(coordinates.length * 3);
    
    for (let i = 0; i < coordinates.length; i++) {
      const [lat, lng] = coordinates[i];
      
      // Get elevation at this point
      let elevation = 0;
      if (elevationData) {
        elevation = getElevationAtPoint(lat, lng, elevationData, gridBounds);
      }
      
      // Project coordinate
      const [x, y, z] = project({ lat, lng });
      
      // Adjust Y based on elevation and type
      let adjustedY = y;
      if (bridge) {
        // Bridge: elevate above terrain
        adjustedY = y + elevation * 0.1 + 10; // 10 units above terrain
      } else if (tunnel) {
        // Tunnel: below terrain
        adjustedY = y - 5; // 5 units below surface
      } else {
        // Normal track: follow terrain
        adjustedY = y + elevation * 0.1;
      }
      
      positions[i * 3] = x;
      positions[i * 3 + 1] = adjustedY;
      positions[i * 3 + 2] = z;
    }
    
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(positions, 3));
    const material = new LineBasicMaterial({ 
      color: tunnel ? '#666666' : bridge ? '#ffff00' : '#8ca4ff',
      linewidth: tunnel ? 3 : bridge ? 4 : 2,
      opacity: tunnel ? 0.7 : 1.0,
      transparent: tunnel,
    });
    
    return new Line(geom, material);
  }, [osmWay, elevationData, project, tunnel, bridge, gridBounds]);
  
  if (!line) return null;
  
  return <primitive object={line} />;
};

