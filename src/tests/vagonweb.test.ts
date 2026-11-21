import { describe, expect, it } from 'vitest';
import { vagonwebTrainUrl } from '../data/vagonweb';

const ZSSK = 'Železničná spoločnosť Slovensko, a.s.';

describe('vagonwebTrainUrl', () => {
  it('builds the page of a ZSSK train', () => {
    expect(vagonwebTrainUrl({ trainType: 'Ex', trainNumber: '42', operator: ZSSK }, 'sk', 2026)).toBe(
      'https://www.vagonweb.cz/razeni/vlak.php?zeme=ZSSK&kategorie=Ex&cislo=42&rok=2026&lang=cs'
    );
    expect(vagonwebTrainUrl({ trainType: 'Os', trainNumber: '4717', operator: ZSSK }, 'en', 2026)).toContain(
      'kategorie=Os&cislo=4717&rok=2026&lang=en'
    );
  });

  it('maps railjet and keeps the category codes vagonWEB uses', () => {
    expect(vagonwebTrainUrl({ trainType: 'railjet', trainNumber: '273', operator: ZSSK }, 'sk', 2026)).toContain(
      'kategorie=RJ&cislo=273'
    );
    expect(vagonwebTrainUrl({ trainType: 'REX', trainNumber: '1870', operator: ZSSK }, 'sk', 2026)).toContain(
      'kategorie=REX'
    );
  });

  it('gives nothing for other operators, unknown types or odd numbers', () => {
    expect(vagonwebTrainUrl({ trainType: 'Ex', trainNumber: '1', operator: 'RegioJet a. s.' }, 'sk')).toBeNull();
    expect(vagonwebTrainUrl({ trainType: 'Os', trainNumber: '8', operator: 'Leo Express Slovensko s.r.o.' }, 'sk')).toBeNull();
    expect(vagonwebTrainUrl({ trainType: 'Bus', trainNumber: '8', operator: ZSSK }, 'sk')).toBeNull();
    expect(vagonwebTrainUrl({ trainType: 'Os', trainNumber: '12a', operator: ZSSK }, 'sk')).toBeNull();
    expect(vagonwebTrainUrl({ trainType: 'Os', trainNumber: '12', operator: undefined }, 'sk')).toBeNull();
  });
});
