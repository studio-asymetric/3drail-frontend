/**
 * ZSSK "mimoriadnosti": the public Mastodon account @zssk_mimoriadne that ZSSK links from its
 * site posts every delay, cancellation and note about a train, and the line closures. Posts
 * follow one pattern ("Os 3101 (Myjava 04:01 - Trenčín 05:15) odrieknutý v úseku ..."), so
 * they are turned into structured events here.
 */

const ACCOUNT_ID = '110689585617761822';
export const MIMORIADNOSTI_URL = `https://mastodon.social/api/v1/accounts/${ACCOUNT_ID}/statuses?limit=40&exclude_replies=true`;
export const MIMORIADNOSTI_SOURCE = {
  name: '@zssk_mimoriadne',
  url: 'https://mastodon.social/@zssk_mimoriadne',
};

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };

/** Mastodon post HTML -> plain text, line breaks kept as spaces. */
export function postText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|apos);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, ' ')
    .trim();
}

const TRAIN_HEAD =
  /(?<![A-Za-z])([A-Za-z]{1,12})\s*(\d{1,5})\s*\(\s*([^()]+?)\s+(\d{1,2}:\d{2})\s*[-–—]\s*([^()]+?)\s+(\d{1,2}:\d{2})\s*\)/g;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim();
const normTime = (value) => {
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
};

/** What the rest of one train's sentence says. */
function classify(rest) {
  const text = clean(rest);
  const lower = text.toLowerCase();

  if (/odriekn/.test(lower)) {
    const full = /v celom úseku/.test(lower);
    const section = text.match(/v úseku\s+(.+?)\s+-\s+(.+?)(?:\.|\s+Náhrada|$)/i);
    const replacementMatch = text.match(/Náhrada:\s*(.*)$/i);
    const replacementText = clean(replacementMatch?.[1] ?? '');
    let replacement = null;
    if (replacementMatch) {
      replacement = /^bez náhrady/i.test(replacementText)
        ? { kind: 'none', text: 'bez náhrady' }
        : /autobus/i.test(replacementText)
          ? { kind: 'bus', text: replacementText }
          : { kind: 'train', text: replacementText };
    }
    return {
      kind: 'cancel',
      full,
      section: !full && section ? { from: clean(section[1]), to: clean(section[2]) } : null,
      replacement,
    };
  }

  const delay = text.match(/(predpokladan\S*|aktuáln\S*)?\s*me[sš]k\S*\s+zo stanice\s+(.+?)\s+(\d+)\s*min/i);
  if (delay) {
    return {
      kind: 'delay',
      station: clean(delay[2]),
      minutes: Number(delay[3]),
      forecast: /predpokladan/i.test(delay[1] ?? '') || /predpokladan/i.test(lower),
    };
  }

  if (/upozor/.test(lower)) {
    return { kind: 'note', note: clean(text.replace(/^upozorňujeme cestujúcich,?\s*(že)?\s*/i, '')) };
  }
  return { kind: 'info', note: text };
}

/** Day and time in Slovakia for an instant. */
function slovakParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Minutes since local midnight of the post's day for an "HH:MM" on that service day, rolled over midnight. */
function minutesOf(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * Turn the recent posts into events. `now` is a Date (tests pass their own).
 * Each post can name several trains; a post with none is a line notice.
 */
export function parsePosts(posts, now = new Date()) {
  const events = [];
  for (const post of posts) {
    if (post.reblog || !post.content) {
      continue;
    }
    const text = postText(post.content);
    const at = post.created_at;
    const base = { postId: String(post.id), at, url: post.url, text };
    TRAIN_HEAD.lastIndex = 0;
    const heads = [...text.matchAll(TRAIN_HEAD)];
    if (heads.length === 0) {
      const section = text.match(/v úseku\s+(.+?)\s+-\s+(.+?)(?:\s+od\b|\s+do\b|\.|,|$)/i);
      const lifted = /obnoven|opäť premáva|ukončen|odstránen/i.test(text);
      events.push({
        ...base,
        id: `${base.postId}`,
        kind: 'closure',
        train: null,
        section: section ? { from: clean(section[1]), to: clean(section[2]) } : null,
        lifted,
        bus: /autobus/i.test(text),
      });
      continue;
    }
    heads.forEach((head, index) => {
      const next = heads[index + 1];
      const rest = text.slice(head.index + head[0].length, next ? next.index : text.length);
      const detail = classify(rest);
      const fromTime = normTime(head[4]);
      const toTime = normTime(head[6]);
      // The service day is the post's day; a run that ends "earlier" than it starts ends tomorrow.
      const posted = slovakParts(new Date(at));
      const startMin = minutesOf(fromTime);
      const endMin = minutesOf(toTime) + (minutesOf(toTime) < startMin ? 1440 : 0);
      events.push({
        ...base,
        id: `${base.postId}:${head[1]}${head[2]}`,
        train: { type: head[1], number: head[2] },
        from: { name: clean(head[3]), time: fromTime },
        to: { name: clean(head[5]), time: toTime },
        // Minutes after midnight (Slovak time) of the day the post was written.
        endsAtMinute: endMin,
        postedDay: `${posted.year}-${String(posted.month).padStart(2, '0')}-${String(posted.day).padStart(2, '0')}`,
        ...detail,
      });
    });
  }
  return keepActive(events, now);
}

const ENDED_GRACE_MINUTES = 25;
const CLOSURE_KEEP_HOURS = 36;

/** Drop events about runs that are over, keep only the newest of each kind per train. */
export function keepActive(events, now = new Date()) {
  const nowParts = slovakParts(now);
  const today = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;
  const nowMinute = nowParts.hour * 60 + nowParts.minute;
  const seen = new Set();
  const active = [];
  const sorted = [...events].sort((left, right) => new Date(right.at) - new Date(left.at));
  for (const event of sorted) {
    if (event.kind === 'closure') {
      const ageHours = (now - new Date(event.at)) / 3_600_000;
      if (ageHours > CLOSURE_KEEP_HOURS || event.lifted) {
        continue;
      }
      active.push(event);
      continue;
    }
    // A run belongs to the day it was posted; it is over a little after its last stop.
    const dayDiff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${event.postedDay}T00:00:00Z`)) / 86_400_000);
    const endsAt = event.endsAtMinute - dayDiff * 1440;
    if (endsAt + ENDED_GRACE_MINUTES < nowMinute) {
      continue;
    }
    // Newest wins per train and kind (a delay that was updated, a cancellation repeated).
    const key = `${event.train.number}:${event.kind}:${event.kind === 'note' ? event.note : ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    active.push(event);
  }
  // A cancelled train's old delay report no longer matters.
  const cancelled = new Set(active.filter((event) => event.kind === 'cancel' && event.full).map((event) => event.train.number));
  return active.filter((event) => !(event.kind === 'delay' && cancelled.has(event.train?.number)));
}

let cache = { at: 0, payload: null };
const CACHE_MS = 120_000;

/** Fetch the feed (cached); returns the payload, the previous one if the fetch fails. */
export async function loadMimoriadnosti(fetchImpl = fetch, now = () => new Date()) {
  if (cache.payload && Date.now() - cache.at < CACHE_MS) {
    return cache.payload;
  }
  try {
    const response = await fetchImpl(MIMORIADNOSTI_URL, {
      headers: { 'User-Agent': 'railatlas-proxy/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const posts = await response.json();
    cache = {
      at: Date.now(),
      payload: {
        fetchedAt: now().toISOString(),
        source: MIMORIADNOSTI_SOURCE,
        events: parsePosts(Array.isArray(posts) ? posts : [], now()),
      },
    };
  } catch (error) {
    if (!cache.payload) {
      throw error;
    }
    // keep serving the last good copy, retry soon
    cache.at = Date.now() - CACHE_MS + 20_000;
  }
  return cache.payload;
}
