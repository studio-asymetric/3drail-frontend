import { describe, expect, it } from 'vitest';
import { shortStationName } from '../data/placeName';

describe('shortStationName', () => {
  it('keeps names that already fit', () => {
    ['Malacky', 'Kúty št. hr.', 'Výh. Svätý Jur', 'Kysucké Nové Mesto', 'Liptovský Mikuláš'].forEach((name) =>
      expect(shortStationName(name)).toBe(name)
    );
  });

  it('shortens the station words first', () => {
    expect(shortStationName('Bratislava hlavná stanica')).toBe('Bratislava hl. st.');
    expect(shortStationName('Košice hlavná stanica')).toBe('Košice hl. st.');
  });

  it('writes Bratislava and Košice stops the local way', () => {
    expect(shortStationName('Bratislava-Petržalka')).toBe('BA-Petržalka');
    expect(shortStationName('Bratislava-Vinohrady')).toBe('BA-Vinohrady');
    expect(shortStationName('Bratislava ústredná nákladná stanica')).toBe('BA ústr. nákl. st.');
  });

  it('abbreviates the least important words last', () => {
    expect(shortStationName('Nové Mesto nad Váhom')).toBe('Nové Mesto n. V.');
    expect(shortStationName('Lehota pod Vtáčnikom zastávka')).toBe('Lehota p. V. zast.');
  });
});
