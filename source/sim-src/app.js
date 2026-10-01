/* CNC cell simulator: discrete-time simulation of the four state machines described in the report.
   Each machine is a generator ("coroutine"); yield {k:'t'} waits for time, yield {k:'c'} waits for a condition. */
(() => {
  'use strict';
  const M = window.CellModel, D = window.CellDiagrams;
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
  const MACHINES = ['R1', 'CONV', 'R2', 'XCHK'];
  const LABEL = { R1: 'Robot 1 + CNC', CONV: 'Conveyor', R2: 'Robot 2 + pallet', XCHK: 'Cross-check' };
  const KIND = { W1: 'op', D4: 'op', E7: 'op', H: 'hold', F: 'fault', E5: 'ok', E6: 'stop', X1: 'ok', X2: 'warn', X3: 'stop', X4: 'check' };
  const CPS = M.CHECKPOINTS.map((c) => Object.assign({}, c));
  const CP = {}; CPS.forEach((c) => { CP[c.id] = c; });

  let S, W, SUP, procs = [];
  const MCH = {};
  const logs = [];
  let logDirty = true, statesDirty = true, bannerKey = '';

  // ------------------------------------------------------------------ world
  function newSim(setup) {
    S = {
      t: 0, speed: +$('#selSpeed').value || 10, running: true, setup, lineStop: false, stopReason: '',
      qualityHold: false, step: false, autoOp: $('#chkAuto').checked, logAll: $('#chkAll').checked,
      inject: { under: 0, gripMiss: false, frames: { 'CAM-1': 0, 'CAM-2': 0 } }, faults: {}, camFault: null, verify: null,
    };
    W = {
      parts: [], nextId: 1, palletIn: { present: true, busy: false }, palletOut: { present: true, busy: false },
      cnc: { state: 'EMPTY', part: null, locked: false, startCmd: false, vise: 'open', runStart: 0, doneAt: null },
      door: { pos: 0, anim: null }, belt: { cmd: false, v: 0, off: 0 },
      r1: robot(L.r1, true), r2: robot(L.r2, false),
      flags: { partPlaced: false, pickAllowed: false, partPicked: false },
      outCount: 0, ok: 0, nok: 0, consecNok: 0, beacon: false, pe65: -9,
      stats: { runTime: 0, firstStart: null, lastIdle: null, idleSum: 0, idleN: 0, cycles: 0, mism: 0, stops: 0 },
    };
    CPS.forEach((c) => { c.fault = false; c.glitch = false; c.last = null; c.count = 0; });
    for (let i = 3; i < 12; i++) addPart('raw', { k: 'in', slot: i });
    for (let i = 0; i < 8; i++) addPart('fin', { k: 'out', slot: i });
    W.outCount = 8;
    SUP = { events: [] };
    MACHINES.forEach((k) => { MCH[k] = { state: '', since: 0, why: '', prev: '' }; });
    setState('XCHK', 'X1', 'all checkpoints agree');
    procs = [];
    spawn(setup === 1 ? r1S1() : r1S2());
    spawn(cncProc());
    spawn(convProc());
    spawn(setup === 1 ? r2S1() : r2S2());
    spawn(operatorProc());
    logs.length = 0; logDirty = true;
    log('info', `Setup ${setup} started · input pallet 9 raw parts · output pallet 8 of 12 · CNC empty`);
    buildUi();
  }
  function robot(base, dual) { return { base, tool: base.home.slice(), anim: null, fing: 'open', hold: { A: null, B: null, S: null }, clearCnc: true, clearConv: true, dual, active: 'A', rot: null }; }
  // Dual gripper (Setup 2): the wrist turns 180° so that gripper `to` faces the work.
  // startTurn lets the robot keep moving while it turns; turnWrist waits for the turn.
  function startTurn(r, to, dur) { if (!r.dual || S.setup !== 2 || r.active === to || r.rot) return; r.rot = { t0: S.t, t1: S.t + dur, to }; }
  function* turnWrist(r, to, dur) { startTurn(r, to, dur); if (r.rot) yield* wait(r.rot.t1 - S.t); }
  function addPart(st, loc) { const p = { id: W.nextId++, st, loc, dims: [50, 50, 50], meas: null, nok: false }; W.parts.push(p); return p; }
  const partIn = (slot) => W.parts.find((p) => p.loc.k === 'in' && p.loc.slot === slot);
  function firstRaw() { for (let i = 0; i < 12; i++) if (partIn(i)) return i; return -1; }
  function firstFreeOut() { for (let i = 0; i < 12; i++) if (!W.parts.some((p) => p.loc.k === 'out' && p.loc.slot === i)) return i; return -1; }

  // ------------------------------------------------------------------ scheduler
  function spawn(gen) { procs.push({ it: gen, wait: null, done: false }); }
  function runProcs() {
    for (const p of procs) {
      let guard = 0;
      while (!p.done && guard++ < 60) {
        const w = p.wait;
        if (w) {
          if (w.k === 't' && S.t < w.until) break;
          if (w.k === 'c' && !w.fn()) break;
          p.wait = null;
        }
        const r = p.it.next();
        if (r.done) { p.done = true; break; }
        p.wait = r.value || null;
      }
    }
    procs = procs.filter((p) => !p.done);
  }
  function* wait(s) { if (s > 0) yield { k: 't', until: S.t + s }; }
  function* until(fn) { if (!fn()) yield { k: 'c', fn }; }

  // ------------------------------------------------------------------ states
  function setState(m, id, why) {
    const x = MCH[m];
    if (x.state === id && x.why === (why || '')) return;
    if (x.state !== id) { x.prev = x.state; x.since = S.t; }
    x.state = id; x.why = why || '';
    statesDirty = true;
    if (S.step && m !== 'XCHK') { S.step = false; S.running = false; syncRun(); }
  }
  function* hp(m) {
    if (!S.lineStop) return;
    const resume = MCH[m].state;
    setState(m, 'H', 'LINE STOP from the cross-check supervisor');
    const r = m === 'R1' ? W.r1 : m === 'R2' ? W.r2 : null;
    if (r) { r.clearConv = true; yield* moveTo(r, r.base.home, 1.5); }
    yield* until(() => !S.lineStop);
    setState(m, resume, 'reset: resume at the same step');
  }
  function* enter(m, id, why) { yield* hp(m); setState(m, id, why); }
  function* fault(m, msg) {
    const resume = MCH[m].state;
    S.faults[m] = msg;
    setState(m, 'F', msg);
    log('fault', `${msg} → FAULT (no automatic robot retry)`);
    yield* until(() => !S.faults[m]);
    setState(m, resume, 'fault cleared by the operator · the step is repeated');
  }

  // ------------------------------------------------------------------ checkpoints
  const truth = {
    'CP-1': () => W.palletIn.present,
    'CP-2': () => W.parts.some((p) => p.loc.k === 'conv' && p.loc.x < L.convEntry[0] + 30),
    'CP-3': () => W.parts.some((p) => p.loc.k === 'conv' && p.loc.x > P.stopX - 12),
    'CP-4': () => W.palletOut.present,
    'CP-5': () => W.parts.some((p) => p.loc.k === 'gauge'),
  };
  const proxLive = (id) => (CP[id].fault ? false : truth[id]());
  const camWord = (id, v) => ((id === 'CP-1' || id === 'CP-4') ? (v ? 'a pallet' : 'no pallet') : (v ? 'a part' : 'no part'));
  function* check(id, o) {
    o = o || {};
    const cp = CP[id];
    if (!o.quick) yield* wait(T.check);
    flashCam(cp.cam);
    if (S.inject.frames[cp.cam] > 0) {
      S.inject.frames[cp.cam]--;
      log('check', `${cp.cam} image not valid at ${id} (calibration marks not found) → re-trigger once`);
      yield* wait(0.3);
      flashCam(cp.cam);
      if (S.inject.frames[cp.cam] > 0) {
        S.inject.frames[cp.cam]--;
        cameraFault(cp);
        if (o.m) {
          const resume = MCH[o.m].state;
          setState(o.m, 'H', `${cp.cam} fault: line stop`);
          yield* until(() => !S.lineStop);
          setState(o.m, resume, 'camera repaired · resume');
        } else yield* until(() => !S.lineStop);
      } else log('check', `${cp.cam} re-trigger OK at ${id}`);
    }
    const t = truth[id]();
    let prox = cp.fault ? false : t;
    if (cp.glitch) { prox = !prox; cp.glitch = false; }
    const cam = t;
    cp.last = { t: S.t, prox, cam, agree: prox === cam };
    markRoi(cp.roi, prox === cam);
    if (prox !== cam) mismatch(cp, prox, cam);
    else if (S.logAll) log('check', `${id} agree: ${cp.prox} ${prox ? 'ON' : 'OFF'}, ${cp.cam} sees ${camWord(id, cam)}`);
    return cam;
  }
  function mismatch(cp, prox, cam) {
    cp.count++; W.stats.mism++;
    SUP.events.push({ t: S.t, cp: cp.id, tag: cp.prox });
    pruneWindow();
    const n = SUP.events.length;
    log('mismatch', `${cp.id} ${cp.where}: ${cp.prox} = ${prox ? 'ON' : 'OFF'} but ${cp.cam} sees ${camWord(cp.id, cam)} → camera value used (${n} of 3 in 10 min)`);
    if (n >= RU.mismatchLimit) lineStop(`3 camera / proximity mismatches within 10 min (${windowSummary()})`);
    else if (!S.lineStop) setState('XCHK', 'X2', `mismatch at ${cp.id} · camera value used`);
  }
  function windowSummary() {
    const c = {};
    SUP.events.forEach((e) => { c[e.tag] = (c[e.tag] || 0) + 1; });
    return Object.keys(c).map((k) => `${k} ×${c[k]}`).join(', ');
  }
  function pruneWindow() {
    const before = SUP.events.length;
    SUP.events = SUP.events.filter((e) => S.t - e.t <= RU.mismatchWindow);
    if (before && !SUP.events.length && MCH.XCHK.state === 'X2') setState('XCHK', 'X1', 'no mismatch for 10 min (window empty)');
  }
  function lineStop(reason) {
    if (S.lineStop) return;
    S.lineStop = true; S.stopReason = reason; W.stats.stops++;
    setState('XCHK', 'X3', reason);
    log('stop', `LINE STOP: ${reason}. Controlled stop: the CNC finishes its cycle, robots finish the step and park, no new transport.`);
  }
  function cameraFault(cp) { S.camFault = cp.cam; lineStop(`${cp.cam} gave two invalid images at ${cp.id} (camera fault)`); }

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
  function* openDoor(r, approach) {
    yield* moveTo(r, L.handleClosed, approach + 0.5);
    r.fing = 'handle';
    W.door.anim = { from: 0, to: 1, t0: S.t, t1: S.t + 3.0 };
    yield* moveTo(r, L.handleOpen, 3.0);
    W.door.pos = 1; W.door.anim = null; r.fing = 'open';
    yield* wait(0.5);
  }
  function* closeDoor(r) {
    yield* moveTo(r, L.handleOpen, 0.5);
    r.fing = 'handle';
    W.door.anim = { from: 1, to: 0, t0: S.t, t1: S.t + 3.0 };
    yield* moveTo(r, L.handleClosed, 3.0);
    W.door.pos = 0; W.door.anim = null; r.fing = 'open';
    yield* wait(0.5);
    yield* wait(T.lock);
    W.cnc.locked = true;
  }
  const cncReady = () => (W.cnc.state === 'DONE' && !W.cnc.locked) || W.cnc.state === 'EMPTY';

  // ------------------------------------------------------------------ Robot 1 building blocks
  function* pickRaw(r, g, stateId) {
    const m = 'R1', tag = g === 'S' ? 'GR-21' : 'GR-21' + g;
    for (;;) {
      const present = yield* check('CP-1', { m });
      const slot = firstRaw();
      if (!present || slot < 0) {
        yield* enter(m, 'W1', present ? 'CAM-1: no parts left on the input pallet' : 'CP-1: no input pallet');
        log('pallet', 'Input pallet empty → HMI: "Load input pallet" · amber light');
        yield* moveTo(r, r.base.home, 1.5);
        yield* until(() => W.palletIn.present && !W.palletIn.busy && firstRaw() >= 0);
        yield* enter(m, stateId, 'pallet loaded · CP-1 OK');
        continue;
      }
      yield* moveTo(r, D.slotPos('in', slot), T.convToPallet);
      yield* wait(0.7);
      r.fing = 'grip';
      yield* wait(T.grip);
      if (S.inject.gripMiss) {
        S.inject.gripMiss = false;
        r.fing = 'closed';
        yield* wait(0.3);
        yield* fault(m, `${tag} grip not confirmed at the input pallet (fingers closed on nothing)`);
        r.fing = 'open';
        continue;
      }
      const p = partIn(slot);
      p.loc = { k: 'r1', g }; r.hold[g] = p;
      yield* wait(0.8);
      return;
    }
  }
  function* unload(r) {
    yield* moveTo(r, P.doorway, 1.0); r.clearCnc = false;
    yield* moveTo(r, P.fixture, 1.0);
    r.fing = 'grip'; yield* wait(T.grip);
    W.cnc.vise = 'open'; yield* wait(T.viseOpen);
    const p = W.cnc.part; W.cnc.part = null; p.loc = { k: 'r1', g: 'S' }; r.hold.S = p;
    yield* wait(T.lift);
    yield* moveTo(r, P.doorway, 1.0); yield* moveTo(r, P.outside, 1.0); r.clearCnc = true;
  }
  function* load(r) {
    yield* moveTo(r, P.outside, T.palletToDoor);
    yield* moveTo(r, P.doorway, 1.0); r.clearCnc = false;
    yield* moveTo(r, P.fixture, 1.0);
    const p = r.hold.S; r.hold.S = null; p.loc = { k: 'cnc' }; W.cnc.part = p;
    yield* wait(T.placeInVise);
    W.cnc.vise = 'clamped'; yield* wait(T.viseClamp);
    yield* wait(T.seatCheck);
    r.fing = 'open'; yield* wait(T.release);
    yield* moveTo(r, P.doorway, 1.0); yield* moveTo(r, P.outside, 1.0); r.clearCnc = true;
  }
  function* exchange(r, hasPart) {
    yield* moveTo(r, P.doorway, 1.0); r.clearCnc = false;
    yield* moveTo(r, P.fixture, 1.0);
    if (hasPart) {
      r.fing = 'grip'; yield* wait(T.grip);
      W.cnc.vise = 'open'; yield* wait(T.viseOpen);
      const f = W.cnc.part; W.cnc.part = null; f.loc = { k: 'r1', g: 'B' }; r.hold.B = f;
      yield* wait(T.lift);
    } else W.cnc.vise = 'open';
    yield* turnWrist(r, 'A', T.swapGripper);   // B (finished part) turns away, A (raw part) faces the vise
    r.fing = 'grip';
    const p = r.hold.A; r.hold.A = null; p.loc = { k: 'cnc' }; W.cnc.part = p;
    yield* wait(T.placeInVise);
    W.cnc.vise = 'clamped'; yield* wait(T.viseClamp);
    yield* wait(T.seatCheck);
    r.fing = 'open'; yield* wait(T.release);
    yield* moveTo(r, P.doorway, 1.0); yield* moveTo(r, P.outside, 1.0); r.clearCnc = true;
  }
  function* placeOnConveyor(r, g) {
    const m = 'R1';
    yield* moveTo(r, P.convAbove, T.doorToConv);
    yield* until(() => W.belt.v === 0 && !W.belt.cmd && !truth['CP-2']());
    yield* check('CP-2', { quick: true, m });
    r.clearConv = false;
    yield* moveTo(r, P.convPlace, 0.7);
    const p = r.hold[g]; r.hold[g] = null; p.loc = { k: 'conv', x: P.convPlace[0] }; r.fing = 'open';
    yield* wait(T.release);
    yield* moveTo(r, P.convAbove, 0.8);
    r.clearConv = true;
    yield* check('CP-2', { m });
    W.flags.partPlaced = true;
  }
  function* cycleStart() {
    if (S.qualityHold) {
      setState('R1', MCH.R1.state, 'cycle start held: QUALITY HOLD (2 NOK parts in a row)');
      yield* until(() => !S.qualityHold);
      setState('R1', MCH.R1.state, 'quality hold released · ZS-32 closed · ZS-33 locked');
    }
    yield* wait(T.cycleStart);
    W.cnc.startCmd = true;
    yield* until(() => W.cnc.state === 'RUN');
  }

  // ------------------------------------------------------------------ Robot 1 programs
  function* r1S1() {
    const r = W.r1, m = 'R1';
    yield* enter(m, 'A0', 'Auto mode ON');
    yield* moveTo(r, r.base.home, 1.0);
    yield* wait(0.5);
    yield* enter(m, 'A1', 'Robot home · CNC ready · ZS-32 door closed');
    for (;;) {
      yield* until(cncReady);
      const hasPart = W.cnc.state === 'DONE';
      yield* enter(m, 'A2', hasPart ? 'CNC cycle complete (M30) · spindle stopped · ZS-33 unlocked' : 'CNC empty and ready (first cycle)');
      yield* openDoor(r, T.homeToDoor);
      if (hasPart) {
        yield* enter(m, 'A3', 'ZS-31 door open = ON · ZS-32 = OFF');
        yield* unload(r);
        yield* enter(m, 'A4', 'GR-21 grip OK · ZS-34 vise open · PS-36 OFF · R1 clear of CNC');
        yield* placeOnConveyor(r, 'S');
        yield* enter(m, 'A5', 'CP-2 part present (PE-41 + CAM-1) · R1 clear of conveyor');
      } else {
        yield* enter(m, 'A5', 'CNC empty (first cycle) · ZS-31 door open');
      }
      yield* pickRaw(r, 'S', 'A5');
      yield* enter(m, 'A6', 'GR-21 grip OK · CAM-1 slot now empty');
      yield* load(r);
      yield* enter(m, 'A7', 'ZS-35 clamped · PS-36 part seated · gripper open · R1 clear of CNC');
      yield* closeDoor(r);
      yield* enter(m, 'A8', 'ZS-32 door closed = ON · ZS-33 locked');
      yield* cycleStart();
      yield* enter(m, 'A1', 'CNC in cycle');
      yield* moveTo(r, r.base.home, T.doorToHome);
    }
  }
  function* r1S2() {
    const r = W.r1, m = 'R1';
    yield* enter(m, 'B0', 'Auto mode ON');
    yield* moveTo(r, r.base.home, 1.0);
    yield* wait(0.5);
    let why = 'Robot home · CNC ready · door closed';
    for (;;) {
      yield* enter(m, 'B1', why);
      startTurn(r, 'A', 1.2);                    // turn gripper A to the front while moving
      yield* pickRaw(r, 'A', 'B1');
      yield* enter(m, 'B2', 'GR-21A grip OK · CAM-1 slot now empty');
      startTurn(r, 'B', 1.2);                    // empty gripper B will open the door
      yield* moveTo(r, r.base.doorReady, T.palletToDoor);
      yield* until(cncReady);
      const hasPart = W.cnc.state === 'DONE';
      yield* enter(m, 'B3', hasPart ? 'CNC cycle complete · spindle stopped · ZS-33 unlocked' : 'CNC empty and ready (first cycle)');
      yield* openDoor(r, 0);
      yield* enter(m, 'B4', 'ZS-31 door open = ON · ZS-32 = OFF');
      yield* exchange(r, hasPart);
      yield* enter(m, 'B5', `${hasPart ? 'GR-21B grip OK · ' : ''}ZS-35 clamped · PS-36 seated · R1 clear of CNC`);
      yield* closeDoor(r);
      yield* enter(m, 'B6', 'ZS-32 door closed = ON · ZS-33 locked');
      yield* cycleStart();
      if (r.hold.B) {
        yield* enter(m, 'B7', 'CNC in cycle · gripper B holds a finished part');
        startTurn(r, 'B', 1.2);                  // finished part in B faces the belt
        yield* placeOnConveyor(r, 'B');
        why = 'CP-2 part present (PE-41 + CAM-1) · R1 clear';
      } else why = 'CNC in cycle · first cycle: gripper B is empty';
    }
  }

  // ------------------------------------------------------------------ CNC
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

  // ------------------------------------------------------------------ Conveyor
  function* convProc() {
    const m = 'CONV';
    yield* enter(m, 'C1', 'Start-up: CP-2 and CP-3 clear');
    for (;;) {
      yield* until(() => W.flags.partPlaced);
      W.flags.partPlaced = false;
      yield* enter(m, 'C2', 'Robot 1 "part placed" · CP-2 part present (PE-41 + CAM-1)');
      for (;;) {
        yield* until(() => W.r1.clearConv && W.r2.clearConv && !truth['CP-3']() && !S.lineStop);
        const busy = yield* check('CP-3', { quick: true, m });
        if (!busy) break;
      }
      yield* enter(m, 'C3', 'R1 and R2 clear of conveyor · CP-3 exit clear');
      W.belt.cmd = true;
      yield* until(() => truth['CP-3']());
      setState(m, 'C4', proxLive('CP-3') ? 'PE-42 ON: part at the end stop' : 'CAM-2 sees the part at the end stop (PE-42 did not switch)');
      W.belt.cmd = false;
      yield* until(() => W.belt.v === 0);
      yield* wait(T.zeroSpeed);
      setState(m, 'C5', 'ENC-43 zero speed for 0.2 s');
      yield* check('CP-3', { m });
      W.flags.pickAllowed = true;
      yield* until(() => W.flags.partPicked);
      W.flags.partPicked = false; W.flags.pickAllowed = false;
      yield* enter(m, 'C1', 'Robot 2 picked: GR-51 grip OK · CP-3 exit clear');
    }
  }

  // ------------------------------------------------------------------ Robot 2
  function* pickFromConveyor(r, m) {
    r.clearConv = false;
    yield* moveTo(r, P.convPick, T.r2ToExit);
    r.fing = 'grip';
    yield* wait(T.r2Pick);
    const p = W.parts.find((q) => q.loc.k === 'conv' && q.loc.x > P.stopX - 12);
    if (p) { p.loc = { k: 'r2', g: 'S' }; r.hold.S = p; }
    yield* moveTo(r, P.convOff, 0.6);
    r.clearConv = true;
    yield* check('CP-3', { quick: true, m });
    W.flags.partPicked = true;
  }
  function* placeOnPallet(r, m) {
    yield* check('CP-4', { m });
    const slot = firstFreeOut();
    yield* moveTo(r, D.slotPos('out', slot), T.r2ToPallet);
    const p = r.hold.S; r.hold.S = null; p.loc = { k: 'out', slot }; r.fing = 'open';
    yield* wait(T.r2Place);
    W.outCount = W.parts.filter((q) => q.loc.k === 'out').length;
    W.ok++;
    if (S.logAll) log('check', `CAM-2: slot ${slot + 1} occupied · output pallet ${W.outCount} of 12`);
    yield* moveTo(r, r.base.home, T.r2Home);
  }
  function* palletFull(m, id, why) {
    yield* enter(m, id, why);
    W.beacon = true;
    log('pallet', 'Output pallet full (12 of 12) → LT-53 blue light ON · HMI: "Pallet ready for pickup"');
    yield* until(() => !W.palletOut.present);
    yield* until(() => W.palletOut.present && !W.palletOut.busy);
    yield* check('CP-4', { m });
    W.outCount = 0; W.beacon = false;
    log('pallet', 'New empty pallet (PX-52 OFF → ON, CAM-2 sees it empty) → count = 0 · LT-53 OFF');
  }
  function* r2S1() {
    const r = W.r2, m = 'R2';
    yield* enter(m, 'D0', 'Auto mode ON');
    yield* moveTo(r, r.base.home, 1.0);
    yield* check('CP-4', { m });
    let why = 'Robot home · pallet present · free slots';
    for (;;) {
      yield* enter(m, 'D1', why);
      yield* until(() => W.flags.pickAllowed && MCH.CONV.state === 'C5');
      yield* enter(m, 'D2', 'Conveyor in C5: "pick allowed" + pick pose (CAM-2)');
      yield* pickFromConveyor(r, m);
      yield* enter(m, 'D3', 'GR-51 grip OK · CP-3 exit clear · R2 clear of conveyor');
      yield* placeOnPallet(r, m);
      if (W.outCount >= 12) { yield* palletFull(m, 'D4', 'count = 12 and CAM-2: all slots full'); why = 'pallet swapped → count = 0 · LT-53 OFF'; }
      else why = `CAM-2: slot occupied · count ${W.outCount} < 12`;
    }
  }
  function* r2S2() {
    const r = W.r2, m = 'R2';
    yield* enter(m, 'E0', 'Auto mode ON');
    yield* moveTo(r, r.base.home, 1.0);
    yield* check('CP-4', { m });
    yield* check('CP-5', { quick: true, m });
    log('measure', 'Start-up master cube 50.000 mm: LS-61 50.001 · LS-62 49.999 · LS-63 50.000 mm → gauge OK');
    let why = 'Robot home · pallet ready · gauge verified';
    for (;;) {
      yield* enter(m, 'E1', why);
      yield* until(() => W.flags.pickAllowed && MCH.CONV.state === 'C5');
      yield* enter(m, 'E2', 'Conveyor in C5: "pick allowed" + pick pose (CAM-2)');
      yield* pickFromConveyor(r, m);
      yield* enter(m, 'E3', 'GR-51 grip OK · CP-3 exit clear · R2 clear');
      yield* moveTo(r, P.nest, T.r2ToGauge);
      yield* wait(T.r2LoadGauge * 0.6);
      const p = r.hold.S; r.hold.S = null; p.loc = { k: 'gauge' }; r.fing = 'open';
      yield* wait(T.r2LoadGauge * 0.4);
      yield* moveTo(r, P.nestOut, 0.5);
      yield* check('CP-5', { m });
      yield* enter(m, 'E4', 'CP-5 part in nest (PX-64 + CAM-2) · R2 clear of the laser paths');
      yield* wait(T.measure);
      const meas = p.dims.map((v) => v + (Math.random() - 0.5) * 0.004);
      p.meas = meas;
      const okPart = meas.every((v) => v >= RU.minSize);
      log('measure', `Part #${p.id}: L ${meas[0].toFixed(3)} · W ${meas[1].toFixed(3)} · H ${meas[2].toFixed(3)} mm → ${okPart ? 'OK, all ≥ 48.00' : 'NOK, undersized'}`);
      yield* moveTo(r, P.nest, 0.5);
      r.fing = 'grip'; yield* wait(0.5);
      p.loc = { k: 'r2', g: 'S' }; r.hold.S = p;
      if (okPart) {
        W.consecNok = 0;
        yield* enter(m, 'E5', 'Yes: L, W and H ≥ 48.00 mm (OK part)');
        yield* placeOnPallet(r, m);
        if (W.outCount >= 12) { yield* palletFull(m, 'E7', 'count = 12 · CAM-2: all slots full'); why = 'pallet swapped · count = 0 · LT-53 OFF'; }
        else why = `CAM-2: slot occupied · count ${W.outCount} < 12`;
      } else {
        p.nok = true;
        yield* enter(m, 'E6', 'No: undersized part (a dimension < 48.00 mm)');
        yield* moveTo(r, P.nokDrop, T.r2ToNok);
        r.hold.S = null; p.loc = { k: 'nok', i: W.nok }; r.fing = 'open';
        W.pe65 = S.t; W.nok++; W.consecNok++;
        yield* wait(T.r2Drop);
        log('quality', `NOK part #${p.id} dropped in the locked chute (PE-65 confirmed) · NOK total ${W.nok}`);
        if (W.consecNok >= RU.consecutiveNokHold && !S.qualityHold) {
          S.qualityHold = true;
          log('quality', 'QUALITY HOLD: 2 NOK parts in a row → the CNC finishes its part and does not start a new cycle until the tool and offsets are checked');
        }
        yield* moveTo(r, r.base.home, T.r2Home);
        why = 'PE-65 part dropped · NOK + 1';
      }
    }
  }

  // ------------------------------------------------------------------ operator
  const needInput = () => W.palletIn.present && !W.palletIn.busy && firstRaw() < 0;
  const needOutput = () => W.beacon && W.palletOut.present && !W.palletOut.busy;
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
    b.v = b.cmd ? Math.min(VMAX, b.v + ACC * h) : Math.max(0, b.v - ACC * h);
    if (b.v > 0) {
      b.off = (b.off + b.v * h) % 24;
      for (const p of W.parts) if (p.loc.k === 'conv') p.loc.x = Math.min(P.stopX, p.loc.x + b.v * h);
    }
    if (W.cnc.state === 'RUN') W.stats.runTime += h;
    for (const r of [W.r1, W.r2]) if (r.rot && S.t >= r.rot.t1) { r.active = r.rot.to; r.rot = null; }
    pruneWindow();
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
  function stateName(m, id) {
    const tab = { R1: S.setup === 1 ? 'R1S1' : 'R1S2', CONV: 'CONV', R2: S.setup === 1 ? 'R2S1' : 'R2S2', XCHK: 'XCHK' }[m];
    return (M.STATES[tab] && M.STATES[tab][id]) || id;
  }
  function cncLabel() {
    const c = W.cnc, p = c.part;
    if (c.state === 'RUN') return ['CNC', `MACHINING ${fmtMS(T.cncCycle - (S.t - c.runStart))}`, 'ok'];
    if (p && p.st === 'fin') return ['CNC', c.locked ? 'CYCLE COMPLETE' : 'DONE · DOOR UNLOCKED', 'warn'];
    if (p) return ['CNC', c.locked ? 'LOADED · WAIT START' : doorPos() > 0.01 ? 'LOADED · DOOR OPEN' : 'LOADED', ''];
    return ['CNC', doorPos() > 0.01 ? 'EMPTY · DOOR OPEN' : 'EMPTY · READY', ''];
  }
  function renderMimic() {
    // door + belt
    doorEl.setAttribute('transform', `translate(0 ${fx2(doorPos() * L.door.travel)})`);
    beltEl.setAttribute('transform', `translate(${fx2(W.belt.off)} 0)`);
    // dynamic layer
    let s = '';
    for (const p of W.parts) { if (p.loc.k === 'r1' || p.loc.k === 'r2') continue; const [x, y] = partXY(p); s += D.partSvg(x, y, partCls(p)); }
    s += robotSvg(W.r1, L.elbow.r1, 'ROBOT 1');
    s += robotSvg(W.r2, L.elbow.r2, 'ROBOT 2');
    const c = cncLabel();
    s += pill(120, 200, c[0], c[1], c[2]);
    const mk = (m, x, y) => { const id = MCH[m].state; s += pill(x, y, id, stateName(m, id), KIND[id] || ''); };
    mk('R1', L.r1.x, L.r1.y + 56);
    if (S.setup === 2) s += pill(L.r1.x, L.r1.y + 80, 'GRIPPERS', gripperText(W.r1), '');
    mk('CONV', 646, 318);
    mk('R2', L.r2.x + 6, L.r2.y - 50);
    mk('XCHK', 700, 24);
    dyn.innerHTML = s;
    // sensors
    const dp = doorPos();
    const v = {
      'PX-11': proxLive('CP-1'), 'PE-41': proxLive('CP-2'), 'PE-42': proxLive('CP-3'), 'PX-52': proxLive('CP-4'),
      'PX-64': S.setup === 2 && proxLive('CP-5'), 'ENC-43': W.belt.v > 0.5,
      'ZS-31': dp > 0.99, 'ZS-32': dp < 0.01, 'ZS-33': W.cnc.locked, 'ZS-34': W.cnc.vise === 'open',
      'ZS-35': W.cnc.vise === 'clamped', 'PS-36': !!W.cnc.part, 'PE-65': S.t - W.pe65 < 0.8,
    };
    Object.keys(leds).forEach((k) => leds[k].forEach((el) => el.classList.toggle('on', !!v[k])));
    // lamps
    const lt = lightState();
    lamps.red && lamps.red.classList.toggle('ly-lamp-off', !lt.r);
    lamps.amber && lamps.amber.classList.toggle('ly-lamp-off', !lt.a);
    lamps.green && lamps.green.classList.toggle('ly-lamp-off', !lt.g);
    if (lamps.blue) { lamps.blue.classList.toggle('ly-lamp-off', !W.beacon); lamps.blue.classList.toggle('blinkb', W.beacon); }
    // camera flashes
    const now = performance.now();
    Object.keys(fovs).forEach((k) => fovs[k].classList.toggle('flash', (flashes['fov:' + k] || 0) > now));
    Object.keys(rois).forEach((k) => {
      const f = flashes['roi:' + k];
      rois[k].classList.toggle('hit-ok', !!f && f.until > now && f.ok);
      rois[k].classList.toggle('hit-bad', !!f && f.until > now && !f.ok);
    });
  }
  function lightState() {
    const fault = Object.keys(S.faults).some((k) => S.faults[k]);
    const r = S.lineStop || fault;
    const warn = !r && (SUP.events.length > 0 || S.qualityHold || MCH.R1.state === 'W1');
    return { r, a: warn, blinkA: SUP.events.length > 0, g: !r && !warn && S.running };
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
    // checkpoint table
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
    $('#chips').innerHTML = MACHINES.map((m) => `<button type="button" class="chip" data-m="${m}"><div class="m"><span>${LABEL[m]}</span><span class="dur"></span></div><div class="s"><span class="id"></span><span class="nm"></span></div><div class="w"></div></button>`).join('');
    $$('#chips .chip').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.m)));
  }
  const diagOpts = { standalone: false, noTitle: true, noNote: true };
  function diagSvg(t) {
    if (t === 'R1') return (S.setup === 1 ? D.smRobot1S1 : D.smRobot1S2)(diagOpts);
    if (t === 'CONV') return D.smConveyor(diagOpts);
    if (t === 'R2') return (S.setup === 1 ? D.smRobot2S1 : D.smRobot2S2)(diagOpts);
    return D.smSupervisor(diagOpts) + '<div class="sp"></div>' + D.flowCrossCheck(diagOpts);
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
      const k = KIND[x.state] || '';
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
    $('#winCount').textContent = `${n} / 3`;
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
    const fault = Object.keys(S.faults).find((k) => S.faults[k]);
    let txt = 'Running', cls = 'ok';
    if (S.lineStop) { txt = 'Line stopped · verify sensors'; cls = 'bad'; }
    else if (fault) { txt = `Fault · ${LABEL[fault]}`; cls = 'bad'; }
    else if (S.qualityHold) { txt = 'Quality hold'; cls = 'warn'; }
    else if (SUP.events.length) { txt = `Sensor mismatch ${SUP.events.length} / 3`; cls = 'warn'; }
    else if (MCH.R1.state === 'W1') { txt = 'Waiting · input pallet empty'; cls = 'op'; }
    else if (W.beacon) { txt = 'Output pallet full'; cls = 'op'; }
    else if (!S.running) { txt = 'Paused'; cls = ''; }
    st.textContent = txt; st.className = 'st-text ' + cls;
    const [r, a, g] = $$('.stack i');
    r.classList.toggle('on', lt.r); a.classList.toggle('on', lt.a); a.classList.toggle('blink', lt.a && lt.blinkA); g.classList.toggle('on', lt.g);
    $('#btnSwapOut').disabled = !needOutput();
    $('#btnLoadIn').disabled = !W.palletIn.present || W.palletIn.busy || W.parts.filter((p) => p.loc.k === 'in').length >= 12;
  }
  function renderBanner() {
    const fault = Object.keys(S.faults).find((k) => S.faults[k]);
    let key = '', title = '', text = '', cls = '', acts = [], list = [];
    if (S.lineStop) {
      const x = MCH.XCHK.state;
      key = `stop:${x}:${S.verify ? S.verify.i + ':' + S.verify.done : ''}`;
      title = x === 'X4' ? 'Sensor verification in progress' : 'Line stopped · sensor verification required';
      text = `${S.stopReason}. Controlled stop: the CNC finishes the part in the machine, the robots park at home and the belt starts no new transport.`;
      cls = 'bad';
      if (x === 'X3') acts = [['Start sensor verification', 'verify', 'bad']];
      if (x === 'X4' && S.verify) {
        list = S.verify.steps.map((s, i) => [s, i < S.verify.i ? 'done' : i === S.verify.i && !S.verify.done ? 'run' : '']);
        acts = [['Reset and resume', 'resume', S.verify.done ? 'ok' : '', !S.verify.done]];
      }
    } else if (fault) {
      key = 'fault:' + fault; title = `Fault · ${LABEL[fault]}`; text = `${S.faults[fault]}. The sequence stopped with the robot in a safe position. Check the part, then clear the fault; the step is repeated.`; cls = 'bad';
      acts = [['Part checked · clear fault', 'clear', 'bad']];
    } else if (S.qualityHold) {
      key = 'qh'; title = 'Quality hold · 2 NOK parts in a row'; text = 'The CNC finished its part and will not start a new cycle. Check tool wear and work offsets, then release the hold.'; cls = 'warn';
      acts = [['Tool and offsets checked · release', 'qh', 'warn']];
    } else if (SUP.events.length) {
      key = 'mm:' + SUP.events.length; title = `Sensor mismatch warning · ${SUP.events.length} of 3 in 10 min`; text = `Disagreements: ${windowSummary()}. The camera value is used and the line keeps running. A 3rd mismatch within 10 minutes stops the line.`; cls = 'warn';
    } else if (W.beacon) {
      key = 'full'; title = 'Output pallet full · ready for pickup'; text = 'LT-53 blue light ON. Robot 2 waits until PX-52 sees the pallet removed and a new empty pallet is placed.'; cls = 'op';
      acts = [['Swap output pallet', 'swap', '']];
    } else if (MCH.R1.state === 'W1') {
      key = 'empty'; title = 'Input pallet empty'; text = 'CAM-1 finds no raw parts. Robot 1 waits at home; load a new pallet.'; cls = 'op';
      acts = [['Load input pallet', 'load', '']];
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

  // ------------------------------------------------------------------ verification
  function startVerify() {
    if (MCH.XCHK.state !== 'X3') return;
    setState('XCHK', 'X4', 'all equipment stopped · technician starts the check');
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
    log('stop', 'Sensor verification started (X4)');
    const tick = () => {
      if (!S.verify) return;
      S.verify.i++;
      if (S.verify.i >= S.verify.steps.length) { S.verify.done = true; log('stop', 'All checkpoint tests passed'); }
      else setTimeout(tick, 650);
      bannerKey = '';
    };
    setTimeout(tick, 650);
  }
  function resetResume() {
    if (!S.verify || !S.verify.done) return;
    CPS.forEach((c) => { c.fault = false; c.glitch = false; });
    S.camFault = null; S.inject.frames = { 'CAM-1': 0, 'CAM-2': 0 };
    SUP.events = []; S.verify = null;
    S.lineStop = false; S.stopReason = '';
    setState('XCHK', 'X1', 'all CP tests pass · operator reset → counter cleared');
    log('stop', 'Operator reset: mismatch counter cleared, line resumes (X1 NORMAL)');
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
      if (MCH.R1.state === 'W1' || firstRaw() < 0) spawn(reloadInput());
      else { let n = 0; for (let i = 0; i < 12; i++) if (!partIn(i) && !W.parts.some((p) => p.loc.k === 'r1')) { addPart('raw', { k: 'in', slot: i }); n++; } if (n) log('operator', `Operator tops up the input pallet (+${n} raw parts)`); }
    });
    $('#btnSwapOut').addEventListener('click', () => { if (needOutput()) spawn(swapOutput()); });
    $('#bnActions').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'verify') startVerify();
      if (a === 'resume') resetResume();
      if (a === 'clear') { Object.keys(S.faults).forEach((k) => { S.faults[k] = null; }); log('fault', 'Operator checked the part and cleared the fault'); }
      if (a === 'qh') { S.qualityHold = false; W.consecNok = 0; log('quality', 'Tool and offsets checked → quality hold released'); }
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
    if (S.running) {
      let dt = dtReal * S.speed;
      while (dt > 1e-9 && S.running) {
        // step exactly to the next timed wake-up so waits are not stretched by the frame rate
        let h = Math.min(dt, 0.05);
        for (const p of procs) if (p.wait && p.wait.k === 't' && p.wait.until > S.t) h = Math.min(h, p.wait.until - S.t);
        h = Math.max(h, 1e-6);
        S.t += h; physics(h); runProcs(); dt -= h;
      }
    }
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
})();
