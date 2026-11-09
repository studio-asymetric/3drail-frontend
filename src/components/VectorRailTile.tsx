import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry, LineBasicMaterial } from 'three';

interface VectorRailTileProps {
  chains: Float32Array[];
  opacity?: number;
}

/**
 * One LineSegments draw for a tile. Fat Line2 strokes were a few thousand
 * extra meshes and were the main frame-time cost of the network.
 */
export function VectorRailTile({ chains, opacity = 1 }: VectorRailTileProps) {
  const geometry = useMemo(() => {
    let segmentCount = 0;
    chains.forEach((chain) => {
      const points = Math.floor(chain.length / 3);
      if (points >= 2) {
        segmentCount += points - 1;
      }
    });
    const positions = new Float32Array(segmentCount * 6);
    let offset = 0;
    chains.forEach((chain) => {
      const points = Math.floor(chain.length / 3);
      for (let index = 0; index < points - 1; index += 1) {
        const a = index * 3;
        const b = (index + 1) * 3;
        positions[offset++] = chain[a];
        positions[offset++] = chain[a + 1];
        positions[offset++] = chain[a + 2];
        positions[offset++] = chain[b];
        positions[offset++] = chain[b + 1];
        positions[offset++] = chain[b + 2];
      }
    });
    const next = new BufferGeometry();
    next.setAttribute('position', new BufferAttribute(positions, 3));
    return next;
  }, [chains]);

  const material = useMemo(
    () =>
      new LineBasicMaterial({
        color: 0xf4f7fb,
        transparent: opacity < 1,
        opacity,
        depthTest: true,
        depthWrite: false,
      }),
    [opacity]
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return <lineSegments geometry={geometry} material={material} renderOrder={1400} />;
}
