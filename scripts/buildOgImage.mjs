/**
 * Makes public/og-image.png (the picture shown when the site is shared): the look of the train
 * panel, with the logo and a vertical timeline that has the current station on it, over a faint
 * rail map of Slovakia.
 *
 *   node scripts/buildOgImage.mjs
 *
 * Needs Chrome or Edge installed (it renders an HTML page headless and keeps the screenshot).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'og-image.png');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
if (!browser) throw new Error('No Chrome or Edge found');

// the faint rail map behind everything
const sketch = fs.readFileSync(path.join(root, 'src/data/regionSketch.ts'), 'utf8');
const railsMatch = sketch.match(/"sk":\s*\{[\s\S]*?"rails":\s*"([^"]+)"/);
const railsPath = railsMatch ? railsMatch[1] : '';
const logoSvg = fs
  .readFileSync(path.join(root, 'src/logo icon white.svg'), 'utf8')
  .replace(/<\?xml[^>]*\?>/, '')
  .replace('<svg ', '<svg class="logo" ');
const fontUrl = pathToFileURL(path.join(root, 'src/fonts/Geist[wght].woff2')).href;

const stops = [
  { name: 'Košice', planned: '17:34', actual: '17:34', state: 'passed' },
  { name: 'Spišské Vlachy', planned: '17:58', actual: '18:14', state: 'current' },
  { name: 'Poprad-Tatry', planned: '18:21', actual: '18:37', state: 'ahead' },
  { name: 'Žilina', planned: '20:02', actual: '20:18', state: 'ahead' },
  { name: 'Bratislava hl. st.', planned: '22:39', actual: '22:55', state: 'ahead' },
];

const timeline = stops
  .map(
    (stop) => `
      <li class="stop ${stop.state}">
        <span class="mark"></span>
        <span class="name">${stop.name}</span>
        <span class="times">${stop.planned !== stop.actual ? `<s>${stop.planned}</s>` : ''}<b>${stop.actual}</b></span>
      </li>`
  )
  .join('');

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'Geist'; src: url('${fontUrl}') format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; background: #131313; color: #f4f4f4; font-family: 'Geist', system-ui, sans-serif; }
  .bg { position: absolute; inset: 0; background: radial-gradient(1000px 520px at 78% 40%, #232323 0%, #131313 70%); }
  .rails { position: absolute; left: -90px; top: -40px; width: 1000px; height: 600px; opacity: 0.2; }
  .rails path { fill: none; stroke: #fff; stroke-width: 0.9; stroke-linecap: round; stroke-linejoin: round; }
  .brand { position: absolute; left: 72px; top: 64px; display: flex; align-items: center; gap: 22px; }
  .logo { width: 62px; height: 75px; }
  .brand span { font-size: 54px; font-weight: 600; letter-spacing: -0.03em; }
  .claim { position: absolute; left: 72px; bottom: 76px; width: 520px; }
  .claim h1 { font-size: 66px; line-height: 1.04; font-weight: 600; letter-spacing: -0.045em; }
  .claim p { margin-top: 22px; font-size: 27px; line-height: 1.3; color: #9a9a9a; letter-spacing: -0.015em; }
  .card { position: absolute; right: 64px; top: 56px; width: 500px; height: 518px; padding: 34px 38px; background: #131313; border: 1px solid #2c2c2c; border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.55); }
  .id { display: flex; align-items: center; gap: 18px; }
  .pill { padding: 6px 20px; border-radius: 999px; background: #e8743b; border: 3px solid #fff; color: #fff; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; white-space: nowrap; }
  .route { font-size: 34px; font-weight: 500; letter-spacing: -0.03em; white-space: nowrap; }
  .route i { font-style: normal; color: #bdbdbd; font-weight: 300; padding: 0 6px; }
  .status { margin-top: 20px; display: flex; align-items: center; gap: 22px; font-size: 22px; letter-spacing: -0.01em; }
  .delay { color: #e8743b; display: flex; align-items: center; gap: 10px; }
  .delay b { font-weight: 700; }
  .here { color: #a8a8a8; display: flex; align-items: center; gap: 10px; }
  svg.ic { width: 20px; height: 20px; flex: none; }
  .rule { height: 1px; background: #2a2a2a; margin: 24px 0 18px; }
  ul { list-style: none; position: relative; }
  ul::before { content: ''; position: absolute; left: 12px; top: 22px; bottom: 22px; width: 3px; background: linear-gradient(#f4f4f4 0 28%, #5a5a5a 28% 100%); border-radius: 2px; }
  .stop { position: relative; display: grid; grid-template-columns: 56px 1fr auto; align-items: center; height: 64px; font-size: 25px; letter-spacing: -0.02em; }
  .mark { width: 26px; height: 3px; background: #7a7a7a; border-radius: 2px; margin-left: 0; }
  .stop.passed { color: #6e6e6e; }
  .stop.passed .mark { background: #f4f4f4; }
  .stop.current { color: #fff; font-weight: 650; }
  .stop.current .mark { width: 26px; height: 26px; margin-left: 0; border-radius: 50%; background: #131313; border: 3px solid #e8743b; box-shadow: inset 0 0 0 5px #e8743b; }
  .stop.ahead { color: #e8e8e8; }
  .times { display: flex; gap: 14px; font-variant-numeric: tabular-nums; }
  .times s { color: #6e6e6e; font-weight: 400; }
  .times b { font-weight: 650; }
  .stop.passed .times b { font-weight: 400; }
</style></head>
<body>
  <div class="bg"></div>
  <svg class="rails" viewBox="0 0 200 120" aria-hidden="true"><path d="${railsPath}"/></svg>
  <div class="brand">${logoSvg}<span>Môj Vlak</span></div>
  <div class="claim">
    <h1>Mapa vlakov naživo</h1>
    <p>Kde je váš vlak práve teraz, koľko mešká a ktoré zastávky ho čakajú.</p>
  </div>
  <div class="card">
    <div class="id"><span class="pill">Ex 526</span><span class="route">Kriváň <i>→</i> Bratislava</span></div>
    <div class="status">
      <span class="delay"><svg class="ic" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.35"/><path d="M8 4.4V8l2.4 1.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg><span><b>16 min</b> meškanie</span></span>
      <span class="here"><svg class="ic" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.35"/><path d="M8 7.1v4.2M8 5.4h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>Spišské Vlachy</span>
    </div>
    <div class="rule"></div>
    <ul>${timeline}</ul>
  </div>
</body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const page = path.join(dir, 'og.html');
fs.writeFileSync(page, html);
const shot = path.join(dir, 'og.png');
execFileSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1200,630',
    '--virtual-time-budget=4000',
    `--screenshot=${shot}`,
    pathToFileURL(page).href,
  ],
  { stdio: 'ignore' }
);
fs.copyFileSync(shot, out);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`written ${out} (${fs.statSync(out).size} bytes)`);
