// Close-up screenshots of the Setup 2 part exchange with the dual gripper (Robot 1 at the CNC).
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
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.click('#btnS2');
  await page.select('#selSpeed', '60');
  const r1 = () => page.evaluate(() => document.querySelector('#chips .chip[data-m="R1"] .id').textContent);
  const waitFor = async (id, max) => { for (let i = 0; i < (max || 600); i++) { if ((await r1()) === id) return true; await sleep(50); } return false; };
  // region of the mimic around the CNC and Robot 1, in drawing units
  const clip = () => page.evaluate(() => {
    const svg = document.querySelector('#mimic svg'), b = svg.getBoundingClientRect(), k = b.width / 1110;
    const x0 = 28, y0 = 150, x1 = 470, y1 = 600;
    return { x: b.left + x0 * k, y: b.top + window.scrollY + y0 * k, width: (x1 - x0) * k, height: (y1 - y0) * k };
  });
  // skip the first cycle (CNC empty): wait for the first finished part on the conveyor
  await waitFor('B7', 2400);
  await waitFor('B2', 2400);
  await page.select('#selSpeed', '5');
  await sleep(900);
  await page.select('#selSpeed', '1');
  await sleep(300);
  await page.screenshot({ path: out('ex1_wait_at_door.png'), clip: await clip() });
  await page.select('#selSpeed', '10');
  await waitFor('B3', 2400);
  await page.select('#selSpeed', '1');
  await sleep(2300);
  await page.screenshot({ path: out('ex2_B_opens_door.png'), clip: await clip() });
  await page.select('#selSpeed', '5');
  await waitFor('B4', 600);
  await page.select('#selSpeed', '1');
  await sleep(4250);
  await page.screenshot({ path: out('ex3_B_takes_finished_part.png'), clip: await clip() });
  await sleep(2300);
  await page.screenshot({ path: out('ex4_turn_A_loads_raw_part.png'), clip: await clip() });
  await page.select('#selSpeed', '5');
  await waitFor('B5', 600);
  await page.select('#selSpeed', '1');
  await sleep(2200);
  await page.screenshot({ path: out('ex5_A_closes_door.png'), clip: await clip() });
  // full view of Setup 2 with the gripper contents pill, plus the live Robot 1 diagram
  await page.select('#selSpeed', '10');
  await waitFor('B7', 2400);
  await page.select('#selSpeed', '1');
  await page.click('#tabs button[data-tab="R1"]');
  await sleep(1500);
  const full = await page.evaluate(() => { const a = document.querySelector('.bar').getBoundingClientRect(); const b = document.querySelector('.row1').getBoundingClientRect(); return { x: 0, y: a.top + window.scrollY - 12, width: document.documentElement.clientWidth, height: b.bottom - a.top + 24 }; });
  await page.screenshot({ path: out('sim_setup2_overview.png'), clip: full });
  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
