// Compare two verification results (results.json of verify.js): for every run, the number of states
// and transitions, deadlocks, never-reached states, property verdicts and the expected NuSMV verdicts.
//   node compare_verification.js <reference results.json> <new results.json>
// Exit 1 if they differ. Times are not compared.
const fs = require('fs');

const [refFile, newFile] = process.argv.slice(2);
if (!refFile || !newFile) { console.error('usage: node compare_verification.js <reference> <new>'); process.exit(2); }
const load = (f) => Object.fromEntries(JSON.parse(fs.readFileSync(f, 'utf8')).map((x) => [x.tag, x]));
const ref = load(refFile), cur = load(newFile);
const pick = (x) => ({
  states: x.states, edges: x.edges, deadlocks: x.deadlocks, unreached: x.unreached,
  props: Object.fromEntries(x.props.map((p) => [p.id, p.ok])), expect: x.expect,
});
const diffs = [];
new Set(Object.keys(ref).concat(Object.keys(cur))).forEach((tag) => {
  if (!ref[tag] || !cur[tag]) { diffs.push(`${tag}: ${ref[tag] ? 'missing in the new results' : 'not in the reference'}`); return; }
  const a = pick(ref[tag]), b = pick(cur[tag]);
  Object.keys(a).forEach((k) => { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${tag}.${k}: ${JSON.stringify(a[k]).slice(0, 200)} -> ${JSON.stringify(b[k]).slice(0, 200)}`); });
});
if (diffs.length) { console.log(`verification results differ from the reference:\n  ${diffs.join('\n  ')}`); process.exit(1); }
console.log(`verification results identical to the reference (${Object.keys(cur).length} runs)`);
