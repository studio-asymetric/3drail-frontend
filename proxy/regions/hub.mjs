/**
 * Extra regions (Prague / PID) merged into the Slovak proxy, on demand.
 *
 * Nothing is loaded or polled until a browser asks for `regions=pid` (the map does that once the
 * visitor moves to Prague). The first request starts the timetable download/parse in the
 * background; until it is ready the answers are Slovakia only. While browsers keep asking, the
 * Golemio live feed is polled; a few minutes after the last request everything goes quiet again.
 *
 *   REGION_DATA_DIR   where the cut-down PID timetable lives (default region-data/pid)
 *   GOLEMIO_API_KEY   live positions; without it trains of the region run on their timetable
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGtfsRegion } from './gtfsRegion.mjs';
import { startGolemioPolling } from './golemio.mjs';
import { buildRailSubset } from './buildGtfs.mjs';

const dirName = path.dirname(fileURLToPath(import.meta.url));
const PID_FEED_URL = 'https://data.pid.cz/PID_GTFS.zip';
const MAX_DATA_AGE_MS = 3 * 24 * 3_600_000;
const IDLE_STOP_MS = 5 * 60_000;

/** Region ids a request asks for: `regions=pid,...` (unknown ids are ignored). */
export function requestedRegions(reqUrl) {
  return (reqUrl.searchParams.get('regions') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id === 'pid');
}

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())));

async function downloadAndBuild(dataDir, log) {
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

export function createRegionHub(log = () => undefined) {
  const dataDir = path.resolve(dirName, '..', '..', process.env.REGION_DATA_DIR ?? 'region-data/pid');
  const apiKey = process.env.GOLEMIO_API_KEY ?? '';
  let region = null;
  let loading = false;
  let loadedAt = 0;
  let lastAsked = 0;
  let stopPolling = null;
  let idleTimer = null;
  let packBody = null;
  let stationsBody = null;
  const merged = { key: '', body: '', etag: '' };

  const dataFresh = () => {
    try {
      return Date.now() - fs.statSync(path.join(dataDir, 'trips.txt')).mtimeMs < MAX_DATA_AGE_MS;
    } catch {
      return false;
    }
  };

  async function load() {
    if (loading) return;
    loading = true;
    try {
      if (!dataFresh()) {
        try {
          await downloadAndBuild(dataDir, log);
        } catch (error) {
          log(`PID: update failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!fs.existsSync(path.join(dataDir, 'trips.txt'))) {
            throw error;
          }
        }
      }
      region = createGtfsRegion({ dir: dataDir, tz: 'Europe/Prague', log });
      loadedAt = Date.now();
      packBody = null;
      stationsBody = null;
    } catch (error) {
      log(`PID: not available: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loading = false;
    }
  }

  function touch() {
    lastAsked = Date.now();
    if (!region && !loading) {
      load();
    }
    if (region && apiKey && !stopPolling) {
      stopPolling = startGolemioPolling({ region, apiKey, log });
      idleTimer = setInterval(() => {
        if (Date.now() - lastAsked > IDLE_STOP_MS) {
          stopPolling?.();
          stopPolling = null;
          region?.setLive(new Map());
          clearInterval(idleTimer);
          log('PID: idle, live polling stopped');
        }
      }, 60_000);
    }
    if (region && Date.now() - loadedAt > 24 * 3_600_000 && !loading) {
      // a day old: read the refreshed timetable
      region = null;
      load();
    }
    return region;
  }

  return {
    /** Train rows of the regions the request asked for (empty until loaded). */
    trains(ids) {
      return ids.length > 0 ? (touch()?.trains() ?? []) : [];
    },
    /** Slovak journeys `{ body, etag }` merged with the region's (or the region's alone with `only`). */
    journeys(ids, sk, only = false) {
      const r = ids.length > 0 ? touch() : null;
      if (!r) return only ? { body: '{"v":2,"routes":{},"journeys":[]}', etag: '"building"' } : sk;
      const extra = r.journeys();
      if (only) return extra;
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
    isRegionKey(key) {
      return /^p\d/.test(key);
    },
    /** Stop list of a running region train, or null. */
    detail(key) {
      touch();
      return region?.hasKey(key) ? region.detail(key) : null;
    },
    /** `{stations:[...]}` JSON of the region only (the browser merges it); null while loading. */
    stationsBody() {
      const r = touch();
      if (!r) return null;
      stationsBody ??= JSON.stringify({ stations: r.stations() });
      return stationsBody;
    },
    /** Gzipped RNET pack of the region's rails; null while it is still loading. */
    networkPack() {
      const r = touch();
      if (!r) return null;
      packBody ??= r.networkPack();
      return packBody;
    },
  };
}
