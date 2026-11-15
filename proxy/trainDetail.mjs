function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function titled(chunk, key) {
  const match = chunk.match(new RegExp(`lang-title-key="${key}"[^>]*>\\s*([^<]*)`));
  if (!match) {
    return '';
  }
  return decodeEntities(match[1]).replace(/[()]/g, '').trim();
}

/**
 * Turn the HTML partial from mapa.zsr.sk/Start/TrainDetail into station rows.
 * The official map loads this same partial when a train path is opened.
 */
export function parseTrainDetail(html) {
  const rows = String(html).split(/<div class="row /).slice(1);
  const stops = [];

  for (const chunk of rows) {
    const className = chunk.slice(0, chunk.indexOf('"'));
    const currentName = chunk.match(/id="currentStation"[^>]*>([^<]+)/);
    const plainName = chunk.match(
      /<span class="(?:futureName|pastName)?">\s*([^<]+?)\s*<\/span>/
    );
    const name = decodeEntities((currentName?.[1] || plainName?.[1] || '').trim());
    if (!name) {
      continue;
    }

    const state =
      chunk.includes('timeline__marker--live') || chunk.includes('id="currentStation"')
        ? 'current'
        : className.includes('row__before')
          ? 'passed'
          : 'ahead';

    stops.push({
      name,
      arrival: titled(chunk, 'arrival') || titled(chunk, 'arrivalEst'),
      departure: titled(chunk, 'depart') || titled(chunk, 'departEst'),
      scheduledArrival: titled(chunk, 'arrivalGvd'),
      scheduledDeparture: titled(chunk, 'departGvd'),
      state,
      // mapa.zsr.sk marks stops served by replacement buses (náhradná autobusová doprava).
      ...(/lang-title-key="nadKey"|timeline__marker__nad/.test(chunk) ? { bus: true } : {}),
    });
  }

  return stops;
}

/**
 * Operational points that never serve passengers: junctions (Odb.), passing
 * loops (Výh., "výh. č."), automatic block signals (AH), sidings (Vlečka),
 * region borders, km posts, freight yards and state borders.
 */
const NON_STOP_NAME =
  /^(odb\.?|odbočka|výh\.?|vyh\.?|ah|vlečka|vlecka|hranica|km|hláska|hlaska)\s|\svýh\.\s*č\.|\sodb\.?$|nákladná stanic|tranzitná skupina|zriaďovacia stanica|\sšt\.\s*hr\.?$/i;

export function isNonStopName(name) {
  return NON_STOP_NAME.test(String(name ?? '').trim());
}

export function normalizeStationName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const hasTime = (value) => /\d{1,2}:\d{2}/.test(String(value ?? ''));

/**
 * What the train does at each row still ahead of it, read from ZSR: it only gives times
 * for the stops it will call at. Returns [normalizedName, 'stop' | 'pass'] pairs to remember,
 * because once the train has passed a row ZSR shows times there either way.
 */
export function aheadKinds(rows) {
  const out = [];
  rows.forEach((row, index) => {
    if (row.state !== 'ahead' || index === 0 || index === rows.length - 1 || row.bus || isNonStopName(row.name)) {
      return;
    }
    out.push([normalizeStationName(row.name), hasTime(row.scheduledArrival) || hasTime(row.scheduledDeparture) ? 'stop' : 'pass']);
  });
  return out;
}

/**
 * Whether the train calls at each row ('stop') or only runs through it ('pass').
 *
 * Rows ahead of the train are reliable: mapa.zsr.sk gives times only where it
 * stops. Rows already passed also carry times for points it ran through (they
 * reported), so there a name in the GTFS stop list of this train decides when
 * one is known (`gtfsStops`, normalized names), and a scheduled dwell always
 * counts as a stop (crossing waits at a passing loop included).
 */
export function classifyStops(stops, gtfsStops = null, memory = null) {
  const last = stops.length - 1;
  return stops.map((stop, index) => {
    if (index === 0 || index === last) {
      return { ...stop, kind: 'stop' };
    }
    const arr = stop.scheduledArrival;
    const dep = stop.scheduledDeparture;
    if (!hasTime(arr) && !hasTime(dep)) {
      return { ...stop, kind: 'pass' };
    }
    const dwells = hasTime(arr) && hasTime(dep) && arr !== dep;
    // A replacement bus calls at every stop it lists, whatever the train timetable says.
    if (stop.bus) {
      return { ...stop, kind: 'stop' };
    }
    if (isNonStopName(stop.name)) {
      return { ...stop, kind: dwells ? 'wait' : 'pass' };
    }
    if (stop.state !== 'ahead' && !dwells) {
      // Rows the train has passed carry times for everything it went through. What it did
      // at each was seen while the row was still ahead (no times = not a stop): trust that.
      const remembered = memory?.get(normalizeStationName(stop.name));
      if (remembered) {
        return { ...stop, kind: remembered };
      }
      if (gtfsStops && gtfsStops.size > 0) {
        return { ...stop, kind: gtfsStops.has(normalizeStationName(stop.name)) ? 'stop' : 'pass' };
      }
    }
    return { ...stop, kind: 'stop' };
  });
}
