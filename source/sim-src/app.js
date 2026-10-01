/* CNC cell simulator. The state machines are not programmed in this file: an interpreter runs the
   machines of the shared model (CellModel.MACHINES) step by step, with their guards and transitions.
   This file supplies the plant around them: robot jobs (motions that take the model's step times),
   the CNC, the belt, the sensor behind every signal name, the operator, the drawing and the UI.
   Each process is a generator; yield {k:'t'} waits for a time, yield {k:'c'} for a condition. */
(() => {
  'use strict';
  const M = window.CellModel, D = window.CellDiagrams, X = M.expr;
  const L = D.LAYOUT, T = M.T, RU = M.RULES;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtT = (t) => { t = Math.max(0, Math.floor(t)); return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
  const fmtMS = (t) => { t = Math.max(0, Math.ceil(t)); return `${Math.floor(t / 60)}:${pad(t % 60)}`; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fx = (n) => Math.round(n * 10) / 10;

  const P = {
    doorway: [207, 354], outside: [264, 354], fixture: L.fixture,
    convPlace: L.convEntry, convAbove: [L.convEntry[0] + 4, L.convEntry[1] - 62],
    convPick: L.convExit, convOff: [L.convExit[0] - 18, L.convExit[1] + 72], stopX: L.convExit[0],
    nest: L.nest, nestOut: [L.nest[0] + 46, L.nest[1] - 44], nokDrop: L.nokDrop,
  };
  const VMAX = (L.convExit[0] - L.convEntry[0]) / T.beltTravel, ACC = VMAX / T.beltStart;
  const SLOTS = Object.keys(M.SLOTS);                     // R1, CONV, R2, SUP
  const CPS = M.CHECKPOINTS.map((c) => Object.assign({}, c));
  const CP = {}; CPS.forEach((c) => { CP[c.id] = c; });
  const LATCH = { 'HMI.verify': 'verify', 'HMI.reset': 'reset', 'HMI.release': 'release' };

  let S, W, SUP, procs = [];
  let instant = false;                                    // tests: the technician finishes at once
  const MCH = {};
  const logs = [];
  const TRACE = [];                                       // every state change, for the tests
  let logDirty = true, statesDirty = true, bannerKey = '';

  // ------------------------------------------------------------------ world
  function newSim(setup) {
    S = {
      t: 0, speed: +$('#selSpeed').value || 10, running: true, setup, step: false,
      autoOp: $('#chkAuto').checked, logAll: $('#chkAll').checked,
      inject: { under: 0, gripMiss: false, frames: { 'CAM-1': 0, 'CAM-2': 0 } }, faults: {}, camFault: null, verify: null,
      stopReason: '', vars: {}, cp: {}, inputs: { verify: false, reset: false, release: false, clearAt: -1 },
    };
    Object.keys(M.SIGNALS).forEach((k) => { const s = M.SIGNALS[k]; if (s.kind === 'var' && k !== 'mismatches') S.vars[k] = s.num ? 0 : false; });
    W = {
      parts: [], nextId: 1, palletIn: { present: true, busy: false }, palletOut: { present: true, busy: false },
      cnc: { state: 'EMPTY', part: null, locked: false, startCmd: false, vise: 'open', runStart: 0, doneAt: null },
      door: { pos: 0, anim: null }, belt: { cmd: false, v: 0, off: 0 },
      r1: robot(L.r1, true), r2: robot(L.r2, false),
      gauge: { zeroed: false, valid: false, ok: false }, lastSlot: null, beacon: false,
      ok: 0, nok: 0, pe65: -9,
      stats: { runTime: 0, firstStart: null, lastIdle: null, idleSum: 0, idleN: 0, cycles: 0, mism: 0, stops: 0, jobs: 0, violations: 0 },
    };
    CPS.forEach((c) => { c.fault = false; c.glitch = false; c.last = null; c.count = 0; });
    for (let i = 3; i < 12; i++) addPart('raw', { k: 'in', slot: i });
    for (let i = 0; i < 8; i++) addPart('fin', { k: 'out', slot: i });
    SUP = { events: [] };
    const keys = M.SETUP_MACHINES[setup];
    SLOTS.forEach((k) => { MCH[k] = { key: keys.find((mk) => M.MACHINES[mk].slot === k), state: '', since: 0, why: '', prev: '', job: null }; });
    procs = [];
    TRACE.length = 0;
    checkSignals();
    spawn(runMachine('R1'));
    spawn(cncProc());
    spawn(runMachine('CONV'));
    spawn(runMachine('R2'));
    spawn(runMachine('SUP'));
    spawn(operatorProc());
    logs.length = 0; logDirty = true;
    log('info', `Setup ${setup} started · input pallet 9 raw parts · output pallet 8 of 12 · CNC empty`);
    buildUi();
  }
  function robot(base, dual) { return { base, tool: base.home.slice(), anim: null, fing: 'open', hold: { A: null, B: null, S: null }, zone: 'free', job: null, dual, active: 'A', rot: null }; }
  // Dual gripper (Setup 2): the wrist turns 180° so that gripper `to` faces the work, while the robot moves.
  function startTurn(r, to, dur) { if (!r.dual || S.setup !== 2 || r.active === to || r.rot) return; r.rot = { t0: S.t, t1: S.t + dur, to }; }
  function addPart(st, loc) { const p = { id: W.nextId++, st, loc, dims: [50, 50, 50], meas: null, nok: false }; W.parts.push(p); return p; }
  const partIn = (slot) => W.parts.find((p) => p.loc.k === 'in' && p.loc.slot === slot);
  function firstRaw() { for (let i = 0; i < 12; i++) if (partIn(i)) return i; return -1; }
  function firstFreeOut() { for (let i = 0; i < 12; i++) if (!W.parts.some((p) => p.loc.k === 'out' && p.loc.slot === i)) return i; return -1; }
  const outCount = () => W.parts.filter((p) => p.loc.k === 'out').length;
  const atHome = (r) => !r.anim && Math.hypot(r.tool[0] - r.base.home[0], r.tool[1] - r.base.home[1]) < 1;
  const undersized = (p) => !!p && p.dims.some((v) => v < RU.minSize);

  // ------------------------------------------------------------------ scheduler
  function spawn(gen) { procs.push({ it: gen, wait: null, done: false }); }
  const ready = (w) => !w || (w.k === 't' ? S.t >= w.until - 1e-9 : (w.fn() || (w.until != null && S.t >= w.until - 1e-9)));
  // Run every process until nothing moves any more at this instant, so that a signal written by one
  // machine is seen by the others in the same scan.
  function runProcs() {
    for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      for (const p of procs) {
        let guard = 0;
        while (!p.done && guard++ < 80) {
          if (!ready(p.wait)) break;
          p.wait = null; moved = true;
          const r = p.it.next();
          if (r.done) { p.done = true; break; }
          p.wait = r.value || null;
        }
      }
      procs = procs.filter((p) => !p.done);
      if (evalRungs()) moved = true;
      if (!moved) break;
    }
  }
  function* wait(s) { if (s > 1e-9) yield { k: 't', until: S.t + s }; }
  function* until(fn) { if (!fn()) yield { k: 'c', fn }; }

  // ------------------------------------------------------------------ signals: the plant behind every model name
  const SENSE = {
    'HMI.auto': () => true,
    'HMI.loaded': () => W.palletIn.present && !W.palletIn.busy && firstRaw() >= 0,
    'R1.home': () => atHome(W.r1), 'R2.home': () => atHome(W.r2),
    'R1.clearCnc': () => W.r1.zone !== 'cnc', 'R1.clearConv': () => W.r1.zone !== 'conv',
    'R2.clearConv': () => W.r2.zone !== 'conv', 'R2.clearGauge': () => W.r2.zone !== 'gauge',
    'R1.job': () => MCH.R1.job, 'R2.job': () => MCH.R2.job,
    'CNC.ready': () => true,
    'CNC.run': () => W.cnc.state === 'RUN',
    'CNC.done': () => W.cnc.state === 'DONE' && !!W.cnc.part && W.cnc.part.st === 'fin',
    'CNC.empty': () => !W.cnc.part && W.cnc.state !== 'RUN',
    'ZS-31': () => doorPos() > 0.99, 'ZS-32': () => doorPos() < 0.01, 'ZS-33': () => W.cnc.locked,
    'ZS-34': () => W.cnc.vise === 'open', 'ZS-35': () => W.cnc.vise === 'clamped', 'PS-36': () => !!W.cnc.part,
    'GR-21': () => !!W.r1.hold.S, 'GR-21A': () => !!W.r1.hold.A, 'GR-21B': () => !!W.r1.hold.B, 'GR-51': () => !!W.r2.hold.S,
    'ENC-43': () => W.belt.v > 0.5,
    'PE-42': () => proxLive('CP-3'), 'ROI-C': () => truth['CP-3']() && S.camFault !== 'CAM-2',
    'PX-52': () => proxLive('CP-4'),
    'CAM-2.slot': () => W.lastSlot != null && W.parts.some((p) => p.loc.k === 'out' && p.loc.slot === W.lastSlot),
    'outCount': () => outCount(),
    'GAUGE.zeroed': () => W.gauge.zeroed, 'GAUGE.valid': () => W.gauge.valid, 'GAUGE.ok': () => W.gauge.ok,
    'PE-65': () => S.t - W.pe65 < 0.8,
    'TRUE.entryPart': () => truth['CP-2'](), 'TRUE.outPallet': () => W.palletOut.present,
    'TRUE.r2Nok': () => undersized(W.r2.hold.S),
  };
  const INPUT = {
    'HMI.clear': (slot) => !!slot && S.inputs.clearAt >= MCH[slot].since,
    'HMI.verify': () => S.inputs.verify, 'HMI.reset': () => S.inputs.reset, 'HMI.release': () => S.inputs.release,
    'VERIFY.pass': () => !!(S.verify && S.verify.done), 'VERIFY.fail': () => false,
  };
  function read(name, slot) {
    if (M.SLOTS[name]) return MCH[name].state;
    const s = M.SIGNALS[name];
    if (!s) throw new Error('signal not in the model: ' + name);
    if (s.kind === 'check') return !!(S.cp[slot] || {})[name];
    if (s.kind === 'var') return name === 'mismatches' ? SUP.events.length : S.vars[name];
    const f = s.kind === 'input' ? INPUT[name] : SENSE[name];
    if (!f) throw new Error('no plant reader for signal ' + name);
    return f(slot);
  }
  const ev = (e, slot) => X.evaluate(e, (n) => read(n, slot));
  const outputOn = (o) => ev(M.OUTPUTS[o].def);
  // Every name the active machines, outputs, rungs and properties read must have a reader here.
  function checkSignals() {
    const used = new Set();
    const add = (e) => { if (e) X.names(e, true).forEach((n) => used.add(n)); };
    const steps = (list) => (list || []).forEach((st) => ['when', 'confirm', 'await', 'until'].forEach((k) => add(st[k])));
    SLOTS.forEach((k) => {
      const m = M.MACHINES[MCH[k].key];
      add(m.initial.when); steps(m.initial.do);
      if (m.hold) { steps(m.hold.do); add(m.hold.exit); }
      if (m.fault) add(m.fault.exit);
      Object.values(m.states).forEach((s) => { if (s.choice) add(s.choice); steps(s.do); (s.next || []).forEach((tr) => add(tr.when)); (s.faults || []).forEach((f) => add(f.when)); });
    });
    Object.values(M.OUTPUTS).forEach((o) => add(o.def));
    M.RUNGS.forEach((r) => add(r.when));
    M.PROPERTIES.forEach((p) => { add(p.never); add(p.require); });
    used.forEach((n) => { if (M.SIGNALS[n] && M.SIGNALS[n].kind === 'derived') return; try { read(n, 'R1'); } catch (e) { console.error(e.message); } });
  }

  // ------------------------------------------------------------------ interpreter of the model
  const machineOf = (slot) => M.MACHINES[MCH[slot].key];
  const stateOf = (slot, id) => machineOf(slot).states[id];
  const labelText = (tr) => X.label(tr, 400).map(X.plain).join(' ');
  function setState(slot, id, why) {
    const x = MCH[slot];
    if (x.state === id && x.why === (why || '')) return;
    const enter = x.state !== id;
    if (enter) { x.prev = x.state; x.since = S.t; TRACE.push({ t: S.t, slot, from: x.prev, to: id }); }
    x.state = id; x.why = why || '';
    statesDirty = true;
    const s = stateOf(slot, id);
    if (enter && s) {
      if (s.log) log({ op: 'pallet', stop: 'stop' }[s.kind] || 'info', s.log);
      if (slot === 'SUP' && s.kind === 'stop') {
        W.stats.stops++;
        S.stopReason = S.vars.CAM_FAULT ? `${S.camFault || 'a camera'} gave two invalid images (camera fault)` : `${SUP.events.length} camera / proximity mismatches within 10 min (${windowSummary()})`;
      }
      if (s.hmi && s.hmi.proc === 'verify') startVerify();
      if (slot === 'SUP' && s.kind === 'ok' && stateOf(slot, x.prev) && stateOf(slot, x.prev).kind === 'check') {
        S.verify = null; S.stopReason = '';
        log('stop', 'Operator reset: mismatch counter cleared, line resumes');
      }
    }
    if (S.step && slot !== 'SUP' && enter) { S.step = false; S.running = false; syncRun(); }
  }
  function* runMachine(slot) {
    const m = machineOf(slot), init = m.initial;
    if (init.do) yield* runSteps(slot, init.do, false);
    if (init.when) yield* until(() => ev(init.when, slot));
    let target = init.to, why = init.when ? labelText(init) : 'start', from = 0;
    for (;;) {
      for (let n = 0; m.states[target].choice && n < 10; n++) {         // choice: passed at once
        const q = m.states[target], yes = ev(q.choice, slot), sig = M.SIGNALS[q.choice];
        why = `${X.plain(sig.ask.join(' '))} ${yes ? 'Yes' : 'No'}: ${X.plain(yes ? (q.yesText || sig.on) : (q.noText || sig.off))}`;
        target = yes ? q.yes : q.no;
      }
      setState(slot, target, why);
      const r = yield* runState(slot, target, from);
      from = 0;
      if (r.tr) {
        (r.tr.do || []).forEach((a) => applySet(a, slot));
        consumeInputs(r.tr.when);
        why = labelText(r.tr);
        if (r.tr.hold !== false && m.hold && ev('HOLD.req', slot)) yield* holdState(slot);
        target = r.tr.to;
      } else if (r.hold) {
        yield* holdState(slot);
        why = r.at != null ? 'line reset · the check is repeated' : 'line reset · the state is entered again';
        from = r.at || 0;
      } else {
        yield* faultState(slot, r.fault);
        why = 'fault cleared by the operator · the step is repeated';
        if (m.hold && ev('HOLD.req', slot)) yield* holdState(slot);
      }
    }
  }
  function* holdState(slot) {
    const m = machineOf(slot);
    setState(slot, 'H', S.vars.CAM_FAULT && !ev('lineStop') ? `${S.camFault || 'camera'} fault: line stop` : 'LINE STOP from the cross-check supervisor');
    yield* runSteps(slot, m.hold.do || [], false);
    yield* until(() => ev(m.hold.exit, slot));
  }
  function* faultState(slot, msg) {
    S.faults[slot] = msg;
    setState(slot, 'F', msg);
    log('fault', `${msg} → FAULT (no automatic robot retry)`);
    yield* until(() => ev(machineOf(slot).fault.exit, slot));
    S.faults[slot] = null;
  }
  function missing(expr, slot) {
    const e = X.parse(expr), conj = e.op === 'and' ? e.args : [e];
    const bad = conj.filter((c) => !X.evaluate(c, (n) => read(n, slot)));
    return (bad.length ? bad : conj).map((c) => X.plain(X.terms(c)[0].join(' · '))).join(' · ');
  }
  // Steps of a state; returns null when they all ran, or {hold} / {fault} to leave the state.
  function* runSteps(slot, steps, holdable, from) {
    for (let i = from || 0; i < steps.length; i++) {
      const st = steps[i];
      if (st.when && !ev(st.when, slot)) continue;
      if (st.job) {
        yield* runJob(slot, st.job);
        if (st.confirm && !ev(st.confirm, slot)) return { fault: `missing confirmation after "${M.JOBS[st.job].text}": ${missing(st.confirm, slot)}` };
      } else if (st.check) {
        for (;;) {
          if ((yield* check(st.check, st.quick, slot)) === 'camfault') return { hold: true, at: i };
          if (!st.until || ev(st.until, slot)) break;
          if (holdable && ev('HOLD.req', slot)) return { hold: true };
          yield* wait(T.check);
        }
        if (st.confirm && !ev(st.confirm, slot)) return { fault: `missing confirmation at ${st.check}: ${missing(st.confirm, slot)}` };
      } else if (st.await) {
        while (!ev(st.await, slot)) {
          if (holdable && ev('HOLD.req', slot)) return { hold: true };
          yield { k: 'c', fn: () => ev(st.await, slot) || (holdable && ev('HOLD.req', slot)) };
        }
      } else applySet(st, slot);
    }
    return null;
  }
  // One state: its steps, then the first transition whose guard holds. A state that is not a
  // waiting state must leave within RULES.confirmTimeout, otherwise FAULT names what is missing.
  function* runState(slot, id, from) {
    const s = stateOf(slot, id), m = machineOf(slot), holdable = s.hold !== false && !!m.hold;
    const r = yield* runSteps(slot, s.do || [], holdable, from);
    if (r) return r;
    const t0 = S.t, since = new Map();
    const status = () => s.next.map((tr) => ev(tr.when, slot)).join() + '|' + (holdable && s.wait ? ev('HOLD.req', slot) : '') + '|' + (s.faults || []).map((f) => (f.when ? ev(f.when, slot) : '')).join();
    for (;;) {
      let wake = Infinity;
      for (const tr of s.next) {
        const ok = ev(tr.when, slot);
        if (!tr.for) { if (ok) return { tr }; continue; }
        if (!ok) { since.delete(tr); continue; }
        if (!since.has(tr)) since.set(tr, S.t);
        const due = since.get(tr) + T[tr.for];
        if (S.t >= due - 1e-9) return { tr };
        wake = Math.min(wake, due);
      }
      for (const f of s.faults || []) {
        if (f.when && !ev(f.when, slot)) continue;
        if (S.t - t0 >= f.after - 1e-9) return { fault: X.plain(f.text || X.label({ when: f.when }, 400).join(' ')) };
        wake = Math.min(wake, t0 + f.after);
      }
      if (!s.wait) {
        if (S.t - t0 >= RU.confirmTimeout - 1e-9) return { fault: `${id}: missing confirmation: ${missing(s.next[0].when, slot)}` };
        wake = Math.min(wake, t0 + RU.confirmTimeout);
      }
      if (holdable && s.wait && ev('HOLD.req', slot)) return { hold: true };
      const last = status();
      yield { k: 'c', fn: () => status() !== last, until: wake === Infinity ? undefined : wake };
    }
  }
  function applySet(st, slot) {
    if (st.when && !ev(st.when, slot)) return;
    if (st.set) Object.keys(st.set).forEach((v) => setVar(v, st.set[v]));
    if (st.inc) { const sg = M.SIGNALS[st.inc]; setVar(st.inc, Math.min(sg.max != null ? sg.max : Infinity, (S.vars[st.inc] || 0) + 1)); }
  }
  function setVar(v, val) {
    if (v === 'mismatches') { if (val === 0) SUP.events = []; return; }
    const before = S.vars[v];
    S.vars[v] = val;
    if (val === true && before !== true && M.SIGNALS[v].logOn) log(v === 'QH' ? 'quality' : 'info', M.SIGNALS[v].logOn);
    if (v === 'CAM_FAULT' && !val) S.camFault = null;
  }
  function consumeInputs(expr) { X.names(expr, true).forEach((n) => { if (LATCH[n]) S.inputs[LATCH[n]] = false; }); }
  function evalRungs() {
    let fired = false;
    M.RUNGS.forEach((r) => { if (ev(r.when)) { applySet(r); consumeInputs(r.when); log('quality', r.text); fired = true; } });
    return fired;
  }
  function* runJob(slot, name) {
    const j = M.JOBS[name], r = j.robot === 'R1' ? W.r1 : j.robot === 'R2' ? W.r2 : null, t0 = S.t;
    if (!JOB[name]) { console.error('no plant implementation for job ' + name); return; }
    MCH[slot].job = name;
    if (r) { r.zone = j.zone || 'free'; r.job = name; r.fing = r.fing === 'closed' ? 'open' : r.fing; }
    monitorStart(name);
    yield* JOB[name](r);
    if (r) { r.zone = 'free'; r.job = null; }
    MCH[slot].job = null;
    W.stats.jobs++;
    const dt = S.t - t0, want = M.jobTime(name);
    if (Math.abs(dt - want) > 0.011) console.error(`job ${name}: ${dt.toFixed(3)} s in the simulation, ${want} s in the model`);
  }

  // ------------------------------------------------------------------ property monitors (same properties as the verifier)
  const PROPS = () => M.PROPERTIES.filter((p) => !p.setup || p.setup === S.setup);
  function violated(p) {
    W.stats.violations++;
    const msg = `PROPERTY ${p.id} VIOLATED: ${p.text}`;
    log('fault', msg);
    console.error(msg + ` (t = ${S.t.toFixed(2)} s)`);
  }
  function monitorStart(job) { PROPS().forEach((p) => { if (p.start && p.start.includes(job) && !ev(p.require)) violated(p); }); }
  const seen = new Set();
  function monitorStable() {
    PROPS().forEach((p) => {
      if (!p.never) return;
      const bad = ev(p.never);
      if (bad && !seen.has(p.id)) violated(p);
      if (bad) seen.add(p.id); else seen.delete(p.id);
    });
  }

  // ------------------------------------------------------------------ checkpoints: camera + proximity cross-check
  const truth = {
    'CP-1': () => W.palletIn.present,
    'CP-2': () => W.parts.some((p) => p.loc.k === 'conv' && p.loc.x < L.convEntry[0] + 30),
    'CP-3': () => W.parts.some((p) => p.loc.k === 'conv' && p.loc.x > P.stopX - 12),
    'CP-4': () => W.palletOut.present,
    'CP-5': () => W.parts.some((p) => p.loc.k === 'gauge'),
  };
  const proxLive = (id) => (CP[id].fault ? false : truth[id]());
  const camWord = (id, v) => ((id === 'CP-1' || id === 'CP-4') ? (v ? 'a pallet' : 'no pallet') : (v ? 'a part' : 'no part'));
  // Both sources must agree; if not, the camera value is used and the mismatch is counted. An invalid
  // image is re-triggered once; a second invalid image is a camera fault (line stop).
  function* check(id, quick, slot) {
    const cp = CP[id];
    if (!quick) yield* wait(T.check);
    flashCam(cp.cam);
    if (S.inject.frames[cp.cam] > 0) {
      S.inject.frames[cp.cam]--;
      log('check', `${cp.cam} image not valid at ${id} (calibration marks not found) → re-trigger once`);
      yield* wait(RU.retrigger);
      flashCam(cp.cam);
      if (S.inject.frames[cp.cam] > 0) {
        S.inject.frames[cp.cam]--;
        S.camFault = cp.cam;
        setVar('CAM_FAULT', true);
        log('stop', `${cp.cam} gave two invalid images at ${id} → camera fault, line stop`);
        return 'camfault';
      }
      log('check', `${cp.cam} re-trigger OK at ${id}`);
    }
    const t = truth[id]();
    let prox = cp.fault ? false : t;
    if (cp.glitch) { prox = !prox; cp.glitch = false; }
    const cam = t;
    cp.last = { t: S.t, prox, cam, agree: prox === cam };
    markRoi(cp.roi, prox === cam);
    if (prox !== cam) mismatch(cp, prox, cam);
    else if (S.logAll) log('check', `${id} agree: ${cp.prox} ${prox ? 'ON' : 'OFF'}, ${cp.cam} sees ${camWord(id, cam)}`);
    const res = S.cp[slot] = S.cp[slot] || {};
    res[id] = cam;
    if (id === 'CP-1') res['CAM-1.part'] = cam && firstRaw() >= 0;
    return cam;
  }
  function mismatch(cp, prox, cam) {
    cp.count++; W.stats.mism++;
    SUP.events.push({ t: S.t, cp: cp.id, tag: cp.prox });
    pruneWindow();
    log('mismatch', `${cp.id} ${cp.where}: ${cp.prox} = ${prox ? 'ON' : 'OFF'} but ${cp.cam} sees ${camWord(cp.id, cam)} → camera value used (${SUP.events.length} of ${RU.mismatchLimit} in 10 min)`);
  }
  function windowSummary() {
    const c = {};
    SUP.events.forEach((e) => { c[e.tag] = (c[e.tag] || 0) + 1; });
    return Object.keys(c).map((k) => `${k} ×${c[k]}`).join(', ');
  }
  function pruneWindow() { SUP.events = SUP.events.filter((e) => S.t - e.t <= RU.mismatchWindow); }

  // ------------------------------------------------------------------ motion helpers
  function toolPos(r) {
    if (!r.anim) return r.tool;
    const a = r.anim, u = ease(clamp((S.t - a.t0) / (a.t1 - a.t0), 0, 1));
    return [a.from[0] + (a.to[0] - a.from[0]) * u, a.from[1] + (a.to[1] - a.from[1]) * u];
  }
  function* moveTo(r, to, dur) {
    if (!(dur > 0)) { r.tool = to.slice(); r.anim = null; return; }
    r.anim = { from: toolPos(r).slice(), to: to.slice(), t0: S.t, t1: S.t + dur };
    yield* wait(dur);
    r.tool = to.slice(); r.anim = null;
  }
  function doorPos() {
    const d = W.door;
    if (!d.anim) return d.pos;
    const a = d.anim, u = ease(clamp((S.t - a.t0) / (a.t1 - a.t0), 0, 1));
    return a.from + (a.to - a.from) * u;
  }
  function* slideDoor(r, from, to, approach) {
    yield* moveTo(r, from ? L.handleOpen : L.handleClosed, approach + 0.5);
    r.fing = 'handle';
    W.door.anim = { from, to, t0: S.t, t1: S.t + 3.0 };
    yield* moveTo(r, to ? L.handleOpen : L.handleClosed, 3.0);
    W.door.pos = to; W.door.anim = null; r.fing = 'open';
    yield* wait(0.5);
  }
  const g1 = (r) => (r.dual && S.setup === 2 ? 'A' : 'S');

  // ------------------------------------------------------------------ jobs: the plant side of every job of the model
  // Each one takes exactly the time of its components in M.JOBS (runJob reports any difference).
  const JOB = {
    'R1.home': function* (r) { yield* moveTo(r, r.base.home, T.doorToHome); },
    'R1.park': function* (r) { yield* moveTo(r, r.base.home, T.park); },
    'R2.home': function* (r) { yield* moveTo(r, r.base.home, T.r2Home); },
    'R2.park': function* (r) { yield* moveTo(r, r.base.home, T.park); },
    'R1.openDoorFromHome': function* (r) { yield* slideDoor(r, 0, 1, T.homeToDoor); },
    'R1.openDoor': function* (r) { yield* slideDoor(r, 0, 1, 0); },
    'R1.closeDoor': function* (r) { yield* slideDoor(r, 1, 0, 0); },
    'DOOR.lock': function* () { yield* wait(T.lock); W.cnc.locked = true; },
    'CNC.start': function* () { yield* wait(T.cycleStart); W.cnc.startCmd = true; },
    'R1.unload': function* (r) {
      yield* moveTo(r, P.doorway, T.enterCnc / 2); yield* moveTo(r, P.fixture, T.enterCnc / 2);
      r.fing = 'grip'; yield* wait(T.grip);
      W.cnc.vise = 'open'; yield* wait(T.viseOpen);
      const p = W.cnc.part; W.cnc.part = null; if (p) { p.loc = { k: 'r1', g: 'S' }; r.hold.S = p; }
      yield* wait(T.lift);
      yield* moveTo(r, P.doorway, T.exitCnc / 2); yield* moveTo(r, P.outside, T.exitCnc / 2);
    },
    'R1.load': function* (r) { yield* moveTo(r, P.outside, T.palletToDoor); yield* loadVise(r, 'S', T.enterCnc); },
    'R1.toConveyor': function* (r) { yield* moveTo(r, P.convAbove, T.doorToConv); },
    'R1.toConveyorB': function* (r) { startTurn(r, 'B', 1.2); yield* moveTo(r, P.convAbove, T.doorToConv); },
    'R1.placeConv': function* (r) { yield* placeOnBelt(r, 'S'); },
    'R1.placeConvB': function* (r) { yield* placeOnBelt(r, 'B'); },
    'R1.pickRaw': function* (r) { yield* pickRaw(r, 'S'); },
    'R1.pickRawA': function* (r) { startTurn(r, 'A', 1.2); yield* pickRaw(r, 'A'); },
    'R1.toDoorReady': function* (r) { startTurn(r, 'B', 1.2); yield* moveTo(r, r.base.doorReady, T.palletToDoor); },
    'R1.enterCnc': function* (r) { yield* moveTo(r, P.doorway, T.enterCnc / 2); yield* moveTo(r, P.fixture, T.enterCnc / 2); },
    'R1.unloadB': function* (r) {
      r.fing = 'grip'; yield* wait(T.grip);
      W.cnc.vise = 'open'; yield* wait(T.viseOpen);
      const f = W.cnc.part; W.cnc.part = null; if (f) { f.loc = { k: 'r1', g: 'B' }; r.hold.B = f; }
      yield* wait(T.lift);
    },
    'R1.loadA': function* (r) {
      W.cnc.vise = 'open';
      startTurn(r, 'A', T.swapGripper); yield* wait(T.swapGripper);   // B (finished part) turns away, A (raw part) faces the vise
      yield* loadVise(r, 'A', 0);
    },
    'R2.pickConv': function* (r) {
      yield* moveTo(r, P.convPick, T.r2ToExit);
      r.fing = 'grip';
      const p = W.parts.find((q) => q.loc.k === 'conv' && q.loc.x > P.stopX - 12);
      if (p) { p.loc = { k: 'r2', g: 'S' }; r.hold.S = p; }
      yield* moveTo(r, P.convOff, T.r2Pick);
    },
    'R2.placePallet': function* (r) {
      const slot = firstFreeOut();
      yield* moveTo(r, slot >= 0 ? D.slotPos('out', slot) : r.base.home, T.r2ToPallet);
      const p = r.hold.S; r.hold.S = null; r.fing = 'open';
      if (p && slot >= 0) { p.loc = { k: 'out', slot }; W.lastSlot = slot; W.ok++; }
      yield* wait(T.r2Place);
      if (S.logAll) log('check', `CAM-2: slot ${slot + 1} occupied · output pallet ${outCount()} of 12`);
    },
    'R2.loadGauge': function* (r) {
      yield* moveTo(r, P.nest, T.r2ToGauge);
      yield* wait(T.r2LoadGauge * 0.6);
      const p = r.hold.S; r.hold.S = null; r.fing = 'open';
      if (p) p.loc = { k: 'gauge' };
      yield* moveTo(r, P.nestOut, T.r2LoadGauge * 0.4);
    },
    'GAUGE.measure': function* () {
      yield* wait(T.measure);
      const p = W.parts.find((q) => q.loc.k === 'gauge');
      if (!p) { W.gauge.valid = false; return; }
      const meas = p.dims.map((v) => v + (Math.random() - 0.5) * 0.004);
      p.meas = meas;
      W.gauge.valid = true; W.gauge.ok = meas.every((v) => v >= RU.minSize);
      log('measure', `Part #${p.id}: L ${meas[0].toFixed(3)} · W ${meas[1].toFixed(3)} · H ${meas[2].toFixed(3)} mm → ${W.gauge.ok ? 'OK, all ≥ 48.00' : 'NOK, undersized'}`);
    },
    'GAUGE.master': function* () {
      log('measure', 'Start-up master cube 50.000 mm: LS-61 50.001 · LS-62 49.999 · LS-63 50.000 mm → gauge OK');
      W.gauge.zeroed = true;
    },
    'R2.repick': function* (r) {
      yield* moveTo(r, P.nest, T.r2Repick / 2);
      r.fing = 'grip'; yield* wait(T.r2Repick / 2);
      const p = W.parts.find((q) => q.loc.k === 'gauge');
      if (p) { p.loc = { k: 'r2', g: 'S' }; r.hold.S = p; }
      W.gauge.valid = false;
    },
    'R2.dropNok': function* (r) {
      yield* moveTo(r, P.nokDrop, T.r2ToNok);
      const p = r.hold.S; r.hold.S = null; r.fing = 'open';
      if (p) { p.nok = true; p.loc = { k: 'nok', i: W.nok }; W.pe65 = S.t; W.nok++; }
      yield* wait(T.r2Drop);
      if (p) log('quality', `NOK part #${p.id} dropped in the locked chute (PE-65 confirmed) · NOK total ${W.nok}`);
    },
  };
  function* pickRaw(r, g) {
    const slot = firstRaw();
    r.fing = 'open';
    yield* moveTo(r, slot >= 0 ? D.slotPos('in', slot) : r.base.home, T.convToPallet);
    yield* wait(0.7);
    r.fing = 'grip';
    yield* wait(T.grip);
    if (S.inject.gripMiss || slot < 0) {
      S.inject.gripMiss = false;
      r.fing = 'closed';                           // fingers closed on nothing: GR-21 stays OFF
      log('fault', `${g === 'S' ? 'GR-21' : 'GR-21' + g}: fingers fully closed, no part at the input pallet`);
    } else { const p = partIn(slot); p.loc = { k: 'r1', g }; r.hold[g] = p; }
    yield* wait(T.pickPallet - 0.7 - T.grip);
  }
  function* loadVise(r, g, enter) {
    if (enter) { yield* moveTo(r, P.doorway, enter / 2); yield* moveTo(r, P.fixture, enter / 2); }
    r.fing = 'grip';
    const p = r.hold[g]; r.hold[g] = null;
    if (p) { p.loc = { k: 'cnc' }; W.cnc.part = p; }
    yield* wait(T.placeInVise);
    W.cnc.vise = 'clamped'; yield* wait(T.viseClamp);
    yield* wait(T.seatCheck);
    r.fing = 'open'; yield* wait(T.release);
    yield* moveTo(r, P.doorway, T.exitCnc / 2); yield* moveTo(r, P.outside, T.exitCnc / 2);
  }
  function* placeOnBelt(r, g) {
    yield* moveTo(r, P.convPlace, 0.7);
    const p = r.hold[g]; r.hold[g] = null; r.fing = 'open';
    if (p) p.loc = { k: 'conv', x: P.convPlace[0] };
    yield* wait(T.release);
    yield* moveTo(r, P.convAbove, T.placeConv - 0.7 - T.release);
  }

  // ------------------------------------------------------------------ CNC (plant)
  function* cncProc() {
    for (;;) {
      yield* until(() => W.cnc.startCmd);
      W.cnc.startCmd = false;
      const st = W.stats;
      if (W.cnc.doneAt != null) { st.lastIdle = S.t - W.cnc.doneAt; st.idleSum += st.lastIdle; st.idleN++; }
      if (st.firstStart == null) st.firstStart = S.t;
      W.cnc.state = 'RUN'; W.cnc.runStart = S.t;
      yield* wait(T.cncCycle);
      const p = W.cnc.part;
      if (p) {
        p.st = 'fin';
        p.dims = [0, 1, 2].map(() => 50 + (Math.random() - 0.5) * 0.04);
        if (S.inject.under > 0) { S.inject.under--; p.dims[Math.floor(Math.random() * 3)] = 47.35 + Math.random() * 0.5; }
      }
      W.cnc.state = 'DONE'; W.cnc.doneAt = S.t; st.cycles++;
      yield* wait(T.unlock);
      W.cnc.locked = false;
    }
  }

  // ------------------------------------------------------------------ operator
  const activeHmi = (act) => SLOTS.map((k) => stateOf(k, MCH[k].state)).find((s) => s && s.hmi && s.hmi.act === act);
  const needInput = () => W.palletIn.present && !W.palletIn.busy && firstRaw() < 0;
  const needOutput = () => outputOn('LT-53') && W.palletOut.present && !W.palletOut.busy;
  function* reloadInput() {
    W.palletIn.busy = true;
    log('operator', 'Operator removes the empty input pallet (PX-11 OFF)');
    W.palletIn.present = false;
    W.parts = W.parts.filter((p) => p.loc.k !== 'in');
    yield* wait(8);
    for (let i = 0; i < 12; i++) addPart('raw', { k: 'in', slot: i });
    W.palletIn.present = true; W.palletIn.busy = false;
    log('operator', 'Operator places a full input pallet (12 raw parts) and presses "Pallet loaded"');
  }
  function* swapOutput() {
    W.palletOut.busy = true;
    log('operator', 'Operator takes the full output pallet away (PX-52 OFF)');
    W.palletOut.present = false;
    W.parts = W.parts.filter((p) => p.loc.k !== 'out');
    yield* wait(8);
    W.palletOut.present = true; W.palletOut.busy = false;
    log('operator', 'Operator places an empty output pallet');
  }
  function* operatorProc() {
    for (;;) {
      yield* until(() => S.autoOp && (needInput() || needOutput()));
      const t0 = S.t;
      yield* until(() => S.t - t0 >= 45 || !S.autoOp || !(needInput() || needOutput()));
      if (!S.autoOp) continue;
      if (needInput()) yield* reloadInput();
      if (needOutput()) yield* swapOutput();
    }
  }

  // ------------------------------------------------------------------ physics
  function physics(h) {
    const b = W.belt;
    b.cmd = outputOn('BELT.motor');
    b.v = b.cmd ? Math.min(VMAX, b.v + ACC * h) : Math.max(0, b.v - ACC * h);
    if (b.v > 0) {
      b.off = (b.off + b.v * h) % 24;
      for (const p of W.parts) if (p.loc.k === 'conv') p.loc.x = Math.min(P.stopX, p.loc.x + b.v * h);
    }
    if (W.cnc.state === 'RUN') W.stats.runTime += h;
    for (const r of [W.r1, W.r2]) if (r.rot && S.t >= r.rot.t1) { r.active = r.rot.to; r.rot = null; }
    pruneWindow();
  }
  // Advance the simulation by dt seconds of simulated time.
  function advance(dt) {
    while (dt > 1e-9 && S.running) {
      // step exactly to the next timed wake-up so waits are not stretched by the frame rate
      let h = Math.min(dt, 0.05);
      for (const p of procs) if (p.wait && p.wait.until != null && p.wait.until > S.t) h = Math.min(h, p.wait.until - S.t);
      h = Math.max(h, 1e-6);
      S.t += h; physics(h); runProcs(); monitorStable(); dt -= h;
      W.beacon = outputOn('LT-53');
    }
  }

  // ------------------------------------------------------------------ log
  function log(cat, msg) {
    logs.unshift({ t: S.t, cat, msg });
    if (logs.length > 300) logs.pop();
    logDirty = true;
  }

  // ------------------------------------------------------------------ rendering: mimic
  let svgRoot, dyn, doorEl, beltEl, leds = {}, lamps = {}, fovs = {}, rois = {};
  const flashes = {};
  function flashCam(cam) { flashes['fov:' + cam] = performance.now() + 320; }
  function markRoi(roi, ok) { flashes['roi:' + roi] = { until: performance.now() + 1300, ok }; }
  function partXY(p) {
    const k = p.loc.k;
    if (k === 'in') return D.slotPos('in', p.loc.slot);
    if (k === 'out') return D.slotPos('out', p.loc.slot);
    if (k === 'cnc') return P.fixture;
    if (k === 'conv') return [p.loc.x, L.convEntry[1]];
    if (k === 'gauge') return P.nest;
    if (k === 'nok') { const i = p.loc.i % 12; return [L.nok.x + 22 + (i % 4) * 20, L.nok.y + 42 + Math.floor(i / 4) * 18]; }
    return [0, 0];
  }
  function partCls(p) { return `${p.st === 'fin' ? 'fin' : ''}${p.nok ? ' nok' : ''}`; }
  function robotSvg(r, sign, label) {
    const tool = toolPos(r), g = D.armGeom(r.base, tool, sign);
    const fx = Math.cos(g.ang), fy = Math.sin(g.ang), px = -fy, py = fx;
    let s = `<line class="ly-link" x1="${fx2(r.base.x)}" y1="${fx2(r.base.y)}" x2="${fx2(g.ex)}" y2="${fx2(g.ey)}"/>`;
    s += `<line class="ly-link2" x1="${fx2(g.ex)}" y1="${fx2(g.ey)}" x2="${fx2(g.tx - fx * 8)}" y2="${fx2(g.ty - fy * 8)}"/>`;
    s += `<circle class="ly-robot" cx="${r.base.x}" cy="${r.base.y}" r="${r.base.r}"/><text class="ly-robot-t" x="${r.base.x}" y="${r.base.y + 4}" text-anchor="middle">${label}</text>`;
    s += `<circle class="ly-joint" cx="${fx2(g.ex)}" cy="${fx2(g.ey)}" r="7"/>`;
    const OPEN = { open: 16, grip: 12, handle: 6, closed: 3 };
    // one gripper head: palm + two fingers pointing along the arm, centred on (cx, cy)
    const head = (cx, cy, fing) => {
      const w = OPEN[fing] || 14;
      const fin = (side) => { const ox = cx + px * side * w, oy = cy + py * side * w; return `<line class="ly-finger" x1="${fx2(ox - fx * 12)}" y1="${fx2(oy - fy * 12)}" x2="${fx2(ox + fx * 5)}" y2="${fx2(oy + fy * 5)}"/>`; };
      return `<line class="ly-finger" x1="${fx2(cx - fx * 12 + px * w)}" y1="${fx2(cy - fy * 12 + py * w)}" x2="${fx2(cx - fx * 12 - px * w)}" y2="${fx2(cy - fy * 12 - py * w)}"/>` + fin(1) + fin(-1);
    };
    if (!(r.dual && S.setup === 2)) {
      if (r.hold.S) s += D.partSvg(g.tx, g.ty, partCls(r.hold.S));
      return s + head(g.tx, g.ty, r.fing);
    }
    // dual gripper: the active head sits on the tool point, the other one 30 px to the side;
    // a wrist turn rotates both heads 180° about the adapter centre
    const act = r.active, oth = act === 'A' ? 'B' : 'A', DIST = 30;
    const T0 = [g.tx, g.ty], O0 = [g.tx + px * DIST, g.ty + py * DIST];
    const pos = { [act]: T0, [oth]: O0 };
    if (r.rot) {
      const u = ease(clamp((S.t - r.rot.t0) / (r.rot.t1 - r.rot.t0), 0, 1)), phi = Math.PI * u;
      const mx = (T0[0] + O0[0]) / 2, my = (T0[1] + O0[1]) / 2;
      const turn = (q) => { const dx = q[0] - mx, dy = q[1] - my; return [mx + dx * Math.cos(phi) - dy * Math.sin(phi), my + dx * Math.sin(phi) + dy * Math.cos(phi)]; };
      pos[act] = turn(T0); pos[oth] = turn(O0);
    }
    s += `<line class="ly-link2" style="stroke-width:6" x1="${fx2(pos.A[0] - fx * 12)}" y1="${fx2(pos.A[1] - fy * 12)}" x2="${fx2(pos.B[0] - fx * 12)}" y2="${fx2(pos.B[1] - fy * 12)}"/>`;
    ['A', 'B'].forEach((h) => {
      const [hx, hy] = pos[h], isAct = h === r.active && !r.rot;
      const fing = isAct && (r.fing === 'handle' || r.fing === 'closed') ? r.fing : r.hold[h] ? 'grip' : isAct ? r.fing : 'open';
      if (r.hold[h]) s += D.partSvg(hx, hy, partCls(r.hold[h]));
      s += head(hx, hy, fing);
      const lx = hx - fx * 21, ly = hy - fy * 21;
      s += `<circle cx="${fx2(lx)}" cy="${fx2(ly)}" r="7.5" fill="${h === 'A' ? '#1565c0' : '#a0521d'}" stroke="#fff" stroke-width="1.2"/><text x="${fx2(lx)}" y="${fx2(ly + 3.6)}" text-anchor="middle" fill="#fff" class="pill-t">${h}</text>`;
    });
    return s;
  }
  function gripperText(r) {
    const w = (h) => (r.hold[h] ? (r.hold[h].st === 'fin' ? 'finished part' : 'raw part') : 'empty');
    return `A: ${w('A')} · B: ${w('B')}`;
  }
  function fx2(n) { return Math.round(n * 10) / 10; }
  function pill(x, y, id, name, kind) {
    const w = 18 + id.length * 6.6 + name.length * 6.5;
    const fill = { ok: '#1e8a4c', op: '#1565c0', hold: '#a86b00', warn: '#a86b00', fault: '#c62828', stop: '#c62828', check: '#7b3fb5' }[kind] || 'var(--pill)';
    return `<g><rect x="${fx2(x - w / 2)}" y="${y - 10}" width="${fx2(w)}" height="20" rx="10" fill="${fill}" opacity=".94"/>` +
      `<text x="${fx2(x - w / 2 + 9)}" y="${y + 4}" fill="#fff" class="pill-t">${esc(id)}</text>` +
      `<text x="${fx2(x - w / 2 + 14 + id.length * 6.6)}" y="${y + 4}" fill="#fff" class="pill-n">${esc(name)}</text></g>`;
  }
  const stateName = (slot, id) => (M.STATES[MCH[slot].key] || {})[id] || id;
  function kindOf(slot, id) {
    if (id === 'H') return 'hold';
    if (id === 'F') return 'fault';
    const s = stateOf(slot, id);
    return (s && s.kind) || '';
  }
  function cncLabel() {
    const c = W.cnc, p = c.part;
    if (c.state === 'RUN') return ['CNC', `MACHINING ${fmtMS(T.cncCycle - (S.t - c.runStart))}`, 'ok'];
    if (p && p.st === 'fin') return ['CNC', c.locked ? 'CYCLE COMPLETE' : 'DONE · DOOR UNLOCKED', 'warn'];
    if (p) return ['CNC', c.locked ? 'LOADED · WAIT START' : doorPos() > 0.01 ? 'LOADED · DOOR OPEN' : 'LOADED', ''];
    return ['CNC', doorPos() > 0.01 ? 'EMPTY · DOOR OPEN' : 'EMPTY · READY', ''];
  }
  function renderMimic() {
    doorEl.setAttribute('transform', `translate(0 ${fx2(doorPos() * L.door.travel)})`);
    beltEl.setAttribute('transform', `translate(${fx2(W.belt.off)} 0)`);
    let s = '';
    for (const p of W.parts) { if (p.loc.k === 'r1' || p.loc.k === 'r2') continue; const [x, y] = partXY(p); s += D.partSvg(x, y, partCls(p)); }
    s += robotSvg(W.r1, L.elbow.r1, 'ROBOT 1');
    s += robotSvg(W.r2, L.elbow.r2, 'ROBOT 2');
    const c = cncLabel();
    s += pill(120, 200, c[0], c[1], c[2]);
    const mk = (slot, x, y) => { const id = MCH[slot].state; s += pill(x, y, id, stateName(slot, id), kindOf(slot, id)); };
    mk('R1', L.r1.x, L.r1.y + 56);
    if (S.setup === 2) s += pill(L.r1.x, L.r1.y + 80, 'GRIPPERS', gripperText(W.r1), '');
    mk('CONV', 646, 318);
    mk('R2', L.r2.x + 6, L.r2.y - 50);
    mk('SUP', 700, 24);
    dyn.innerHTML = s;
    const dp = doorPos();
    const v = {
      'PX-11': proxLive('CP-1'), 'PE-41': proxLive('CP-2'), 'PE-42': proxLive('CP-3'), 'PX-52': proxLive('CP-4'),
      'PX-64': S.setup === 2 && proxLive('CP-5'), 'ENC-43': W.belt.v > 0.5,
      'ZS-31': dp > 0.99, 'ZS-32': dp < 0.01, 'ZS-33': W.cnc.locked, 'ZS-34': W.cnc.vise === 'open',
      'ZS-35': W.cnc.vise === 'clamped', 'PS-36': !!W.cnc.part, 'PE-65': S.t - W.pe65 < 0.8,
    };
    Object.keys(leds).forEach((k) => leds[k].forEach((el) => el.classList.toggle('on', !!v[k])));
    const lt = lightState();
    lamps.red && lamps.red.classList.toggle('ly-lamp-off', !lt.r);
    lamps.amber && lamps.amber.classList.toggle('ly-lamp-off', !lt.a);
    lamps.green && lamps.green.classList.toggle('ly-lamp-off', !lt.g);
    if (lamps.blue) { lamps.blue.classList.toggle('ly-lamp-off', !W.beacon); lamps.blue.classList.toggle('blinkb', W.beacon); }
    const now = performance.now();
    Object.keys(fovs).forEach((k) => fovs[k].classList.toggle('flash', (flashes['fov:' + k] || 0) > now));
    Object.keys(rois).forEach((k) => {
      const f = flashes['roi:' + k];
      rois[k].classList.toggle('hit-ok', !!f && f.until > now && f.ok);
      rois[k].classList.toggle('hit-bad', !!f && f.until > now && !f.ok);
    });
  }
  // stack light LT-01 = the model outputs; the green lamp is also off while the simulation is paused
  function lightState() {
    return { r: outputOn('LT-01.red'), a: outputOn('LT-01.amber'), blinkA: SUP.events.length > 0, g: outputOn('LT-01.green') && S.running };
  }

  // ------------------------------------------------------------------ UI
  let tab = 'R1';
  function buildUi() {
    $('#mimic').innerHTML = D.layoutSvg({ setup: S.setup, noTitle: true, standalone: false, sim: true });
    svgRoot = $('#mimic svg');
    dyn = $('#ly-dyn', svgRoot); doorEl = $('#ly-door', svgRoot); beltEl = $('#ly-beltlines', svgRoot);
    leds = {}; $$('[data-led]', svgRoot).forEach((el) => { (leds[el.dataset.led] = leds[el.dataset.led] || []).push(el); });
    lamps = {}; $$('[data-lamp]', svgRoot).forEach((el) => { lamps[el.dataset.lamp] = el; });
    fovs = {}; $$('[data-fov]', svgRoot).forEach((el) => { fovs[el.dataset.fov] = el; });
    rois = {}; $$('rect[data-roi]', svgRoot).forEach((el) => { rois[el.dataset.roi] = el; });
    $('#btnS1').setAttribute('aria-pressed', S.setup === 1); $('#btnS2').setAttribute('aria-pressed', S.setup === 2);
    $('#btnUnder').disabled = S.setup !== 2;
    $('#underNote').textContent = S.setup === 2 ? 'The gauge measures every part; any dimension below 48.00 mm goes to the NOK chute. Two NOK parts in a row trigger a quality hold.' : 'Setup 2 only: the gauge station rejects parts with any dimension below 48.00 mm.';
    const tb = $('#cpTable tbody');
    tb.innerHTML = CPS.map((c) => `<tr data-cp="${c.id}"${c.setup > S.setup ? ' class="dis"' : ''}>
      <td><span class="cpid">${c.id}</span><span class="cpw">${esc(c.where)}</span></td>
      <td><span class="led"></span><span class="tag">${c.prox}</span><span class="flt" hidden>FAULT</span></td>
      <td><span class="tag">${c.cam}</span> <span class="cr"></span></td>
      <td><span class="res"></span><span class="ago"></span></td>
      <td><div class="inj"><button type="button" class="btn sm" data-inj="glitch"${c.setup > S.setup ? ' disabled' : ''}>Glitch</button><button type="button" class="btn sm" data-inj="fault"${c.setup > S.setup ? ' disabled' : ''}>Fault</button></div></td></tr>`).join('');
    buildChips();
    showTab(tab);
    statesDirty = true; logDirty = true; bannerKey = '';
  }
  function buildChips() {
    $('#chips').innerHTML = SLOTS.map((m) => `<button type="button" class="chip" data-m="${m}"><div class="m"><span>${M.SLOTS[m].label}</span><span class="dur"></span></div><div class="s"><span class="id"></span><span class="nm"></span></div><div class="w"></div></button>`).join('');
    $$('#chips .chip').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.m)));
  }
  const diagOpts = { standalone: false, noTitle: true, noNote: true };
  function diagSvg(t) {
    const svg = D.stateDiagram(MCH[t].key, diagOpts);
    return t === 'SUP' ? svg + '<div class="sp"></div>' + D.flowCrossCheck(diagOpts) : svg;
  }
  let lastHighlighted = '';
  function showTab(t) {
    tab = t;
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t));
    $('#diag').innerHTML = diagSvg(t);
    $('#diag').scrollTop = 0;
    lastHighlighted = '';
    highlight();
  }
  function highlight() {
    const id = MCH[tab].state;
    const key = tab + ':' + id;
    $$('#diag [data-state]').forEach((el) => el.classList.toggle('dg-active', el.dataset.state === id && el.classList.contains('dg-state')));
    if (key !== lastHighlighted && $('#chkFollow').checked) {
      const el = $(`#diag .dg-state[data-state="${id}"]`);
      const box = $('#diag');
      if (el) {
        const r = el.getBoundingClientRect(), c = box.getBoundingClientRect();
        if (r.top < c.top + 20 || r.bottom > c.bottom - 20) box.scrollTo({ top: box.scrollTop + (r.top - c.top) - c.height / 2 + r.height / 2, behavior: 'smooth' });
      }
    }
    lastHighlighted = key;
  }
  function renderChips() {
    $$('#chips .chip').forEach((b) => {
      const m = b.dataset.m, x = MCH[m];
      const k = kindOf(m, x.state);
      b.className = `chip${m === tab ? ' sel' : ''}${k ? ' k-' + k : ''}`;
      $('.id', b).textContent = x.state;
      $('.nm', b).textContent = stateName(m, x.state);
      $('.w', b).textContent = x.why ? '← ' + x.why : '';
      $('.w', b).title = x.why;
      $('.dur', b).textContent = `${fx(S.t - x.since).toFixed(1)} s`;
    });
  }
  function renderChecks() {
    CPS.forEach((c) => {
      const tr = $(`#cpTable tr[data-cp="${c.id}"]`);
      if (!tr) return;
      const active = c.setup <= S.setup;
      $('.led', tr).classList.toggle('on', active && proxLive(c.id));
      $('.flt', tr).hidden = !c.fault;
      const res = $('.res', tr), ago = $('.ago', tr), cr = $('.cr', tr);
      if (c.last) {
        res.textContent = c.last.agree ? 'AGREE' : 'MISMATCH → CAMERA';
        res.className = 'res ' + (c.last.agree ? 'ok' : 'bad');
        ago.textContent = `${Math.round(S.t - c.last.t)} s ago · ${c.count} mismatch${c.count === 1 ? '' : 'es'}`;
        cr.textContent = c.last.cam ? (c.id === 'CP-1' || c.id === 'CP-4' ? '✓ pallet' : '✓ part') : '– none';
      } else { res.textContent = active ? 'waiting' : 'Setup 2'; res.className = 'res'; ago.textContent = ''; cr.textContent = ''; }
      $$('[data-inj]', tr).forEach((b) => {
        if (b.dataset.inj === 'fault') { b.textContent = c.fault ? 'Faulty' : 'Fault'; b.classList.toggle('bad', c.fault); }
        else b.classList.toggle('warn', c.glitch);
      });
    });
    const n = SUP.events.length;
    $('#winCount').textContent = `${n} / ${RU.mismatchLimit}`;
    const bar = $('#wbar');
    bar.innerHTML = SUP.events.map((e) => `<span class="dot" style="left:${fx(100 - ((S.t - e.t) / RU.mismatchWindow) * 100)}%" title="${e.cp} ${e.tag}"></span>`).join('') +
      '<span class="ax" style="left:4px">−10 min</span><span class="ax" style="right:4px">now</span>';
  }
  function renderKpis() {
    const st = W.stats;
    const util = st.firstStart != null && S.t - st.firstStart > 1 ? `${(100 * st.runTime / (S.t - st.firstStart)).toFixed(1)}<small> %</small>` : '–';
    const idle = st.lastIdle != null ? `${st.lastIdle.toFixed(1)}<small> s</small>` : '–';
    const design = S.setup === 1 ? M.KPI.idle1 : M.KPI.idle2;
    const avg = st.idleN ? T.cncCycle + st.idleSum / st.idleN : T.cncCycle + design;
    const items = [
      ['Parts on pallet', `${W.ok}`], ['NOK parts', S.setup === 2 ? `${W.nok}` : '<small>Setup 2</small>'],
      ['CNC utilization', util], [`Last CNC idle (design ${design} s)`, idle],
      ['Parts per hour', `${(3600 / avg).toFixed(1)}`], ['Mismatches · stops', `${st.mism} · ${st.stops}`],
    ];
    $('#kpis').innerHTML = items.map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  }
  function renderLog() {
    if (!logDirty) return;
    logDirty = false;
    $('#log').innerHTML = logs.slice(0, 160).map((e) => `<li><span class="t">${fmtT(e.t)}</span><span class="c ${e.cat}">${e.cat}</span><span class="m">${esc(e.msg)}</span></li>`).join('');
  }
  function renderHeader() {
    $('#clock').textContent = `sim time ${fmtT(S.t)} · ${S.speed}×`;
    const lt = lightState();
    const st = $('#stText');
    const fault = SLOTS.find((k) => S.faults[k]);
    const op = activeHmi('load') || activeHmi('swap');
    let txt = 'Running', cls = 'ok';
    if (ev('lineStop')) { txt = 'Line stopped · verify sensors'; cls = 'bad'; }
    else if (fault) { txt = `Fault · ${M.SLOTS[fault].label}`; cls = 'bad'; }
    else if (S.vars.QH) { txt = 'Quality hold'; cls = 'warn'; }
    else if (SUP.events.length) { txt = `Sensor mismatch ${SUP.events.length} / ${RU.mismatchLimit}`; cls = 'warn'; }
    else if (op) { txt = op.hmi.title; cls = 'op'; }
    else if (!S.running) { txt = 'Paused'; cls = ''; }
    st.textContent = txt; st.className = 'st-text ' + cls;
    const [r, a, g] = $$('.stack i');
    r.classList.toggle('on', lt.r); a.classList.toggle('on', lt.a); a.classList.toggle('blink', lt.a && lt.blinkA); g.classList.toggle('on', lt.g);
    $('#btnSwapOut').disabled = !needOutput();
    $('#btnLoadIn').disabled = !W.palletIn.present || W.palletIn.busy || W.parts.filter((p) => p.loc.k === 'in').length >= 12;
  }
  function renderBanner() {
    const fault = SLOTS.find((k) => S.faults[k]);
    let key = '', title = '', text = '', cls = '', acts = [], list = [];
    if (ev('lineStop')) {
      const h = stateOf('SUP', MCH.SUP.state).hmi;
      key = `stop:${MCH.SUP.state}:${S.verify ? S.verify.i + ':' + S.verify.done : ''}:${S.inputs.verify}:${ev('CELL.stopped')}`;
      title = h.title;
      text = `${S.stopReason}. Controlled stop: the CNC finishes the part in the machine, the robots park at home and the belt starts no new transport.`;
      cls = 'bad';
      if (h.act === 'verify') {
        if (S.inputs.verify && !ev('CELL.stopped')) text += ' The check starts as soon as both robots are parked and the belt is stopped.';
        acts = [[S.inputs.verify ? 'Waiting for the cell to stop…' : 'Start sensor verification', 'verify', 'bad', S.inputs.verify]];
      }
      if (h.act === 'reset' && S.verify) {
        list = S.verify.steps.map((s, i) => [s, i < S.verify.i ? 'done' : i === S.verify.i && !S.verify.done ? 'run' : '']);
        acts = [['Reset and resume', 'resume', S.verify.done ? 'ok' : '', !S.verify.done || S.inputs.reset]];
      }
    } else if (fault) {
      key = 'fault:' + fault + ':' + S.faults[fault]; title = `Fault · ${M.SLOTS[fault].label}`; text = `${S.faults[fault]}. The sequence stopped with the robot in a safe position. Check the part, then clear the fault; the step is repeated.`; cls = 'bad';
      acts = [['Part checked · clear fault', 'clear', 'bad']];
    } else if (S.vars.QH) {
      key = 'qh'; title = 'Quality hold · 2 NOK parts in a row'; text = 'The CNC finished its part and will not start a new cycle. Check tool wear and work offsets, then release the hold.'; cls = 'warn';
      acts = [['Tool and offsets checked · release', 'qh', 'warn']];
    } else if (SUP.events.length) {
      key = 'mm:' + SUP.events.length; title = `Sensor mismatch warning · ${SUP.events.length} of ${RU.mismatchLimit} in 10 min`; text = `Disagreements: ${windowSummary()}. The camera value is used and the line keeps running. A ${RU.mismatchLimit}rd mismatch within 10 minutes stops the line.`; cls = 'warn';
    } else {
      const s = activeHmi('swap') || activeHmi('load');
      if (s) {
        key = 'hmi:' + s.hmi.act; title = s.hmi.title; text = s.hmi.text; cls = s.hmi.cls;
        acts = [[s.hmi.act === 'swap' ? 'Swap output pallet' : 'Load input pallet', s.hmi.act, '']];
      }
    }
    if (key === bannerKey) return;
    bannerKey = key;
    const bn = $('#banner');
    bn.hidden = !key;
    if (!key) return;
    bn.className = 'banner ' + cls;
    $('#bnTitle').textContent = title; $('#bnText').textContent = text;
    $('#bnList').innerHTML = list.map(([s, c]) => `<li class="${c}">${esc(s)}</li>`).join('');
    $('#bnActions').innerHTML = acts.map(([l, a, c, dis]) => `<button type="button" class="btn ${c}" data-act="${a}"${dis ? ' disabled' : ''}>${esc(l)}</button>`).join('');
  }

  // ------------------------------------------------------------------ sensor verification (technician, plant side of X4)
  function startVerify() {
    const faulty = CPS.filter((c) => c.fault).map((c) => c.prox);
    const tags = Array.from(new Set(SUP.events.map((e) => e.tag).concat(faulty)));
    const steps = [];
    if (tags.length) steps.push(`Inspect ${tags.join(', ')}: ${faulty.length ? 'dirty / misaligned lens found on ' + faulty.join(', ') + ' → cleaned and realigned' : 'lens cleaned, bracket tight'}`);
    if (S.camFault) steps.push(`${S.camFault}: cable reseated, lens cleaned, trigger test OK`);
    steps.push('Check brackets and the alignment LEDs of the through-beams');
    CPS.filter((c) => c.setup <= S.setup).forEach((c) => steps.push(`Test ${c.id} with a test part: ${c.prox} ON and ${c.cam} part · removed: both OFF`));
    steps.push('Camera calibration target: CAM-1 and CAM-2 position error < 1 mm');
    if (S.setup === 2) steps.push('Master cube 50.000 mm: LS-61 / LS-62 / LS-63 within ±0.02 mm');
    S.verify = { steps, i: 0, done: false };
    log('stop', 'Sensor verification started: all equipment stopped, technician in the cell');
    if (instant) { S.verify.i = steps.length - 1; }
    const tick = () => {
      if (!S.verify) return;
      S.verify.i++;
      if (S.verify.i >= S.verify.steps.length) {
        S.verify.done = true;
        CPS.forEach((c) => { c.fault = false; c.glitch = false; });        // the technician repaired the sensors
        S.inject.frames = { 'CAM-1': 0, 'CAM-2': 0 };
        log('stop', 'All checkpoint tests passed');
      } else setTimeout(tick, 650);
      bannerKey = '';
    };
    if (instant) tick(); else setTimeout(tick, 650);
  }

  // ------------------------------------------------------------------ controls
  function syncRun() { $('#btnRun').textContent = S.running ? 'Pause' : 'Run'; }
  function bind() {
    $('#btnS1').addEventListener('click', () => { if (S.setup !== 1) newSim(1); });
    $('#btnS2').addEventListener('click', () => { if (S.setup !== 2) newSim(2); });
    $('#btnReset').addEventListener('click', () => newSim(S.setup));
    $('#btnRun').addEventListener('click', () => { S.running = !S.running; S.step = false; syncRun(); });
    $('#btnStep').addEventListener('click', () => { S.step = true; S.running = true; syncRun(); });
    $('#selSpeed').addEventListener('change', (e) => { S.speed = +e.target.value; });
    $('#chkAuto').addEventListener('change', (e) => { S.autoOp = e.target.checked; });
    $('#chkAll').addEventListener('change', (e) => { S.logAll = e.target.checked; });
    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
    $('#cpTable').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-inj]'); if (!b) return;
      const c = CP[b.closest('tr').dataset.cp];
      if (b.dataset.inj === 'glitch') { c.glitch = true; log('info', `Test: next ${c.id} reading of ${c.prox} will be wrong (single glitch)`); }
      else { c.fault = !c.fault; log('info', c.fault ? `Test: ${c.prox} made faulty (dirty / misaligned: it misses the object)` : `Test: ${c.prox} fault removed`); }
    });
    $('#btnBadFrame').addEventListener('click', () => { S.inject.frames['CAM-1'] = 1; log('info', 'Test: the next CAM-1 image will be invalid once'); });
    $('#btnCamFail').addEventListener('click', () => { S.inject.frames['CAM-2'] = 2; log('info', 'Test: CAM-2 will deliver two invalid images in a row'); });
    $('#btnGripMiss').addEventListener('click', () => { S.inject.gripMiss = true; log('info', 'Test: Robot 1 will miss its next pick'); });
    $('#btnUnder').addEventListener('click', () => { S.inject.under++; log('info', 'Test: the next part to finish will be undersized in one dimension'); });
    $('#btnLoadIn').addEventListener('click', () => {
      if (activeHmi('load') || firstRaw() < 0) spawn(reloadInput());
      else { let n = 0; for (let i = 0; i < 12; i++) if (!partIn(i) && !W.parts.some((p) => p.loc.k === 'r1')) { addPart('raw', { k: 'in', slot: i }); n++; } if (n) log('operator', `Operator tops up the input pallet (+${n} raw parts)`); }
    });
    $('#btnSwapOut').addEventListener('click', () => { if (needOutput()) spawn(swapOutput()); });
    $('#bnActions').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'verify') { S.inputs.verify = true; log('stop', 'Technician requests the sensor verification'); }
      if (a === 'resume') { S.inputs.reset = true; }
      if (a === 'clear') { S.inputs.clearAt = S.t; log('fault', 'Operator checked the part and cleared the fault'); }
      if (a === 'qh') S.inputs.release = true;
      if (a === 'swap' && needOutput()) spawn(swapOutput());
      if (a === 'load') spawn(reloadInput());
      bannerKey = '';
    });
  }

  // ------------------------------------------------------------------ main loop
  let last = performance.now(), uiT = 0;
  function frame(now) {
    const dtReal = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (S.running) advance(dtReal * S.speed);
    renderMimic();
    uiT += dtReal;
    if (uiT > 0.12 || statesDirty) {
      uiT = 0;
      renderHeader(); renderChips(); renderChecks(); renderKpis(); renderLog(); renderBanner();
      if (statesDirty) { statesDirty = false; highlight(); }
    }
    requestAnimationFrame(frame);
  }
  bind();
  newSim(1);
  syncRun();
  requestAnimationFrame(frame);
  // hooks for the headless tests: run without drawing, read the trace and the counters
  window.CellSim = {
    get S() { return S; }, get W() { return W; }, MCH, TRACE, logs, ev,
    newSim, advance: (sec) => { const run = S.running; S.running = true; advance(sec); S.running = run; },
    set instantVerify(v) { instant = !!v; },
    press: (act) => { const b = document.createElement('button'); b.dataset.act = act; $('#bnActions').appendChild(b); b.click(); b.remove(); },
  };
})();
