// Check of the timed model (src/cell-timed.js, step A4.2) without UPPAAL: the network is simulated
//   node timed.js [hours]
// for both cases of the master check (§5.17), first with every time at its nominal value: the CNC
// idle of every cycle must then equal the KPI of the model (M.KPI.idle2); then with random times in
// their intervals for `hours` (default 20): no deadlock or timelock may occur. The idle and period
// found are printed next to the hand-computed range M.KPI.idle2Range (the bounds come from UPPAAL, A4.3).
const M = require('./src/cell-model.js');
const TM = require('./src/cell-timed.js');

const hours = Number(process.argv[2] || 20);
const stats = (a) => (a.length ? `${Math.min(...a).toFixed(2)} to ${Math.max(...a).toFixed(2)} s, mean ${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2)} s` : 'none');
let failed = false;
for (const master of [false, true]) {
  const net = TM.network({ master });
  const name = master ? 'case 2 (master check may fall due)' : 'case 1 (no master check after start-up)';
  const nom = TM.simulate(net, { seconds: 7200, nominal: true });
  const off = nom.idles.filter((x) => Math.abs(x - M.KPI.idle2) > 0.005);
  const okNom = !nom.error && nom.idles.length >= 10 && !off.length;
  console.log(`${name}, nominal times: ${nom.cycles} cycles, idle ${stats(nom.idles)} (KPI ${M.KPI.idle2} s) ${okNom ? 'OK' : 'FAIL'}${nom.error ? ': ' + nom.error : ''}`);
  const rnd = TM.simulate(net, { seconds: hours * 3600, seed: 1 });
  const okRnd = !rnd.error && rnd.cycles > 0;
  console.log(`${name}, random times, ${hours} h: ${rnd.cycles} cycles, idle ${stats(rnd.idles)}, period ${stats(rnd.periods)} ${okRnd ? 'OK' : 'FAIL'}${rnd.error ? ': ' + rnd.error : ''}`);
  failed = failed || !okNom || !okRnd;
}
console.log(`hand-computed idle range (every time at its minimum / maximum): ${M.KPI.idle2Range.join(' to ')} s`);
process.exit(failed ? 1 : 0);
