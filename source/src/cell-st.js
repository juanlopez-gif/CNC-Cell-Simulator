/* IEC 61131-3 Structured Text of the cell controller, generated from the shared model (step A3.2).
   Execution semantics: PROJECT_STATUS.md §5.16. One function block per machine of
   M.SETUP_MACHINES[2], written only from the data of the model (states, steps, guards, jobs,
   checkpoints, M.PLC), so that the same generator serves the element template of phase B.
   toSt() returns the text of source/plc/cell.st: the function blocks, the program that runs one
   scan (inputs, machines in the fixed order with the urgent supervisor after each, rungs,
   outputs) and the configuration with the global variables. The I/O are plain globals; their
   addresses for the Modbus bridge come in step A3.3. */
(function (root) {
  const M = root.CellModel || require('./cell-model.js');
  const X = M.expr;
  const { SIGNALS, MACHINES, JOBS, CHECKPOINTS, RULES, T, PLC, OUTPUTS, RUNGS } = M;

  const H = 98, F = 99;                       // codes of the global HOLD and FAULT states
  const id = (n) => String(n).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const ms = (s) => `T#${Math.round(s * 1000)}ms`;
  // text safe inside a comment, in ASCII
  const ASCII = { '→': '->', '·': '-', '≥': '>=', '≤': '<=', '–': '-', '−': '-', '±': '+/-', '°': ' deg' };
  const cm = (s) => String(s).replace(/\(\*/g, '( *').replace(/\*\)/g, '* )');
  const MKS = M.SETUP_MACHINES[2];
  const SLOT_MK = Object.fromEntries(MKS.map((mk) => [MACHINES[mk].slot, mk]));
  const JOB_NO = Object.fromEntries(Object.keys(JOBS).map((j, i) => [j, i + 1]));
  const CP = Object.fromEntries(CHECKPOINTS.map((c) => [c.id, c]));
  // discrete field devices ("ZS-34 / ZS-35" names two); cameras, robots, CNC and gauge controllers are not among them
  const FIELD = ['prox', 'door', 'safety', 'vise', 'enc', 'grip'];
  const SENSOR_TAGS = new Set(M.SENSORS.filter((s) => FIELD.includes(s.kind)).flatMap((s) => s.tag.split(' / ')));

  // state codes: 0 = the initial pseudo-state (black dot), 1.. in the order of the model, H, F
  const CODES = {};
  MKS.forEach((mk) => {
    const c = { H, F };
    Object.keys(MACHINES[mk].states).forEach((sid, i) => { c[sid] = i + 1; });
    CODES[mk] = c;
  });
  const isChoice = (mk, sid) => !!(MACHINES[mk].states[sid] || {}).choice;

  // ------------------------------------------------------------------ signals and their PLC variables
  // every expression the PLC evaluates, with the machine that evaluates it (null = the program)
  const exprs = [];
  const stepExprs = (mk, steps) => (steps || []).forEach((st) => ['when', 'confirm', 'await', 'until'].forEach((f) => { if (st[f]) exprs.push([mk, st[f]]); }));
  MKS.forEach((mk) => {
    const m = MACHINES[mk];
    stepExprs(mk, m.initial.do);
    if (m.initial.when) exprs.push([mk, m.initial.when]);
    if (m.hold) { stepExprs(mk, m.hold.do); exprs.push([mk, m.hold.exit]); }
    if (m.fault) exprs.push([mk, m.fault.exit]);
    Object.values(m.states).forEach((s) => {
      if (s.choice) { exprs.push([mk, s.choice]); return; }
      stepExprs(mk, s.do);
      s.next.forEach((tr) => exprs.push([mk, tr.when]));
      (s.faults || []).forEach((f) => { if (f.when) exprs.push([mk, f.when]); });
    });
  });
  RUNGS.forEach((r) => exprs.push([null, r.when]));
  Object.values(OUTPUTS).forEach((o) => exprs.push([null, o.def]));
  Object.values(PLC.timers).forEach((x) => exprs.push([null, x.when]));
  const used = new Set();
  exprs.forEach(([, e]) => X.names(e, true).forEach((n) => used.add(n)));

  // inputs read only as the exit of a FAULT are latched per machine while it is in F; the other
  // operator inputs and the pulse sensors are latched on the rising edge until a transition reads them
  const faultExitInputs = new Set();
  MKS.forEach((mk) => { const m = MACHINES[mk]; if (m.fault) X.names(m.fault.exit, true).forEach((n) => { if (SIGNALS[n] && SIGNALS[n].kind === 'input') faultExitInputs.add(n); }); });
  const LATCHED = new Set([...used].filter((n) => (SIGNALS[n] && SIGNALS[n].kind === 'input' && !faultExitInputs.has(n)) || PLC.pulse.includes(n)));
  const checkProx = new Set();
  const checkUse = {};                          // machine -> checkpoints it checks
  MKS.forEach((mk) => {
    const m = MACHINES[mk], set = new Set();
    const scan = (steps) => (steps || []).forEach((st) => { if (st.check) set.add(st.check); });
    scan(m.initial.do); if (m.hold) scan(m.hold.do);
    Object.values(m.states).forEach((s) => scan(s.do));
    checkUse[mk] = [...set];
    set.forEach((c) => checkProx.add(CP[c].prox));
  });
  // a sensor named by a device tag is debounced (RULES.debounce); controller signals are not
  const debounced = (n) => SENSOR_TAGS.has(n) && !PLC.pulse.includes(n);

  // ST text of one signal read by machine mk (null = the program)
  function ref(n, mk) {
    const s = SIGNALS[n];
    if (!s) { if (SENSOR_TAGS.has(n)) return id(n); throw new Error(`cell-st: unknown signal ${n}`); }
    if (s.kind === 'truth') throw new Error(`cell-st: the PLC cannot read ${n}`);
    if (s.kind === 'check') { if (!mk) throw new Error(`cell-st: ${n} read outside a machine`); return `res_${id(n)}`; }
    if (s.kind === 'input') return faultExitInputs.has(n) ? `clr_${id(n)}` : `L_${id(n)}`;
    return id(n);
  }
  function stateRef(slot, value) {
    const mk = SLOT_MK[slot];
    const code = CODES[mk][value];
    if (code === undefined) throw new Error(`cell-st: ${slot} has no state ${value}`);
    return [`${id(slot)}_state`, code];
  }
  const REL = { '=': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
  function ex(e, mk) {
    if (typeof e === 'string') e = X.parse(e);
    switch (e.op) {
      case 'and': return '(' + e.args.map((a) => ex(a, mk)).join(' AND ') + ')';
      case 'or': return '(' + e.args.map((a) => ex(a, mk)).join(' OR ') + ')';
      case 'not': return `NOT (${ex(e.arg, mk)})`;
      case 'sig': {
        const s = SIGNALS[e.name];
        if (s && s.def) return ex(s.def, mk);
        return ref(e.name, mk);
      }
      case 'cmp': {
        if (SLOT_MK[e.name]) { const [v, code] = stateRef(e.name, e.value); return `(${v} ${REL[e.rel]} ${code})`; }
        const v = X.constVal(e.value);
        if (typeof v !== 'number') throw new Error(`cell-st: ${e.name}${e.rel}${e.value} is not numeric`);
        return `(${ref(e.name, mk)} ${REL[e.rel]} ${v})`;
      }
    }
    throw new Error('cell-st: bad expression ' + JSON.stringify(e));
  }
  const HOLDREQ = (mk) => ex('HOLD.req', mk);
  const lit = (v) => (v === true ? 'TRUE' : v === false ? 'FALSE' : String(v));
  // statements that write PLC variables (set / inc); writing the mismatch counter clears the window
  function sets(obj) {
    return Object.entries(obj || {}).map(([v, val]) => (v === PLC.mismatchCount
      ? `${id(v)} := ${lit(val)}; mmPending := 0; mmClear := TRUE;`
      : `${id(v)} := ${lit(val)};`));
  }
  const consume = (src) => [...X.names(src, true)].filter((n) => LATCHED.has(n)).map((n) => `${ref(n)} := FALSE;`);

  // ------------------------------------------------------------------ one function block per machine
  function fb(mk) {
    const m = MACHINES[mk], slot = m.slot, C = CODES[mk], S = `${id(slot)}_state`;
    const hasJobs = [m.initial.do, m.hold && m.hold.do, ...Object.values(m.states).map((s) => s.do)].some((l) => (l || []).some((st) => st.job));
    const chans = checkUse[mk];
    const ch = (cp, f) => `${id(slot)}_${id(cp)}_${f}`;
    const faults = [];                            // fault code -> text, for the comment table
    const tFor = [];
    const L = [];
    const out = (lvl, s) => L.push('  '.repeat(lvl) + s);
    const enter = (to) => `${S} := ${C[to]}; stp := 0; ph := 0; fresh := TRUE; moved := TRUE;`;
    const goH = (res, step) => `hRes := ${res}; hStep := ${step}; ${S} := ${H}; stp := 0; ph := 0; fresh := TRUE; moved := TRUE;`;
    const stopOut = () => [hasJobs ? `${id(slot)}_Start := FALSE;` : '', ...chans.map((cp) => `${ch(cp, 'Trig')} := FALSE;`)].filter(Boolean).join(' ');
    const goF = (code, text) => {
      faults.push([code, text]);
      return `fRes := ${S}; ${id(slot)}_fault := ${code}; ${stopOut()} ${faultExitInputs.size ? [...faultExitInputs].map((n) => `clr_${id(n)} := FALSE;`).join(' ') : ''} ${S} := ${F}; stp := 0; ph := 0; fresh := TRUE; moved := TRUE;`.replace(/ +/g, ' ');
    };
    const timerFor = (x) => {
      const t = Object.entries(PLC.timers).find(([, d]) => d.after === x);
      return t ? `IF ${ex(t[1].when, mk)} THEN ${id(t[0])}_restart := TRUE; END_IF;` : '';
    };

    // the steps of one state; code = state code, holdable = a LINE STOP may interrupt the waiting
    function steps(code, sid, list, holdable) {
      (list || []).forEach((st, k) => {
        const where = `${sid} step ${k + 1}`;
        out(2, `IF stp = ${k} AND NOT moved THEN (* ${where}: ${cm(st.job ? 'job ' + st.job : st.check ? 'check ' + st.check : st.await ? 'await ' + st.await : 'set')} *)`);
        if (st.job) {
          const J = id(slot);
          out(3, 'IF ph = 0 THEN');
          if (st.when) out(4, `IF NOT (${ex(st.when, mk)}) THEN stp := ${k + 1};`);
          out(4, `${st.when ? 'ELSIF' : 'IF'} NOT COMM_LOST AND NOT ${J}_Done THEN ${J}_JobNo := ${JOB_NO[st.job]}; ${J}_Start := TRUE; ph := 1;`);
          out(4, 'END_IF;');
          out(3, 'ELSIF ph = 1 THEN');
          out(4, `IF COMM_LOST THEN ${goF(code * 100 + 31 + k, `${sid}: communication lost during ${st.job}`)}`);
          out(4, `ELSIF ${J}_Done THEN`);
          out(5, `${J}_Start := FALSE;`);
          const tr = timerFor(st.job); if (tr) out(5, tr);
          if (st.confirm) {
            const c = code * 100 + k + 1;
            out(5, `IF NOT (${ex(st.confirm, mk)}) THEN ${goF(c, `${sid}: missing confirmation after ${st.job}: ${st.confirm}`)}`);
            out(5, 'ELSE ph := 2; END_IF;');
          } else out(5, 'ph := 2;');
          out(4, 'END_IF;');
          out(3, `ELSIF ph = 2 AND NOT ${J}_Done THEN ph := 0; stp := ${k + 1};`);
          out(3, 'END_IF;');
        } else if (st.check) {
          const cp = CP[st.check], prox = id(cp.prox), res = `res_${id(st.check)}`;
          out(3, 'IF ph = 0 THEN');
          if (st.when) out(4, `IF NOT (${ex(st.when, mk)}) THEN stp := ${k + 1}; ELSE tries := 0; ph := ${st.quick ? 2 : 1}; END_IF;`);
          else out(4, `tries := 0; ph := ${st.quick ? 2 : 1};`);
          out(3, 'END_IF;');
          if (!st.quick) out(3, `IF ph = 1 AND NOT moved THEN tStep(IN := TRUE, PT := ${ms(T.check)}); IF tStep.Q THEN tStep(IN := FALSE); ph := 2; END_IF; END_IF; (* settle *)`);
          out(3, `IF ph = 2 AND NOT moved AND NOT ${ch(st.check, 'Done')} THEN proxL := ${prox}; ${ch(st.check, 'Trig')} := TRUE; ph := 3; END_IF;`);
          out(3, `IF ph = 3 AND NOT moved AND ${ch(st.check, 'Done')} THEN`);
          out(4, `${ch(st.check, 'Trig')} := FALSE;`);
          out(4, `IF NOT ${ch(st.check, 'Valid')} THEN (* invalid image: one re-trigger, then camera fault *)`);
          out(5, `tries := tries + 1;`);
          out(5, `IF tries >= 2 THEN ${id(PLC.cameraFault)} := TRUE; ${goH(code, k)} ELSE ph := 4; END_IF;`);
          out(4, `ELSIF proxL = ${ch(st.check, 'Cam')} THEN ${res} := proxL; ph := 5;`);
          const fuse = { camera: ch(st.check, 'Cam'), prox: 'proxL', present: 'TRUE', absent: 'FALSE' }[cp.rule];
          if (cp.rule === 'ask') out(4, `ELSE ${id(PLC.cameraFault)} := TRUE; ${goH(code, k)} (* rule ask: line stop, the operator looks *)`);
          else out(4, `ELSE ${res} := ${fuse}; mmPending := mmPending + 1; ${id(PLC.mismatchCount)} := MIN(${id(PLC.mismatchCount)} + 1, ${RULES.mismatchLimit}); ph := 5; (* disagreement: rule ${cp.rule} *)`);
          out(4, 'END_IF;');
          const also = PLC.checkAlso[st.check];
          if (also) out(4, `IF ph = 5 THEN res_${id(also)} := ${res} AND ${ch(st.check, 'Also')}; END_IF;`);
          out(3, 'END_IF;');
          out(3, `IF ph = 4 AND NOT moved AND NOT ${ch(st.check, 'Done')} THEN tStep(IN := TRUE, PT := ${ms(RULES.retrigger)}); IF tStep.Q THEN tStep(IN := FALSE); ph := 2; END_IF; END_IF; (* re-trigger *)`);
          out(3, 'IF ph = 5 AND NOT moved THEN');
          let lvl = 4;
          if (st.until) {
            out(4, `IF NOT (${ex(st.until, mk)}) THEN`);
            out(5, holdable ? `IF ${HOLDREQ(mk)} THEN ${goH(code, 0)} ELSE ph := 6; END_IF;` : 'ph := 6;');
            out(4, 'ELSE');
            lvl = 5;
          }
          if (st.confirm) {
            const c = code * 100 + k + 1;
            out(lvl, `IF NOT (${ex(st.confirm, mk)}) THEN ${goF(c, `${sid}: missing confirmation at ${st.check}: ${st.confirm}`)}`);
            out(lvl, `ELSE stp := ${k + 1}; ph := 0; END_IF;`);
          } else out(lvl, `stp := ${k + 1}; ph := 0;`);
          if (st.until) out(4, 'END_IF;');
          out(3, 'END_IF;');
          if (st.until) out(3, `IF ph = 6 AND NOT moved THEN tStep(IN := TRUE, PT := ${ms(T.check)}); IF tStep.Q THEN tStep(IN := FALSE); tries := 0; ph := ${st.quick ? 2 : 1}; END_IF; END_IF; (* repeat until ${cm(st.until)} *)`);
        } else if (st.await) {
          out(3, `IF ${ex(st.await, mk)} THEN stp := ${k + 1};`);
          if (holdable) out(3, `ELSIF ${HOLDREQ(mk)} THEN ${goH(code, 0)}`);
          out(3, 'END_IF;');
        } else {
          const body = [...sets(st.set), ...(st.inc ? [`${id(st.inc)} := MIN(${id(st.inc)} + 1, ${SIGNALS[st.inc].max === undefined ? 32767 : SIGNALS[st.inc].max});`] : [])].join(' ');
          out(3, st.when ? `IF ${ex(st.when, mk)} THEN ${body} END_IF;` : body);
          out(3, `stp := ${k + 1};`);
        }
        out(2, 'END_IF;');
      });
    }

    // the transitions of one state, evaluated once its steps are done
    function transitions(code, sid, s, list, holdable, initial) {
      const n = (list || []).length;
      out(2, `IF stp = ${n} AND NOT moved THEN`);
      out(3, `tWait(IN := TRUE, PT := T#24h);`);
      s.next.forEach((tr) => {
        if (tr.for) { const t = `tFor${tFor.length + 1}`; tFor.push(t); tr._t = t; out(3, `${t}(IN := ${ex(tr.when, mk)}, PT := ${ms(T[tr.for])});`); }
      });
      const arms = [];
      s.next.forEach((tr) => {
        const body = [...(tr.when ? consume(tr.when) : []), ...(tr.do || []).flatMap((a) => sets(a.set))];
        const go = !initial && tr.hold !== false && m.hold
          ? `IF ${HOLDREQ(mk)} THEN ${goH(C[tr.to], 0)} ELSE ${enter(tr.to)} END_IF;`
          : enter(tr.to);
        arms.push([tr._t ? `${tr._t}.Q` : tr.when ? ex(tr.when, mk) : 'TRUE', [...body, go].join(' ') + ` (* to ${tr.to} *)`]);
        delete tr._t;
      });
      (s.faults || []).forEach((f, i) => {
        const c = code * 100 + 50 + i;
        arms.push([`${f.when ? ex(f.when, mk) + ' AND ' : ''}tWait.ET >= ${ms(f.after)}`, goF(c, `${sid}: ${X.plain(f.text || X.label(f.when))}`)]);
      });
      if (!s.wait) arms.push([`tWait.ET >= ${ms(RULES.confirmTimeout)}`, goF(code * 100 + 99, `${sid}: missing confirmation: ${s.next[0].when}`)]);
      if (holdable && s.wait) arms.push([HOLDREQ(mk), goH(code, 0)]);
      arms.forEach(([g, body], i) => out(3, `${i ? 'ELSIF' : 'IF'} ${g} THEN ${body}`));
      if (arms.length) out(3, 'END_IF;');
      out(2, 'END_IF;');
    }

    // ---- body
    out(0, `(* ${m.title} *)`);
    out(0, `IF fresh THEN tWait(IN := FALSE); tStep(IN := FALSE); fresh := FALSE; END_IF;`);
    const freshAt = L.length - 1;
    out(0, 'moved := FALSE;');
    [...faultExitInputs].forEach((n) => out(0, `IF ${S} = ${F} AND E_${id(n)} THEN clr_${id(n)} := TRUE; END_IF;`));
    out(0, `CASE ${S} OF`);
    // initial pseudo-state
    out(1, `0: (* initial${m.initial.text ? ': ' + cm(X.plain(m.initial.text)) : ''} *)`);
    steps(0, 'initial', m.initial.do, false);
    transitions(0, 'initial', { wait: true, next: [{ to: m.initial.to, when: m.initial.when }] }, m.initial.do, false, true);
    Object.entries(m.states).forEach(([sid, s]) => {
      if (s.choice) return;
      const holdable = s.hold !== false && !!m.hold;
      out(1, `${C[sid]}: (* ${sid} ${cm(s.name)}${s.wait ? ' · waiting' : ''}${holdable ? '' : ' · not interrupted by a LINE STOP'} *)`);
      steps(C[sid], sid, s.do, holdable);
      transitions(C[sid], sid, s, s.do, holdable, false);
    });
    if (m.hold) {
      out(1, `${H}: (* H HOLD: ${cm(X.plain(m.hold.desc.join(' ')))} *)`);
      steps(H, 'H', m.hold.do, false);
      const n = (m.hold.do || []).length;
      out(2, `IF stp = ${n} AND NOT moved AND ${ex(m.hold.exit, mk)} THEN ${S} := hRes; stp := hStep; ph := 0; fresh := TRUE; moved := TRUE; END_IF;`);
    }
    if (m.fault) {
      out(1, `${F}: (* F FAULT: ${cm(X.plain(m.fault.desc.join(' ')))}; the state is entered again *)`);
      // a FAULT during H (communication lost while parking) returns to H with its resume point
      const again = m.hold ? `IF fRes = ${H} THEN ${S} := ${H}; ELSIF ${HOLDREQ(mk)} THEN hRes := fRes; hStep := 0; ${S} := ${H}; ELSE ${S} := fRes; END_IF;` : `${S} := fRes;`;
      out(2, `IF ${ex(m.fault.exit, mk)} THEN ${[...faultExitInputs].map((x) => `clr_${id(x)} := FALSE;`).join(' ')} ${id(slot)}_fault := 0; ${again} stp := 0; ph := 0; fresh := TRUE; moved := TRUE; END_IF;`);
    }
    out(0, 'END_CASE;');
    // choice states are passed in the same call
    const choices = Object.entries(m.states).filter(([, s]) => s.choice);
    if (choices.length) {
      for (let d = 0; d < choices.length; d++) {
        out(0, `CASE ${S} OF (* choice states *)`);
        choices.forEach(([sid, q]) => out(1, `${C[sid]}: IF ${ex(q.choice, mk)} THEN ${S} := ${C[q.yes]}; ELSE ${S} := ${C[q.no]}; END_IF; (* ${sid}: ${q.choice} *)`));
        out(0, 'END_CASE;');
      }
    }
    if (tFor.length) L[freshAt] = `IF fresh THEN tWait(IN := FALSE); tStep(IN := FALSE); ${tFor.map((t) => `${t}(IN := FALSE);`).join(' ')} fresh := FALSE; END_IF;`;

    // ---- declarations
    const D = [`FUNCTION_BLOCK FB_${mk}`, '  VAR_EXTERNAL'];
    globals().forEach(([n, type]) => D.push(`    ${n} : ${type};`));
    D.push('  END_VAR', '  VAR');
    D.push('    stp : INT := 0;        (* step of the state; = number of steps once they are done *)');
    D.push('    ph : INT := 0;         (* phase of the running step *)');
    D.push('    hRes : INT := 0;       (* state to resume after H *)');
    D.push('    hStep : INT := 0;      (* step to resume after H (a check repeated after a camera fault) *)');
    D.push('    fRes : INT := 0;       (* state to enter again after F *)');
    D.push('    tries : INT := 0;      (* images taken by the running check *)');
    D.push('    proxL : BOOL;          (* proximity value latched with the camera trigger *)');
    D.push('    fresh : BOOL := TRUE;  (* a state was entered: reset the timers *)');
    D.push('    moved : BOOL;          (* this call changed the state: nothing else runs *)');
    D.push('    tWait : TON;           (* time since the steps of the state were done *)');
    D.push('    tStep : TON;           (* settle, re-trigger and repeat timer of a check *)');
    tFor.forEach((t) => D.push(`    ${t} : TON;`));
    const results = new Set();
    chans.forEach((c) => { results.add(c); if (PLC.checkAlso[c]) results.add(PLC.checkAlso[c]); });
    [...results].forEach((r) => D.push(`    res_${id(r)} : BOOL;  (* result of the last check ${r} of this machine *)`));
    [...faultExitInputs].forEach((n) => D.push(`    clr_${id(n)} : BOOL;  (* ${n} pressed while in F *)`));
    D.push('  END_VAR');
    const codes = Object.entries(C).map(([sid, c]) => `${sid}=${c}${isChoice(mk, sid) ? ' (choice)' : ''}`).join(' ');
    const head = [`(* States of ${slot} (${S}): 0=initial ${codes} *)`];
    if (faults.length) head.push(`(* Fault codes of ${slot} (${id(slot)}_fault):`, ...faults.map(([c, t]) => `   ${c} ${cm(t)}`), '*)');
    return [...head, ...D, ...L.map((x) => '  ' + x), 'END_FUNCTION_BLOCK', ''].join('\n');
  }

  // ------------------------------------------------------------------ global variables
  let GLOBALS = null;
  function globals() {
    if (GLOBALS) return GLOBALS;
    const g = [];                                 // [name, type, group, comment]
    const add = (n, type, group, c, meta) => { if (!g.some((x) => x[0] === n)) g.push([n, type, group, c || '', meta || null]); };
    MKS.forEach((mk) => {
      const slot = MACHINES[mk].slot;
      add(`${id(slot)}_state`, 'INT', 'out', `state of ${slot} (codes in FB_${mk})`, { k: 'state', slot });
      if (MACHINES[mk].fault) add(`${id(slot)}_fault`, 'INT', 'out', `fault code of ${slot}, 0 = none`, { k: 'fault', slot });
    });
    MKS.forEach((mk) => {
      const m = MACHINES[mk], slot = id(m.slot);
      const hasJobs = [m.initial.do, m.hold && m.hold.do, ...Object.values(m.states).map((s) => s.do)].some((l) => (l || []).some((st) => st.job));
      if (hasJobs) {
        add(`${slot}_JobNo`, 'INT', 'out', 'job number (order of M.JOBS, from 1)', { k: 'jobNo', slot: m.slot });
        add(`${slot}_Start`, 'BOOL', 'out', 'job start (handshake: Start, Done, Start low, Done low)', { k: 'jobStart', slot: m.slot });
        add(`${slot}_Done`, 'BOOL', 'in', 'job done, held until Start is low', { k: 'jobDone', slot: m.slot });
      }
      checkUse[mk].forEach((cp) => {
        add(`${slot}_${id(cp)}_Trig`, 'BOOL', 'out', `camera trigger for ${cp}`, { k: 'camTrig', slot: m.slot, cp });
        add(`${slot}_${id(cp)}_Done`, 'BOOL', 'in', `camera answer for ${cp} ready, held until Trig is low`, { k: 'camDone', slot: m.slot, cp });
        add(`${slot}_${id(cp)}_Valid`, 'BOOL', 'in', `${CP[cp].cam} image valid`, { k: 'camValid', slot: m.slot, cp });
        add(`${slot}_${id(cp)}_Cam`, 'BOOL', 'in', `${CP[cp].cam} / ${CP[cp].roi}: ${CP[cp].fact}`, { k: 'cam', slot: m.slot, cp });
        if (PLC.checkAlso[cp]) add(`${slot}_${id(cp)}_Also`, 'BOOL', 'in', `${CP[cp].cam}: ${PLC.checkAlso[cp]}`, { k: 'camAlso', slot: m.slot, cp, name: PLC.checkAlso[cp] });
      });
    });
    const sensors = [...used].filter((n) => SIGNALS[n] && SIGNALS[n].kind === 'sensor' && !SIGNALS[n].def).concat([...checkProx].filter((n) => !used.has(n)));
    sensors.forEach((n) => {
      const s = SIGNALS[n] || {};
      if (PLC.timers[n]) { add(id(n), 'BOOL', 'int', `PLC timer (M.PLC.timers)`); add(`${id(n)}_restart`, 'BOOL', 'int', `restart ${n}`); return; }
      if (PLC.pulse.includes(n)) { add(`${id(n)}_in`, 'BOOL', 'in', `${n}, raw`, { k: 'sensor', name: n }); add(id(n), 'BOOL', 'int', `${n}, latched on the rising edge`); return; }
      if (debounced(n)) { add(`${id(n)}_in`, 'BOOL', 'in', `${n}, raw`, { k: 'sensor', name: n }); add(id(n), 'BOOL', 'int', `${n}, debounced`); return; }
      add(id(n), s.num ? 'INT' : 'BOOL', 'in', n, { k: 'sensor', name: n });
    });
    [...used].filter((n) => SIGNALS[n] && SIGNALS[n].kind === 'input').forEach((n) => {
      add(id(n), 'BOOL', 'in', `${n} (button)`, { k: 'input', name: n });
      if (faultExitInputs.has(n)) add(`E_${id(n)}`, 'BOOL', 'int', `rising edge of ${n} in this scan`);
      else add(`L_${id(n)}`, 'BOOL', 'int', `${n}, latched until a transition reads it`);
    });
    add('HB', 'BOOL', 'in', 'heartbeat, toggled by the bridge', { k: 'hb' });
    Object.keys(SIGNALS).filter((n) => SIGNALS[n].kind === 'var').forEach((n) => add(id(n), SIGNALS[n].num ? 'INT' : 'BOOL', PLC.retain.includes(n) ? 'retain' : 'int', n));
    add('COMM_LOST', 'BOOL', 'int', 'no heartbeat for M.PLC.heartbeatTimeout');
    add('mmPending', 'INT', 'int', 'mismatch events to add to the window');
    add('mmClear', 'BOOL', 'int', 'clear the mismatch window');
    Object.keys(OUTPUTS).forEach((n) => add(id(n), 'BOOL', 'out', OUTPUTS[n].text, { k: 'output', name: n }));
    // copies of the PLC variables for the bridge (diagnostics, the comparison of A3.4)
    Object.keys(SIGNALS).filter((n) => SIGNALS[n].kind === 'var').forEach((n) => add(`V_${id(n)}`, SIGNALS[n].num ? 'INT' : 'BOOL', 'out', `copy of ${n}`, { k: 'var', name: n }));
    GLOBALS = g;
    return g;
  }

  // ------------------------------------------------------------------ the program: one scan
  function program() {
    const g = globals();
    const L = [];
    const out = (s) => L.push('  ' + s);
    const V = ['PROGRAM CellMain', '  VAR_EXTERNAL'];
    g.forEach(([n, type]) => V.push(`    ${n} : ${type};`));
    V.push('  END_VAR', '  VAR');
    MKS.forEach((mk) => V.push(`    fb${mk} : FB_${mk};`));
    V.push('    hbT : TON;', '    hbLast : BOOL;', '    n : INT;', '    oldest : INT;', '    best : TIME;');
    const deb = g.filter(([n, , grp, c]) => grp === 'int' && / debounced$/.test(c)).map(([n]) => n);
    deb.forEach((n) => V.push(`    db_${n} : TON;`));
    const pul = PLC.pulse.map(id), edges = [...used].filter((n) => SIGNALS[n] && SIGNALS[n].kind === 'input').map(id);
    [...pul, ...edges].forEach((n) => V.push(`    rt_${n} : R_TRIG;`));
    const W = RULES.mismatchLimit;
    for (let i = 1; i <= W; i++) V.push(`    mmOn${i} : BOOL;`, `    mmT${i} : TON;`);
    Object.keys(PLC.timers).forEach((n) => V.push(`    tm_${id(n)} : TON;`));
    V.push('  END_VAR');

    out('(* 1. inputs: heartbeat, debounce, latches, mismatch window, PLC timers *)');
    out(`hbT(IN := HB = hbLast, PT := ${ms(PLC.heartbeatTimeout)}); hbLast := HB; COMM_LOST := hbT.Q;`);
    deb.forEach((n) => out(`db_${n}(IN := ${n}_in <> ${n}, PT := ${ms(RULES.debounce)}); IF db_${n}.Q THEN ${n} := ${n}_in; END_IF;`));
    pul.forEach((n) => out(`rt_${n}(CLK := ${n}_in); IF rt_${n}.Q THEN ${n} := TRUE; END_IF;`));
    [...used].filter((n) => SIGNALS[n] && SIGNALS[n].kind === 'input').forEach((n) => {
      out(faultExitInputs.has(n) ? `rt_${id(n)}(CLK := ${id(n)}); E_${id(n)} := rt_${id(n)}.Q;` : `rt_${id(n)}(CLK := ${id(n)}); IF rt_${id(n)}.Q THEN L_${id(n)} := TRUE; END_IF;`);
    });
    const on = (i) => `mmOn${i}`;
    out(`IF mmClear THEN ${Array.from({ length: W }, (_, i) => `${on(i + 1)} := FALSE;`).join(' ')} mmClear := FALSE; END_IF;`);
    out('WHILE mmPending > 0 DO (* a new mismatch event: a free place, or the oldest one is replaced *)');
    out(`  oldest := 0; best := T#0ms;`);
    for (let i = 1; i <= W; i++) out(`  IF oldest >= 0 AND NOT ${on(i)} THEN oldest := -${i}; ELSIF oldest >= 0 AND mmT${i}.ET >= best THEN best := mmT${i}.ET; oldest := ${i}; END_IF;`);
    out('  IF oldest < 0 THEN oldest := -oldest; END_IF;');
    for (let i = 1; i <= W; i++) out(`  IF oldest = ${i} THEN ${on(i)} := TRUE; mmT${i}(IN := FALSE); END_IF;`);
    out('  mmPending := mmPending - 1;');
    out('END_WHILE;');
    out('n := 0;');
    for (let i = 1; i <= W; i++) out(`mmT${i}(IN := ${on(i)}, PT := ${ms(RULES.mismatchWindow)}); IF mmT${i}.Q THEN ${on(i)} := FALSE; mmT${i}(IN := FALSE); END_IF; IF ${on(i)} THEN n := n + 1; END_IF;`);
    out(`${id(PLC.mismatchCount)} := n;`);
    Object.entries(PLC.timers).forEach(([n, x]) => {
      out(`IF ${id(n)}_restart THEN tm_${id(n)}(IN := FALSE); ${id(n)}_restart := FALSE; END_IF;`);
      out(`tm_${id(n)}(IN := ${ex(x.when, null)}, PT := ${ms(RULES[x.every])}); ${id(n)} := tm_${id(n)}.Q;`);
    });
    out('');
    out('(* 2. machines in a fixed order; the urgent supervisor first and after every other machine *)');
    const urgent = MKS.filter((mk) => MACHINES[mk].urgent), normal = MKS.filter((mk) => !MACHINES[mk].urgent);
    const callU = () => urgent.forEach((mk) => out(`fb${mk}();`));
    callU();
    normal.forEach((mk, i) => {
      out(`fb${mk}();`);
      if (i === normal.length - 1) RUNGS.forEach((r) => out(`IF ${ex(r.when, null)} THEN ${[...sets(r.set), ...consume(r.when)].join(' ')} END_IF; (* rung: ${cm(X.plain(r.text))} *)`));
      callU();
    });
    out('');
    out('(* 3. outputs *)');
    Object.entries(OUTPUTS).forEach(([n, o]) => out(`${id(n)} := ${ex(o.def, null)}${PLC.stopOnCommLoss.includes(n) ? ' AND NOT COMM_LOST' : ''};`));
    g.filter(([, , , , x]) => x && x.k === 'var').forEach(([n, , , , x]) => out(`${n} := ${id(x.name)};`));
    return [...V, ...L, 'END_PROGRAM', ''].join('\n');
  }

  // I/O addresses of the OpenPLC Modbus master: the slave device (the bridge) maps its discrete inputs
  // to %IX100.0.., input registers to %IW100.., coils to %QX100.0.., holding registers to %QW100..
  function addresses() {
    const g = globals(), at = {}, n = { IX: 0, IW: 0, QX: 0, QW: 0 };
    g.forEach(([name, type, grp]) => {
      if (grp !== 'in' && grp !== 'out') return;
      const a = (grp === 'in' ? 'I' : 'Q') + (type === 'BOOL' ? 'X' : 'W');
      const i = n[a]++;
      at[name] = { area: a, index: i, addr: type === 'BOOL' ? `%${a}${100 + Math.floor(i / 8)}.${i % 8}` : `%${a}${100 + i}` };
    });
    return at;
  }

  // what the bridge needs: every Modbus address with the meaning of its variable
  function ioMap() {
    GLOBALS = null;
    const g = globals(), at = addresses();
    const table = { IX: 'discreteInputs', IW: 'inputRegisters', QX: 'coils', QW: 'holdingRegisters' };
    const map = { note: 'Generated by source/src/cell-st.js. Modbus addresses of source/plc/cell.st (OpenPLC master, the bridge is the slave device).',
      scanMs: PLC.scanMs, heartbeatTimeout: PLC.heartbeatTimeout, debounce: RULES.debounce,
      discreteInputs: [], inputRegisters: [], coils: [], holdingRegisters: [],
      jobs: Object.keys(JOBS), states: {} };
    g.forEach(([name, , , , meta]) => { const a = at[name]; if (a) map[table[a.area]][a.index] = Object.assign({ st: name, addr: a.addr }, meta); });
    MKS.forEach((mk) => { const s = {}; Object.entries(CODES[mk]).forEach(([sid, c]) => { s[c] = sid; }); s[0] = ''; map.states[MACHINES[mk].slot] = s; });
    return JSON.stringify(map, null, 1) + '\n';
  }

  function configuration() {
    const g = globals(), at = addresses();
    const C = ['CONFIGURATION Config0'];
    const block = (grp, title, retain) => {
      const v = g.filter((x) => x[2] === grp);
      if (!v.length) return;
      C.push(`  VAR_GLOBAL${retain ? ' RETAIN' : ''} (* ${title} *)`);
      v.forEach(([n, type, , c]) => C.push(`    ${n}${at[n] ? ' AT ' + at[n].addr : ''} : ${type};${c ? ` (* ${cm(c)} *)` : ''}`));
      C.push('  END_VAR');
    };
    block('in', 'inputs from the plant (Modbus bridge, A3.3)');
    block('out', 'outputs to the plant');
    block('int', 'internal');
    block('retain', 'kept over a cold restart (M.PLC.retain)', true);
    C.push('  RESOURCE Res0 ON PLC');
    C.push(`    TASK MainTask (INTERVAL := T#${PLC.scanMs}ms, PRIORITY := 0);`);
    C.push('    PROGRAM Main WITH MainTask : CellMain;');
    C.push('  END_RESOURCE');
    C.push('END_CONFIGURATION', '');
    return C.join('\n');
  }

  function toSt() {
    GLOBALS = null;
    const fbs = MKS.map(fb);
    return [
      '(* Generated by source/src/cell-st.js from source/src/cell-model.js. Do not edit by hand.',
      '   Controller of the CNC machine-tending cell (Setup 2), IEC 61131-3 Structured Text.',
      '   Execution semantics: PROJECT_STATUS.md section 5.16. *)',
      '',
      ...fbs,
      program(),
      configuration(),
    ].join('\n').replace(/[^\n\x20-\x7e]/g, (c) => ASCII[c] || '?');   // texts of the model appear in comments only
  }

  const API = { toSt, ioMap, CODES, JOB_NO };
  root.CellSt = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
