// Exhaustive verification of the state machines of the shared model.
//   node --max-old-space-size=14000 verify.js [outDir]
// For each setup and fault class it builds the abstract model (src/cell-verify.js), explores every
// reachable state, checks the properties of M.PROPERTIES and writes
//   cell_setupN_<faults>.smv   the same model for NuSMV (run with: NuSMV -dynamic -dcx -r file.smv)
//   results.md / results.json  states, properties, unreachable states, counterexample traces
// If NuSMV is on the PATH (or in the NUSMV environment variable) the .smv files are checked with it
// too (output in cell_setupN_<faults>.nusmv.txt) and the report compares its verdicts with the search.
//   ONLY=setup2_sensor,...  re-runs some analyses and keeps the others from the last results.json
//   NUSMV_ONLY=1            keeps the results of the search and runs only NuSMV
//   NUSMV_JOBS=n            NuSMV runs at the same time (default 4), NUSMV_TIMEOUT=s per run (default 4 h)
//   REPORT_ONLY=1           only rewrites results.md from results.json
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const M = require('./src/cell-model.js');
const V = require('./src/cell-verify.js');

const OUT = process.argv[2] || path.join(__dirname, 'out', 'verification');
fs.mkdirSync(OUT, { recursive: true });
const RUNS = [];
[1, 2].forEach((setup) => ['none', 'sensor', 'process'].forEach((faults) => RUNS.push({ setup, faults })));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const { REPORT_ONLY, NUSMV_ONLY } = process.env;
const selected = (tag) => !ONLY || ONLY.includes(tag);
const RESULTS = path.join(OUT, 'results.json');
let results = [];
if ((ONLY || REPORT_ONLY || NUSMV_ONLY) && fs.existsSync(RESULTS)) results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const lint = M.lint();
if (lint.length) { console.error('model lint failed:\n' + lint.join('\n')); process.exit(1); }

// ---- explicit search
if (!REPORT_ONLY && !NUSMV_ONLY) for (const run of RUNS) {
  const tag = `setup${run.setup}_${run.faults}`;
  if (!selected(tag)) continue;
  const ir = V.build(run.setup, { faults: run.faults === 'none' ? false : run.faults });
  const smvFile = `cell_${tag}.smv`;
  fs.writeFileSync(path.join(OUT, smvFile), V.toSmv(ir));
  process.stdout.write(`${tag}: ${ir.vars.length} variables, ${ir.cmds.length} commands ... `);
  const t0 = Date.now();
  const r = V.check(ir, { maxStates: 30e6 });
  console.log(`${r.states} states, ${r.edges} transitions, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.results.filter((x) => !x.ok).length} failed, ${r.deadlocks} deadlocks`);
  results = results.filter((x) => x.tag !== tag);
  results.push({ tag, setup: run.setup, faults: run.faults, vars: ir.vars.length, commands: ir.cmds.length, smv: smvFile, states: r.states, edges: r.edges, seconds: (Date.now() - t0) / 1000, deadlocks: r.deadlocks, deadlock: r.deadlock, unreached: r.unreached, props: r.results, expect: V.expected(ir, r) });
}
const order = RUNS.map((x) => `setup${x.setup}_${x.faults}`);
results.sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag));

// ---- NuSMV: an independent, BDD-based check of the same .smv files
let nusmv = process.env.NUSMV || null;
if (!nusmv && !REPORT_ONLY) { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['NuSMV'], { stdio: 'pipe' }); nusmv = 'NuSMV'; } catch (e) { /* not installed */ } }
if (NUSMV_ONLY && !nusmv) { console.error('NUSMV_ONLY needs NuSMV on the PATH or NUSMV=<path to NuSMV>'); process.exit(1); }

// NuSMV prints every result with its formula; the results are matched to the NAMEs of the .smv file by
// that formula (normalized: NuSMV drops the braces and writes value sets with union).
function readNusmv(smv, out) {
  const norm = (e) => e.replace(/\bunion\b/g, ' ').replace(/[\s(){},]/g, '');
  const want = new Map();
  for (const m of smv.matchAll(/^(SPEC|INVARSPEC) NAME (\S+) := (.*);$/gm)) {
    const k = (m[1] === 'SPEC' ? 'specification' : 'invariant') + ' ' + norm(m[3]);
    want.set(k, (want.get(k) || []).concat(m[2]));
  }
  const verdict = {}, problems = [];
  for (const m of out.matchAll(/^-- (specification|invariant) (.*?)\s+is (true|false)$/gm)) {
    const names = want.get(m[1] + ' ' + norm(m[2]));
    if (names && names.length) verdict[names.shift()] = m[3] === 'true';
    else problems.push(`unknown result ${m[2].slice(0, 60)}`);
  }
  const st = out.match(/^reachable states: (\S+)/m), ver = out.match(/This is NuSMV (\S+)/);
  return { verdict, problems, states: st ? Number(st[1]) : null, version: ver ? ver[1] : null };
}
// The checks of a model run in two parts, in parallel: the CTL specifications L1-L3 (they need NuSMV's
// fair states, the slowest part) and the invariants with the number of reachable states. The
// invariants without next() come first (fast once the reachable states are known), those with next()
// last (the first of them costs about one more reachability computation). Every specification is its
// own command: NuSMV writes its output when a command ends, so a part stopped by the timeout keeps the
// results it already has.
const TIMEOUT = Number(process.env.NUSMV_TIMEOUT || 4 * 3600);
function nusmvParts(x) {
  const smv = fs.readFileSync(path.join(OUT, x.smv), 'utf8');
  const inv = [...smv.matchAll(/^INVARSPEC NAME (\S+) := (.*);$/gm)];
  const ctl = [...smv.matchAll(/^SPEC NAME (\S+) :=/gm)].map((m) => m[1]);
  const cmds = (check, names) => names.map((n) => `${check} -P "${n}"`);
  const plain = inv.filter((m) => !/\bnext\(/.test(m[2])).map((m) => m[1]), nexts = inv.filter((m) => /\bnext\(/.test(m[2])).map((m) => m[1]);
  return [
    ctl.length && { name: ctl.join(', '), cmds: cmds('check_ctlspec', ctl) },
    { name: 'invariants', cmds: [...cmds('check_invar', plain), 'print_reachable_states', ...cmds('check_invar', nexts)] },
  ].filter(Boolean).map((p, i) => Object.assign(p, { x, file: `nusmv/${x.tag}.${i}` }));
}
function runPart(p) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.join(OUT, 'nusmv'), { recursive: true });
    fs.writeFileSync(path.join(OUT, p.file + '.cmd'), ['set on_failure_script_quits', 'go', ...p.cmds, 'quit'].join('\n') + '\n');
    const txt = path.join(OUT, p.file + '.txt');
    const fd = fs.openSync(txt, 'w');
    const t0 = Date.now();
    let timedOut = false, finished = false;
    // run in OUT with relative file names: NuSMV on Windows does not open some long absolute paths
    const proc = spawn(nusmv, ['-dynamic', '-dcx', '-source', p.file + '.cmd', p.x.smv], { cwd: OUT, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, TIMEOUT * 1000);
    const done = (code, err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fs.closeSync(fd);
      p.seconds = (Date.now() - t0) / 1000;
      p.out = fs.readFileSync(txt, 'utf8');
      p.problem = timedOut ? `stopped after ${(TIMEOUT / 3600).toFixed(1)} h` : code ? (err ? err.message : `exit code ${code}`) : null;
      console.log(`NuSMV ${p.x.tag}, ${p.name}: ${(p.out.match(/^-- (specification|invariant) /gm) || []).length} results, ${p.seconds.toFixed(0)} s${p.problem ? ', ' + p.problem : ''}`);
      resolve();
    };
    proc.on('error', (e) => done(1, e));
    proc.on('exit', (code) => done(code));
  });
}
// the outputs of the parts, one after the other, in cell_<tag>.nusmv.txt
function joinParts(x, parts, jobs) {
  const text = parts.map((p) => `==== ${p.name}: NuSMV -dynamic -dcx -source <${p.cmds.length} commands> ${x.smv}, ${p.seconds.toFixed(0)} s${p.problem ? ', ' + p.problem : ''}\n${p.out}`).join('\n');
  fs.writeFileSync(path.join(OUT, x.smv.replace('.smv', '.nusmv.txt')), text);
  const r = readNusmv(fs.readFileSync(path.join(OUT, x.smv), 'utf8'), text);
  parts.forEach((p) => { if (p.problem) r.problems.push(`${p.name}: ${p.problem}`); });
  x.nusmv = Object.assign({ seconds: parts.reduce((s, p) => s + p.seconds, 0), jobs, parts: parts.map((p) => ({ name: p.name, seconds: p.seconds, problem: p.problem })) }, r);
  console.log(`NuSMV ${x.tag}: ${Object.keys(r.verdict).length} results, ${r.states} states${r.problems.length ? ', ' + r.problems.join('; ') : ''}`);
}
// NuSMV against the search: specifications with another verdict, and the number of reachable states
const sameCount = (a, b) => a === b || Number(b.toPrecision(6)) === a;   // NuSMV prints 6 digits
function compare(x) {
  if (!x.nusmv || !x.expect) return null;
  const names = Object.keys(x.expect);
  const differ = names.filter((k) => k in x.nusmv.verdict && x.nusmv.verdict[k] !== x.expect[k]);
  const missing = names.filter((k) => !(k in x.nusmv.verdict));
  const extra = Object.keys(x.nusmv.verdict).filter((k) => !(k in x.expect));
  const states = x.nusmv.states !== null && sameCount(x.nusmv.states, x.states);
  return { names, differ, missing, extra, states, ok: !differ.length && !missing.length && !extra.length && !x.nusmv.problems.length && states };
}

(async () => {
  if (nusmv && !REPORT_ONLY) {
    const models = results.filter((x) => selected(x.tag)).sort((a, b) => b.states - a.states);   // largest first
    const parts = models.flatMap(nusmvParts), queue = parts.slice();
    const jobs = Math.min(Number(process.env.NUSMV_JOBS || 4), parts.length);
    await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await runPart(queue.shift()); }));
    models.forEach((x) => joinParts(x, parts.filter((p) => p.x === x), jobs));
  }

  // ---- report
  const L = [];
  const FAULTS = { none: 'nominal operation', sensor: 'camera / proximity mismatches and camera faults', process: 'missed picks, confirmation timeouts, transport timers' };
  const faultText = (x) => FAULTS[x.faults] + (x.faults === 'process' && x.setup === 2 ? ', undersized parts' : '');
  const num = (n) => n.toLocaleString('en-US');
  const smvNum = (n) => (n >= 1e6 ? n.toExponential(5).replace(/\.?0+e/, 'e').replace(/e\+(\d)$/, 'e+0$1') : num(n));   // as NuSMV prints it
  L.push('# Verification of the cell state machines');
  L.push('');
  L.push(`Generated by \`source/verify.js\` from \`source/src/cell-model.js\` on ${new Date().toISOString().slice(0, 10)}.`);
  L.push('The abstract model contains the four state machines exactly as written in the model (every state and step is a location, every guard a command guard). The plant is abstract: no step times, jobs finish in any order, the CNC, the belt and the operator move nondeterministically, and the output pallet holds 2 parts instead of 12. Every reachable state was explored. Safety properties (P) were checked in every stable state or at every start of the named jobs; liveness properties (L) mean that from every reachable state the goal can still be reached (no deadlock and no livelock), assuming the operator eventually does what the HMI asks.');
  L.push('');
  L.push('| Run | Faults | States | Transitions | Time | Deadlocks | Failed properties |');
  L.push('|---|---|---:|---:|---:|---:|---|');
  results.forEach((x) => L.push(`| Setup ${x.setup} | ${faultText(x)} | ${num(x.states)} | ${num(x.edges)} | ${x.seconds.toFixed(1)} s | ${x.deadlocks} | ${x.props.filter((p) => !p.ok).map((p) => p.id).join(', ') || 'none'} |`));
  L.push('');
  const C = Object.fromEntries(results.map((x) => [x.tag, compare(x)]));
  const checked = results.filter((x) => C[x.tag]);
  if (checked.length) {
    const ver = checked.map((x) => x.nusmv.version).find(Boolean) || '';
    L.push('## NuSMV');
    L.push('');
    L.push(`The \`.smv\` files were also checked with NuSMV ${ver}, a symbolic (BDD-based) model checker that reads only the \`.smv\` file. It checks every property, the absence of deadlocks (\`no_deadlock\`) and, for every state of every machine, whether it is never reached (\`unreachable_*\`); its number of reachable states (printed with 6 significant digits) is compared with the search. Each model is checked by two NuSMV runs at the same time, one for the invariants and one for the CTL specifications L1-L3, with every specification as its own command (\`NuSMV -dynamic -dcx -r <file>\` runs the same checks in one go). Both checkers read the same abstract model, generated from \`cell-model.js\`: the agreement checks the search and the export, not the abstraction.`);
    L.push('');
    L.push('| Run | Specifications | Same verdict as the search | Reachable states (NuSMV) | States (search) | NuSMV time |');
    L.push('|---|---:|---|---:|---:|---:|');
    checked.forEach((x) => {
      const c = C[x.tag];
      const stopped = (x.nusmv.parts || []).filter((p) => p.problem).map((p) => `${p.name}: ${p.problem}`);
      const other = [...x.nusmv.problems.filter((q) => !stopped.includes(q)), ...c.extra.map((e) => `unknown ${e}`)];
      let verdict = c.differ.length ? `**no: ${c.differ.join(', ')}**` : `all ${c.names.length - c.missing.length}${c.missing.length ? ' checked' : ''}`;
      if (c.missing.length) verdict += `; **no result for ${c.missing.length > 5 ? c.missing.length + ' specifications' : c.missing.join(', ')}**${stopped.length ? ` (${stopped.join('; ')})` : ''}`;
      if (other.length) verdict += `; **${other.join('; ')}**`;
      L.push(`| Setup ${x.setup}, ${x.faults} | ${Object.keys(x.nusmv.verdict).length} | ${verdict} | ${x.nusmv.states === null ? '–' : smvNum(x.nusmv.states)} | ${num(x.states)}${c.states || x.nusmv.states === null ? '' : ' **(differs)**'} | ${x.nusmv.seconds.toFixed(0)} s |`);
    });
    const notRun = results.filter((x) => !C[x.tag]);
    L.push('');
    const jobs = Math.max(...checked.map((x) => x.nusmv.jobs || 1));
    L.push(`NuSMV time is the sum of the wall-clock times of the runs of a model${jobs > 1 ? `, with up to ${jobs} runs at a time on one PC` : ''}.`, '');
    if (notRun.length) L.push(`NuSMV was not run for: ${notRun.map((x) => `Setup ${x.setup}, ${x.faults}`).join('; ')}.`, '');
  }
  L.push('## Properties');
  L.push('');
  let searchOnly = 0;
  const cell = (x, id) => {
    const q = x.props.find((y) => y.id === id);
    if (!q) return '–';
    const js = q.ok ? 'pass' : '**FAIL**', n = x.nusmv && x.nusmv.verdict[id];
    if (x.nusmv && n === undefined) { searchOnly++; return js + '*'; }   // NuSMV ran but gave no result for it
    return n === undefined || n === q.ok ? js : `${js} (NuSMV: **${n ? 'pass' : 'FAIL'}**)`;
  };
  L.push('| Id | Property | ' + results.map((x) => `S${x.setup} ${x.faults}`).join(' | ') + ' |');
  L.push('|---|---|' + results.map(() => ':-:').join('|') + '|');
  M.PROPERTIES.forEach((p) => L.push(`| ${p.id} | ${p.text} | ` + results.map((x) => cell(x, p.id)).join(' | ') + ' |'));
  L.push('');
  if (checked.length) {
    const all = checked.length === results.length && !searchOnly;
    L.push(checked.every((x) => !C[x.tag].differ.length) ? `NuSMV gives the same verdict for every entry${all ? '' : ' it checked'}.` : 'Where NuSMV differs, its verdict is shown.');
    if (searchOnly) L.push('\\* explicit search only: NuSMV gave no result for this property in this run (see the NuSMV table).');
    L.push('');
  }
  L.push('## States that were never reached');
  L.push('');
  results.forEach((x) => {
    const u = Object.entries(x.unreached).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ');
    L.push(`- Setup ${x.setup}, ${x.faults}: ${u || 'none'}`);
  });
  L.push('');
  const fails = results.flatMap((x) => x.props.filter((p) => !p.ok).map((p) => ({ x, p })));
  if (fails.length || results.some((x) => x.deadlock)) {
    L.push('## Counterexamples');
    fails.forEach(({ x, p }) => { L.push('', `### Setup ${x.setup}, ${x.faults}: ${p.id} ${p.text}`, '', '```', ...p.trace.map((s, i) => `${i + 1}. ${s}`), '```'); });
    results.filter((x) => x.deadlock).forEach((x) => { L.push('', `### Setup ${x.setup}, ${x.faults}: deadlock`, '', '```', ...x.deadlock.trace.map((s, i) => `${i + 1}. ${s}`), '```'); });
    L.push('');
  }
  L.push('## Files');
  L.push('');
  results.forEach((x) => L.push(`- \`${x.smv}\`: NuSMV model, ${x.vars} variables, ${x.commands} commands${x.nusmv ? ' (NuSMV output in `' + x.smv.replace('.smv', '.nusmv.txt') + '`)' : ''}`));
  if (!checked.length) L.push('', 'NuSMV was not installed when this report was generated; the `.smv` files can be checked with `NuSMV -dynamic -dcx -r <file>`.');
  fs.writeFileSync(path.join(OUT, 'results.md'), L.join('\n') + '\n');
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 1));
  console.log('written', path.join(OUT, 'results.md'));
  if (fails.length || results.some((x) => x.deadlocks) || checked.some((x) => !C[x.tag].ok)) process.exitCode = 1;
})();
