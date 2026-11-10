const CP_BOARD_URL = 'https://cp.sk/vlakbusmhd/odchody/';

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' '));
}

function timeFromDatetime(value) {
  const match = String(value ?? '').match(/(\d{1,2}:\d{2})/);
  return match?.[1] ?? '';
}

function trainNumberFromCode(code) {
  const match = String(code ?? '').match(/(\d{1,6})\b/);
  return match?.[1] ?? '';
}

export function parseStationBoard(html) {
  const chunks = String(html).split(/<tr class="dep-row dep-row-first"/i).slice(1);
  const rows = [];
  chunks.forEach((chunk) => {
    const destination = decodeEntities((chunk.match(/data-stationname="([^"]*)"/i) || [])[1] || '');
    const datetime = decodeEntities((chunk.match(/data-datetime="([^"]*)"/i) || [])[1] || '');
    const trainId = decodeEntities((chunk.match(/data-train="([^"]*)"/i) || [])[1] || '');
    const code = stripTags(
      (chunk.match(/<span class="code">[\s\S]*?<h3[^>]*>\s*([^<]+)/i) || [])[1] || ''
    );
    const via = decodeEntities((chunk.match(/title="prech[^"]*"[\s\S]*?cez\s+([^<]+)/i) || [])[1] || '');
    const operator = decodeEntities((chunk.match(/title="dopravce"[^>]*>([^<]+)/i) || [])[1] || '');
    const delayText = decodeEntities((chunk.match(/class="delay-bubble[^"]*"[^>]*>([^<]+)/i) || [])[1] || '');
    const delayMatch = delayText.match(/(\d+)/);
    const time = timeFromDatetime(datetime) || decodeEntities((chunk.match(/<h3>(\d{1,2}:\d{2})<\/h3>/) || [])[1] || '');
    if (!time && !code && !destination) {
      return;
    }
    rows.push({
      time,
      datetime,
      code,
      trainId,
      trainNumber: trainNumberFromCode(code),
      destination,
      via,
      operator,
      delayText,
      delayMinutes: delayMatch ? Number(delayMatch[1]) : 0,
    });
  });
  return rows;
}

export async function fetchStationBoard(stationName, arrivals) {
  const name = String(stationName ?? '').trim();
  if (!name) {
    return { station: '', arrivals: Boolean(arrivals), rows: [], status: 'error', error: 'Missing station' };
  }
  const url = new URL(CP_BOARD_URL);
  url.searchParams.set('f', name);
  url.searchParams.set('submit', 'true');
  url.searchParams.set('changeShield', 'true');
  if (arrivals) {
    url.searchParams.set('byarr', 'true');
  }
  const response = await fetch(url, {
    headers: {
      'User-Agent': '3Drail-frontend/1.0 (railmap station board)',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`cp.sk HTTP ${response.status}`);
  }
  const html = await response.text();
  const rows = parseStationBoard(html);
  return {
    station: name,
    arrivals: Boolean(arrivals),
    source: CP_BOARD_URL,
    status: rows.length > 0 ? 'ok' : 'empty',
    rows,
  };
}
