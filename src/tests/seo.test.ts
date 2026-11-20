import { describe, expect, it } from 'vitest';
import { seoFor } from '../seo';

describe('seoFor', () => {
  it('titles the home page and stays under search-result limits', () => {
    const sk = seoFor('sk', { kind: 'home' });
    expect(sk.title).toContain('Môj Vlak');
    expect(sk.title).toMatch(/^Mapa vlakov a poloha vlakov/);
    expect(sk.title.length).toBeLessThanOrEqual(60);
    expect(sk.description.length).toBeLessThanOrEqual(170);
  });

  it('names a train with its destination', () => {
    const seo = seoFor('sk', { kind: 'train', label: 'R 744 Ponitran', destination: 'Bratislava' });
    expect(seo.title).toBe('R 744 Ponitran → Bratislava – poloha vlaku a meškanie | Môj Vlak');
    expect(seo.description).toContain('Živá poloha vlaku R 744 Ponitran');
  });

  it('names a station and speaks English when asked', () => {
    expect(seoFor('en', { kind: 'station', name: 'Trnava' }).title).toBe(
      'Trnava – train departures and arrivals | Môj Vlak'
    );
  });
});
