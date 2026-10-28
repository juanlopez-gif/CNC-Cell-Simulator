// Regression fingerprint of Setup 2: everything that must not change when the code is reorganized.
//   node regress.js > ../regression/<name>.json               record a reference (see ../regression/README.md)
//   node regress.js --compare ../regression/setup2_reference.json  compare with it (exit 1 on a difference)
// It collects: the model KPIs and nominal state times, the NuSMV models of the three fault classes
// (hash), the SVG figures (hash), the browser trace of two deterministic scenarios (hash) and the
// Python engine fingerprints (engine/regress.py: deterministic and seeded random runs).
// Needs out/sim/index.html (node build_sim.js), Chrome (CHROME or the default path) and Python.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const M = require('./src/cell-model.js');
const V = require('./src/cell-verify.js');
const { CHROME } = require('./chrome.js');

const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');
const traceSha = (t) => sha(JSON.stringify(t.map((e) => [Math.round(e[0] * 1e6) / 1e6, e[1], e[2], e[3]])));

async function collect() {
  const out = {};
  // model
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  out.kpi = { idle: M.KPI.idle2, cycle: M.KPI.cycle2, util: r6(M.KPI.util2), pph: r6(M.KPI.pph2) };
  out.stateTimes = {};
  M.SETUP_MACHINES[2].forEach((mk) => Object.keys(M.MACHINES[mk].states).forEach((id) => {
    if (!M.MACHINES[mk].states[id].choice) out.stateTimes[`${mk}.${id}`] = M.stateTime(mk, id);
  }));
  // verification models
  out.smv = {};
  Object.keys(V.RUNS).forEach((f) => {
    const ir = V.build(2, { faults: V.RUNS[f] });
    out.smv[f] = { vars: ir.vars.length, commands: ir.cmds.length, sha256: sha(V.toSmv(ir)) };
  });
  // figures
  out.figures = {};
  require('./figures.js').forEach(([name, fn]) => { out.figures[name] = sha(fn()); });
  // browser simulator
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  await page.setContent(fs.readFileSync(path.join(__dirname, 'out', 'sim', 'index.html'), 'utf8'), { waitUntil: 'load', timeout: 60000 });
  await page.click('#btnRun');
  out.browser = {};
  for (const scenario of ['nominal', 'cp2fault']) {
    const t = await page.evaluate((scenario) => {
      const C = window.CellSim;
      C.instantVerify = true;
      C.newSim(2);
      C.S.running = false;
      for (let t = 0; t < 3600; t += 10) {
        if (scenario === 'cp2fault' && t === 300) document.querySelector('#cpTable tr[data-cp="CP-2"] button[data-inj="fault"]').click();
        C.advance(10);
        if (scenario === 'cp2fault') {
          if (C.MCH.SUP.state === 'X3' && !C.S.inputs.verify) C.press('verify');
          if (C.MCH.SUP.state === 'X4' && C.S.verify && C.S.verify.done && !C.S.inputs.reset) C.press('resume');
        }
      }
      return C.TRACE.map((e) => [e.t, e.slot, e.from, e.to]);
    }, scenario);
    out.browser['det_' + scenario] = { changes: t.length, sha256: traceSha(t) };
  }
  await new Promise((r) => setTimeout(r, 3000));                // let the page draw a few frames
  out.browser.pageErrors = pageErrors;                        // must stay empty
  await browser.close();
  // Python engine
  out.python = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['regress.py'], { cwd: path.join(__dirname, '..', 'engine'), encoding: 'utf8', maxBuffer: 1 << 26 }));
  return out;
}

function diff(a, b, at, list) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    new Set(Object.keys(a).concat(Object.keys(b))).forEach((k) => diff(a[k], b[k], at ? `${at}.${k}` : k, list));
  } else if (JSON.stringify(a) !== JSON.stringify(b)) list.push(`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return list;
}

(async () => {
  const cur = await collect();
  const i = process.argv.indexOf('--compare');
  if (i < 0) { console.log(JSON.stringify(cur, null, 1)); return; }
  const ref = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  const d = diff(ref.fingerprint || ref, cur, '', []);
  if (!d.length) { console.log('regression: Setup 2 identical to the reference'); return; }
  console.log(`regression: ${d.length} difference(s)\n  ` + d.join('\n  '));
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
