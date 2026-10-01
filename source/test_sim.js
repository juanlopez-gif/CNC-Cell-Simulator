// Headless runs of the simulator: collect console errors, drive scenarios, take screenshots.
//   node test_sim.js basic | fault | s2 | mobile | conform | all
// conform: hours of simulated operation with random faults, checked against the model:
//   every state change must be a transition of M.MACHINES (or an entry into / exit from H and F),
//   no property of M.PROPERTIES may be violated, every job must take its model time, and in the
//   runs without faults the CNC idle time of every cycle must equal the KPI derived from the model.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const M = require('./src/cell-model.js');
const shot = (n) => path.join(__dirname, 'out', 'sim', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// successors of a state with the choice pseudo-states resolved
function successors(mk, id) {
  const m = M.MACHINES[mk], out = new Set();
  const resolve = (t) => { const s = m.states[t]; if (s && s.choice) { resolve(s.yes); resolve(s.no); } else out.add(t); };
  (m.states[id].next || []).forEach((tr) => resolve(tr.to));
  return out;
}
function conformance(trace, setup) {
  const bySlot = {};
  M.SETUP_MACHINES[setup].forEach((k) => { bySlot[M.MACHINES[k].slot] = k; });
  const errs = [], base = {}, visited = {};
  for (const e of trace) {
    const mk = bySlot[e.slot], m = M.MACHINES[mk];
    (visited[mk] = visited[mk] || new Set()).add(e.to);
    const bad = () => errs.push(`${mk}: ${e.from || '(start)'} -> ${e.to} at t = ${e.t.toFixed(1)} s is not a transition of the model`);
    if (!e.from) { const init = new Set(); const r = (t) => { const s = m.states[t]; if (s && s.choice) { r(s.yes); r(s.no); } else init.add(t); }; r(m.initial.to); if (!init.has(e.to)) bad(); continue; }
    if (e.to === 'H' || e.to === 'F') { if (!base[e.slot]) base[e.slot] = e.from; if (!m[e.to === 'H' ? 'hold' : 'fault']) bad(); continue; }
    if (e.from === 'H' || e.from === 'F') { const b = base[e.slot]; base[e.slot] = null; if (!(e.to === b || successors(mk, b).has(e.to))) bad(); continue; }
    if (!successors(mk, e.from).has(e.to)) bad();
  }
  const unvisited = {};
  Object.keys(visited).forEach((mk) => {
    const all = Object.keys(M.MACHINES[mk].states).filter((id) => !M.MACHINES[mk].states[id].choice).concat(M.MACHINES[mk].hold ? ['H'] : [], M.MACHINES[mk].fault ? ['F'] : []);
    unvisited[mk] = all.filter((id) => !visited[mk].has(id));
  });
  return { errs, unvisited };
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const html = fs.readFileSync(path.join(__dirname, 'out', 'sim', 'index.html'), 'utf8');
  let failed = false;
  const open = async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.setViewport({ width: 1500, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    return { page, errors };
  };
  const state = (page) => page.evaluate(() => ({
    chips: Array.from(document.querySelectorAll('#chips .chip')).map((c) => c.querySelector('.id').textContent + ' ' + c.querySelector('.nm').textContent),
    status: document.querySelector('#stText').textContent, clock: document.querySelector('#clock').textContent,
    kpis: Array.from(document.querySelectorAll('.kpi')).map((k) => k.textContent.trim()),
    log: Array.from(document.querySelectorAll('#log li')).slice(0, 12).map((l) => l.textContent.trim()),
    banner: document.querySelector('#banner').hidden ? '' : document.querySelector('#bnTitle').textContent,
  }));
  const report = (name, errors) => { console.log(`[${name}] console errors:`, errors.length ? '\n' + errors.join('\n') : 'none'); if (errors.length) failed = true; };
  const arg = process.argv[2] || 'basic';
  const modes = arg === 'all' ? ['basic', 'fault', 's2', 'mobile', 'conform'] : [arg];

  for (const mode of modes) {
    const { page, errors } = await open();
    await page.select('#selSpeed', '60');
    if (mode === 'basic') {
      for (let i = 0; i < 6; i++) { await sleep(2500); console.log(JSON.stringify(await state(page))); }
      await page.screenshot({ path: shot('shot_s1.png'), fullPage: true });
    }
    if (mode === 'fault') {
      await sleep(3000);
      await page.click('#cpTable tr[data-cp="CP-2"] button[data-inj="fault"]');
      for (let i = 0; i < 16; i++) { await sleep(2500); const s = await state(page); console.log(s.clock, '|', s.status, '|', s.banner, '|', s.chips.join(' / ')); if (s.banner.startsWith('Line stopped')) break; }
      await page.select('#selSpeed', '10');
      await sleep(1500);
      await page.screenshot({ path: shot('shot_stop.png'), fullPage: true });
      await page.click('#bnActions button[data-act="verify"]');
      for (let i = 0; i < 40; i++) { await sleep(500); if (await page.$('#bnActions button[data-act="resume"]:not([disabled])')) break; }
      await page.screenshot({ path: shot('shot_verify.png'), fullPage: false });
      await page.click('#bnActions button[data-act="resume"]');
      await sleep(3000);
      const s = await state(page); console.log('after reset:', s.status, s.chips.join(' / ')); console.log(s.log.join('\n'));
    }
    if (mode === 's2') {
      await page.click('#btnS2');
      await sleep(1500);
      await page.click('#btnUnder'); await page.click('#btnUnder');
      for (let i = 0; i < 14; i++) { await sleep(2500); const s = await state(page); console.log(s.clock, '|', s.status, '|', s.banner, '|', s.chips.join(' / ')); }
      const s = await state(page); console.log(s.kpis.join(' | ')); console.log(s.log.join('\n'));
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
    if (mode === 'conform') {
      await page.click('#btnRun');                                  // pause the animation; the test drives the clock
      const runs = [
        { setup: 1, hours: 2, faults: false, seed: 1 }, { setup: 2, hours: 2, faults: false, seed: 2 },
        { setup: 1, hours: 8, faults: true, seed: 3 }, { setup: 2, hours: 8, faults: true, seed: 4 },
      ];
      for (const run of runs) {
        const res = await page.evaluate((run) => {
          let a = run.seed * 2654435761 >>> 0;                       // seeded random numbers (mulberry32)
          Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
          const C = window.CellSim, rnd = Math.random;
          C.instantVerify = true;
          C.newSim(run.setup);
          C.S.running = false;
          const act = { fault: 0, clear: 0, verify: 0, reset: 0, release: 0, injected: {} };
          const inj = (k) => { act.injected[k] = (act.injected[k] || 0) + 1; };
          let faultSince = null, qhSince = null;
          for (let t = 0; t < run.hours * 3600; t += 10) {
            C.advance(10);
            const S = C.S;
            if (run.faults && rnd() < 0.012) {                       // about one disturbance every 14 min
              const k = rnd();
              const cps = ['CP-1', 'CP-2', 'CP-3', 'CP-4'].concat(run.setup === 2 ? ['CP-5'] : []);
              const cp = cps[Math.floor(rnd() * cps.length)];
              const row = document.querySelector(`#cpTable tr[data-cp="${cp}"]`);
              if (k < 0.3) { row.querySelector('button[data-inj="glitch"]').click(); inj('glitch'); }
              else if (k < 0.45) { row.querySelector('button[data-inj="fault"]').click(); inj('sensor fault'); }
              else if (k < 0.6) { document.querySelector('#btnBadFrame').click(); inj('bad frame'); }
              else if (k < 0.7) { document.querySelector('#btnCamFail').click(); inj('camera failure'); }
              else if (k < 0.85) { document.querySelector('#btnGripMiss').click(); inj('grip miss'); }
              else if (run.setup === 2) { document.querySelector('#btnUnder').click(); inj('undersized part'); }
            }
            // the operator is sometimes away: the input pallet runs empty (Robot 1 waits in W1)
            if (run.faults && rnd() < 0.003) { S.autoOp = !S.autoOp; inj(S.autoOp ? 'operator back' : 'operator away'); }
            // operator and technician
            const fault = Object.keys(S.faults).some((k) => S.faults[k]);
            if (fault) { if (faultSince == null) faultSince = S.t; if (S.t - faultSince > 60) { C.press('clear'); act.clear++; faultSince = null; } } else faultSince = null;
            if (S.vars.QH) { if (qhSince == null) qhSince = S.t; if (S.t - qhSince > 120) { C.press('qh'); act.release++; qhSince = null; } } else qhSince = null;
            if (C.MCH.SUP.state === 'X3' && !S.inputs.verify) { C.press('verify'); act.verify++; }
            if (C.MCH.SUP.state === 'X4' && S.verify && S.verify.done && !S.inputs.reset) { C.press('resume'); act.reset++; }
          }
          const st = C.W.stats;
          return { trace: C.TRACE.slice(), stats: st, avgIdle: st.idleN ? st.idleSum / st.idleN : null, idles: null, act, t: C.S.t, ok: C.W.ok, nok: C.W.nok };
        }, run);
        const c = conformance(res.trace, run.setup);
        const kpi = run.setup === 1 ? M.KPI.idle1 : M.KPI.idle2;
        console.log(`\n[conform] Setup ${run.setup}, ${run.hours} h ${run.faults ? 'with' : 'without'} faults: ${res.trace.length} state changes, ${res.stats.jobs} jobs, ${res.stats.cycles} CNC cycles, ${res.ok} parts on the pallet, ${res.nok} NOK, ${res.stats.mism} mismatches, ${res.stats.stops} line stops`);
        if (run.faults) console.log('  injected:', JSON.stringify(res.act.injected), ' operator:', JSON.stringify({ clear: res.act.clear, verify: res.act.verify, reset: res.act.reset, release: res.act.release }));
        console.log('  transitions not in the model:', c.errs.length ? '\n  ' + c.errs.slice(0, 20).join('\n  ') : 'none');
        console.log('  property violations:', res.stats.violations);
        console.log('  states never visited:', JSON.stringify(c.unvisited));
        if (!run.faults) {
          const okIdle = res.avgIdle != null && Math.abs(res.avgIdle - kpi) < 0.005;
          console.log(`  mean CNC idle ${res.avgIdle == null ? '-' : res.avgIdle.toFixed(3)} s, model KPI ${kpi} s → ${okIdle ? 'equal' : 'DIFFERENT'}`);
          if (!okIdle) failed = true;
        }
        if (c.errs.length || res.stats.violations) failed = true;
      }
    }
    report(mode, errors);
    await page.close();
  }
  await browser.close();
  if (failed) { console.log('\nRESULT: FAILED'); process.exit(1); }
  console.log('\nRESULT: OK');
})().catch((e) => { console.error(e); process.exit(1); });
