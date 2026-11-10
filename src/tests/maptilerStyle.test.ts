import { describe, expect, it } from 'vitest';
import {
  maptilerPathFromRequest,
  railatlasStyle,
  withAbsoluteAssetUrls,
} from '../../proxy/maptilerStyle.mjs';

describe('railatlasStyle', () => {
  it('keeps overlay hook layer ids and MapTiler sources', () => {
    const style = railatlasStyle('light');
    const ids = style.layers.map((layer: { id: string }) => layer.id);
    expect(ids).toContain('background_fill');
    expect(ids).toContain('background_relief');
    expect(style.sources.basemap.tiles[0]).toContain('/proxy/maptiler/tiles/v3/');
    expect(style.sources.relief.encoding).toBe('terrarium');
    expect(style.glyphs).toContain('/proxy/maptiler/fonts/');
    expect(JSON.stringify(style)).not.toMatch(/geops|sbb|trafimage/i);
  });

  it('uses a darker canvas in dark mode', () => {
    const light = railatlasStyle('light');
    const dark = railatlasStyle('dark');
    expect(light.layers[0].paint['background-color']).toBe('#ebebeb');
    expect(dark.layers[0].paint['background-color']).toBe('#292929');
  });
});

describe('withAbsoluteAssetUrls', () => {
  it('prefixes relative tile and glyph urls', () => {
    const style = withAbsoluteAssetUrls(railatlasStyle('light'), 'https://railatlas.eu');
    expect(style.sources.basemap.tiles[0]).toBe(
      'https://railatlas.eu/proxy/maptiler/tiles/v3/{z}/{x}/{y}.pbf'
    );
    expect(style.glyphs).toBe('https://railatlas.eu/proxy/maptiler/fonts/{fontstack}/{range}.pbf');
  });
});

describe('maptilerPathFromRequest', () => {
  it('accepts vite-stripped and production prefixes', () => {
    expect(maptilerPathFromRequest(new URL('http://127.0.0.1/maptiler/tiles/v3/7/70/44.pbf'))).toBe(
      '/tiles/v3/7/70/44.pbf'
    );
    expect(
      maptilerPathFromRequest(new URL('https://railatlas.eu/proxy/maptiler/fonts/Noto%20Sans%20Regular/0-255.pbf'))
    ).toBe('/fonts/Noto Sans Regular/0-255.pbf');
  });
});
