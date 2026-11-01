// Regenerate the generated files of the repository from the model, or check that they are current.
//   node build_all.js           write diagrams/ (SVG + PNG, needs Chrome), simulation/index.html,
//                               engine/cellsim/cell_model.json, source/plc/cell.st and io_map.json,
//                               verification/cell_setup2_timed*.xml
//   node build_all.js --check   exit 1 if a committed generated file is not what the sources give:
//                               the SVG figures, the simulator page, the model JSON, the PLC program and
//                               the NuSMV models and the UPPAAL models (cell_setup2_timed*.xml)
//                               in verification/ (PNG files and verification results are not compared)
// The verification results take minutes to hours: npm run verify, then copy out/verification/* to
// ../verification/.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('./src/cell-model.js');
const V = require('./src/cell-verify.js');
const FIGS = require('./figures.js');
const { buildSim } = require('./build_sim.js');
const { modelJson, OUT: JSON_OUT } = require('./export_model.js');
const ST = require('./src/cell-st.js');
const TM = require('./src/cell-timed.js');

const ROOT = path.join(__dirname, '..');
const DIAG = path.join(ROOT, 'diagrams');
const SIM = path.join(ROOT, 'simulation', 'index.html');
const PLC_ST = path.join(__dirname, 'plc', 'cell.st');
const PLC_IO = path.join(__dirname, 'plc', 'io_map.json');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

const lint = M.lint();
if (lint.length) { console.error('model lint failed:\n' + lint.join('\n')); process.exit(1); }

// every generated text file: [path in the repository, expected content]
const expected = [];
FIGS.forEach(([name, fn]) => expected.push([path.join(DIAG, name + '.svg'), fn()]));
expected.push([SIM, buildSim().index]);
expected.push([JSON_OUT, modelJson()]);
expected.push([PLC_ST, ST.toSt()]);
expected.push([PLC_IO, ST.ioMap()]);
Object.keys(V.RUNS).forEach((f) => {
  const ir = V.build(2, { faults: V.RUNS[f] });
  expected.push([path.join(ROOT, 'verification', `cell_setup2_${f}.smv`), V.toSmv(ir)]);
});
// the timed model for UPPAAL (A4), case 1 and case 2 of the master check (PROJECT_STATUS.md §5.17)
[[false, 'cell_setup2_timed.xml'], [true, 'cell_setup2_timed_master.xml']].forEach(([master, name]) => {
  const net = TM.network({ master });
  expected.push([path.join(ROOT, 'verification', name), TM.toUppaal(net, TM.queries(net))]);
});
const known = new Set(FIGS.map(([n]) => n));
const stale = fs.readdirSync(DIAG).filter((f) => /^fig\d+_.*\.(svg|png)$/.test(f) && !known.has(f.replace(/\.(svg|png)$/, '')));

if (process.argv.includes('--check')) {
  const bad = expected.filter(([f, text]) => read(f) !== text.replace(/\r\n/g, '\n')).map(([f]) => rel(f));
  stale.forEach((f) => bad.push(`diagrams/${f} (not produced by figures.js)`));
  FIGS.forEach(([n]) => { if (!fs.existsSync(path.join(DIAG, n + '.png'))) bad.push(`diagrams/${n}.png missing`); });
  if (bad.length) { console.error('generated files out of date (run npm run build):\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log(`generated files up to date: ${expected.length} files checked`);
} else {
  // PNG + SVG through Chrome, then copy to diagrams/
  const tmp = path.join(__dirname, 'out', 'figures');
  execFileSync(process.execPath, [path.join(__dirname, 'render.js'), tmp], { stdio: 'inherit' });
  FIGS.forEach(([n]) => ['svg', 'png'].forEach((ext) => fs.copyFileSync(path.join(tmp, `${n}.${ext}`), path.join(DIAG, `${n}.${ext}`))));
  stale.forEach((f) => { fs.unlinkSync(path.join(DIAG, f)); console.log('removed', 'diagrams/' + f); });
  expected.filter(([f]) => !f.startsWith(DIAG) && !f.endsWith('.smv')).forEach(([f, text]) => fs.writeFileSync(f, text));
  console.log(`written: ${FIGS.length} figures, ${rel(SIM)}, ${rel(JSON_OUT)}, ${rel(PLC_ST)}, ${rel(PLC_IO)}, verification/cell_setup2_timed*.xml`);
  console.log('verification/*.smv are written by verify.js (npm run verify), not here');
}
