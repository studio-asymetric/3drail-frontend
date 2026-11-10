import fs from 'node:fs';
import path from 'node:path';

export const GEOPS_STYLE_ID = 'basemap_dark_ch.sbb.netzkarte';
const GEOPS_ORIGIN = 'https://maps.geops.io';
const GEOPS_STYLE_IDS = {
  dark: ['basemap_dark_ch.sbb.netzkarte'],
  light: ['basemap_bright_ch.sbb.netzkarte', 'base_bright_v2'],
};
const STYLE_CACHE_NAMES = {
  dark: 'style-v6.json',
  light: 'style-light-v2.json',
};
const LIGHT_BASEMAP_SURFACE = '#ebebeb';
const RAIL_LAYER = /railways|tram|subway|railstation|platform_|light.?rail/i;
const DROP_SOURCES = new Set([
  'stations',
  'platforms',
  'busses',
  'ch.sbb.passagier_freq',
  'ch_borders',
  'journey_pois',
  'perimeter_mask',
]);

export function rewriteGeopsValue(value) {
  if (typeof value === 'string') {
    return value
      .replace(/https:\/\/maps\.geops\.io(\/[^?\s"']*)/g, (_match, pathname) => {
        return `/proxy/geops${pathname}`;
      })
      .replace(/\/proxy\?mode=geops&u=(\/[^?\s"']*)/g, '/proxy/geops$1')
      .replace(/[?&]key=[^&"']+/g, '')
      .replace(/\?&/g, '?')
      .replace(/\?$/g, '');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteGeopsValue(entry));
  }
  if (value && typeof value === 'object') {
    const next = {};
    Object.entries(value).forEach(([key, entry]) => {
      next[key] = rewriteGeopsValue(entry);
    });
    return next;
  }
  return value;
}

function softenLightBasemap(style) {
  if (!Array.isArray(style?.layers)) {
    return style;
  }
  return {
    ...style,
    layers: style.layers.map((layer) => {
      if (layer?.type !== 'background') {
        return layer;
      }
      const paint = { ...(layer.paint ?? {}) };
      const current = paint['background-color'];
      if (
        current === undefined ||
        current === '#ffffff' ||
        current === '#fff' ||
        current === 'white'
      ) {
        paint['background-color'] = LIGHT_BASEMAP_SURFACE;
      }
      return { ...layer, paint };
    }),
  };
}

export function stripRailwayLayers(style) {
  const layers = Array.isArray(style.layers) ? style.layers : [];
  const sources = { ...(style.sources ?? {}) };
  DROP_SOURCES.forEach((sourceId) => {
    delete sources[sourceId];
  });
  return {
    ...style,
    sources,
    layers: layers.filter((layer) => {
      const id = String(layer?.id ?? '');
      const source = String(layer?.source ?? '');
      const sourceLayer = String(layer?.['source-layer'] ?? '');
      if (DROP_SOURCES.has(source)) {
        return false;
      }
      if (sourceLayer.toLowerCase().includes('rail')) {
        return false;
      }
      if (sourceLayer === 'public_transport' && /station|platform/i.test(id)) {
        return false;
      }
      return !RAIL_LAYER.test(id);
    }),
  };
}

function safeUpstreamPath(raw) {
  const pathname = decodeURIComponent(String(raw ?? '')).split('?')[0];
  if (!pathname.startsWith('/') || pathname.includes('..')) {
    return null;
  }
  return pathname;
}

function cacheFileForPath(cacheDir, pathname) {
  const safe = pathname.replace(/[^a-zA-Z0-9._/-]+/g, '_').replace(/^\/+/, '');
  return path.join(cacheDir, 'geops', safe);
}

function encodePathname(pathname) {
  return pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function fetchGeops(pathname, apiKey) {
  const encodedPath = encodePathname(pathname);
  const separator = encodedPath.includes('?') ? '&' : '?';
  const url = `${GEOPS_ORIGIN}${encodedPath}${apiKey ? `${separator}key=${apiKey}` : ''}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': '3Drail-frontend/1.0 (railmap proxy)' },
    signal: AbortSignal.timeout(20000),
  });
  return response;
}

export async function fetchGeopsStyle(apiKey, cacheDir, theme = 'dark') {
  if (!apiKey) {
    return null;
  }
  const resolvedTheme = theme === 'light' ? 'light' : 'dark';
  const cacheName = STYLE_CACHE_NAMES[resolvedTheme];
  const cacheFile = cacheDir ? path.join(cacheDir, 'geops', cacheName) : null;
  if (cacheFile && fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return resolvedTheme === 'light' ? softenLightBasemap(cached) : cached;
    } catch {
      // Fetch a fresh copy if the cache is corrupt.
    }
  }
  const styleIds = GEOPS_STYLE_IDS[resolvedTheme];
  let lastError = new Error(`geOps ${resolvedTheme} style missing`);
  for (const styleId of styleIds) {
    const response = await fetchGeops(`/styles/${styleId}/style.json`, apiKey);
    if (!response.ok) {
      lastError = new Error(`geOps style ${styleId} HTTP ${response.status}`);
      continue;
    }
    let json = stripRailwayLayers(rewriteGeopsValue(await response.json()));
    if (resolvedTheme === 'light') {
      json = softenLightBasemap(json);
    }
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(json));
    }
    return json;
  }
  throw lastError;
}

export async function fetchGeopsAsset(cacheDir, apiKey, rawPath) {
  const pathname = safeUpstreamPath(rawPath);
  if (!pathname || !apiKey) {
    return null;
  }
  const file = cacheFileForPath(cacheDir, pathname);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    if (pathname.endsWith('.json')) {
      const json = rewriteGeopsValue(JSON.parse(fs.readFileSync(file, 'utf8')));
      return { buffer: Buffer.from(JSON.stringify(json)), json };
    }
    return { buffer: fs.readFileSync(file), json: null };
  }
  const response = await fetchGeops(pathname, apiKey);
  if (!response.ok) {
    if (pathname.includes('@2x')) {
      return fetchGeopsAsset(cacheDir, apiKey, pathname.replace('@2x', ''));
    }
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json') || pathname.endsWith('.json')) {
    const json = rewriteGeopsValue(await response.json());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json));
    return { buffer: Buffer.from(JSON.stringify(json)), json };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return { buffer, json: null };
}
