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
    });
  }

  return stops;
}
