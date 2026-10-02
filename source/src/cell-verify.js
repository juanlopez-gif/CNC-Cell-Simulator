/* Abstract model of the cell for exhaustive verification, built from the shared model.
   The controller is taken from M.MACHINES without change: every state and every step of it becomes
   a location, every guard and step action becomes a guarded command. The plant is abstracted: step
   times disappear, jobs complete in any order relative to the other machines, and the CNC, the belt,
   the operator and (optionally) sensor and process faults move nondeterministically.
   build() returns the guarded commands (interleaving semantics, one command per step), check()
   explores every reachable state, toSmv() prints the same commands as a NuSMV model. */
(function (root) {
  const M = root.CellModel || require('./cell-model.js');
  const X = M.expr;

  // ------------------------------------------------------------------ IR expressions
  const TT = { op: 'T' }, FF = { op: 'F' };
  const and = (...a) => { const args = a.flat().filter((x) => x.op !== 'T'); if (args.some((x) => x.op === 'F')) return FF; return !args.length ? TT : args.length === 1 ? args[0] : { op: 'and', args }; };
  const or = (...a) => { const args = a.flat().filter((x) => x.op !== 'F'); if (args.some((x) => x.op === 'T')) return TT; return !args.length ? FF : args.length === 1 ? args[0] : { op: 'or', args }; };
  const not = (a) => (a.op === 'T' ? FF : a.op === 'F' ? TT : a.op === 'not' ? a.a : { op: 'not', a });
  const bv = (v) => ({ op: 'var', v });
  const inn = (v, vals) => (vals.length ? { op: 'in', v, vals } : FF);
  const eq = (v, val) => inn(v, [val]);
  const cmp = (v, rel, n) => ({ op: 'cmp', v, rel, n });
  const REL = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
  // value expressions of an update
  const VAL = (val) => ({ op: 'val', val });
  const COPY = (v) => ({ op: 'copy', v });
  const BEXP = (e) => ({ op: 'bexp', e });
  const ADD = (v, n, lo, hi) => ({ op: 'add', v, n, lo, hi });
  const ONEOF = (vals) => ({ op: 'oneOf', vals });
  const san = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');

  // ------------------------------------------------------------------ build
  function build(setup, opts) {
    opts = Object.assign({ faults: 'all', slots: 2 }, opts || {});
    if (opts.faults === true) opts.faults = 'all';
    // fault classes: sensor = camera / proximity mismatches and camera faults; process = missed picks,
    // confirmation timeouts and timer faults, undersized parts (Setup 2)
    const FL = { mismatch: ['sensor', 'all'], camera: ['sensor', 'all'], grip: ['process', 'all'], timeout: ['process', 'all'], nok: ['process', 'all'] };
    const F = Object.fromEntries(Object.keys(FL).map((k) => [k, FL[k].includes(opts.faults)]));
    const N = opts.slots;
    const PART = setup === 1 ? ['none', 'raw', 'fin'] : ['none', 'raw', 'ok', 'nok'];
    const FIN = setup === 1 ? ['fin'] : ['ok', 'nok'];
    const vars = [], VI = {};
    const addVar = (name, dom, init, note) => { VI[name] = vars.length; vars.push({ name, dom, init, note }); };
    const B = [false, true];
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

    // ---- machines: one location per blocking step and one exit location per state
    const keys = M.SETUP_MACHINES[setup], mach = {};
    const blocking = (st) => !!(st.job || st.check || st.await);
    keys.forEach((mk) => {
      const m = M.MACHINES[mk], slot = m.slot, locs = [], info = {};
      const add = (loc, sid, i, st) => { locs.push(loc); info[loc] = { sid, i, st }; };
      (m.initial.do || []).forEach((st, i) => { if (blocking(st)) add(`I_${i}`, 'I', i, st); });
      add('I_x', 'I', 'x');
      Object.keys(m.states).forEach((sid) => {
        const s = m.states[sid];
        if (s.choice) return;
        (s.do || []).forEach((st, i) => { if (blocking(st)) add(`${sid}_${i}`, sid, i, st); });
        add(`${sid}_x`, sid, 'x');
      });
      if (m.hold) { (m.hold.do || []).forEach((st, i) => { if (blocking(st)) add(`H_${i}`, 'H', i, st); }); add('H_x', 'H', 'x'); }
      if (m.fault) add('F_x', 'F', 'x');
      // resume points: enter a state again at step 0, or repeat a check after a camera fault
      const res = ['none'];
      if (m.hold || m.fault) {
        Object.keys(m.states).forEach((sid) => {
          res.push(`${sid}@0`);
          (m.states[sid].do || []).forEach((st, i) => { if (st.check) res.push(`${sid}@${i}`); });
        });
      }
      mach[slot] = { mk, m, slot, locs, info, res: Array.from(new Set(res)) };
    });
    const SL = Object.keys(mach);
    const locsOf = (slot, sid) => mach[slot].locs.filter((l) => mach[slot].info[l].sid === sid);
    const jobLocs = (slot, pred) => mach[slot].locs.filter((l) => { const st = mach[slot].info[l].st; return st && st.job && (!pred || pred(st.job)); });
    const zoneLocs = (slot, zone) => jobLocs(slot, (j) => M.JOBS[j].zone === zone);
    const robotOf = (j) => M.JOBS[j].robot;

    // ---- variables
    SL.forEach((slot) => {
      const ms = mach[slot], m = ms.m;
      addVar(slot, ms.locs, (m.initial.do || []).some(blocking) ? 'I_0' : 'I_x', `location of the ${slot} machine (state_step)`);
      if (m.hold || m.fault) addVar(slot + '_res', ms.res, 'none', `where ${slot} continues after HOLD / FAULT`);
    });
    const PLC_VARS = ['partPlaced', 'pickAllowed', 'partPicked', 'CAM_FAULT'].concat(setup === 2 ? ['QH'] : []);
    PLC_VARS.forEach((v) => addVar(v, B, false, 'PLC variable'));
    addVar('mismatches', range(0, M.RULES.mismatchLimit), 0, 'mismatches in the window');
    if (setup === 2) addVar('consecNok', range(0, M.RULES.consecutiveNokHold), 0, 'NOK parts in a row');
    // check results belong to the machine that made the check
    const CPV = (slot, cp) => `res_${slot}_${san(cp)}`;
    SL.forEach((slot) => {
      const m = mach[slot].m, made = new Set();
      const scan = (list) => (list || []).forEach((st) => { if (st.check) { made.add(st.check); if (st.check === 'CP-1') made.add('CAM-1.part'); } });
      scan(m.initial.do); Object.values(m.states).forEach((x) => scan(x.do));
      made.forEach((cp) => addVar(CPV(slot, cp), B, false, `${slot}: result of its last ${cp} check`));
    });
    // plant
    addVar('door', ['closed', 'open'], 'closed', 'CNC door');
    addVar('lock', B, false, 'guard lock engaged');
    addVar('vise', ['open', 'clamped'], 'open', 'vise');
    addVar('cnc', PART, 'none', 'part in the fixture');
    addVar('run', B, false, 'CNC machining');
    (setup === 1 ? ['r1S'] : ['r1A', 'r1B']).forEach((g) => addVar(g, PART, 'none', 'part in Robot 1 gripper ' + g.slice(2)));
    addVar('r2S', PART, 'none', 'part in the Robot 2 gripper');
    ['beltEntry', 'beltMid', 'beltExit'].forEach((b) => addVar(b, PART, 'none', 'part on the belt'));
    addVar('moving', B, false, 'belt moving');
    addVar('inPresent', B, true, 'input pallet in place');
    addVar('inParts', B, true, 'raw parts left on the input pallet');
    addVar('outPresent', B, true, 'output pallet in place');
    addVar('outCount', range(0, N), range(0, N - 1), `parts on the output pallet (capacity ${N} in the abstract model)`);
    addVar('r1Home', B, true, 'Robot 1 at home');
    addVar('r2Home', B, true, 'Robot 2 at home');
    if (setup === 2) {
      addVar('nest', PART, 'none', 'part in the gauge nest');
      addVar('measured', B, false, 'gauge reading valid');
      addVar('zeroed', B, false, 'gauge zeroed with the master cube');
      addVar('pe65', B, false, 'PE-65 saw a part fall');
    }
    const has = (v) => v in VI;

    // ---- signals of the model -> IR
    const PLANT = {
      'HMI.auto': () => TT, 'HMI.loaded': () => and(bv('inPresent'), bv('inParts')),
      'R1.home': () => and(bv('r1Home'), not(inn('R1', jobLocs('R1')))),
      'R2.home': () => and(bv('r2Home'), not(inn('R2', jobLocs('R2')))),
      'R1.clearCnc': () => not(inn('R1', zoneLocs('R1', 'cnc'))), 'R1.clearConv': () => not(inn('R1', zoneLocs('R1', 'conv'))),
      'R2.clearConv': () => not(inn('R2', zoneLocs('R2', 'conv'))), 'R2.clearGauge': () => not(inn('R2', zoneLocs('R2', 'gauge'))),
      'CNC.ready': () => TT, 'CNC.run': () => bv('run'),
      'CNC.done': () => and(not(bv('run')), inn('cnc', FIN)), 'CNC.empty': () => and(not(bv('run')), eq('cnc', 'none')),
      'ZS-31': () => eq('door', 'open'), 'ZS-32': () => eq('door', 'closed'), 'ZS-33': () => bv('lock'),
      'ZS-34': () => eq('vise', 'open'), 'ZS-35': () => eq('vise', 'clamped'), 'PS-36': () => not(eq('cnc', 'none')),
      'GR-21': () => not(eq('r1S', 'none')), 'GR-21A': () => not(eq('r1A', 'none')), 'GR-21B': () => not(eq('r1B', 'none')),
      'GR-51': () => not(eq('r2S', 'none')),
      'ENC-43': () => bv('moving'), 'PE-42': () => not(eq('beltExit', 'none')), 'ROI-C': () => not(eq('beltExit', 'none')),
      'PX-52': () => bv('outPresent'), 'CAM-2.slot': () => TT,
      'GAUGE.zeroed': () => bv('zeroed'), 'GAUGE.valid': () => bv('measured'), 'GAUGE.ok': () => eq('nest', 'ok'), 'PE-65': () => bv('pe65'),
      'TRUE.entryPart': () => not(eq('beltEntry', 'none')), 'TRUE.outPallet': () => bv('outPresent'), 'TRUE.r2Nok': () => eq('r2S', 'nok'),
    };
    const TRUTH = {
      'CP-1': bv('inPresent'), 'CP-2': not(eq('beltEntry', 'none')), 'CP-3': not(eq('beltExit', 'none')),
      'CP-4': bv('outPresent'), 'CP-5': has('nest') ? not(eq('nest', 'none')) : FF,
    };
    const NUMVAR = { outCount: 'outCount', mismatches: 'mismatches', consecNok: 'consecNok' };
    let ctx = null;                            // the machine whose expression is being translated
    function SIG(src, inputs) {
      const e = typeof src === 'string' ? X.parse(src) : src;
      switch (e.op) {
        case 'and': return and(e.args.map((a) => SIG(a, inputs)));
        case 'or': return or(e.args.map((a) => SIG(a, inputs)));
        case 'not': return not(SIG(e.arg, inputs));
        case 'sig': {
          const s = M.SIGNALS[e.name];
          if (s.def) return SIG(s.def, inputs);
          if (s.kind === 'input') { if (!inputs || !(e.name in inputs)) throw new Error('input not assigned: ' + e.name); return inputs[e.name] ? TT : FF; }
          if (s.kind === 'check') { if (!ctx) throw new Error('check result read outside a machine: ' + e.name); return has(CPV(ctx, e.name)) ? bv(CPV(ctx, e.name)) : FF; }
          if (s.kind === 'var') return has(e.name) ? bv(e.name) : FF;
          if (!PLANT[e.name]) throw new Error('no abstract plant for signal ' + e.name);
          return PLANT[e.name]();
        }
        case 'cmp': {
          if (M.SLOTS[e.name]) { const ls = locsOf(e.name, e.value); if (e.rel === '=') return inn(e.name, ls); return not(inn(e.name, ls)); }
          if (/\.job$/.test(e.name)) { const slot = e.name.split('.')[0]; return inn(slot, jobLocs(slot, (j) => j === e.value)); }
          const s = M.SIGNALS[e.name];
          if (s && s.def) return SIG(s.def, inputs);
          const v = NUMVAR[e.name];
          if (!v || !has(v)) throw new Error('no numeric variable for ' + e.name);
          const n = e.value === 'slots' ? N : X.constVal(e.value);
          return inn(v, vars[VI[v]].dom.filter((d) => REL[e.rel](d, n)));
        }
      }
      throw new Error('bad expression');
    }
    const inputsOf = (src) => Array.from(X.names(src, true)).filter((n) => M.SIGNALS[n] && M.SIGNALS[n].kind === 'input');

    // ---- substitution: a condition evaluated after the updates of the same command
    function subst(e, upd) {
      switch (e.op) {
        case 'T': case 'F': return e;
        case 'and': return and(e.args.map((a) => subst(a, upd)));
        case 'or': return or(e.args.map((a) => subst(a, upd)));
        case 'not': return not(subst(e.a, upd));
        case 'var': case 'in': case 'cmp': {
          const u = upd[e.v];
          if (!u) return e;
          const dom = vars[VI[e.v]].dom;
          const test = (val) => (e.op === 'var' ? val === true : e.op === 'in' ? e.vals.includes(val) : REL[e.rel](val, e.n));
          if (u.op === 'val') return test(u.val) ? TT : FF;
          if (u.op === 'bexp') { if (e.op !== 'var') throw new Error('bexp on non-boolean'); return u.e; }
          if (u.op === 'copy') return e.op === 'var' ? bv(u.v) : e.op === 'in' ? inn(u.v, e.vals) : cmp(u.v, e.rel, e.n);
          if (u.op === 'add') return inn(u.v, dom.filter((d) => test(Math.max(u.lo, Math.min(u.hi, d + u.n)))));
          throw new Error(`cannot evaluate ${e.v} after a ${u.op} update in the same step`);
        }
      }
      throw new Error('bad expression ' + e.op);
    }
    // compose: apply new updates after earlier ones (value expressions refer to the old state)
    function compose(upd, more) {
      const out = Object.assign({}, upd);
      Object.keys(more).forEach((v) => {
        const u = more[v];
        if (u.op === 'copy' && upd[u.v]) out[v] = upd[u.v];
        else if (u.op === 'bexp') out[v] = BEXP(subst(u.e, upd));
        else if (u.op === 'add' && upd[u.v]) {
          const p = upd[u.v];
          if (p.op === 'val') out[v] = VAL(Math.max(u.lo, Math.min(u.hi, p.val + u.n)));
          else throw new Error('cannot compose two counter updates');
        } else out[v] = u;
      });
      return out;
    }
    const setUpd = (st) => {
      const u = {};
      if (st.set) Object.keys(st.set).forEach((v) => {
        if (v === 'mismatches') u.mismatches = VAL(st.set[v]);
        else if (has(v)) u[v] = VAL(st.set[v]);
      });
      if (st.inc && has(st.inc)) { const sg = M.SIGNALS[st.inc]; u[st.inc] = ADD(st.inc, 1, 0, sg.max); }
      return u;
    };
    const condSet = (st, upd) => {      // set/inc with an optional `when`: returns branches
      const u = setUpd(st);
      if (!st.when) return [{ cond: TT, upd: compose(upd, u) }];
      const c = subst(SIG(st.when), upd);
      return [{ cond: c, upd: compose(upd, u) }, { cond: not(c), upd }];
    };
    // job effects on the abstract plant
    function jobUpd(j) {
      const J = M.JOBS[j], u = {};
      if (J.move) {
        const [from, to] = J.move;
        const fromVar = { entry: 'beltEntry', exit: 'beltExit' }[from] || from, toVar = { entry: 'beltEntry', exit: 'beltExit' }[to] || to;
        let val;
        if (from === 'in') { val = VAL('raw'); u.inParts = ONEOF([true, false]); }
        else { val = COPY(fromVar); u[fromVar] = VAL('none'); if (fromVar === 'nest') u.measured = VAL(false); }
        if (to === 'out') u.outCount = ADD('outCount', 1, 0, N);
        else if (to === 'nok') u.pe65 = VAL(true);
        else u[toVar] = val;
      }
      Object.keys(J.set || {}).forEach((k) => {
        if (k === 'cnc') u.run = VAL(true);
        else if (has(k)) u[k] = VAL(J.set[k]);
      });
      if (J.at === 'home') u[J.robot === 'R1' ? 'r1Home' : 'r2Home'] = VAL(true);
      return u;
    }
    const jobStart = (j) => {               // the robot leaves home when a job starts; PE-65 resets
      const r = robotOf(j), u = {};
      if (r === 'R1') u.r1Home = VAL(false);
      if (r === 'R2') { u.r2Home = VAL(false); if (has('pe65')) u.pe65 = VAL(false); }
      return u;
    };

    // ---- commands
    const cmds = [];
    const addCmd = (c) => {
      if (c.guard.op === 'F') return;
      c.id = cmds.length;
      cmds.push(c);
    };
    // Enter state `sid` of `slot` at step k inside the command being built. Choices and instant steps
    // (set, inc, skipped steps) are passed in the same command; returns the possible end points.
    function advance(slot, sid, k, cond, upd, depth) {
      const ms = mach[slot], m = ms.m;
      if ((depth || 0) > 30) throw new Error(`advance loop in ${slot} at ${sid}`);
      const s = sid === 'H' ? { do: m.hold.do || [] } : sid === 'F' ? { do: [] } : sid === 'I' ? { do: m.initial.do || [] } : m.states[sid];
      if (s.choice) {
        const c = subst(SIG(s.choice), upd);
        return advance(slot, s.yes, 0, and(cond, c), upd, (depth || 0) + 1).concat(advance(slot, s.no, 0, and(cond, not(c)), upd, (depth || 0) + 1));
      }
      const steps = s.do || [];
      for (let i = k; i < steps.length; i++) {
        const st = steps[i];
        if (blocking(st)) {
          const enter = (c2, u2) => {
            const u3 = st.job ? compose(u2, jobStart(st.job)) : u2;
            return [{ cond: c2, upd: u3, loc: `${sid}_${i}`, job: st.job }];
          };
          if (st.when) {
            const c = subst(SIG(st.when), upd);
            return enter(and(cond, c), upd).concat(advance(slot, sid, i + 1, and(cond, not(c)), upd, (depth || 0) + 1));
          }
          return enter(cond, upd);
        }
        const br = condSet(st, upd);
        if (br.length === 1) { upd = br[0].upd; continue; }
        return br.flatMap((b) => advance(slot, sid, i + 1, and(cond, b.cond), b.upd, (depth || 0) + 1));
      }
      return [{ cond, upd, loc: `${sid}_x` }];
    }
    const HOLDREQ = SIG('HOLD.req');
    function emit(slot, at, cond, leaves, label, extra) {
      leaves.forEach((l) => {
        const upd = Object.assign({}, l.upd, { [slot]: VAL(l.loc) });
        if (mach[slot].res.length > 1 && !('_res' in (extra || {})) && !upd[slot + '_res'] && (l.loc !== 'H_0' && !l.loc.startsWith('H_') && l.loc !== 'F_x')) upd[slot + '_res'] = VAL('none');
        addCmd(Object.assign({ proc: slot, at, guard: and(eq(slot, at), cond, l.cond), upd, label, enters: l.job && l.loc !== at ? l.job : null }, extra || {}));
      });
    }
    const toHold = (slot, at, cond, resPoint, label) => {
      const m = mach[slot].m;
      if (!m.hold) return;
      const leaves = advance(slot, 'H', 0, TT, {});
      leaves.forEach((l) => l.upd[slot + '_res'] = VAL(resPoint));
      emit(slot, at, cond, leaves, label, { _res: true });
    };
    const toFault = (slot, at, cond, resPoint, label) => {
      if (!mach[slot].m.fault) return;
      addCmd({ proc: slot, at, guard: and(eq(slot, at), cond), upd: { [slot]: VAL('F_x'), [slot + '_res']: VAL(resPoint) }, label });
    };
    const resumeFrom = (point) => { const [sid, k] = point.split('@'); return [sid, +k]; };

    SL.forEach((slot) => {
      const ms = mach[slot], m = ms.m;
      ctx = slot;
      ms.locs.forEach((at) => {
        const { sid, i, st } = ms.info[at];
        const s = sid === 'I' ? { next: [{ to: m.initial.to, when: m.initial.when || 'HMI.auto', hold: false }], wait: true } : sid === 'H' || sid === 'F' ? null : m.states[sid];
        const holdable = !!m.hold && s && s.hold !== false && sid !== 'I';
        const stepsOf = sid === 'H' ? (m.hold.do || []) : sid === 'I' ? (m.initial.do || []) : sid === 'F' ? [] : (s.do || []);
        if (i !== 'x') {
          // ---------------- a blocking step
          if (st.job) {
            const variants = [{ name: 'done', upd: jobUpd(st.job) }];
            if (F.grip && M.JOBS[st.job].canFail) variants.push({ name: 'missed', upd: {} });
            variants.forEach((v) => {
              const after = st.confirm ? subst(SIG(st.confirm), v.upd) : TT;
              emit(slot, at, after, advance(slot, sid, i + 1, TT, v.upd), `${sid}: ${st.job} ${v.name}`);
              if (st.confirm) toFault(slot, at, not(after), `${sid}@0`, `${sid}: ${st.job} ${v.name}, confirmation missing`);
            });
          } else if (st.check) {
            const cpv = CPV(slot, st.check);
            const base = { [cpv]: BEXP(TRUTH[st.check]) };
            if (st.check === 'CP-1') base[CPV(slot, 'CAM-1.part')] = BEXP(and(bv('inPresent'), bv('inParts')));
            const variants = [{ name: 'agree', upd: base }];
            if (F.mismatch) variants.push({ name: 'mismatch', upd: Object.assign({}, base, { mismatches: ADD('mismatches', 1, 0, M.RULES.mismatchLimit) }) });
            variants.forEach((v) => {
              const ok = st.until ? subst(SIG(st.until), v.upd) : TT;
              const conf = st.confirm ? subst(SIG(st.confirm), v.upd) : TT;
              emit(slot, at, and(ok, conf), advance(slot, sid, i + 1, TT, v.upd), `${sid}: ${st.check} ${v.name}`);
              if (st.confirm) toFault(slot, at, and(ok, not(conf)), `${sid}@0`, `${sid}: ${st.check} ${v.name}, confirmation missing`);
              if (st.until) {
                // not yet: check again later (or hold while waiting)
                addCmd({ proc: slot, at, guard: and(eq(slot, at), not(ok), holdable ? not(HOLDREQ) : TT), upd: v.upd, label: `${sid}: ${st.check} ${v.name}, not yet` });
                if (holdable) toHold(slot, at, and(not(ok), HOLDREQ), `${sid}@0`, `${sid}: hold while waiting`);
              }
            });
            if (F.camera && sid !== 'I') {
              const leaves = mach[slot].m.hold ? advance(slot, 'H', 0, TT, {}) : [];
              leaves.forEach((l) => { l.upd.CAM_FAULT = VAL(true); l.upd[slot + '_res'] = VAL(`${sid}@${i}`); });
              emit(slot, at, TT, leaves, `${sid}: ${st.check} camera fault`, { _res: true });
            }
          } else if (st.await) {
            const w = SIG(st.await);
            emit(slot, at, w, advance(slot, sid, i + 1, TT, {}), `${sid}: await ${st.await}`);
            if (holdable) toHold(slot, at, and(not(w), HOLDREQ), `${sid}@0`, `${sid}: hold while waiting`);
          }
          return;
        }
        // ---------------- exit location
        if (sid === 'H') {
          ms.res.filter((r) => r !== 'none').forEach((r) => {
            const [rs, rk] = resumeFrom(r);
            emit(slot, at, and(SIG(m.hold.exit), eq(slot + '_res', r)), advance(slot, rs, rk, TT, {}), `H: resume ${r}`);
          });
          return;
        }
        if (sid === 'F') {
          ms.res.filter((r) => r !== 'none').forEach((r) => {
            const [rs, rk] = resumeFrom(r);
            const clear = SIG(m.fault.exit, { 'HMI.clear': true });
            emit(slot, at, and(clear, eq(slot + '_res', r), m.hold ? not(HOLDREQ) : TT), advance(slot, rs, rk, TT, {}), `F: cleared, repeat ${r}`);
            if (m.hold) toHold(slot, at, and(clear, eq(slot + '_res', r), HOLDREQ), r, 'F: cleared during a line stop');
          });
          return;
        }
        const ins = Array.from(new Set(s.next.flatMap((tr) => inputsOf(tr.when))));
        const combos = ins.reduce((acc, n) => acc.flatMap((a) => [Object.assign({}, a, { [n]: false }), Object.assign({}, a, { [n]: true })]), [{}]);
        const urgent = !!m.urgent && !ins.length;
        combos.forEach((inputs) => {
          let prior = FF;
          s.next.forEach((tr) => {
            const g = SIG(tr.when, inputs), en = and(g, not(prior));
            prior = or(prior, g);
            if (en.op === 'F') return;
            let acts = {};
            (tr.do || []).forEach((a) => { acts = compose(acts, setUpd(a)); });
            const holdPt = tr.hold !== false && !!m.hold && sid !== 'I';
            const lbl = `${sid} → ${tr.to}` + (ins.length ? ` [${ins.filter((n) => inputs[n]).join(', ') || 'no input'}]` : '');
            if (holdPt) {
              emit(slot, at, and(en, not(HOLDREQ)), advance(slot, tr.to, 0, TT, acts), lbl, { urgent });
              toHold(slot, at, and(en, HOLDREQ), `${tr.to}@0`, `${sid}: hold before ${tr.to}`);
            } else emit(slot, at, en, advance(slot, tr.to, 0, TT, acts), lbl, { urgent });
          });
          const none = not(prior);
          if (F.timeout && !s.wait && m.fault) toFault(slot, at, none, `${sid}@0`, `${sid}: confirmation timeout`);
          if (s.wait && holdable) toHold(slot, at, and(none, HOLDREQ), `${sid}@0`, `${sid}: hold while waiting`);
          if (F.timeout && m.fault) (s.faults || []).forEach((f) => toFault(slot, at, and(none, f.when ? SIG(f.when) : TT), `${sid}@0`, `${sid}: timer fault (${X.plain(f.text || '')})`));
        });
      });
    });
    ctx = null;
    // dedupe commands with the same guard and updates (several input combinations give the same move)
    const seenCmd = new Map();
    const uniq = [];
    cmds.forEach((c) => { const k = c.proc + '|' + JSON.stringify(c.guard) + '|' + JSON.stringify(c.upd); if (!seenCmd.has(k)) { seenCmd.set(k, c); uniq.push(c); } });
    cmds.length = 0; uniq.forEach((c, i) => { c.id = i; cmds.push(c); });

    // ---- plant and environment
    const plant = (proc, label, guard, upd) => addCmd({ proc, at: null, guard, upd, label });
    if (setup === 1) plant('CNC', 'CNC: cycle complete', and(bv('run'), eq('cnc', 'raw')), { run: VAL(false), cnc: VAL('fin') });
    else plant('CNC', 'CNC: cycle complete (part OK or undersized)', and(bv('run'), eq('cnc', 'raw')), { run: VAL(false), cnc: F.nok ? ONEOF(['ok', 'nok']) : VAL('ok') });
    plant('CNC', 'CNC: cycle complete (empty)', and(bv('run'), not(eq('cnc', 'raw'))), { run: VAL(false) });
    plant('CNC', 'CNC: guard lock released after the cycle', and(not(bv('run')), bv('lock'), inn('cnc', FIN)), { lock: VAL(false) });
    const MOTOR = SIG(M.OUTPUTS['BELT.motor'].def), LT53 = SIG(M.OUTPUTS['LT-53'].def);
    plant('BELT', 'belt starts', and(MOTOR, not(bv('moving'))), { moving: VAL(true) });
    plant('BELT', 'belt stops', and(not(MOTOR), bv('moving')), { moving: VAL(false) });
    plant('BELT', 'part moves from the entry', and(bv('moving'), not(eq('beltEntry', 'none')), eq('beltMid', 'none')), { beltMid: COPY('beltEntry'), beltEntry: VAL('none') });
    plant('BELT', 'part reaches the end stop', and(bv('moving'), not(eq('beltMid', 'none')), eq('beltExit', 'none')), { beltExit: COPY('beltMid'), beltMid: VAL('none') });
    plant('OP', 'operator removes the empty input pallet', and(bv('inPresent'), not(bv('inParts'))), { inPresent: VAL(false) });
    plant('OP', 'operator places a full input pallet', not(bv('inPresent')), { inPresent: VAL(true), inParts: VAL(true) });
    plant('OP', 'operator takes the full output pallet away', and(LT53, bv('outPresent')), { outPresent: VAL(false), outCount: VAL(0) });
    plant('OP', 'operator places an empty output pallet', not(bv('outPresent')), { outPresent: VAL(true) });
    if (F.mismatch) plant('ENV', 'a mismatch leaves the 10-min window', cmp('mismatches', '>', 0), { mismatches: ADD('mismatches', -1, 0, M.RULES.mismatchLimit) });
    M.RUNGS.forEach((r) => {
      const g = SIG(r.when, { 'HMI.release': true });
      const u = {}; Object.keys(r.set).forEach((v) => { if (has(v)) u[v] = VAL(r.set[v]); });
      if (Object.keys(u).length) plant('OP', 'rung: ' + r.text, g, u);
    });

    // ---- properties
    const props = M.PROPERTIES.filter((p) => !p.setup || p.setup === setup).map((p) => {
      const q = { id: p.id, text: p.text };
      if (p.never) { q.kind = 'never'; q.e = SIG(p.never); }
      if (p.start) { q.kind = 'start'; q.jobs = p.start; q.e = SIG(p.require); }
      if (p.eventually) { q.kind = 'eventually'; q.e = SIG(p.eventually); }
      return q;
    });
    // coverage targets: every state of every machine
    const states = {};
    SL.forEach((slot) => { states[slot] = Array.from(new Set(mach[slot].locs.map((l) => mach[slot].info[l].sid))).filter((s) => s !== 'I'); });
    return { setup, opts, vars, VI, cmds, props, mach: Object.fromEntries(SL.map((s) => [s, { mk: mach[s].mk, locs: mach[s].locs, info: Object.fromEntries(mach[s].locs.map((l) => [l, { sid: mach[s].info[l].sid, job: mach[s].info[l].st && mach[s].info[l].st.job }])) }])), states };
  }

  // ------------------------------------------------------------------ explicit-state exploration
  // Breadth-first search over all reachable states. States are stored as nv bytes in one buffer and
  // found again through an open-addressing hash table, so a state costs about nv + 20 bytes.
  // Safety properties are checked during the search. The "eventually" properties (AG EF goal) are
  // checked afterwards with Tarjan's algorithm on the same graph (successors are recomputed, not
  // stored): they hold if every bottom strongly connected component contains a goal state.
  function check(ir, limits) {
    limits = Object.assign({ maxStates: 3e6 }, limits || {});
    const { vars, VI, cmds } = ir, nv = vars.length;
    const vidx = vars.map((v) => { const m = new Map(); v.dom.forEach((d, k) => m.set(d, k)); return m; });
    function ce(e) {                         // compile an expression to a test on a state array
      switch (e.op) {
        case 'T': return () => true;
        case 'F': return () => false;
        case 'var': { const i = VI[e.v]; const one = vidx[i].get(true); return (s) => s[i] === one; }
        case 'in': { const i = VI[e.v]; const mask = vars[i].dom.map((d) => e.vals.includes(d)); return (s) => mask[s[i]]; }
        case 'cmp': { const i = VI[e.v]; const mask = vars[i].dom.map((d) => REL[e.rel](d, e.n)); return (s) => mask[s[i]]; }
        case 'not': { const a = ce(e.a); return (s) => !a(s); }
        case 'and': { const a = e.args.map(ce); return (s) => { for (const f of a) if (!f(s)) return false; return true; }; }
        case 'or': { const a = e.args.map(ce); return (s) => { for (const f of a) if (f(s)) return true; return false; }; }
      }
      throw new Error('bad op ' + e.op);
    }
    function cu(upd) {                       // compile updates: state -> list of next states
      const parts = Object.keys(upd).map((v) => {
        const i = VI[v];
        if (i === undefined) throw new Error('update of unknown variable ' + v);
        const u = upd[v], ix = vidx[i];
        const idxOf = (val) => { const k = ix.get(val); if (k === undefined) throw new Error(`value ${val} not in the domain of ${v}`); return k; };
        let f;
        if (u.op === 'val') { const k = [idxOf(u.val)]; f = () => k; }
        else if (u.op === 'copy') { const j = VI[u.v]; const map = vars[j].dom.map((d) => [idxOf(d)]); f = (s) => map[s[j]]; }
        else if (u.op === 'bexp') { const g = ce(u.e), t = [idxOf(true)], fl = [idxOf(false)]; f = (s) => (g(s) ? t : fl); }
        else if (u.op === 'add') { const j = VI[u.v]; const map = vars[j].dom.map((d) => [idxOf(Math.max(u.lo, Math.min(u.hi, d + u.n)))]); f = (s) => map[s[j]]; }
        else if (u.op === 'oneOf') { const ks = u.vals.map(idxOf); f = () => ks; }
        else throw new Error('bad update ' + u.op);
        return [i, f];
      });
      return (s) => {
        let outs = [s.slice()];
        for (const [i, f] of parts) {
          const vals = f(s);
          if (vals.length === 1) { for (const o of outs) o[i] = vals[0]; }
          else outs = outs.flatMap((o) => vals.map((k) => { const c = o.slice(); c[i] = k; return c; }));
        }
        return outs;
      };
    }
    const C = cmds.map((c) => ({ c, g: ce(c.guard), u: cu(c.upd) }));
    // index the commands of a machine by its location; plant commands are always candidates
    const byLoc = {}, free = [];
    C.forEach((x) => {
      if (x.c.at) { const i = VI[x.c.proc], k = vidx[i].get(x.c.at); ((byLoc[i] = byLoc[i] || {})[k] = byLoc[i][k] || []).push(x); }
      else free.push(x);
    });
    const slotIdx = Object.keys(byLoc).map(Number);
    const enabled = (s) => {
      const out = [];
      for (const i of slotIdx) { const l = byLoc[i][s[i]]; if (l) for (const x of l) if (x.g(s)) out.push(x); }
      for (const x of free) if (x.g(s)) out.push(x);
      const urg = out.filter((x) => x.c.urgent);
      return urg.length ? { list: urg, stable: false } : { list: out, stable: true };
    };
    const startProps = ir.props.filter((p) => p.kind === 'start').map((p) => ({ p, f: ce(p.e) }));
    const neverProps = ir.props.filter((p) => p.kind === 'never').map((p) => ({ p, f: ce(p.e) }));
    const evProps = ir.props.filter((p) => p.kind === 'eventually').map((p) => ({ p, f: ce(p.e) }));
    // ---- state store
    const grow32 = (init) => { let a = new Int32Array(init || 1 << 16), n = 0; return { push(v) { if (n === a.length) { const b = new Int32Array(a.length * 2); b.set(a); a = b; } a[n++] = v; }, get: (i) => a[i], get length() { return n; } }; };
    let pool = new Uint8Array(nv * 65536), count = 0;
    let cap = 1 << 20, mask = cap - 1, table = new Int32Array(cap).fill(-1);
    const parent = grow32(1 << 20), via = grow32(1 << 20);
    const hashOf = (s, off) => { let h = 2166136261; for (let k = 0; k < nv; k++) { h ^= s[off + k]; h = Math.imul(h, 16777619); } return h >>> 0; };
    const same = (s, id) => { const o = id * nv; for (let k = 0; k < nv; k++) if (pool[o + k] !== s[k]) return false; return true; };
    const rehash = () => {
      cap *= 2; mask = cap - 1; table = new Int32Array(cap).fill(-1);
      for (let id = 0; id < count; id++) { let h = hashOf(pool, id * nv) & mask; while (table[h] !== -1) h = (h + 1) & mask; table[h] = id; }
    };
    const find = (s) => { let h = hashOf(s, 0) & mask; for (;;) { const id = table[h]; if (id === -1) return -1; if (same(s, id)) return id; h = (h + 1) & mask; } };
    const intern = (s, from, cmd) => {
      let h = hashOf(s, 0) & mask;
      for (;;) { const id = table[h]; if (id === -1) break; if (same(s, id)) return id; h = (h + 1) & mask; }
      const id = count++;
      if ((id + 1) * nv > pool.length) { const p2 = new Uint8Array(pool.length * 2); p2.set(pool); pool = p2; }
      pool.set(s, id * nv); table[h] = id; parent.push(from); via.push(cmd);
      if (count * 2 > cap) rehash();
      return id;
    };
    const st = (id) => pool.slice(id * nv, id * nv + nv);
    // initial states (variables with a set of initial values give several)
    let inits = [new Uint8Array(nv)];
    vars.forEach((v, i) => {
      const vals = Array.isArray(v.init) ? v.init : [v.init];
      inits = inits.flatMap((s) => vals.map((val) => { const c = s.slice(); const k = vidx[i].get(val); if (k === undefined) throw new Error(`init ${v.name}=${val}`); c[i] = k; return c; }));
    });
    inits.forEach((s) => intern(s, -1, -1));
    const viol = {}, deadlocks = [];
    const t0 = Date.now();
    let edges = 0;
    for (let n = 0; n < count; n++) {
      if (count > limits.maxStates) throw new Error(`more than ${limits.maxStates} states`);
      const s = st(n), en = enabled(s);
      if (!en.list.length) deadlocks.push(n);
      if (en.stable) for (const { p, f } of neverProps) if (viol[p.id] === undefined && f(s)) viol[p.id] = n;
      for (const x of en.list) {
        for (const t of x.u(s)) {
          const id = intern(t, n, x.c.id);
          edges++;
          if (x.c.enters) for (const { p, f } of startProps) if (viol[p.id] === undefined && p.jobs.includes(x.c.enters) && !f(t)) viol[p.id] = id;
        }
      }
      if (limits.progress && n % 1e6 === 0 && n) limits.progress(n, count);
    }
    const ns = count;
    // ---- Tarjan (iterative) on the implicit graph: find the bottom SCCs
    if (evProps.length) {
      const index = new Int32Array(ns).fill(-1), low = new Int32Array(ns), onStack = new Uint8Array(ns);
      const sccStack = new Int32Array(ns), callV = new Int32Array(ns), callPos = new Int32Array(ns);
      let sp = 0, cp = 0, idx = 0;
      const sccOf = new Int32Array(ns).fill(-1);
      let nScc = 0;
      const badScc = evProps.map(() => -1);
      const successorsOf = (v) => { const s = st(v), out = new Set(); for (const x of enabled(s).list) for (const t of x.u(s)) out.add(find(t)); return Array.from(out); };
      // successor lists live on a shared stack, one block per active frame
      let succTop = 0;
      const succArr = { a: new Int32Array(1 << 20) };
      const pushSucc = (list) => { while (succTop + list.length > succArr.a.length) { const b = new Int32Array(succArr.a.length * 2); b.set(succArr.a); succArr.a = b; } for (const w of list) succArr.a[succTop++] = w; };
      const frameStart = new Int32Array(ns), frameEnd = new Int32Array(ns);
      for (let root0 = 0; root0 < ns; root0++) {
        if (index[root0] !== -1) continue;
        // push root
        const enter = (v) => {
          index[v] = low[v] = idx++; sccStack[sp++] = v; onStack[v] = 1;
          const list = successorsOf(v);
          frameStart[cp] = succTop; pushSucc(list); frameEnd[cp] = succTop;
          callV[cp] = v; callPos[cp] = frameStart[cp]; cp++;
        };
        enter(root0);
        while (cp > 0) {
          const f = cp - 1, v = callV[f];
          if (callPos[f] < frameEnd[f]) {
            const w = succArr.a[callPos[f]++];
            if (index[w] === -1) enter(w);
            else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
            continue;
          }
          // all successors done
          if (low[v] === index[v]) {
            // pop the SCC; it is a bottom SCC if no edge leaves it
            const members = [];
            let w;
            do { w = sccStack[--sp]; onStack[w] = 0; sccOf[w] = nScc; members.push(w); } while (w !== v);
            let bottom = true;
            for (const m of members) { for (const u of successorsOf(m)) if (sccOf[u] !== nScc) { bottom = false; break; } if (!bottom) break; }
            if (bottom) evProps.forEach(({ f: g }, k) => { if (badScc[k] === -1 && !members.some((m) => g(st(m)))) badScc[k] = members[0]; });
            nScc++;
          }
          succTop = frameStart[f];
          cp--;
          if (cp > 0) { const u = callV[cp - 1]; low[u] = Math.min(low[u], low[v]); }
        }
      }
      evProps.forEach(({ p }, k) => { if (badScc[k] !== -1) viol[p.id] = badScc[k]; });
    }
    // coverage: which states of each machine are reachable
    const covered = {};
    Object.keys(ir.mach).forEach((slot) => {
      const i = VI[slot], seenS = new Set();
      for (let n = 0; n < ns; n++) seenS.add(ir.mach[slot].info[vars[i].dom[pool[n * nv + i]]].sid);
      covered[slot] = ir.states[slot].filter((sid) => !seenS.has(sid));
    });
    const trace = (id) => {
      const path = [];
      for (let k = id; k >= 0 && parent.get(k) !== -1; k = parent.get(k)) path.push(cmds[via.get(k)].label);
      return path.reverse();
    };
    const describe = (id) => Object.fromEntries(vars.map((v, i) => [v.name, v.dom[pool[id * nv + i]]]));
    const results = ir.props.map((p) => ({ id: p.id, text: p.text, kind: p.kind, ok: viol[p.id] === undefined, trace: viol[p.id] === undefined ? null : trace(viol[p.id]), state: viol[p.id] === undefined ? null : describe(viol[p.id]) }));
    return { states: ns, edges, ms: Date.now() - t0, results, deadlocks: deadlocks.length, deadlock: deadlocks.length ? { trace: trace(deadlocks[0]), state: describe(deadlocks[0]) } : null, unreached: covered, commands: cmds.length };
  }

  // the verdict of the explicit search for every specification of toSmv(ir), by its NAME
  function expected(ir, r) {
    const out = {};
    r.results.forEach((p) => { out[p.id] = p.ok; });
    out.no_deadlock = r.deadlocks === 0;
    Object.keys(ir.mach).forEach((slot) => ir.states[slot].forEach((sid) => { out[`unreachable_${san(slot)}_${san(sid)}`] = r.unreached[slot].includes(sid); }));
    return out;
  }

  // ------------------------------------------------------------------ NuSMV export
  function toSmv(ir) {
    const { vars, cmds } = ir;
    const lit = (v, val) => (typeof val === 'boolean' ? (val ? 'TRUE' : 'FALSE') : typeof val === 'number' ? String(val) : san(val));
    const vname = (v) => san(v);
    const isBool = (v) => vars[ir.VI[v]].dom[0] === false;
    function ex(e) {
      switch (e.op) {
        case 'T': return 'TRUE';
        case 'F': return 'FALSE';
        case 'var': return vname(e.v);
        case 'in': return e.vals.length === 1 ? `${vname(e.v)} = ${lit(e.v, e.vals[0])}` : `${vname(e.v)} in {${e.vals.map((x) => lit(e.v, x)).join(', ')}}`;
        case 'cmp': return `${vname(e.v)} ${e.rel} ${e.n}`;
        case 'not': return `!(${ex(e.a)})`;
        case 'and': return '(' + e.args.map(ex).join(' & ') + ')';
        case 'or': return '(' + e.args.map(ex).join(' | ') + ')';
      }
      throw new Error('bad op');
    }
    function val(v, u) {
      switch (u.op) {
        case 'val': return lit(v, u.val);
        case 'copy': return vname(u.v);
        case 'bexp': return ex(u.e);
        case 'add': return `max(${u.lo}, min(${u.hi}, ${vname(u.v)} + ${u.n}))`;
        case 'oneOf': return `{${u.vals.map((x) => lit(v, x)).join(', ')}}`;
      }
      throw new Error('bad update');
    }
    const L = [];
    const ascii = (t) => t.replace(/→/g, '->').replace(/·/g, '-').replace(/≥/g, '>=').replace(/[^\x20-\x7e]/g, '?');
    L.push(`-- NuSMV model of the CNC machine-tending cell, Setup ${ir.setup}, faults: ${ir.opts.faults || 'none (nominal operation)'}.`);
    L.push('-- Generated by source/src/cell-verify.js from source/src/cell-model.js. Do not edit by hand.');
    L.push('-- Semantics: interleaving of guarded commands. The input cmd selects the command of each step. It is');
    L.push('-- carried out only when its guard g<i> holds and, while the supervisor must react (urgent), only if it');
    L.push('-- is one of its automatic commands; otherwise the step leaves the state unchanged, like idle. Such');
    L.push('-- steps add no states and change none of the specifications below (no TRANS constraints: with them');
    L.push('-- NuSMV needs hours for the fair states of the largest model).');
    L.push(`-- Abstractions: no step times; jobs complete at any time; output pallet capacity ${ir.opts.slots}.`);
    L.push('MODULE main');
    L.push('VAR');
    vars.forEach((v) => {
      const dom = v.dom[0] === false ? 'boolean' : typeof v.dom[0] === 'number' ? `${v.dom[0]}..${v.dom[v.dom.length - 1]}` : `{${v.dom.map((d) => san(d)).join(', ')}}`;
      L.push(`  ${vname(v.name)} : ${dom};${v.note ? ' -- ' + v.note : ''}`);
    });
    // an input, not a state variable: the reachable states are then exactly those of check()
    L.push('IVAR');
    L.push(`  cmd : {idle, ${cmds.map((c) => 'c' + c.id).join(', ')}};`);
    L.push('DEFINE');
    cmds.forEach((c) => L.push(`  g${c.id} := ${ex(c.guard)}; -- ${c.proc}: ${ascii(c.label)}`));
    const urg = cmds.filter((c) => c.urgent);
    L.push(`  urgent := ${urg.length ? urg.map((c) => 'g' + c.id).join(' | ') : 'FALSE'}; -- the supervisor must react`);
    L.push(`  enabled := ${cmds.map((c) => 'g' + c.id).join(' | ')}; -- some command other than idle can be taken`);
    L.push('ASSIGN');
    vars.forEach((v) => {
      const init = Array.isArray(v.init) ? `{${v.init.map((x) => lit(v.name, x)).join(', ')}}` : lit(v.name, v.init);
      L.push(`  init(${vname(v.name)}) := ${init};`);
    });
    vars.forEach((v) => {
      const cases = cmds.filter((c) => v.name in c.upd).map((c) => `    cmd = c${c.id} & g${c.id}${c.urgent ? '' : ' & !urgent'} : ${val(v.name, c.upd[v.name])};`);
      if (!cases.length) { L.push(`  next(${vname(v.name)}) := ${vname(v.name)};`); return; }   // without next() NuSMV would let it change freely
      L.push(`  next(${vname(v.name)}) := case`);
      L.push(...cases);
      L.push(`    TRUE : ${vname(v.name)};`);
      L.push('  esac;');
    });
    L.push('-- properties (M.PROPERTIES)');
    ir.props.forEach((p) => {
      L.push(`-- ${p.id}: ${ascii(p.text)}`);
      if (p.kind === 'never') L.push(`INVARSPEC NAME ${p.id} := !urgent -> !(${ex(p.e)});`);
      if (p.kind === 'start') {
        // on every transition into a location of the job, from another location, as in check()
        const into = [];
        Object.keys(ir.mach).forEach((slot) => { const ls = ir.mach[slot].locs.filter((l) => p.jobs.includes(ir.mach[slot].info[l].job)); if (ls.length) into.push(`(next(${vname(slot)}) != ${vname(slot)} & (next(${vname(slot)}) in {${ls.map(san).join(', ')}}))`); });
        L.push(`INVARSPEC NAME ${p.id} := (${into.join(' | ')}) -> next(${ex(p.e)});`);
      }
      if (p.kind === 'eventually') L.push(`SPEC NAME ${p.id} := AG EF (${ex(p.e)});`);
    });
    L.push('-- no deadlock: in every reachable state some command other than idle can be taken');
    L.push('INVARSPEC NAME no_deadlock := enabled;');
    L.push('-- every state of every machine: true if it can never be reached (as invariants: much faster than EF)');
    Object.keys(ir.mach).forEach((slot) => {
      ir.states[slot].forEach((sid) => {
        const ls = ir.mach[slot].locs.filter((l) => ir.mach[slot].info[l].sid === sid);
        L.push(`INVARSPEC NAME unreachable_${san(slot)}_${san(sid)} := !(${vname(slot)} in {${ls.map(san).join(', ')}});`);
      });
    });
    return L.join('\n') + '\n';
  }

  const API = { build, check, expected, toSmv };
  root.CellVerify = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
