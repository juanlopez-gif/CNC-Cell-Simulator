// Screenshots of the simulator for the report.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const html = fs.readFileSync(path.join(__dirname, 'out', 'sim', 'index.html'), 'utf8');
const out = (n) => path.join(__dirname, 'out', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1.6 });
  await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  // Setup 1: faulty PE-41 until the second mismatch (warning state)
  await page.select('#selSpeed', '60');
  await sleep(2500);
  await page.click('#cpTable tr[data-cp="CP-2"] button[data-inj="fault"]');
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const n = await page.evaluate(() => document.querySelector('#winCount').textContent);
    if (n.startsWith('2')) break;
  }
  await page.select('#selSpeed', '1');
  await sleep(1200);
  const clip1 = await page.evaluate(() => { const a = document.querySelector('.bar').getBoundingClientRect(); const b = document.querySelector('.row1').getBoundingClientRect(); return { x: 0, y: a.top + window.scrollY - 12, width: document.documentElement.clientWidth, height: b.bottom - a.top + 24 }; });
  await page.screenshot({ path: out('sim_setup1_warning.png'), clip: clip1 });
  // Setup 2: one undersized part, capture after it reaches the NOK chute
  await page.click('#btnS2');
  await page.select('#selSpeed', '60');
  await sleep(800);
  await page.click('#btnUnder');
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const nok = await page.evaluate(() => document.querySelectorAll('.kpi .v')[1].textContent);
    if (nok.trim() === '1') break;
  }
  await sleep(4500);
  await page.select('#selSpeed', '1');
  await page.click('#tabs button[data-tab="R2"]');
  await sleep(1200);
  const clip2 = await page.evaluate(() => { const a = document.querySelector('.bar').getBoundingClientRect(); const b = document.querySelector('.row1').getBoundingClientRect(); return { x: 0, y: a.top + window.scrollY - 12, width: document.documentElement.clientWidth, height: b.bottom - a.top + 24 }; });
  await page.screenshot({ path: out('sim_setup2_gauge.png'), clip: clip2 });
  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
