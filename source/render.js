// Generate every diagram as SVG + PNG (2x) using the installed Chrome.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const D = require('./src/cell-diagrams.js');

const OUT = process.argv[2] || path.join(__dirname, 'out');
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
fs.mkdirSync(path.join(OUT, 'doc'), { recursive: true });

const BASE = [
  ['fig01_layout_setup1', (o) => D.layoutSvg({ setup: 1, snapshot: true, ...o })],
  ['fig02_control_architecture', (o) => D.archDiagram(o)],
  ['fig05_flow_setup1', (o) => D.flowSetup1(o)],
  ['fig03_crosscheck_flow', (o) => D.flowCrossCheck(o)],
  ['fig04_supervisor_states', (o) => D.smSupervisor(o)],
  ['fig06_states_robot1_setup1', (o) => D.smRobot1S1(o)],
  ['fig07_states_conveyor', (o) => D.smConveyor(o)],
  ['fig08_states_robot2_setup1', (o) => D.smRobot2S1(o)],
  ['fig09_layout_setup2', (o) => D.layoutSvg({ setup: 2, snapshot: true, ...o })],
  ['fig11_flow_setup2', (o) => D.flowSetup2(o)],
  ['fig12_states_robot1_setup2', (o) => D.smRobot1S2(o)],
  ['fig13_states_robot2_setup2', (o) => D.smRobot2S2(o)],
  ['fig10_timing_setup1_vs_setup2', (o) => D.timingChart(o)],
];
// full = with title and notes (stand-alone images); doc = caption comes from the report
const FIGS = [];
BASE.forEach(([n, f]) => { FIGS.push([n, () => f({})]); FIGS.push(['doc/' + n, () => f({ noTitle: true, noNote: true })]); });

const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Barlow+Semi+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&display=block';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  // Load the web fonts once; every figure reuses this page.
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${FONTS}"><style>html,body{margin:0;background:#fff}</style></head><body><div id="host"></div></body></html>`, { waitUntil: 'load' });
  const loaded = await page.evaluate(async () => {
    const specs = ['400 12px "Barlow"', '600 12px "Barlow"', '700 12px "Barlow"', 'italic 400 12px "Barlow"',
      '600 12px "Barlow Semi Condensed"', '700 12px "Barlow Semi Condensed"',
      '400 12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"', '600 12px "IBM Plex Mono"'];
    const r = await Promise.all(specs.map((s) => document.fonts.load(s).then((f) => f.length).catch(() => 0)));
    return r;
  });
  console.log('fonts loaded:', loaded.join(','));
  for (const [name, fn] of FIGS) {
    if (ONLY && !ONLY.some((k) => name.includes(k))) continue;
    const svg = fn();
    fs.writeFileSync(path.join(OUT, name + '.svg'), svg);
    const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
    const w = Math.ceil(+m[1]), h = Math.ceil(+m[2]);
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.evaluate((s) => { document.getElementById('host').innerHTML = s; }, svg);
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('#host svg');
    await el.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('ok', name, w + 'x' + h);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
