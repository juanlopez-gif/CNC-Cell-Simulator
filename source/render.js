// Generate every figure of figures.js as SVG + PNG (2x) using the installed Chrome.
//   node render.js [outDir] [filter]      (build_all.js copies them to ../diagrams/)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { CHROME } = require('./chrome.js');

const OUT = process.argv[2] || path.join(__dirname, 'out');
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
fs.mkdirSync(OUT, { recursive: true });

const FIGS = require('./figures.js');

const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Barlow+Semi+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&display=block';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
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
