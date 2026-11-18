import { describe, expect, it } from 'vitest';
import { abbreviationSteps, townOf } from '../data/placeName';

describe('townOf', () => {
  it('reduces a station name to its town', () => {
    expect(townOf('Bratislava hlavná stanica')).toBe('Bratislava');
    expect(townOf('Bratislava-Nové Mesto')).toBe('Bratislava');
    expect(townOf('Poprad-Tatry')).toBe('Poprad');
    expect(townOf('Čadca št. hr.')).toBe('Čadca');
    expect(townOf('Žilina')).toBe('Žilina');
  });

  it('prefers the longest place, and an exact one over a prefix', () => {
    expect(townOf('Nové Zámky')).toBe('Nové Zámky');
    expect(townOf('Banská Bystrica')).toBe('Banská Bystrica');
    expect(townOf('Trnava')).toBe('Trnava');
    expect(townOf('Trnavá Hora')).toBe('Trnavá Hora');
  });

  it('drops station words from places abroad', () => {
    expect(townOf('Praha hl.n.')).toBe('Praha');
    expect(townOf('Budapest-Keleti')).toBe('Budapest');
    expect(townOf('Wien Hauptbahnhof')).toBe('Wien');
    expect(townOf('Praha jih')).toBe('Praha');
  });
});

describe('abbreviationSteps', () => {
  it('shortens one word at a time, least important first', () => {
    expect(abbreviationSteps('Banská Bystrica')).toEqual(['Banská Bystrica', 'B. Bystrica']);
    expect(abbreviationSteps('Nové Mesto nad Váhom')).toEqual([
      'Nové Mesto nad Váhom',
      'Nové Mesto n. Váhom',
      'Nové Mesto n. V.',
      'N. Mesto n. V.',
    ]);
    expect(abbreviationSteps('Spišská Nová Ves')).toEqual(['Spišská Nová Ves', 'S. Nová Ves', 'S. N. Ves']);
    expect(abbreviationSteps('Žilina')).toEqual(['Žilina']);
  });
});
