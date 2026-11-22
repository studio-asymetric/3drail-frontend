/** node scripts/buildPidRegion.mjs <unzipped PID_GTFS dir> [out dir = region-data/pid] */
import { buildRailSubset } from '../proxy/regions/buildGtfs.mjs';

const [, , inputArg, outArg] = process.argv;
if (!inputArg) {
  console.error('usage: node scripts/buildPidRegion.mjs <gtfs dir> [out dir]');
  process.exit(1);
}
await buildRailSubset(inputArg, outArg ?? 'region-data/pid');
