import {
  Cache,
  ClampToEdgeWrapping,
  LinearFilter,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three';

Cache.enabled = true;

const loader = new TextureLoader();
const textures = new Map<string, Texture>();
const inflight = new Map<string, Promise<Texture | null>>();

export function basemapTileKey(zoom: number, tileX: number, tileY: number) {
  return `${zoom}/${tileX}/${tileY}`;
}

export function getCachedBasemapTexture(zoom: number, tileX: number, tileY: number) {
  return textures.get(basemapTileKey(zoom, tileX, tileY)) ?? null;
}

export function loadBasemapTexture(zoom: number, tileX: number, tileY: number) {
  const key = basemapTileKey(zoom, tileX, tileY);
  const cached = textures.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const request = new Promise<Texture | null>((resolve) => {
    loader.load(
      `/proxy?mode=basemap&z=${zoom}&x=${tileX}&y=${tileY}`,
      (texture) => {
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearFilter;
        texture.magFilter = LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = ClampToEdgeWrapping;
        texture.wrapT = ClampToEdgeWrapping;
        texture.needsUpdate = true;
        textures.set(key, texture);
        inflight.delete(key);
        resolve(texture);
      },
      undefined,
      () => {
        inflight.delete(key);
        resolve(null);
      }
    );
  });
  inflight.set(key, request);
  return request;
}
