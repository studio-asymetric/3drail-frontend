import { SLOVAK_PLACES } from './slovakPlaces';

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** folded name -> name as written ("nove zamky" -> "Nové Zámky") */
let places: Map<string, string> | null = null;
function placeMap() {
  if (!places) {
    places = new Map();
    SLOVAK_PLACES.forEach((name) => {
      const key = fold(name);
      if (key && !places!.has(key)) {
        places!.set(key, name);
      }
    });
  }
  return places;
}

/** Words that only describe the station, never the town (also for stations abroad). */
const STATION_WORDS = new Set([
  'hlavna',
  'hlavni',
  'hl',
  'st',
  'stanica',
  'zastavka',
  'nadrazi',
  'predmestie',
  'hbf',
  'hauptbahnhof',
  'keleti',
  'nyugati',
  'deli',
  'jih',
  'sever',
  'hr',
  'odb',
  'wschodnia',
  'zachodnia',
  'centralna',
  'glowna',
  'gl',
  'hlavny',
  'nadrazie',
  'bahnhof',
  'bf',
  'palyaudvar',
  'pu',
]);

/**
 * "Bratislava hlavná stanica" -> "Bratislava", "Poprad-Tatry" -> "Poprad", "Čadca št. hr." ->
 * "Čadca": the longest Slovak town or village the station name starts with. Names that are
 * no Slovak place (abroad) lose the station words instead: "Praha hl.n." -> "Praha".
 */
export function townOf(stationName: string): string {
  const trimmed = stationName.trim();
  if (!trimmed) {
    return trimmed;
  }
  const tokens = fold(trimmed).split(' ').filter(Boolean);
  const map = placeMap();
  for (let count = tokens.length; count >= 1; count -= 1) {
    const hit = map.get(tokens.slice(0, count).join(' '));
    if (hit) {
      return hit;
    }
  }
  // Not a Slovak place: keep the leading words up to the first station word.
  const original = trimmed.split(/[\s-]+/).filter(Boolean);
  const keep: string[] = [];
  for (const word of original) {
    if (STATION_WORDS.has(fold(word)) && keep.length > 0) {
      break;
    }
    keep.push(word);
  }
  return keep.join(' ') || trimmed;
}

/** Linking words inside a name: the first to be abbreviated ("nad" -> "n."). */
const LINKING_WORDS = new Set(['nad', 'pod', 'pri', 'na', 'v', 'vo', 'medzi', 'za', 'pred']);

const initial = (word: string) => (/^ch/i.test(word) ? word.slice(0, 2) : word.charAt(0)) + '.';

/**
 * The name from full to as short as it gets, one word more abbreviated at each step, least
 * important words first: "Nové Mesto nad Váhom" -> "Nové Mesto n. Váhom" -> "Nové Mesto n. V." ->
 * "N. Mesto n. V."; "Banská Bystrica" -> "B. Bystrica". The last main word always stays whole.
 */
export function abbreviationSteps(name: string): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const steps = [words.join(' ')];
  if (words.length < 2) {
    return steps;
  }
  const order: number[] = [];
  const linking = words.map((word, index) => (LINKING_WORDS.has(fold(word)) ? index : -1)).filter((index) => index >= 0);
  linking.forEach((index) => order.push(index));
  // what follows a linking word ("Váhom"): the qualifier of the name
  words.forEach((_, index) => {
    if (linking.some((link) => index > link) && !order.includes(index)) {
      order.push(index);
    }
  });
  // then the leading words, first to last, keeping the last main word whole
  const lastMain = linking.length > 0 ? linking[0] - 1 : words.length - 1;
  for (let index = 0; index < lastMain; index += 1) {
    if (!order.includes(index)) {
      order.push(index);
    }
  }
  const current = [...words];
  for (const index of order) {
    current[index] = initial(words[index]);
    steps.push(current.join(' '));
  }
  return steps;
}

/** Station words written out in full, and their usual short forms. */
// Word edges by hand:  does not count "ú" or "á" as letters.
const word = (text: string) => new RegExp(`(?<=^|[ -])${text}(?=$|[ -])`, 'i');
const STATION_SHORT: Array<[RegExp, string]> = [
  [word('hlavná stanica'), 'hl. st.'],
  [word('hlavné nádražie'), 'hl. n.'],
  [word('hlavní nádraží'), 'hl. n.'],
  [word('nákladná stanica'), 'nákl. st.'],
  [word('ústredná'), 'ústr.'],
  [word('zastávka'), 'zast.'],
  [word('stanica'), 'st.'],
];

/** The two cities with many stations: their stops are known as "BA-…", "KE-…". */
const CITY_SHORT: Array<[RegExp, string]> = [
  [/^Bratislava(?=[\s-])/, 'BA'],
  [/^Košice(?=[\s-])/, 'KE'],
];

/**
 * A station name short enough for one line ("Bratislava hlavná stanica" -> "Bratislava hl. st.",
 * "Bratislava-Petržalka" -> "BA-Petržalka", "Nové Mesto nad Váhom" -> "Nové Mesto n. V."):
 * each step only when the name is still longer than `max` characters.
 */
export function shortStationName(name: string, max = 18): string {
  let out = name.trim().replace(/\s+/g, ' ');
  if (out.length <= max) {
    return out;
  }
  for (const [pattern, short] of STATION_SHORT) {
    out = out.replace(pattern, short);
  }
  if (out.length <= max) {
    return out;
  }
  for (const [pattern, short] of CITY_SHORT) {
    out = out.replace(pattern, short);
  }
  if (out.length <= max) {
    return out;
  }
  const steps = abbreviationSteps(out);
  return steps.find((step) => step.length <= max) ?? steps[steps.length - 1];
}
