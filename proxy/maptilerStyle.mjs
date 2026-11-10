import fs from 'node:fs';
import path from 'node:path';

const OPENFREEMAP_PLANET = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_FONTS = 'https://tiles.openfreemap.org/fonts';
const TERRARIUM_ORIGIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const VECTOR_MAX_ZOOM = 14;
const HILLSHADE_MAX_ZOOM = 12;
const BASEMAP_DETAIL_ZOOM = 14;
const MAP_VIEW_MAX_ZOOM = 16;
const PLANET_JSON_TTL_MS = 24 * 60 * 60 * 1000;

const PALETTES = {
  light: {
    background: '#ebebeb',
    wood: 'rgba(188, 188, 188, 1)',
    woodOpacity: [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      0,
      10.5,
      0.08,
      12,
      0.1,
      BASEMAP_DETAIL_ZOOM,
      0.12,
      MAP_VIEW_MAX_ZOOM,
      0.12,
    ],
    builtup: [
      'interpolate',
      ['linear'],
      ['zoom'],
      9.3,
      'rgba(220, 176, 153, 1)',
      12,
      'rgba(203, 176, 164, 1)',
    ],
    builtupOpacity: [
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      0,
      7,
      0.2,
      13.5,
      0.2,
      BASEMAP_DETAIL_ZOOM,
      0.2,
      MAP_VIEW_MAX_ZOOM,
      0.2,
    ],
    grass: 'rgba(226, 226, 226, 1)',
    forest: 'rgba(232, 232, 232, 1)',
    wetland: 'rgba(226, 226, 226, 1)',
    farmland: 'rgba(228, 228, 228, 1)',
    water: [
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      'rgba(154, 162, 168, 1)',
      11,
      'rgba(170, 176, 180, 1)',
    ],
    borderRibbon: '#b3b3b3',
    border: '#7a7a7a',
    street: '#ffffff',
    streetMajor: 'rgba(243, 234, 216, 1)',
    streetOutline: 'rgba(169, 163, 163, 1)',
    path: 'rgba(247, 242, 237, 1)',
    building: 'rgba(208, 208, 210, 1)',
    buildingOutline: 'rgba(224, 224, 226, 1)',
    label: 'rgba(88, 88, 88, 1)',
    labelHalo: 'rgba(247, 246, 246, 1)',
    waterLabel: 'rgba(72, 78, 82, 1)',
  },
  dark: {
    background: '#292929',
    wood: 'rgba(36, 36, 36, 1)',
    woodOpacity: [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      0,
      10.5,
      0.05,
      12,
      0.06,
      BASEMAP_DETAIL_ZOOM,
      0.08,
      MAP_VIEW_MAX_ZOOM,
      0.08,
    ],
    builtup: [
      'interpolate',
      ['linear'],
      ['zoom'],
      9.3,
      'rgba(92, 72, 64, 1)',
      12,
      'rgba(78, 66, 62, 1)',
    ],
    builtupOpacity: [
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      0,
      7,
      0.28,
      13.5,
      0.22,
      BASEMAP_DETAIL_ZOOM,
      0.22,
      MAP_VIEW_MAX_ZOOM,
      0.22,
    ],
    grass: 'rgba(34, 34, 34, 1)',
    forest: 'rgba(32, 32, 32, 1)',
    wetland: 'rgba(35, 35, 35, 1)',
    farmland: 'rgba(37, 37, 37, 1)',
    water: [
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      'rgba(50, 50, 50, 1)',
      11,
      'rgba(56, 56, 56, 1)',
    ],
    borderRibbon: '#4a4a4a',
    border: '#737373',
    street: '#3a3a3a',
    streetMajor: '#454545',
    streetOutline: '#2a2a2a',
    path: '#3f3d3b',
    building: '#3c3c3c',
    buildingOutline: '#484848',
    label: 'rgba(214, 214, 214, 1)',
    labelHalo: 'rgba(28, 28, 28, 1)',
    waterLabel: 'rgba(130, 130, 130, 1)',
  },
};

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track'];
const PATH_CLASSES = ['path'];
const BUILTUP_CLASSES = ['residential', 'suburb', 'neighbourhood', 'quarter', 'commercial', 'industrial', 'retail'];

function streetWidth(scale) {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    9,
    ['match', ['get', 'class'], 'motorway', 1.1 * scale, 'trunk', 0.95 * scale, 'primary', 0.8 * scale, 0.45 * scale],
    12,
    ['match', ['get', 'class'], 'motorway', 2.4 * scale, 'trunk', 2 * scale, 'primary', 1.6 * scale, 0.9 * scale],
    BASEMAP_DETAIL_ZOOM,
    ['match', ['get', 'class'], 'motorway', 5 * scale, 'trunk', 4.2 * scale, 'primary', 3.4 * scale, 1.8 * scale],
    MAP_VIEW_MAX_ZOOM,
    ['match', ['get', 'class'], 'motorway', 5 * scale, 'trunk', 4.2 * scale, 'primary', 3.4 * scale, 1.8 * scale],
  ];
}

export function railatlasStyle(theme = 'light') {
  const night = theme === 'dark';
  const p = PALETTES[night ? 'dark' : 'light'];
  return {
    version: 8,
    name: night ? 'railatlas-dark' : 'railatlas-light',
    glyphs: '/proxy/maptiler/fonts/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'vector',
        tiles: ['/proxy/maptiler/tiles/v3/{z}/{x}/{y}.pbf'],
        maxzoom: VECTOR_MAX_ZOOM,
        attribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors',
      },
      relief: {
        type: 'raster-dem',
        tiles: ['/proxy/maptiler/tiles/hillshade/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: HILLSHADE_MAX_ZOOM,
        encoding: 'terrarium',
        attribution: '© Mapzen / AWS Terrain Tiles',
      },
    },
    layers: [
      {
        id: 'background_fill',
        type: 'background',
        paint: { 'background-color': p.background },
      },
      {
        id: 'background_relief',
        type: 'hillshade',
        source: 'relief',
        minzoom: 5,
        maxzoom: MAP_VIEW_MAX_ZOOM,
        paint: {
          'hillshade-exaggeration': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0,
            6,
            night ? 0.24 : 0.26,
            12,
            night ? 0.2 : 0.22,
            BASEMAP_DETAIL_ZOOM,
            night ? 0.2 : 0.22,
            MAP_VIEW_MAX_ZOOM,
            night ? 0.2 : 0.22,
          ],
          'hillshade-illumination-direction': 315,
          'hillshade-shadow-color': night ? '#050505' : '#c8c4be',
          'hillshade-highlight-color': night ? '#3a3a38' : '#ffffff',
          'hillshade-accent-color': night ? '#101010' : '#ddd8d2',
        },
      },
      {
        id: 'land_wood',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'wood'],
        paint: {
          'fill-antialias': false,
          'fill-color': p.wood,
          'fill-opacity': p.woodOpacity,
        },
      },
      {
        id: 'land_builtup',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landuse',
        minzoom: 6,
        filter: ['match', ['get', 'class'], BUILTUP_CLASSES, true, false],
        paint: {
          'fill-antialias': false,
          'fill-color': p.builtup,
          'fill-opacity': p.builtupOpacity,
        },
      },
      {
        id: 'land_cover',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        minzoom: 10,
        filter: ['match', ['get', 'class'], ['grass', 'farmland', 'wetland', 'wood'], true, false],
        paint: {
          'fill-antialias': false,
          'fill-color': [
            'match',
            ['get', 'class'],
            'wood',
            p.forest,
            'wetland',
            p.wetland,
            'farmland',
            p.farmland,
            p.grass,
          ],
          'fill-opacity': night
            ? [
                'interpolate',
                ['linear'],
                ['zoom'],
                10,
                0,
                12,
                0.18,
                BASEMAP_DETAIL_ZOOM,
                0.26,
                MAP_VIEW_MAX_ZOOM,
                0.26,
              ]
            : [
                'interpolate',
                ['linear'],
                ['zoom'],
                10,
                0,
                12,
                0.38,
                BASEMAP_DETAIL_ZOOM,
                0.5,
                MAP_VIEW_MAX_ZOOM,
                0.5,
              ],
        },
      },
      {
        id: 'borders_ribbon',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundary',
        minzoom: 0,
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.borderRibbon,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 6, 3, 9, 9, 11, 12],
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': p.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'basemap',
        'source-layer': 'waterway',
        minzoom: 8,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.water,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.6,
            11,
            1.4,
            BASEMAP_DETAIL_ZOOM,
            2.4,
            MAP_VIEW_MAX_ZOOM,
            2.4,
          ],
        },
      },
      {
        id: 'borders',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundary',
        minzoom: 6,
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.border,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 6, 1, 9, 1.5, 11, 2],
        },
      },
      {
        id: 'streets_outline',
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 9,
        filter: [
          'all',
          ['match', ['get', 'class'], ROAD_CLASSES, true, false],
          ['!=', ['get', 'brunnel'], 'tunnel'],
        ],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.streetOutline,
          'line-width': streetWidth(1.35),
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            0.35,
            12,
            0.85,
            BASEMAP_DETAIL_ZOOM,
            0.85,
            MAP_VIEW_MAX_ZOOM,
            0.85,
          ],
        },
      },
      {
        id: 'streets',
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 9,
        filter: [
          'all',
          ['match', ['get', 'class'], ROAD_CLASSES, true, false],
          ['!=', ['get', 'brunnel'], 'tunnel'],
        ],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'class'],
            ['motorway', 'trunk'],
            p.streetMajor,
            p.street,
          ],
          'line-width': streetWidth(1),
        },
      },
      {
        id: 'paths',
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 14,
        filter: ['match', ['get', 'class'], PATH_CLASSES, true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.path,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            BASEMAP_DETAIL_ZOOM,
            0.6,
            MAP_VIEW_MAX_ZOOM,
            0.6,
          ],
        },
      },
      {
        id: 'tunnel_streets',
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 11,
        filter: [
          'all',
          ['match', ['get', 'class'], ROAD_CLASSES, true, false],
          ['==', ['get', 'brunnel'], 'tunnel'],
        ],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': p.street,
          'line-width': streetWidth(0.9),
          'line-opacity': 0.45,
        },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'building',
        minzoom: 14,
        paint: { 'fill-color': p.building, 'fill-opacity': 0.85 },
      },
      {
        id: 'buildings_outline',
        type: 'line',
        source: 'basemap',
        'source-layer': 'building',
        minzoom: 15,
        paint: { 'line-color': p.buildingOutline, 'line-width': 0.6 },
      },
      {
        id: 'label_water',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'water_name',
        minzoom: 10,
        layout: {
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 12,
          'text-max-width': 8,
          'text-letter-spacing': 0.08,
        },
        paint: {
          'text-color': p.waterLabel,
          'text-halo-color': p.labelHalo,
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'label_place_names',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'place',
        minzoom: 7,
        maxzoom: 16,
        filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'hamlet', 'suburb'], true, false],
        layout: {
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            7,
            ['match', ['get', 'class'], 'city', 13, 'town', 11, 10],
            12,
            ['match', ['get', 'class'], 'city', 16, 'town', 13, 11],
          ],
          'text-padding': 10,
          'text-max-width': 8,
          'text-letter-spacing': 0.08,
        },
        paint: {
          'text-color': p.label,
          'text-halo-color': p.labelHalo,
          'text-halo-width': 1.6,
        },
      },
    ],
  };
}

export function withAbsoluteAssetUrls(style, origin) {
  const root = String(origin ?? '').replace(/\/$/, '');
  if (!root) {
    return style;
  }
  const abs = (value) =>
    typeof value === 'string' && value.startsWith('/') ? `${root}${value}` : value;
  const sources = Object.fromEntries(
    Object.entries(style.sources ?? {}).map(([id, source]) => {
      if (!source || typeof source !== 'object') {
        return [id, source];
      }
      const next = { ...source };
      if (Array.isArray(next.tiles)) {
        next.tiles = next.tiles.map(abs);
      }
      if (typeof next.url === 'string') {
        next.url = abs(next.url);
      }
      return [id, next];
    })
  );
  return {
    ...style,
    glyphs: abs(style.glyphs),
    sprite: abs(style.sprite),
    sources,
  };
}

export function maptilerPathFromRequest(reqUrl) {
  const pathname = reqUrl.pathname;
  for (const prefix of ['/proxy/maptiler', '/maptiler']) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const sliced = pathname.slice(prefix.length) || '/';
      try {
        return decodeURIComponent(sliced);
      } catch {
        return sliced;
      }
    }
  }
  return null;
}

function safeMaptilerPath(raw) {
  const pathname = decodeURIComponent(String(raw ?? '')).split('?')[0];
  if (!pathname.startsWith('/') || pathname.includes('..')) {
    return null;
  }
  if (/^\/tiles\/v3\/\d+\/\d+\/\d+\.pbf$/.test(pathname)) {
    return pathname;
  }
  if (/^\/tiles\/hillshade\/\d+\/\d+\/\d+\.(png|webp)$/.test(pathname)) {
    return pathname;
  }
  if (/^\/fonts\/[^/]+\/\d+-\d+\.pbf$/.test(pathname)) {
    return pathname;
  }
  return null;
}

function cacheFileForPath(cacheDir, pathname) {
  const safe = pathname.replace(/[^a-zA-Z0-9._/-]+/g, '_').replace(/^\/+/, '');
  return path.join(cacheDir, 'maptiler', safe);
}

function fallbackPlanetTileUrl(z, x, y) {
  return `${OPENFREEMAP_PLANET}/${z}/${x}/${y}`;
}

async function planetTileUrl(cacheDir, z, x, y) {
  const file = path.join(cacheDir, 'maptiler', 'planet.json');
  let json = null;
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < PLANET_JSON_TTL_MS) {
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      json = null;
    }
  }
  if (!json?.tiles?.[0]) {
    try {
      const response = await fetch(OPENFREEMAP_PLANET, {
        headers: { 'User-Agent': 'railatlas/1.0 (openfreemap proxy)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error(`OpenFreeMap planet JSON HTTP ${response.status}`);
      }
      json = await response.json();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
    } catch {
      return fallbackPlanetTileUrl(z, x, y);
    }
  }
  if (!json?.tiles?.[0]) {
    return fallbackPlanetTileUrl(z, x, y);
  }
  return String(json.tiles[0])
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

function upstreamUrl(pathname, cacheDir) {
  const vector = pathname.match(/^\/tiles\/v3\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (vector) {
    return planetTileUrl(cacheDir, vector[1], vector[2], vector[3]);
  }
  const font = pathname.match(/^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/);
  if (font) {
    return `${OPENFREEMAP_FONTS}/${encodeURIComponent(font[1])}/${font[2]}.pbf`;
  }
  const hill = pathname.match(/^\/tiles\/hillshade\/(\d+)\/(\d+)\/(\d+)\.(?:png|webp)$/);
  if (hill) {
    return `${TERRARIUM_ORIGIN}/${hill[1]}/${hill[2]}/${hill[3]}.png`;
  }
  return null;
}

export async function fetchMaptilerAsset(cacheDir, _apiKey, rawPath) {
  const pathname = safeMaptilerPath(rawPath);
  if (!pathname) {
    return null;
  }
  const file = cacheFileForPath(cacheDir, pathname);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { buffer: fs.readFileSync(file), contentType: contentTypeFor(pathname) };
  }
  let url;
  try {
    url = await upstreamUrl(pathname, cacheDir);
  } catch {
    return null;
  }
  if (!url) {
    return null;
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'railatlas/1.0 (basemap proxy)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return {
    buffer,
    contentType: contentTypeFor(pathname, response.headers.get('content-type')),
  };
}

function contentTypeFor(pathname, header) {
  if (pathname.endsWith('.pbf')) {
    return pathname.includes('/fonts/') ? 'application/x-protobuf' : 'application/vnd.mapbox-vector-tile';
  }
  if (pathname.endsWith('.png')) {
    return 'image/png';
  }
  if (pathname.endsWith('.webp')) {
    return 'image/webp';
  }
  return header || 'application/octet-stream';
}
