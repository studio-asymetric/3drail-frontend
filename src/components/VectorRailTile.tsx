import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Group } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';

interface VectorRailTileProps {
  chains: Float32Array[];
  opacity?: number;
}

/**
 * Screen-space strokes for one batch of railway polylines.
 * WebGL's built-in lines ignore width, which hid the curves.
 */
export function VectorRailTile({ chains, opacity = 1 }: VectorRailTileProps) {
  const { size } = useThree();
  const material = useMemo(
    () =>
      new LineMaterial({
        color: 0xf4f7fb,
        linewidth: 2.4,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      }),
    [opacity]
  );

  const group = useMemo(() => {
    const next = new Group();
    chains.forEach((chain) => {
      if (chain.length < 6) {
        return;
      }
      const geometry = new LineGeometry();
      geometry.setPositions(chain);
      const line = new Line2(geometry, material);
      line.renderOrder = 1400;
      next.add(line);
    });
    return next;
  }, [chains, material]);

  useEffect(() => {
    material.resolution.set(size.width, size.height);
  }, [material, size.width, size.height]);

  useEffect(() => {
    return () => {
      group.traverse((object) => {
        const line = object as Line2;
        line.geometry?.dispose();
      });
      material.dispose();
    };
  }, [group, material]);

  return <primitive object={group} />;
}
