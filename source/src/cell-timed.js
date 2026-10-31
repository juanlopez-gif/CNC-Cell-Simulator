/* Timed model of the cell for UPPAAL (step A4, PROJECT_STATUS.md §5.17), built from the untimed
   model of cell-verify.js in nominal operation (no faults). Every machine becomes a timed automaton
   whose locations are the locations of the IR and whose edges are its commands; a job or a camera
   check takes a time in its interval (M.TRANGE, step A2.3), every other edge is taken as soon as it
   is enabled. The plant processes (CNC, belt, operator, environment) are small automata whose edges
   are the plant commands of the IR, with their times.
   network() returns the network as data, toUppaal() prints it as an UPPAAL XML file, simulate()
   runs it with random or nominal times: a check of the network without UPPAAL. */
(function (root) {
  const M = root.CellModel || require('./cell-model.js');
  const V = root.CellVerify || require('./cell-verify.js');
  const UNIT = 0.01;                                     // s per time unit (UPPAAL clocks compare with integers)
  const tk = (s) => Math.round(s / UNIT);
  // [min, max, nominal] in time units of a sum of time components
  const span = (keys) => [0, 1].map((k) => tk(keys.reduce((a, c) => a + M.TRANGE[c][k], 0))).concat(tk(keys.reduce((a, c) => a + M.T[c], 0)));

  // IR expressions (as in cell-verify.js)
  const TT = { op: 'T' }, FF = { op: 'F' };
  const and = (...a) => { const args = a.flat().filter((x) => x.op !== 'T'); if (args.some((x) => x.op === 'F')) return FF; return !args.length ? TT : args.length === 1 ? args[0] : { op: 'and', args }; };
  const or = (...a) => { const args = a.flat().filter((x) => x.op !== 'F'); if (args.some((x) => x.op === 'T')) return TT; return !args.length ? FF : args.length === 1 ? args[0] : { op: 'or', args }; };
  const not = (a) => (a.op === 'T' ? FF : a.op === 'F' ? TT : a.op === 'not' ? a.a : { op: 'not', a });
  const REL = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
  // an expression with one variable known (the location of the machine on whose edge it stands)
  function known(e, v, val) {
    switch (e.op) {
      case 'and': return and(e.args.map((a) => known(a, v, val)));
      case 'or': return or(e.args.map((a) => known(a, v, val)));
      case 'not': return not(known(e.a, v, val));
      case 'var': return e.v !== v ? e : val === true ? TT : FF;
      case 'in': return e.v !== v ? e : e.vals.includes(val) ? TT : FF;
      case 'cmp': return e.v !== v ? e : REL[e.rel](val, e.n) ? TT : FF;
    }
    return e;
  }
  const varsOf = (e, out = new Set()) => { if (e.v !== undefined) out.add(e.v); (e.args || []).forEach((a) => varsOf(a, out)); if (e.a) varsOf(e.a, out); return out; };
  // nondeterministic updates (oneOf, step) -> one variant per value, with the guard that selects it
  function variants(upd) {
    let out = [{ g: [], u: {} }];
    Object.keys(upd).forEach((v) => {
      const x = upd[v];
      if (x.op === 'oneOf') out = out.flatMap((o) => x.vals.map((val) => ({ g: o.g, u: Object.assign({}, o.u, { [v]: { op: 'val', val } }) })));
      else if (x.op === 'step') out = out.flatMap((o) => Object.keys(x.map).flatMap((d) => x.map[d].map((val) => ({ g: o.g.concat({ op: 'in', v: x.v, vals: [Number(d)] }), u: Object.assign({}, o.u, { [v]: { op: 'val', val } }) }))));
      else out.forEach((o) => { o.u[v] = x; });
    });
    return out;
  }

  // ------------------------------------------------------------------ network
  // opts.master: the 4-h master check of the gauge may fall due (case 2 of §5.17), otherwise it never
  // does after start-up (case 1).
  function network(opts) {
    opts = Object.assign({ master: false }, opts || {});
    const N = M.RULES.palletSlots;
    const ir = V.build(2, { faults: false, slots: N });
    const vars = ir.vars.map((v) => ({ name: v.name, dom: v.dom, init: v.init, note: v.note }));
    const addVar = (name, dom, init, note) => { ir.VI[name] = vars.length; vars.push({ name, dom, init, note }); };
    addVar('zsOk', [false, true], true, 'belt at zero speed for the zero-speed window (C4 -> C5)');
    addVar('cyc', [0, 1, 2], 0, 'observer: CNC cycles completed (2 = two or more)');
    const clocks = [], tpls = [];
    const tpl = (name, clock) => { const t = { name, clock, locs: {}, order: [], edges: [], init: null }; if (clock) clocks.push(clock); tpls.push(t); return t; };
    const loc = (t, name, o) => { t.locs[name] = Object.assign({ name, inv: null, committed: false }, o || {}); t.order.push(name); return name; };
    const edge = (t, from, to, guard, upd, o) => variants(upd).forEach((x) => t.edges.push(Object.assign({ from, to, guard: and(guard, x.g), upd: x.u, clk: null, sync: null, resets: [], label: '' }, o || {})));
    const plantCmd = (label) => { const c = ir.cmds.find((x) => !x.at && x.label === label); if (!c) throw new Error('no plant command ' + label); return c; };

    // ---- machines
    Object.keys(ir.mach).forEach((slot) => {
      const ms = ir.mach[slot], m = M.MACHINES[ms.mk], t = tpl('A_' + slot, 'x_' + slot);
      const stepOf = (l) => {
        const [sid, i] = [l.slice(0, l.lastIndexOf('_')), l.slice(l.lastIndexOf('_') + 1)];
        if (i === 'x') return null;
        return (sid === 'I' ? m.initial.do : sid === 'H' ? m.hold.do : m.states[sid].do)[+i];
      };
      ms.locs.forEach((l) => {
        const st = stepOf(l);
        const time = st && st.job ? span(M.JOBS[st.job].time) : st && st.check && !st.quick ? span(['check']) : null;
        // a check repeated until its condition holds waits one check time between tries, quick or not
        // (as the engines do); its other edges stay immediate
        const retry = st && st.check && st.until ? span(['check']) : null;
        loc(t, l, { time, retry, inv: time || retry ? { c: t.clock, hi: (time || retry)[1] } : null });
      });
      t.init = ir.vars[ir.VI[slot]].init;
      ir.cmds.filter((c) => c.proc === slot).forEach((c) => {
        const to = c.upd[slot] ? c.upd[slot].val : c.at, L = t.locs[c.at];     // a check "not yet" repeats
        // the only other self-loop, SUP X4 -> X4 (verification failed), is not reachable without faults
        const timed = L.time || (to === c.at ? L.retry : null);
        let guard = known(c.guard, slot, c.at);
        const sid = ms.info[c.at].sid, s = m.states[sid];
        if (c.at.endsWith('_x') && s && (s.next || []).some((tr) => tr.for)) {
          if (!s.next.every((tr) => !tr.for || tr.for === 'zeroSpeed')) throw new Error(`${slot} ${sid}: only the zero-speed window is timed`);
          guard = and(guard, { op: 'var', v: 'zsOk' });
        }
        edge(t, c.at, to, guard, c.upd, {
          clk: timed ? { c: t.clock, lo: timed[0] } : null,
          sync: c.urgent ? 'sup' : timed ? null : 'hurry', resets: [t.clock], label: c.label,
        });
      });
    });

    // ---- CNC: cycle, door unlock after it; the observer clocks w (idle) and p (period)
    {
      const t = tpl('A_CNC', 'x_CNC'), cyc = span(['cncCycle']), un = span(['unlock']);
      clocks.push('w', 'p');
      loc(t, 'Idle'); loc(t, 'Started', { committed: true });
      loc(t, 'Running', { time: cyc, inv: { c: 'x_CNC', hi: cyc[1] } });
      loc(t, 'Unlocking', { time: un, inv: { c: 'x_CNC', hi: un[1] } });
      t.init = 'Idle';
      edge(t, 'Idle', 'Started', { op: 'var', v: 'run' }, {}, { sync: 'hurry', label: 'CNC: cycle start seen' });
      edge(t, 'Started', 'Running', TT, {}, { resets: ['x_CNC', 'p'], label: 'CNC: machining' });
      ['CNC: cycle complete (part OK or undersized)', 'CNC: cycle complete (empty)'].forEach((lb) => {
        const c = plantCmd(lb);
        edge(t, 'Running', 'Unlocking', c.guard, Object.assign({}, c.upd, { cyc: { op: 'add', v: 'cyc', n: 1, lo: 0, hi: 2 } }),
          { clk: { c: 'x_CNC', lo: cyc[0] }, resets: ['x_CNC', 'w'], label: lb });
      });
      const lk = plantCmd('CNC: guard lock released after the cycle');
      edge(t, 'Unlocking', 'Idle', lk.guard, lk.upd, { clk: { c: 'x_CNC', lo: un[0] }, label: lk.label });
      edge(t, 'Unlocking', 'Idle', not(lk.guard), {}, { clk: { c: 'x_CNC', lo: un[0] }, label: 'CNC: no lock to release' });
    }

    // ---- belt: start ramp, transport from the start of motion, stop ramp, zero-speed window
    {
      const t = tpl('A_BELT', 'x_BELT'), bs = span(['beltStart']), tr = span(['beltTravel']), bp = span(['beltStop']), zs = span(['zeroSpeed']);
      const start = plantCmd('belt starts'), stop = plantCmd('belt stops');
      const entry = plantCmd('part moves from the entry'), exit = plantCmd('part reaches the end stop');
      loc(t, 'Stopped');
      loc(t, 'Starting', { time: bs, inv: { c: 'x_BELT', hi: bs[1] } });
      loc(t, 'Moving', { time: tr, inv: { c: 'x_BELT', hi: tr[1] } });
      loc(t, 'Stopping', { time: bp, inv: { c: 'x_BELT', hi: bp[1] } });
      loc(t, 'Settling', { time: zs, inv: { c: 'x_BELT', hi: zs[1] } });
      t.init = 'Stopped';
      edge(t, 'Stopped', 'Starting', start.guard, { zsOk: { op: 'val', val: false } }, { sync: 'hurry', resets: ['x_BELT'], label: 'motor on' });
      edge(t, 'Starting', 'Moving', TT, start.upd, { clk: { c: 'x_BELT', lo: bs[0] }, resets: ['x_BELT'], label: start.label });
      edge(t, 'Moving', 'Moving', entry.guard, entry.upd, { sync: 'hurry', label: entry.label });
      edge(t, 'Moving', 'Moving', exit.guard, exit.upd, { clk: { c: 'x_BELT', lo: tr[0] }, label: exit.label });
      edge(t, 'Moving', 'Stopping', stop.guard, {}, { sync: 'hurry', resets: ['x_BELT'], label: 'motor off' });
      edge(t, 'Stopping', 'Settling', TT, stop.upd, { clk: { c: 'x_BELT', lo: bp[0] }, resets: ['x_BELT'], label: stop.label });
      edge(t, 'Settling', 'Stopped', TT, { zsOk: { op: 'val', val: true } }, { clk: { c: 'x_BELT', lo: zs[0] }, label: 'zero speed for the window' });
    }

    // ---- operator: acts at once (condition of the bounds, §5.17)
    {
      const t = tpl('A_OP', null);
      loc(t, 'Ready'); t.init = 'Ready';
      // an output pallet is taken away only with parts on it: the IR lets the operator take away the
      // new empty pallet again while Robot 2 still shows LT-53, which at once would repeat without end
      const away = 'operator takes the full output pallet away';
      if (!ir.cmds.some((c) => c.proc === 'OP' && c.label === away)) throw new Error('no plant command ' + away);
      ir.cmds.filter((c) => c.proc === 'OP').forEach((c) => edge(t, 'Ready', 'Ready', c.label === away ? and(c.guard, { op: 'cmp', v: 'outCount', rel: '>', n: 0 }) : c.guard, c.upd, { sync: 'hurry', label: c.label }));
    }

    // ---- environment: the initial fill of the output pallet; the master check falling due (case 2)
    {
      const t = tpl('A_ENV', null);
      loc(t, 'Start', { committed: true }); loc(t, 'Env'); t.init = 'Start';
      const oc = ir.vars[ir.VI.outCount];
      edge(t, 'Start', 'Env', TT, { outCount: { op: 'oneOf', vals: [].concat(oc.init) } }, { label: 'initial fill of the output pallet' });
      vars[ir.VI.outCount].init = 0;
      if (opts.master) { const c = plantCmd('4 h pass since the last master check'); edge(t, 'Env', 'Env', c.guard, c.upd, { label: c.label, optional: true }); }
    }
    const unknown = ir.cmds.filter((c) => !c.at && !['CNC', 'BELT', 'OP', 'ENV'].includes(c.proc));
    if (unknown.length) throw new Error('plant commands without a timed process: ' + unknown.map((c) => c.label).join(', '));
    return { opts, ir, vars, VI: ir.VI, clocks, tpls, N };
  }

  // ------------------------------------------------------------------ UPPAAL XML
  function toUppaal(net, queries) {
    const { vars, VI } = net;
    const san = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
    const isBool = (v) => vars[VI[v]].dom[0] === false;
    const enc = (v, val) => {
      if (isBool(v)) return val ? 'true' : 'false';
      const k = vars[VI[v]].dom.indexOf(val);
      if (k < 0) throw new Error(`value ${val} not in the domain of ${v}`);
      return String(k);
    };
    vars.forEach((v) => { if (typeof v.dom[0] === 'number' && v.dom.some((d, k) => d !== k)) throw new Error(`numeric domain of ${v.name} must be 0..n`); });
    function ex(e) {
      switch (e.op) {
        case 'T': return 'true';
        case 'F': return 'false';
        case 'var': return san(e.v);
        case 'in':
          if (isBool(e.v)) return e.vals.length === 2 ? 'true' : e.vals[0] ? san(e.v) : `!${san(e.v)}`;
          return e.vals.length === 1 ? `${san(e.v)} == ${enc(e.v, e.vals[0])}` : '(' + e.vals.map((x) => `${san(e.v)} == ${enc(e.v, x)}`).join(' || ') + ')';
        case 'cmp': return `${san(e.v)} ${e.rel === '=' ? '==' : e.rel} ${e.n}`;
        case 'not': return `!(${ex(e.a)})`;
        case 'and': return '(' + e.args.map(ex).join(' && ') + ')';
        case 'or': return '(' + e.args.map(ex).join(' || ') + ')';
      }
      throw new Error('bad op ' + e.op);
    }
    function rhs(v, u) {
      switch (u.op) {
        case 'val': return enc(v, u.val);
        case 'copy': if (String(vars[VI[u.v]].dom) !== String(vars[VI[v]].dom)) throw new Error(`copy ${u.v} -> ${v}: different domains`); return san(u.v);
        case 'bexp': return ex(u.e);
        case 'add': { const s = `${san(u.v)} + ${u.n}`; return `(${s} > ${u.hi} ? ${u.hi} : ${s} < ${u.lo} ? ${u.lo} : ${s})`; }
      }
      throw new Error('bad update ' + u.op);
    }
    // the updates of a command are simultaneous (they read the old state): a value that reads a
    // variable written by another update of the same edge goes through a temporary
    let nInt = 0, nBool = 0;
    function assigns(e) {
      const keys = Object.keys(e.upd), written = new Set(keys);
      const reads = (u) => (u.op === 'copy' || u.op === 'add' ? [u.v] : u.op === 'bexp' ? Array.from(varsOf(u.e)) : []);
      const pre = [], main = [], post = [];
      let ki = 0, kb = 0;
      keys.forEach((v) => {
        const u = e.upd[v];
        if (reads(u).some((r) => r !== v && written.has(r))) {
          const tmp = isBool(v) ? `tb${kb++}` : `ti${ki++}`;
          pre.push(`${tmp} = ${rhs(v, u)}`); post.push(`${san(v)} = ${tmp}`, `${tmp} = ${isBool(v) ? 'false' : '0'}`);
        } else main.push(`${san(v)} = ${rhs(v, u)}`);
      });
      nInt = Math.max(nInt, ki); nBool = Math.max(nBool, kb);
      return pre.concat(main, post, e.resets.map((c) => `${c} = 0`)).join(', ');
    }
    const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const T = [];
    net.tpls.forEach((t) => {
      const id = (l) => `${t.name}_${san(l)}`;
      T.push('  <template>', `    <name>${t.name}</name>`);
      t.order.forEach((l) => {
        const L = t.locs[l];
        T.push(`    <location id="${id(l)}">`, `      <name>${san(l)}</name>`);
        if (L.inv) T.push(`      <label kind="invariant">${x(`${L.inv.c} <= ${L.inv.hi}`)}</label>`);
        if (L.committed) T.push('      <committed/>');
        T.push('    </location>');
      });
      T.push(`    <init ref="${id(t.init)}"/>`);
      t.edges.forEach((e) => {
        if (e.sync && e.clk) throw new Error(`${t.name}: clock guard on an urgent edge (${e.label})`);
        const g = [e.clk ? `${e.clk.c} >= ${e.clk.lo}` : null, e.guard.op === 'T' ? null : ex(e.guard)].filter(Boolean).join(' && ');
        const a = assigns(e);
        T.push('    <transition>', `      <source ref="${id(e.from)}"/>`, `      <target ref="${id(e.to)}"/>`);
        if (g) T.push(`      <label kind="guard">${x(g)}</label>`);
        if (e.sync) T.push(`      <label kind="synchronisation">${e.sync}!</label>`);
        if (a) T.push(`      <label kind="assignment">${x(a)}</label>`);
        if (e.label) T.push(`      <label kind="comments">${x(e.label)}</label>`);
        T.push('    </transition>');
      });
      T.push('  </template>');
    });
    const D = [];
    D.push(`// Timed model of the CNC machine-tending cell, Setup 2, nominal operation; master check of the gauge: ${net.opts.master ? 'may fall due (case 2)' : 'never due after start-up (case 1)'}.`);
    D.push('// Generated by source/src/cell-timed.js from source/src/cell-model.js (PROJECT_STATUS.md §5.17). Do not edit by hand.');
    D.push(`// Time unit: ${UNIT} s. Output pallet capacity ${net.N}.`);
    D.push('// hurry: edges taken as soon as they are enabled; sup: the supervisor reacts before any other edge.');
    D.push('urgent broadcast chan hurry, sup;');
    D.push('chan priority default < sup;');
    D.push('clock ' + net.clocks.join(', ') + ';');
    vars.forEach((v) => {
      const type = isBool(v.name) ? 'bool' : `int[0,${v.dom.length - 1}]`;
      const vals = isBool(v.name) || typeof v.dom[0] === 'number' ? '' : ' [' + v.dom.map((d, k) => `${k} ${d}`).join(', ') + ']';
      D.push(`${type} ${san(v.name)} = ${enc(v.name, Array.isArray(v.init) ? v.init[0] : v.init)}; // ${v.note || ''}${vals}`);
    });
    const body = T.join('\n');                                   // counts the temporaries
    for (let k = 0; k < nInt; k++) D.push(`int ti${k} = 0; // temporary of a simultaneous update`);
    for (let k = 0; k < nBool; k++) D.push(`bool tb${k} = false; // temporary of a simultaneous update`);
    const out = ['<?xml version="1.0" encoding="utf-8"?>',
      "<!DOCTYPE nta PUBLIC '-//Uppaal Team//DTD Flat System 1.6//EN' 'http://www.it.uu.se/research/group/darts/uppaal/flat-1_6.dtd'>",
      '<nta>', `  <declaration>${x(D.join('\n'))}</declaration>`, body,
      `  <system>${x('system ' + net.tpls.map((t) => t.name).join(', ') + ';')}</system>`, '  <queries>'];
    (queries || []).forEach((q) => out.push('    <query>', `      <formula>${x(q.f)}</formula>`, `      <comment>${x(q.c)}</comment>`, '    </query>'));
    out.push('  </queries>', '</nta>');
    return out.join('\n') + '\n';
  }

  // Queries of the model (A4.2: sanity; A4.3: the bounds of §5.17)
  function queries(net) {
    const q = [{ f: 'A[] not deadlock', c: 'no deadlock and no timelock: the cell always continues' }];
    const ir = net.ir;
    Object.keys(ir.mach).forEach((slot) => ir.states[slot].forEach((sid) => {
      const ls = ir.mach[slot].locs.filter((l) => ir.mach[slot].info[l].sid === sid);
      q.push({ f: 'E<> (' + ls.map((l) => `A_${slot}.${l}`).join(' || ') + ')', c: `${slot} ${sid} reachable` });
    }));
    q.push({ f: 'sup{A_CNC.Started && cyc >= 1}: w', c: 'B1 CNC idle per cycle, supremum (time units of 0.01 s)' });
    q.push({ f: 'inf{A_CNC.Started && cyc >= 1}: w', c: 'B1 CNC idle per cycle, infimum' });
    q.push({ f: 'sup{A_CNC.Started && cyc >= 1}: p', c: 'B2 period between two CNC starts, supremum' });
    q.push({ f: 'inf{A_CNC.Started && cyc >= 1}: p', c: 'B2 period between two CNC starts, infimum' });
    return q;
  }

  // ------------------------------------------------------------------ simulation of the network
  // Every timed location gets a time drawn in its interval when it is entered (opts.nominal: the
  // nominal time), and its timed edge is taken then; urgent edges are taken at once, in a random
  // order. An optional edge (the master check falling due) is taken with probability opts.pDue when
  // enabled. Returns the CNC idle and period of every cycle after the first, in s.
  function simulate(net, opts) {
    opts = Object.assign({ seconds: 3600, seed: 1, nominal: false, pDue: 0.1 }, opts || {});
    let a = opts.seed >>> 0;
    const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let r = Math.imul(a ^ (a >>> 15), 1 | a); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
    const val = {};
    net.vars.forEach((v) => { val[v.name] = Array.isArray(v.init) ? v.init[0] : v.init; });
    const ev = (e) => {
      switch (e.op) {
        case 'T': return true;
        case 'F': return false;
        case 'var': return val[e.v] === true;
        case 'in': return e.vals.includes(val[e.v]);
        case 'cmp': return REL[e.rel](val[e.v], e.n);
        case 'not': return !ev(e.a);
        case 'and': return e.args.every(ev);
        case 'or': return e.args.some(ev);
      }
      throw new Error('bad op');
    };
    const rv = (u) => (u.op === 'val' ? u.val : u.op === 'copy' ? val[u.v] : u.op === 'bexp' ? ev(u.e) : Math.max(u.lo, Math.min(u.hi, val[u.v] + u.n)));
    let t = 0;
    const reset = {}, at = {}, due = {};
    net.clocks.forEach((c) => { reset[c] = 0; });
    const clk = (c) => t - reset[c];
    const draw = (tp) => {
      const L = tp.locs[at[tp.name]], tm = L.time || L.retry;
      due[tp.name] = !tm ? Infinity : reset[L.inv.c] + (opts.nominal ? tm[2] : tm[0] + rnd() * (tm[1] - tm[0]));
    };
    net.tpls.forEach((tp) => { at[tp.name] = tp.init; draw(tp); });
    const out = { idles: [], periods: [], cycles: 0, error: null, steps: 0 };
    const eps = 1e-9;
    const fire = (tp, e) => {
      const nv = {};
      Object.keys(e.upd).forEach((v) => { nv[v] = rv(e.upd[v]); });
      Object.assign(val, nv);
      e.resets.forEach((c) => { reset[c] = t; });
      const before = at[tp.name];
      at[tp.name] = e.to;
      const L = tp.locs[e.to];
      if (before !== e.to || (L.inv && e.resets.includes(L.inv.c))) draw(tp);
      else if (e.clk) due[tp.name] = Infinity;          // the timed edge of this location has been taken
      if (tp.name === 'A_CNC' && e.to === 'Started' && val.cyc >= 1) { out.idles.push(clk('w') * UNIT); out.periods.push(clk('p') * UNIT); }
      if (tp.name === 'A_CNC' && e.to === 'Unlocking') out.cycles++;
      out.steps++;
    };
    const end = tk(opts.seconds);
    let instant = 0, lastT = -1;
    while (t < end) {
      if (t !== lastT) { lastT = t; instant = 0; }
      if (++instant > 10000) { out.error = `more than 10000 steps without time passing at ${(t * UNIT).toFixed(2)} s: ` + net.tpls.map((tp) => `${tp.name}.${at[tp.name]}`).join(' '); break; }
      const committed = net.tpls.filter((tp) => tp.locs[at[tp.name]].committed);
      const cand = [];
      net.tpls.forEach((tp) => {
        if (committed.length && !committed.includes(tp)) return;
        tp.edges.forEach((e) => { if (e.from === at[tp.name] && (!e.clk || clk(e.clk.c) >= e.clk.lo - eps) && ev(e.guard)) cand.push([tp, e]); });
      });
      const sup = cand.filter(([, e]) => e.sync === 'sup');
      const urgent = sup.length ? sup : cand.filter(([tp, e]) => committed.length || e.sync);
      const ready = cand.filter(([tp, e]) => e.clk && t >= due[tp.name] - eps);
      const optional = cand.filter(([, e]) => e.optional);
      if (optional.length && rnd() < opts.pDue) { fire(...optional[0]); continue; }
      const now = sup.length ? sup : urgent.concat(ready);
      if (now.length) { fire(...now[Math.floor(rnd() * now.length)]); continue; }
      // let time pass to the next drawn time
      let next = Infinity;
      net.tpls.forEach((tp) => { if (due[tp.name] > t + eps) next = Math.min(next, due[tp.name]); });
      if (next === Infinity) { out.error = `deadlock at ${(t * UNIT).toFixed(2)} s: ` + net.tpls.map((tp) => `${tp.name}.${at[tp.name]}`).join(' '); break; }
      const late = net.tpls.find((tp) => { const L = tp.locs[at[tp.name]]; return L.inv && next - reset[L.inv.c] > L.inv.hi + eps; });
      if (late) { out.error = `timelock at ${(t * UNIT).toFixed(2)} s: ${late.name} cannot stay in ${at[late.name]} and no edge is enabled; ` + net.tpls.map((tp) => `${tp.name}.${at[tp.name]}`).join(' '); break; }
      t = next;
    }
    out.seconds = t * UNIT;
    return out;
  }

  const API = { UNIT, span, network, toUppaal, queries, simulate };
  root.CellTimed = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
