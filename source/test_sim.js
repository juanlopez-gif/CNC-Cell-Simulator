// Headless run of the simulator: collect console errors, drive scenarios, take screenshots.
const path = require('path');
const puppeteer = require('puppeteer-core');
const file = 'file:///' + path.join(__dirname, 'out', 'sim', 'index.html').replace(/\\/g, '/');
const shot = (n) => path.join(__dirname, 'out', 'sim', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.setViewport({ width: 1500, height: 1200, deviceScaleFactor: 1 });
  await page.setContent(require('fs').readFileSync(path.join(__dirname, 'out', 'sim', 'index.html'), 'utf8'), { waitUntil: 'load', timeout: 60000 });
  const mode = process.argv[2] || 'basic';
  const state = () => page.evaluate(() => ({
    chips: Array.from(document.querySelectorAll('#chips .chip')).map((c) => c.querySelector('.id').textContent + ' ' + c.querySelector('.nm').textContent),
    status: document.querySelector('#stText').textContent, clock: document.querySelector('#clock').textContent,
    kpis: Array.from(document.querySelectorAll('.kpi')).map((k) => k.textContent.trim()),
    log: Array.from(document.querySelectorAll('#log li')).slice(0, 12).map((l) => l.textContent.trim()),
    banner: document.querySelector('#banner').hidden ? '' : document.querySelector('#bnTitle').textContent,
  }));
  await page.select('#selSpeed', '60');
  if (mode === 'basic') {
    for (let i = 0; i < 6; i++) { await sleep(2500); console.log(JSON.stringify(await state())); }
    await page.screenshot({ path: shot('shot_s1.png'), fullPage: true });
  }
  if (mode === 'fault') {
    await sleep(3000);
    await page.click('#cpTable tr[data-cp="CP-2"] button[data-inj="fault"]');
    for (let i = 0; i < 12; i++) { await sleep(2500); const s = await state(); console.log(s.clock, '|', s.status, '|', s.banner, '|', s.chips.join(' / ')); if (s.banner.startsWith('Line stopped')) break; }
    await page.select('#selSpeed', '10');
    await sleep(1500);
    await page.screenshot({ path: shot('shot_stop.png'), fullPage: true });
    await page.click('#bnActions button[data-act="verify"]');
    await sleep(9000);
    await page.screenshot({ path: shot('shot_verify.png'), fullPage: false });
    await page.click('#bnActions button[data-act="resume"]');
    await sleep(3000);
    const s = await state(); console.log('after reset:', s.status, s.chips.join(' / ')); console.log(s.log.join('\n'));
  }
  if (mode === 's2') {
    await page.click('#btnS2');
    await sleep(1500);
    await page.click('#btnUnder'); await page.click('#btnUnder');
    for (let i = 0; i < 14; i++) { await sleep(2500); const s = await state(); console.log(s.clock, '|', s.status, '|', s.banner, '|', s.chips.join(' / ')); }
    const s = await state(); console.log(s.kpis.join(' | ')); console.log(s.log.join('\n'));
    await page.screenshot({ path: shot('shot_s2.png'), fullPage: true });
  }
  if (mode === 'mobile') {
    await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 1 });
    await sleep(2000);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    console.log('scrollWidth/clientWidth', w);
    await page.screenshot({ path: shot('shot_mobile.png'), fullPage: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setViewport({ width: 1500, height: 1200, deviceScaleFactor: 1 });
    await sleep(1500);
    await page.screenshot({ path: shot('shot_dark.png'), fullPage: false });
  }
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
