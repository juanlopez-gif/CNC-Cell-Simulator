// Step A2.5: pallet capacity and combined faults (verification/pallet_capacity.md).
//   node --max-old-space-size=4000 verify_pallet.js [outFile]   default ../verification/pallet_capacity.json
//   ONLY=cap3_none,any_process,...   runs only these (the others are kept from the output file)
// Runs the explicit search of cell-verify.js with an output pallet of capacity 3 and of any capacity
// (slots 'any'), the counter game for L1-L3 (limits.counters) and the largest combined-fault run that
// fits in memory. One run at a time; the large ones need about 8 GB.
const fs = require('fs');
const path = require('path');
const V = require('./src/cell-verify.js');

const OUT = process.argv[2] || path.join(__dirname, '..', 'verification', 'pallet_capacity.json');
const COUNTERS = ['outCount', 'inParts'];
const RUNS = [
  { id: 'cap3_none', faults: V.RUNS.none, slots: 3 },
  { id: 'cap3_process', faults: V.RUNS.process, slots: 3 },
  { id: 'cap3_camwrong', faults: V.RUNS.camwrong, slots: 3 },
  { id: 'any_none', faults: V.RUNS.none, slots: 'any', game: true },
  { id: 'any_process', faults: V.RUNS.process, slots: 'any', game: true },
  { id: 'any_camwrong', faults: V.RUNS.camwrong, slots: 'any', game: true },
  { id: 'any_sensor', faults: V.RUNS.sensor, slots: 'any' },
  { id: 'any_sensor_camwrong', faults: V.RUNS.sensor_camwrong, slots: 'any' },
  // every class of 'all' except undersized parts (nok): 'all' itself is about 1.4e9 states
  { id: 'all_but_nok', faults: ['sensor', 'timeout', 'grip', 'master'], slots: 2 },
];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
let results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
for (const run of RUNS) {
  if (ONLY && !ONLY.includes(run.id)) continue;
  const ir = V.build(2, { faults: run.faults, slots: run.slots });
  process.stdout.write(`${run.id}: ${ir.vars.length} variables, ${ir.cmds.length} commands ... `);
  const t0 = Date.now();
  const r = V.check(ir, { maxStates: 120e6, counters: run.game ? COUNTERS : null });
  const failed = r.results.filter((x) => !x.ok).map((x) => x.id);
  const game = r.game ? Object.fromEntries(Object.entries(r.game).map(([k, g]) => [k, g.ok])) : null;
  console.log(`${r.states} states, ${r.edges} transitions, ${((Date.now() - t0) / 1000).toFixed(1)} s, failed: ${failed.join(' ') || 'none'}, ${r.deadlocks} deadlocks${game ? ', game: ' + JSON.stringify(game) : ''}`);
  results[run.id] = { faults: run.faults, slots: run.slots, states: r.states, edges: r.edges, seconds: (Date.now() - t0) / 1000,
    failed, deadlocks: r.deadlocks, game, unreached: r.unreached };
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n');
}
console.log('written', OUT);
