import type { AppLocale } from '../i18n';

/**
 * Link to a train's composition (wagon order) on vagonWEB, the Czech-Slovak railway coach
 * database. The vagonWEB team allows linking to their train pages; there is no API yet.
 * Verified pattern: /razeni/vlak.php?zeme=ZSSK&kategorie=Ex&cislo=42&rok=2026[&lang=en]
 */
export const VAGONWEB_HOME = 'https://www.vagonweb.cz/';

/** Our train types -> the category codes vagonWEB uses for ZSSK trains. */
const CATEGORY: Record<string, string> = {
  os: 'Os',
  zr: 'Zr',
  r: 'R',
  rex: 'REX',
  ex: 'Ex',
  ec: 'EC',
  en: 'EN',
  sc: 'SC',
  rj: 'RJ',
  railjet: 'RJ',
  rjx: 'RJX',
};

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export function vagonwebTrainUrl(
  train: { trainType?: string; trainNumber: string; operator?: string },
  locale: AppLocale,
  year = new Date().getFullYear()
): string | null {
  const category = CATEGORY[fold(train.trainType ?? '').trim()];
  const number = String(train.trainNumber ?? '').trim();
  // Only ZSSK trains: vagonWEB files other operators' trains under their own country or carrier.
  const isZssk = /zeleznicna spolocnost slovensko|zssk/.test(fold(train.operator ?? ''));
  if (!category || !/^\d{1,5}$/.test(number) || !isZssk) {
    return null;
  }
  const query = new URLSearchParams({ zeme: 'ZSSK', kategorie: category, cislo: number, rok: String(year) });
  // vagonWEB has no Slovak interface; Czech is the closest, English for the EN switch.
  query.set('lang', locale === 'en' ? 'en' : 'cs');
  return `https://www.vagonweb.cz/razeni/vlak.php?${query.toString()}`;
}
