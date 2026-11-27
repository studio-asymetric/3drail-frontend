/**
 * Extra regions merged into the Slovak proxy, on demand: Prague (PID) and Brno + South Moravia (JMK).
 *
 * Nothing is loaded or polled until a browser asks for `regions=pid` (or `jmk`). The first request
 * starts the timetable download/parse in the background; until it is ready the answers are Slovakia
 * only. While browsers keep asking, the region's live feed runs; a few minutes after the last
 * request everything goes quiet again.
 *
 *   REGION_DATA_DIR   where the cut-down PID timetable lives (default region-data/pid)
 *   JMK_DATA_DIR      the same for Brno + South Moravia (default region-data/jmk)
 *   GOLEMIO_API_KEY   live positions of Prague; without it trains of the region run on their timetable
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGtfsRegion } from './gtfsRegion.mjs';
import { startGolemioPolling } from './golemio.mjs';
import { startJmkLive } from './jmkLive.mjs';
import { buildJmkRegion, JMK_DATA_VERSION } from './buildJmk.mjs';
import { buildRailSubset, REGION_DATA_VERSION } from './buildGtfs.mjs';

const dirName = path.dirname(fileURLToPath(import.meta.url));
const PID_FEED_URL = 'https://data.pid.cz/PID_GTFS.zip';
const MAX_DATA_AGE_MS = 3 * 24 * 3_600_000;
const IDLE_STOP_MS = 5 * 60_000;

/** Region ids a request asks for: `regions=pid,...` (unknown ids are ignored). */
export function requestedRegions(reqUrl) {
  return (reqUrl.searchParams.get('regions') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id === 'pid' || id === 'jmk');
}

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())));

async function buildPid(dataDir, log) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-'));
  try {
    const zipPath = path.join(work, 'feed.zip');
    log(`PID: downloading ${PID_FEED_URL}`);
    const response = await fetch(PID_FEED_URL, { signal: AbortSignal.timeout(900_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    const raw = path.join(work, 'raw');
    fs.mkdirSync(raw);
    await run('unzip', ['-q', '-o', zipPath, '-d', raw]);
    const out = `${dataDir}.tmp`;
    fs.rmSync(out, { recursive: true, force: true });
    await buildRailSubset(raw, out, () => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.renameSync(out, dataDir);
    log('PID: timetable updated');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const CONFIGS = {
  pid: {
    id: 'pid',
    label: 'PID',
    dir: process.env.REGION_DATA_DIR ?? 'region-data/pid',
    version: String(REGION_DATA_VERSION),
    build: buildPid,
    /** Starts the live feed; returns its stop function, or null when there is nothing to start. */
    startLive: ({ region, log }) => {
      const apiKey = process.env.GOLEMIO_API_KEY ?? '';
      return apiKey ? startGolemioPolling({ region, apiKey, log }) : null;
    },
  },
  jmk: {
    id: 'jmk',
    label: 'JMK',
    dir: process.env.JMK_DATA_DIR ?? 'region-data/jmk',
    version: JMK_DATA_VERSION,
    // the stream costs nothing to keep: stay connected so the next visitor sees vehicles at once
    idleMs: 60 * 60_000,
    // built at server start, so the first visitor does not wait for it
    prebuild: true,
    build: buildJmkRegion,
    startLive: ({ region, dir, log }) => startJmkLive({ region, dataDir: dir, log }),
  },
};

function createOneRegion(config, log) {
  const dataDir = path.resolve(dirName, '..', '..', config.dir);
  let region = null;
  let loading = false;
  let loadedAt = 0;
  let lastAsked = 0;
  let stopLive = null;
  let idleTimer = null;
  let packBody = null;
  let linesBody = null;
  const stopsBodies = new Map(); // kinds mask -> JSON
  let stationsBody = null;
  const merged = { key: '', body: '', etag: '' };
  const say = (message) => log(`${config.label}: ${message}`);

  const dataFresh = () => {
    try {
      const version = fs.readFileSync(path.join(dataDir, 'region.version'), 'utf8').trim();
      return version === config.version && Date.now() - fs.statSync(path.join(dataDir, 'trips.txt')).mtimeMs < MAX_DATA_AGE_MS;
    } catch {
      return false;
    }
  };

  /** Makes sure the cut-down timetable on disk is current (downloads and builds it when it is not). */
  let preparing = null;
  function prepare() {
    if (dataFresh()) return Promise.resolve();
    preparing ??= (async () => {
      try {
        await config.build(dataDir, log);
      } catch (error) {
        say(`update failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!fs.existsSync(path.join(dataDir, 'trips.txt'))) {
          throw error;
        }
      } finally {
        preparing = null;
      }
    })();
    return preparing;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      await prepare();
      region = createGtfsRegion({ dir: dataDir, tz: 'Europe/Prague', log });
      loadedAt = Date.now();
      // the live feed was handed the old region: it starts again, on the new one, with the next request
      if (stopLive) {
        stopLive();
        stopLive = null;
        clearInterval(idleTimer);
      }
      packBody = null;
      stationsBody = null;
      linesBody = null;
      stopsBodies.clear();
    } catch (error) {
      say(`not available: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loading = false;
    }
  }

  function touch() {
    lastAsked = Date.now();
    if (!region && !loading) {
      load();
    }
    if (region && !stopLive) {
      stopLive = config.startLive({ region, dir: dataDir, log: say });
      if (stopLive) {
        idleTimer = setInterval(() => {
          if (Date.now() - lastAsked > (config.idleMs ?? IDLE_STOP_MS)) {
            stopLive?.();
            stopLive = null;
            region?.setLive(new Map());
            region?.setOthers([]);
            clearInterval(idleTimer);
            say('idle, live feed stopped');
          }
        }, 60_000);
      }
    }
    if (region && Date.now() - loadedAt > 24 * 3_600_000 && !loading) {
      // a day old: read the refreshed timetable (the old one keeps serving until the new one is ready)
      load();
    }
    return region;
  }

  return {
    id: config.id,
    touch,
    /**
     * Ahead of the first visitor: builds the timetable on disk (where that is cheap) and reads one
     * that is already there, so a visit right after a restart gets journeys at once instead of a
     * "building" placeholder (the pills would stand still until the page asked again).
     */
    warm: async () => {
      if (config.prebuild) {
        await prepare().catch(() => undefined);
      }
      if (!region && !loading && dataFresh()) {
        await load();
      }
    },
    peek: () => region,
    trains: () => touch()?.trains() ?? [],
    journeys() {
      const r = touch();
      return r ? r.journeys() : null;
    },
    mergedJourneys(sk) {
      const extra = this.journeys();
      if (!extra) return sk;
      const key = `${sk.etag}|${extra.etag}`;
      if (merged.key !== key) {
        const base = JSON.parse(sk.body);
        const add = JSON.parse(extra.body);
        base.routes = { ...base.routes, ...add.routes };
        base.journeys = [...base.journeys, ...add.journeys];
        const etag = `"${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}"`;
        Object.assign(merged, { key, body: JSON.stringify(base), etag });
      }
      return { body: merged.body, etag: merged.etag };
    },
    stationsBody() {
      const r = touch();
      if (!r) return null;
      stationsBody ??= JSON.stringify({ stations: r.stations() });
      return stationsBody;
    },
    stopsBody(mask = 7) {
      const r = touch();
      if (!r) return null;
      const key = mask & 15;
      if (!stopsBodies.has(key)) {
        const rows = r
          .transitStops()
          .filter((row) => row[1] & key)
          .map(([name, kinds, spots]) => [name, kinds & key, spots]);
        stopsBodies.set(key, JSON.stringify({ stops: rows }));
      }
      return stopsBodies.get(key);
    },
    linesBody() {
      const r = touch();
      if (!r) return null;
      linesBody ??= JSON.stringify(r.transitLines());
      return linesBody;
    },
    networkPack() {
      const r = touch();
      if (!r) return null;
      packBody ??= r.networkPack();
      return packBody;
    },
  };
}

export function createRegionHub(log = () => undefined) {
  const regions = new Map(Object.values(CONFIGS).map((config) => [config.id, createOneRegion(config, log)]));
  const pick = (ids) => (ids.length > 0 ? regions.get(ids[0]) : undefined);

  return {
    /** Train rows of the regions the request asked for (empty until loaded). */
    trains(ids) {
      return ids.flatMap((id) => regions.get(id)?.trains() ?? []);
    },
    /** Slovak journeys `{ body, etag }` merged with the region's (or the region's alone with `only`). */
    journeys(ids, sk, only = false) {
      const one = pick(ids);
      if (!one) return sk;
      if (only) {
        const extra = one.journeys();
        return extra ?? { body: '{"v":2,"routes":{},"journeys":[]}', etag: '"building"' };
      }
      return one.mergedJourneys(sk);
    },
    isRegionKey(key) {
      return /^p\d/.test(key);
    },
    /** Stop list of a running region vehicle, or null. */
    detail(key) {
      for (const one of regions.values()) {
        const r = one.peek();
        if (r) {
          const found = r.detail(key);
          if (found) {
            one.touch();
            return found;
          }
        }
      }
      return null;
    },
    /** Readies every region's timetable (Prague's is only read when already on disk: its download is large). */
    warm: () => Promise.all([...regions.values()].map((one) => one.warm())),
    stationsBody: (ids) => pick(ids)?.stationsBody() ?? null,
    stopsBody: (ids, mask = 7) => pick(ids)?.stopsBody(mask) ?? null,
    linesBody: (ids) => pick(ids)?.linesBody() ?? null,
    networkPack: (ids) => pick(ids)?.networkPack() ?? null,
  };
}
