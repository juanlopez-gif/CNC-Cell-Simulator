"""Simulation engine of the CNC machine-tending cell, without graphics.

The state machines are not programmed here: an interpreter runs the machines of the shared model
(cell_model.json) step by step, with their guards and transitions, exactly like the browser
simulator (source/sim-src/app.js). This file supplies the plant around them: robot jobs that take
the model's step times, the CNC, the belt, the sensor behind every signal name, the operator, the
technician and the fault injection.

Each process is a generator: it yields ("t", until) to wait for a time and ("c", condition, until)
to wait for a condition (until = optional time-out). The scheduler runs every process until nothing
moves any more at the current instant, so a signal written by one machine is seen by the others in
the same scan; then the clock advances to the next time step (at most 0.05 s, or the next wake-up).
"""
import math
import random

from .model import load, plain

INF = float("inf")
EPS = 1e-9

# Belt geometry. The browser simulator draws the belt 361 px long; the PLC sees a part at the entry
# (CP-2) in the first 30 px and at the end stop (CP-3) in the last 12 px. Here the same zones in metres.
BELT_LENGTH = 2.0                       # m, conveyor entry to the hard stop
_PX = BELT_LENGTH / 361.0
ENTRY_ZONE = 30 * _PX                   # part "at the entry" while x < this
EXIT_ZONE = 12 * _PX                    # part "at the end stop" while x > BELT_LENGTH - this
ENC_MIN_SPEED = 0.5 * _PX               # m/s, ENC-43 reports "moving" above this speed

LATCH = {"HMI.verify": "verify", "HMI.reset": "reset", "HMI.release": "release"}


def ease(u):
    return 2 * u * u if u < 0.5 else 1 - (-2 * u + 2) ** 2 / 2


class Robot:
    def __init__(self, name, dual):
        self.name = name
        self.dual = dual
        self.pos = "home"          # named position of the tool
        self.moving = False
        self.hold = {"A": None, "B": None, "S": None}
        self.zone = "free"         # free | door | cnc | conv | pallet | gauge | nok (safety planes)
        self.job = None

    @property
    def at_home(self):
        return not self.moving and self.pos == "home"


class Part:
    def __init__(self, pid, st, loc):
        self.id = pid
        self.st = st                # raw | fin
        self.loc = loc              # {"k": in|out|cnc|conv|r1|r2|gauge|nok, ...}
        self.dims = [50.0, 50.0, 50.0]
        self.meas = None
        self.nok = False


class Proc:
    __slots__ = ("gen", "wait", "done", "name")

    def __init__(self, gen, name):
        self.gen, self.wait, self.done, self.name = gen, None, False, name


class CellSim:
    """One simulated cell. Typical use:

        sim = CellSim(setup=2, seed=1)
        sim.advance(3600)                 # one hour of simulated time
        print(sim.kpis())

    Disturbances: inject_glitch(cp), toggle_sensor_fault(cp), inject_bad_frame(),
    inject_camera_failure(), inject_grip_miss(), inject_undersized(). Operator and technician:
    press("verify" | "resume" | "clear" | "qh" | "swap" | "load"), auto_operator.
    """

    def __init__(self, setup=1, seed=None, model=None, auto_operator=True, instant_verify=False,
                 verify_step_time=0.65):
        if setup not in (1, 2):
            raise ValueError("setup must be 1 or 2")
        self.M = model or load()
        self.T, self.RU = self.M.T, self.M.RULES
        self.setup = setup
        self.rnd = random.Random(seed)
        self.auto_operator = auto_operator
        self.instant_verify = instant_verify
        self.verify_step_time = verify_step_time
        self.t = 0.0
        self.logs = []                       # (t, category, message)
        self.trace = []                      # every state change: {t, slot, from, to}
        self.errors = []                     # model / plant disagreements (must stay empty)
        self.vars = {k: (0 if s.get("num") else False) for k, s in self.M.SIGNALS.items()
                     if s["kind"] == "var" and k != "mismatches"}
        self.cp_result = {}                  # slot -> {CP-n: fused result of its last check}
        self.inputs = {"verify": False, "reset": False, "release": False, "clear_at": -1.0}
        self.inject = {"under": 0, "grip_miss": False, "frames": {"CAM-1": 0, "CAM-2": 0}}
        self.faults = {}                     # slot -> fault message
        self.cam_fault = None
        self.verify = None                   # sensor verification in progress
        self.stop_reason = ""
        self.events = []                     # mismatches in the 10-minute window: {t, cp, tag}
        self.cps = {c["id"]: dict(c, fault=False, glitch=False, last=None, count=0) for c in self.M.CHECKPOINTS}
        # plant
        self.parts, self._next_id = [], 1
        self.pallet_in = {"present": True, "busy": False}
        self.pallet_out = {"present": True, "busy": False}
        self.cnc = {"state": "EMPTY", "part": None, "locked": False, "start_cmd": False, "vise": "open",
                    "run_start": 0.0, "done_at": None}
        self.door = {"pos": 0.0, "anim": None}
        self.belt = {"cmd": False, "v": 0.0}
        self.v_max = BELT_LENGTH / self.T["beltTravel"]
        self.acc = self.v_max / self.T["beltStart"]
        self.r1, self.r2 = Robot("R1", True), Robot("R2", False)
        self.gauge = {"zeroed": False, "valid": False, "ok": False}
        self.last_slot = None
        self.pe65 = -9.0
        self.ok_parts = 0
        self.nok_parts = 0
        self.stats = {"run_time": 0.0, "first_start": None, "last_idle": None, "idle_sum": 0.0, "idle_n": 0,
                      "idles": [], "cycles": 0, "mismatches": 0, "stops": 0, "jobs": 0, "violations": 0}
        for i in range(3, 12):
            self._add_part("raw", {"k": "in", "slot": i})
        for i in range(0, 8):
            self._add_part("fin", {"k": "out", "slot": i})
        keys = self.M.SETUP_MACHINES[str(setup)]
        self.mch = {}
        for slot in self.M.SLOTS:
            key = next(k for k in keys if self.M.MACHINES[k]["slot"] == slot)
            self.mch[slot] = {"key": key, "state": "", "since": 0.0, "why": "", "prev": "", "job": None}
        self._seen_never = set()
        self.JOB = self._job_table()
        self._check_signals()
        self.procs = []
        self.spawn(self._run_machine("R1"), "R1")
        self.spawn(self._cnc_proc(), "CNC")
        self.spawn(self._run_machine("CONV"), "CONV")
        self.spawn(self._run_machine("R2"), "R2")
        self.spawn(self._run_machine("SUP"), "SUP")
        self.spawn(self._operator_proc(), "operator")
        self.log("info", f"Setup {setup} started · input pallet 9 raw parts · output pallet 8 of 12 · CNC empty")

    # ================================================================== public API
    def advance(self, seconds):
        """Advance the simulation by `seconds` of simulated time."""
        dt = seconds
        while dt > EPS:
            # step exactly to the next timed wake-up so that waits are not stretched by the time step
            h = min(dt, 0.05)
            for p in self.procs:
                w = p.wait
                if w is not None:
                    until = w[1] if w[0] == "t" else w[2]
                    if until is not None and until > self.t:
                        h = min(h, until - self.t)
            h = max(h, 1e-6)
            self.t += h
            self._physics(h)
            self._run_procs()
            self._monitor_stable()
            dt -= h

    def state(self, slot):
        return self.mch[slot]["state"]

    def press(self, act):
        """Operator / technician buttons of the HMI."""
        if act == "verify":
            self.inputs["verify"] = True
            self.log("stop", "Technician requests the sensor verification")
        elif act == "resume":
            self.inputs["reset"] = True
        elif act == "clear":
            self.inputs["clear_at"] = self.t
            self.log("fault", "Operator checked the part and cleared the fault")
        elif act == "qh":
            self.inputs["release"] = True
        elif act == "swap":
            if self._need_output():
                self.spawn(self._swap_output(), "swap")
        elif act == "load":
            self.spawn(self._reload_input(), "load")
        else:
            raise ValueError("unknown action " + act)

    def inject_glitch(self, cp):
        self.cps[cp]["glitch"] = True
        self.log("info", f"Test: next {cp} reading of {self.cps[cp]['prox']} will be wrong (single glitch)")

    def toggle_sensor_fault(self, cp):
        c = self.cps[cp]
        c["fault"] = not c["fault"]
        self.log("info", f"Test: {c['prox']} made faulty (dirty / misaligned: it misses the object)" if c["fault"]
                 else f"Test: {c['prox']} fault removed")

    def inject_bad_frame(self):
        self.inject["frames"]["CAM-1"] = 1
        self.log("info", "Test: the next CAM-1 image will be invalid once")

    def inject_camera_failure(self):
        self.inject["frames"]["CAM-2"] = 2
        self.log("info", "Test: CAM-2 will deliver two invalid images in a row")

    def inject_grip_miss(self):
        self.inject["grip_miss"] = True
        self.log("info", "Test: Robot 1 will miss its next pick")

    def inject_undersized(self):
        self.inject["under"] += 1
        self.log("info", "Test: the next part to finish will be undersized in one dimension")

    def kpis(self):
        st = self.stats
        util = st["run_time"] / (self.t - st["first_start"]) if st["first_start"] is not None and self.t > st["first_start"] else None
        mean_idle = st["idle_sum"] / st["idle_n"] if st["idle_n"] else None
        design_idle = self.M.KPI["idle1" if self.setup == 1 else "idle2"]
        cycle = self.T["cncCycle"] + (mean_idle if mean_idle is not None else design_idle)
        return {
            "sim_time_h": self.t / 3600, "parts_on_pallet": self.ok_parts, "nok_parts": self.nok_parts,
            "cnc_cycles": st["cycles"], "cnc_utilization": util, "mean_cnc_idle_s": mean_idle,
            "design_cnc_idle_s": design_idle, "parts_per_hour": 3600 / cycle,
            "mismatches": st["mismatches"], "line_stops": st["stops"], "jobs": st["jobs"],
            "property_violations": st["violations"],
        }

    # ================================================================== scheduler
    def spawn(self, gen, name=""):
        self.procs.append(Proc(gen, name))

    def _ready(self, w):
        if w is None:
            return True
        if w[0] == "t":
            return self.t >= w[1] - EPS
        return w[1]() or (w[2] is not None and self.t >= w[2] - EPS)

    def _run_procs(self):
        for _ in range(12):
            moved = False
            for p in self.procs:                      # a process spawned meanwhile also runs in this pass
                guard = 0
                while not p.done and guard < 80:
                    guard += 1
                    if not self._ready(p.wait):
                        break
                    p.wait = None
                    moved = True
                    try:
                        p.wait = p.gen.send(None)
                    except StopIteration:
                        p.done = True
                        break
            self.procs = [p for p in self.procs if not p.done]
            if self._eval_rungs():
                moved = True
            if not moved:
                break

    def _wait(self, s):
        if s > EPS:
            yield ("t", self.t + s)

    def _until(self, fn):
        if not fn():
            yield ("c", fn, None)

    # ================================================================== signals: the plant behind every name
    def _sense(self, name, slot):
        r1, r2, c = self.r1, self.r2, self.cnc
        if name == "HMI.auto":
            return True
        if name == "HMI.loaded":
            return self.pallet_in["present"] and not self.pallet_in["busy"] and self._first_raw() >= 0
        if name == "R1.home":
            return r1.at_home
        if name == "R2.home":
            return r2.at_home
        if name == "R1.clearCnc":
            return r1.zone != "cnc"
        if name == "R1.clearConv":
            return r1.zone != "conv"
        if name == "R2.clearConv":
            return r2.zone != "conv"
        if name == "R2.clearGauge":
            return r2.zone != "gauge"
        if name == "R1.job":
            return self.mch["R1"]["job"]
        if name == "R2.job":
            return self.mch["R2"]["job"]
        if name == "CNC.ready":
            return True
        if name == "CNC.run":
            return c["state"] == "RUN"
        if name == "CNC.done":
            return c["state"] == "DONE" and c["part"] is not None and c["part"].st == "fin"
        if name == "CNC.empty":
            return c["part"] is None and c["state"] != "RUN"
        if name == "ZS-31":
            return self._door_pos() > 0.99
        if name == "ZS-32":
            return self._door_pos() < 0.01
        if name == "ZS-33":
            return c["locked"]
        if name == "ZS-34":
            return c["vise"] == "open"
        if name == "ZS-35":
            return c["vise"] == "clamped"
        if name == "PS-36":
            return c["part"] is not None
        if name == "GR-21":
            return r1.hold["S"] is not None
        if name == "GR-21A":
            return r1.hold["A"] is not None
        if name == "GR-21B":
            return r1.hold["B"] is not None
        if name == "GR-51":
            return r2.hold["S"] is not None
        if name == "ENC-43":
            return self.belt["v"] > ENC_MIN_SPEED
        if name == "PE-42":
            return self._prox_live("CP-3")
        if name == "ROI-C":
            return self._truth("CP-3") and self.cam_fault != "CAM-2"
        if name == "PX-52":
            return self._prox_live("CP-4")
        if name == "CAM-2.slot":
            return self.last_slot is not None and any(p.loc["k"] == "out" and p.loc["slot"] == self.last_slot for p in self.parts)
        if name == "outCount":
            return self._out_count()
        if name == "GAUGE.zeroed":
            return self.gauge["zeroed"]
        if name == "GAUGE.valid":
            return self.gauge["valid"]
        if name == "GAUGE.ok":
            return self.gauge["ok"]
        if name == "PE-65":
            return self.t - self.pe65 < 0.8
        if name == "TRUE.entryPart":
            return self._truth("CP-2")
        if name == "TRUE.outPallet":
            return self.pallet_out["present"]
        if name == "TRUE.r2Nok":
            return self._undersized(r2.hold["S"])
        raise KeyError("no plant reader for signal " + name)

    def _input(self, name, slot):
        if name == "HMI.clear":
            return slot is not None and self.inputs["clear_at"] >= self.mch[slot]["since"]
        if name == "HMI.verify":
            return self.inputs["verify"]
        if name == "HMI.reset":
            return self.inputs["reset"]
        if name == "HMI.release":
            return self.inputs["release"]
        if name == "VERIFY.pass":
            return bool(self.verify and self.verify["done"])
        if name == "VERIFY.fail":
            return False
        raise KeyError("no input for signal " + name)

    def read(self, name, slot=None):
        if name in self.M.SLOTS:
            return self.mch[name]["state"]
        sig = self.M.SIGNALS.get(name)
        if sig is None:
            raise KeyError("signal not in the model: " + name)
        kind = sig["kind"]
        if kind == "check":
            return bool(self.cp_result.get(slot, {}).get(name))
        if kind == "var":
            return len(self.events) if name == "mismatches" else self.vars[name]
        if kind == "input":
            return self._input(name, slot)
        return self._sense(name, slot)

    def ev(self, src, slot=None):
        return self.M.compile(src)(lambda n: self.read(n, slot))

    def output(self, name):
        return self.ev(self.M.OUTPUTS[name]["def"])

    def _check_signals(self):
        """Every name the active machines, outputs, rungs and properties read must have a reader."""
        used = set()

        def add(src):
            if src:
                self.M.names(src, True, used)

        def steps(lst):
            for st in lst or []:
                for k in ("when", "confirm", "await", "until"):
                    add(st.get(k))
        for slot in self.mch:
            m = self._machine(slot)
            add(m["initial"].get("when"))
            steps(m["initial"].get("do"))
            if m.get("hold"):
                steps(m["hold"].get("do"))
                add(m["hold"].get("exit"))
            if m.get("fault"):
                add(m["fault"].get("exit"))
            for s in m["states"].values():
                if s.get("choice"):
                    add(s["choice"])
                steps(s.get("do"))
                for tr in s.get("next", []):
                    add(tr["when"])
                for f in s.get("faults", []):
                    add(f.get("when"))
        for o in self.M.OUTPUTS.values():
            add(o["def"])
        for r in self.M.RUNGS:
            add(r["when"])
        for p in self.M.PROPERTIES:
            add(p.get("never"))
            add(p.get("require"))
        for n in sorted(used):
            sig = self.M.SIGNALS.get(n)
            if sig and sig["kind"] == "derived":
                continue
            self.read(n, "R1")                   # raises if the plant has no reader for it

    # ================================================================== interpreter of the model
    def _machine(self, slot):
        return self.M.MACHINES[self.mch[slot]["key"]]

    def _state_of(self, slot, sid):
        return self._machine(slot)["states"].get(sid)

    def _set_state(self, slot, sid, why=""):
        x = self.mch[slot]
        if x["state"] == sid and x["why"] == (why or ""):
            return
        enter = x["state"] != sid
        if enter:
            x["prev"] = x["state"]
            x["since"] = self.t
            self.trace.append({"t": self.t, "slot": slot, "from": x["prev"], "to": sid})
        x["state"], x["why"] = sid, why or ""
        s = self._state_of(slot, sid)
        if enter and s:
            if s.get("log"):
                self.log({"op": "pallet", "stop": "stop"}.get(s.get("kind"), "info"), s["log"])
            if slot == "SUP" and s.get("kind") == "stop":
                self.stats["stops"] += 1
                self.stop_reason = (f"{self.cam_fault or 'a camera'} gave two invalid images (camera fault)" if self.vars["CAM_FAULT"]
                                    else f"{len(self.events)} camera / proximity mismatches within 10 min ({self._window_summary()})")
            if (s.get("hmi") or {}).get("proc") == "verify":
                self._start_verify()
            prev = self._state_of(slot, x["prev"])
            if slot == "SUP" and s.get("kind") == "ok" and prev and prev.get("kind") == "check":
                self.verify = None
                self.stop_reason = ""
                self.log("stop", "Operator reset: mismatch counter cleared, line resumes")

    def _run_machine(self, slot):
        m = self._machine(slot)
        init = m["initial"]
        if init.get("do"):
            yield from self._run_steps(slot, init["do"], False, 0)
        if init.get("when"):
            yield from self._until(lambda: self.ev(init["when"], slot))
        target, why, frm = init["to"], (self.M.label(init["when"]) if init.get("when") else "start"), 0
        while True:
            n = 0
            while m["states"][target].get("choice") and n < 10:      # choice: passed at once
                q = m["states"][target]
                yes = self.ev(q["choice"], slot)
                sig = self.M.SIGNALS[q["choice"]]
                why = f'{plain(" ".join(sig["ask"]))} {"Yes" if yes else "No"}: {plain((q.get("yesText") or sig["on"]) if yes else (q.get("noText") or sig.get("off", "")))}'
                target = q["yes"] if yes else q["no"]
                n += 1
            self._set_state(slot, target, why)
            r = yield from self._run_state(slot, target, frm)
            frm = 0
            if "tr" in r:
                tr = r["tr"]
                for a in tr.get("do", []):
                    self._apply_set(a, slot)
                self._consume_inputs(tr["when"])
                why = ((tr.get("text") or "") + " " + self.M.label(tr["when"])).strip()
                if tr.get("hold") is not False and m.get("hold") and self.ev("HOLD.req", slot):
                    yield from self._hold_state(slot)
                target = tr["to"]
            elif "hold" in r:
                yield from self._hold_state(slot)
                why = "line reset · the check is repeated" if r.get("at") is not None else "line reset · the state is entered again"
                frm = r.get("at") or 0
            else:
                yield from self._fault_state(slot, r["fault"])
                why = "fault cleared by the operator · the step is repeated"
                if m.get("hold") and self.ev("HOLD.req", slot):
                    yield from self._hold_state(slot)

    def _hold_state(self, slot):
        m = self._machine(slot)
        self._set_state(slot, "H", f"{self.cam_fault or 'camera'} fault: line stop" if self.vars["CAM_FAULT"] and not self.ev("lineStop")
                        else "LINE STOP from the cross-check supervisor")
        yield from self._run_steps(slot, m["hold"].get("do", []), False, 0)
        yield from self._until(lambda: self.ev(m["hold"]["exit"], slot))

    def _fault_state(self, slot, msg):
        self.faults[slot] = msg
        self._set_state(slot, "F", msg)
        self.log("fault", f"{msg} → FAULT (no automatic robot retry)")
        exit_expr = self._machine(slot)["fault"]["exit"]
        yield from self._until(lambda: self.ev(exit_expr, slot))
        self.faults[slot] = None

    def _missing(self, src, slot):
        e = self.M.parse(src)
        conj = e["args"] if e["op"] == "and" else [e]
        bad = [c for c in conj if not self.M._compile_node(c)(lambda n: self.read(n, slot))]
        return " · ".join(plain(" · ".join(self.M.terms(c)[0])) for c in (bad or conj))

    def _run_steps(self, slot, steps, holdable, frm):
        """Steps of a state; returns None when they all ran, or {hold} / {fault} to leave the state."""
        for i in range(frm or 0, len(steps)):
            st = steps[i]
            if st.get("when") and not self.ev(st["when"], slot):
                continue
            if "job" in st:
                yield from self._run_job(slot, st["job"])
                if st.get("confirm") and not self.ev(st["confirm"], slot):
                    return {"fault": f'missing confirmation after "{self.M.JOBS[st["job"]]["text"]}": {self._missing(st["confirm"], slot)}'}
            elif "check" in st:
                while True:
                    res = yield from self._check(st["check"], st.get("quick"), slot)
                    if res == "camfault":
                        return {"hold": True, "at": i}
                    if not st.get("until") or self.ev(st["until"], slot):
                        break
                    if holdable and self.ev("HOLD.req", slot):
                        return {"hold": True}
                    yield from self._wait(self.T["check"])
                if st.get("confirm") and not self.ev(st["confirm"], slot):
                    return {"fault": f'missing confirmation at {st["check"]}: {self._missing(st["confirm"], slot)}'}
            elif "await" in st:
                cond = st["await"]
                while not self.ev(cond, slot):
                    if holdable and self.ev("HOLD.req", slot):
                        return {"hold": True}
                    yield ("c", lambda: self.ev(cond, slot) or (holdable and self.ev("HOLD.req", slot)), None)
            else:
                self._apply_set(st, slot)
        return None

    def _run_state(self, slot, sid, frm):
        """One state: its steps, then the first transition whose guard holds. A state that is not a
        waiting state must leave within RULES.confirmTimeout, otherwise FAULT names what is missing."""
        s = self._state_of(slot, sid)
        m = self._machine(slot)
        holdable = s.get("hold") is not False and bool(m.get("hold"))
        r = yield from self._run_steps(slot, s.get("do", []), holdable, frm)
        if r:
            return r
        t0 = self.t
        since = {}
        nxt, faults, waits = s["next"], s.get("faults", []), bool(s.get("wait"))

        def status():
            return (tuple(self.ev(tr["when"], slot) for tr in nxt),
                    self.ev("HOLD.req", slot) if holdable and waits else None,
                    tuple(self.ev(f["when"], slot) if f.get("when") else None for f in faults))
        while True:
            wake = INF
            for k, tr in enumerate(nxt):
                ok = self.ev(tr["when"], slot)
                if not tr.get("for"):
                    if ok:
                        return {"tr": tr}
                    continue
                if not ok:
                    since.pop(k, None)
                    continue
                since.setdefault(k, self.t)
                due = since[k] + self.T[tr["for"]]
                if self.t >= due - EPS:
                    return {"tr": tr}
                wake = min(wake, due)
            for f in faults:
                if f.get("when") and not self.ev(f["when"], slot):
                    continue
                if self.t - t0 >= f["after"] - EPS:
                    return {"fault": plain(f.get("text") or self.M.label(f["when"]))}
                wake = min(wake, t0 + f["after"])
            if not waits:
                if self.t - t0 >= self.RU["confirmTimeout"] - EPS:
                    return {"fault": f'{sid}: missing confirmation: {self._missing(nxt[0]["when"], slot)}'}
                wake = min(wake, t0 + self.RU["confirmTimeout"])
            if holdable and waits and self.ev("HOLD.req", slot):
                return {"hold": True}
            last = status()
            yield ("c", lambda: status() != last, None if wake == INF else wake)

    def _apply_set(self, st, slot=None):
        if st.get("when") and not self.ev(st["when"], slot):
            return
        for v, val in (st.get("set") or {}).items():
            self._set_var(v, val)
        if st.get("inc"):
            sig = self.M.SIGNALS[st["inc"]]
            top = sig.get("max", INF)
            self._set_var(st["inc"], min(top, (self.vars.get(st["inc"]) or 0) + 1))

    def _set_var(self, v, val):
        if v == "mismatches":
            if val == 0:
                self.events = []
            return
        before = self.vars.get(v)
        self.vars[v] = val
        if val is True and before is not True and self.M.SIGNALS[v].get("logOn"):
            self.log("quality" if v == "QH" else "info", self.M.SIGNALS[v]["logOn"])
        if v == "CAM_FAULT" and not val:
            self.cam_fault = None

    def _consume_inputs(self, src):
        for n in self.M.names(src, True):
            if n in LATCH:
                self.inputs[LATCH[n]] = False

    def _eval_rungs(self):
        fired = False
        for r in self.M.RUNGS:
            if self.ev(r["when"]):
                self._apply_set(r)
                self._consume_inputs(r["when"])
                self.log("quality", r["text"])
                fired = True
        return fired

    def _run_job(self, slot, name):
        j = self.M.JOBS[name]
        r = self.r1 if j["robot"] == "R1" else self.r2 if j["robot"] == "R2" else None
        t0 = self.t
        self.mch[slot]["job"] = name
        if r:
            r.zone = j.get("zone") or "free"
            r.job = name
        self._monitor_start(name)
        yield from self.JOB[name](r)
        if r:
            r.zone = "free"
            r.job = None
        self.mch[slot]["job"] = None
        self.stats["jobs"] += 1
        want = self.M.job_time(name)
        if abs(self.t - t0 - want) > 0.011:
            self.errors.append(f"job {name}: {self.t - t0:.3f} s in the simulation, {want} s in the model")

    # ================================================================== property monitors (same properties as the verifier)
    def _props(self):
        return [p for p in self.M.PROPERTIES if not p.get("setup") or p["setup"] == self.setup]

    def _violated(self, p):
        self.stats["violations"] += 1
        self.log("fault", f"PROPERTY {p['id']} VIOLATED: {p['text']}")
        self.errors.append(f"property {p['id']} violated at t = {self.t:.2f} s: {p['text']}")

    def _monitor_start(self, job):
        for p in self._props():
            if job in (p.get("start") or []) and not self.ev(p["require"]):
                self._violated(p)

    def _monitor_stable(self):
        for p in self._props():
            if not p.get("never"):
                continue
            bad = self.ev(p["never"])
            if bad and p["id"] not in self._seen_never:
                self._violated(p)
            if bad:
                self._seen_never.add(p["id"])
            else:
                self._seen_never.discard(p["id"])

    # ================================================================== checkpoints: camera + proximity cross-check
    def _truth(self, cp):
        if cp == "CP-1":
            return self.pallet_in["present"]
        if cp == "CP-2":
            return any(p.loc["k"] == "conv" and p.loc["x"] < ENTRY_ZONE for p in self.parts)
        if cp == "CP-3":
            return any(p.loc["k"] == "conv" and p.loc["x"] > BELT_LENGTH - EXIT_ZONE for p in self.parts)
        if cp == "CP-4":
            return self.pallet_out["present"]
        if cp == "CP-5":
            return any(p.loc["k"] == "gauge" for p in self.parts)
        raise KeyError(cp)

    def _prox_live(self, cp):
        return False if self.cps[cp]["fault"] else self._truth(cp)

    def _check(self, cid, quick, slot):
        """Both sources must agree; if not, the camera value is used and the mismatch is counted. An
        invalid image is re-triggered once; a second invalid image is a camera fault (line stop)."""
        cp = self.cps[cid]
        if not quick:
            yield from self._wait(self.T["check"])
        frames = self.inject["frames"]
        if frames[cp["cam"]] > 0:
            frames[cp["cam"]] -= 1
            self.log("check", f"{cp['cam']} image not valid at {cid} (calibration marks not found) → re-trigger once")
            yield from self._wait(self.RU["retrigger"])
            if frames[cp["cam"]] > 0:
                frames[cp["cam"]] -= 1
                self.cam_fault = cp["cam"]
                self._set_var("CAM_FAULT", True)
                self.log("stop", f"{cp['cam']} gave two invalid images at {cid} → camera fault, line stop")
                return "camfault"
            self.log("check", f"{cp['cam']} re-trigger OK at {cid}")
        t = self._truth(cid)
        prox = False if cp["fault"] else t
        if cp["glitch"]:
            prox = not prox
            cp["glitch"] = False
        cam = t
        cp["last"] = {"t": self.t, "prox": prox, "cam": cam, "agree": prox == cam}
        if prox != cam:
            self._mismatch(cp, prox, cam)
        res = self.cp_result.setdefault(slot, {})
        res[cid] = cam
        if cid == "CP-1":
            res["CAM-1.part"] = cam and self._first_raw() >= 0
        return cam

    def _mismatch(self, cp, prox, cam):
        cp["count"] += 1
        self.stats["mismatches"] += 1
        self.events.append({"t": self.t, "cp": cp["id"], "tag": cp["prox"]})
        self._prune_window()
        what = ("a pallet" if cam else "no pallet") if cp["id"] in ("CP-1", "CP-4") else ("a part" if cam else "no part")
        self.log("mismatch", f"{cp['id']} {cp['where']}: {cp['prox']} = {'ON' if prox else 'OFF'} but {cp['cam']} sees {what} → "
                 f"camera value used ({len(self.events)} of {self.RU['mismatchLimit']} in 10 min)")

    def _window_summary(self):
        c = {}
        for e in self.events:
            c[e["tag"]] = c.get(e["tag"], 0) + 1
        return ", ".join(f"{k} ×{v}" for k, v in c.items())

    def _prune_window(self):
        self.events = [e for e in self.events if self.t - e["t"] <= self.RU["mismatchWindow"]]

    # ================================================================== sensor verification (technician)
    def _start_verify(self):
        faulty = [c["prox"] for c in self.cps.values() if c["fault"]]
        tags = list(dict.fromkeys([e["tag"] for e in self.events] + faulty))
        steps = []
        if tags:
            steps.append(f"Inspect {', '.join(tags)}: " + (f"dirty / misaligned lens found on {', '.join(faulty)} → cleaned and realigned" if faulty else "lens cleaned, bracket tight"))
        if self.cam_fault:
            steps.append(f"{self.cam_fault}: cable reseated, lens cleaned, trigger test OK")
        steps.append("Check brackets and the alignment LEDs of the through-beams")
        for c in self.cps.values():
            if c["setup"] <= self.setup:
                steps.append(f"Test {c['id']} with a test part: {c['prox']} ON and {c['cam']} part · removed: both OFF")
        steps.append("Camera calibration target: CAM-1 and CAM-2 position error < 1 mm")
        if self.setup == 2:
            steps.append("Master cube 50.000 mm: LS-61 / LS-62 / LS-63 within ±0.02 mm")
        self.verify = {"steps": steps, "i": 0, "done": False}
        self.log("stop", "Sensor verification started: all equipment stopped, technician in the cell")
        if self.instant_verify:
            self._finish_verify()
        else:
            self.spawn(self._technician(), "technician")

    def _technician(self):
        v = self.verify
        while v is self.verify and not v["done"]:
            yield from self._wait(self.verify_step_time)
            if v is not self.verify:
                return
            v["i"] += 1
            if v["i"] >= len(v["steps"]):
                self._finish_verify()

    def _finish_verify(self):
        self.verify["i"] = len(self.verify["steps"])
        self.verify["done"] = True
        for c in self.cps.values():                     # the technician repaired the sensors
            c["fault"] = False
            c["glitch"] = False
        self.inject["frames"] = {"CAM-1": 0, "CAM-2": 0}
        self.log("stop", "All checkpoint tests passed")

    # ================================================================== plant helpers
    def _add_part(self, st, loc):
        p = Part(self._next_id, st, loc)
        self._next_id += 1
        self.parts.append(p)
        return p

    def _part_in(self, slot):
        return next((p for p in self.parts if p.loc["k"] == "in" and p.loc["slot"] == slot), None)

    def _first_raw(self):
        for i in range(12):
            if self._part_in(i):
                return i
        return -1

    def _first_free_out(self):
        used = {p.loc["slot"] for p in self.parts if p.loc["k"] == "out"}
        for i in range(12):
            if i not in used:
                return i
        return -1

    def _out_count(self):
        return sum(1 for p in self.parts if p.loc["k"] == "out")

    def _undersized(self, p):
        return p is not None and any(v < self.RU["minSize"] for v in p.dims)

    def _door_pos(self):
        a = self.door["anim"]
        if not a:
            return self.door["pos"]
        u = ease(min(1.0, max(0.0, (self.t - a["t0"]) / (a["t1"] - a["t0"]))))
        return a["from"] + (a["to"] - a["from"]) * u

    def _move(self, r, to, dur):
        if not dur > 0:
            r.pos, r.moving = to, False
            return
        r.moving = True
        yield from self._wait(dur)
        r.pos, r.moving = to, False

    def _slide_door(self, r, frm, to, approach):
        yield from self._move(r, "handle", approach + 0.5)
        self.door["anim"] = {"from": frm, "to": to, "t0": self.t, "t1": self.t + 3.0}
        yield from self._move(r, "handle", 3.0)
        self.door["pos"], self.door["anim"] = to, None
        yield from self._wait(0.5)

    # ================================================================== jobs: the plant side of every job of the model
    # Each one takes exactly the time of its components in the model (_run_job reports any difference).
    def _job_table(self):
        T = self.T

        def home(t_key):
            def job(r):
                yield from self._move(r, "home", T[t_key])
            return job

        def door_lock(_):
            yield from self._wait(T["lock"])
            self.cnc["locked"] = True

        def cnc_start(_):
            yield from self._wait(T["cycleStart"])
            self.cnc["start_cmd"] = True

        def unload(r):
            yield from self._move(r, "doorway", T["enterCnc"] / 2)
            yield from self._move(r, "fixture", T["enterCnc"] / 2)
            yield from self._wait(T["grip"])
            self.cnc["vise"] = "open"
            yield from self._wait(T["viseOpen"])
            p = self.cnc["part"]
            self.cnc["part"] = None
            if p:
                p.loc = {"k": "r1", "g": "S"}
                r.hold["S"] = p
            yield from self._wait(T["lift"])
            yield from self._move(r, "doorway", T["exitCnc"] / 2)
            yield from self._move(r, "outside", T["exitCnc"] / 2)

        def load(r):
            yield from self._move(r, "outside", T["palletToDoor"])
            yield from self._load_vise(r, "S", T["enterCnc"])

        def to_conveyor(r):
            yield from self._move(r, "conv_above", T["doorToConv"])

        def enter_cnc(r):
            yield from self._move(r, "doorway", T["enterCnc"] / 2)
            yield from self._move(r, "fixture", T["enterCnc"] / 2)

        def unload_b(r):
            yield from self._wait(T["grip"])
            self.cnc["vise"] = "open"
            yield from self._wait(T["viseOpen"])
            f = self.cnc["part"]
            self.cnc["part"] = None
            if f:
                f.loc = {"k": "r1", "g": "B"}
                r.hold["B"] = f
            yield from self._wait(T["lift"])

        def load_a(r):
            self.cnc["vise"] = "open"
            yield from self._wait(T["swapGripper"])       # B (finished part) turns away, A faces the vise
            yield from self._load_vise(r, "A", 0)

        def pick_conv(r):
            yield from self._move(r, "conv_pick", T["r2ToExit"])
            p = next((q for q in self.parts if q.loc["k"] == "conv" and q.loc["x"] > BELT_LENGTH - EXIT_ZONE), None)
            if p:
                p.loc = {"k": "r2", "g": "S"}
                r.hold["S"] = p
            yield from self._move(r, "conv_off", T["r2Pick"])

        def place_pallet(r):
            slot = self._first_free_out()
            yield from self._move(r, f"out{slot}" if slot >= 0 else "home", T["r2ToPallet"])
            p = r.hold["S"]
            r.hold["S"] = None
            if p and slot >= 0:
                p.loc = {"k": "out", "slot": slot}
                self.last_slot = slot
                self.ok_parts += 1
            yield from self._wait(T["r2Place"])

        def load_gauge(r):
            yield from self._move(r, "nest", T["r2ToGauge"])
            yield from self._wait(T["r2LoadGauge"] * 0.6)
            p = r.hold["S"]
            r.hold["S"] = None
            if p:
                p.loc = {"k": "gauge"}
            yield from self._move(r, "nest_out", T["r2LoadGauge"] * 0.4)

        def measure(_):
            yield from self._wait(T["measure"])
            p = next((q for q in self.parts if q.loc["k"] == "gauge"), None)
            if not p:
                self.gauge["valid"] = False
                return
            p.meas = [v + (self.rnd.random() - 0.5) * 0.004 for v in p.dims]
            self.gauge["valid"] = True
            self.gauge["ok"] = all(v >= self.RU["minSize"] for v in p.meas)
            m = p.meas
            self.log("measure", f"Part #{p.id}: L {m[0]:.3f} · W {m[1]:.3f} · H {m[2]:.3f} mm → {'OK, all ≥ 48.00' if self.gauge['ok'] else 'NOK, undersized'}")

        def master(_):
            self.log("measure", "Start-up master cube 50.000 mm: LS-61 50.001 · LS-62 49.999 · LS-63 50.000 mm → gauge OK")
            self.gauge["zeroed"] = True
            return
            yield  # pragma: no cover  (makes this function a generator)

        def repick(r):
            yield from self._move(r, "nest", T["r2Repick"] / 2)
            yield from self._wait(T["r2Repick"] / 2)
            p = next((q for q in self.parts if q.loc["k"] == "gauge"), None)
            if p:
                p.loc = {"k": "r2", "g": "S"}
                r.hold["S"] = p
            self.gauge["valid"] = False

        def drop_nok(r):
            yield from self._move(r, "nok_drop", T["r2ToNok"])
            p = r.hold["S"]
            r.hold["S"] = None
            if p:
                p.nok = True
                p.loc = {"k": "nok", "i": self.nok_parts}
                self.pe65 = self.t
                self.nok_parts += 1
            yield from self._wait(T["r2Drop"])
            if p:
                self.log("quality", f"NOK part #{p.id} dropped in the locked chute (PE-65 confirmed) · NOK total {self.nok_parts}")

        return {
            "R1.home": home("doorToHome"), "R1.park": home("park"), "R2.home": home("r2Home"), "R2.park": home("park"),
            "R1.openDoorFromHome": lambda r: self._slide_door(r, 0.0, 1.0, T["homeToDoor"]),
            "R1.openDoor": lambda r: self._slide_door(r, 0.0, 1.0, 0.0),
            "R1.closeDoor": lambda r: self._slide_door(r, 1.0, 0.0, 0.0),
            "DOOR.lock": door_lock, "CNC.start": cnc_start,
            "R1.unload": unload, "R1.load": load,
            "R1.toConveyor": to_conveyor, "R1.toConveyorB": to_conveyor,
            "R1.placeConv": lambda r: self._place_on_belt(r, "S"), "R1.placeConvB": lambda r: self._place_on_belt(r, "B"),
            "R1.pickRaw": lambda r: self._pick_raw(r, "S"), "R1.pickRawA": lambda r: self._pick_raw(r, "A"),
            "R1.toDoorReady": lambda r: self._move(r, "door_ready", T["palletToDoor"]),
            "R1.enterCnc": enter_cnc, "R1.unloadB": unload_b, "R1.loadA": load_a,
            "R2.pickConv": pick_conv, "R2.placePallet": place_pallet, "R2.loadGauge": load_gauge,
            "GAUGE.measure": measure, "GAUGE.master": master, "R2.repick": repick, "R2.dropNok": drop_nok,
        }

    def _pick_raw(self, r, g):
        T = self.T
        slot = self._first_raw()
        yield from self._move(r, f"in{slot}" if slot >= 0 else "home", T["convToPallet"])
        yield from self._wait(0.7)
        yield from self._wait(T["grip"])
        if self.inject["grip_miss"] or slot < 0:
            self.inject["grip_miss"] = False
            self.log("fault", f"{'GR-21' if g == 'S' else 'GR-21' + g}: fingers fully closed, no part at the input pallet")
        else:
            p = self._part_in(slot)
            p.loc = {"k": "r1", "g": g}
            r.hold[g] = p
        yield from self._wait(T["pickPallet"] - 0.7 - T["grip"])

    def _load_vise(self, r, g, enter):
        T = self.T
        if enter:
            yield from self._move(r, "doorway", enter / 2)
            yield from self._move(r, "fixture", enter / 2)
        p = r.hold[g]
        r.hold[g] = None
        if p:
            p.loc = {"k": "cnc"}
            self.cnc["part"] = p
        yield from self._wait(T["placeInVise"])
        self.cnc["vise"] = "clamped"
        yield from self._wait(T["viseClamp"])
        yield from self._wait(T["seatCheck"])
        yield from self._wait(T["release"])
        yield from self._move(r, "doorway", T["exitCnc"] / 2)
        yield from self._move(r, "outside", T["exitCnc"] / 2)

    def _place_on_belt(self, r, g):
        T = self.T
        yield from self._move(r, "conv_place", 0.7)
        p = r.hold[g]
        r.hold[g] = None
        if p:
            p.loc = {"k": "conv", "x": 0.0}
        yield from self._wait(T["release"])
        yield from self._move(r, "conv_above", T["placeConv"] - 0.7 - T["release"])

    # ================================================================== CNC (plant)
    def _cnc_proc(self):
        c, st = self.cnc, self.stats
        while True:
            yield from self._until(lambda: c["start_cmd"])
            c["start_cmd"] = False
            if c["done_at"] is not None:
                st["last_idle"] = self.t - c["done_at"]
                st["idle_sum"] += st["last_idle"]
                st["idle_n"] += 1
                st["idles"].append(st["last_idle"])
            if st["first_start"] is None:
                st["first_start"] = self.t
            c["state"], c["run_start"] = "RUN", self.t
            yield from self._wait(self.T["cncCycle"])
            p = c["part"]
            if p:
                p.st = "fin"
                p.dims = [50 + (self.rnd.random() - 0.5) * 0.04 for _ in range(3)]
                if self.inject["under"] > 0:
                    self.inject["under"] -= 1
                    p.dims[int(self.rnd.random() * 3)] = 47.35 + self.rnd.random() * 0.5
            c["state"], c["done_at"] = "DONE", self.t
            st["cycles"] += 1
            yield from self._wait(self.T["unlock"])
            c["locked"] = False

    # ================================================================== operator
    def _need_input(self):
        return self.pallet_in["present"] and not self.pallet_in["busy"] and self._first_raw() < 0

    def _need_output(self):
        return self.output("LT-53") and self.pallet_out["present"] and not self.pallet_out["busy"]

    def _reload_input(self):
        self.pallet_in["busy"] = True
        self.log("operator", "Operator removes the empty input pallet (PX-11 OFF)")
        self.pallet_in["present"] = False
        self.parts = [p for p in self.parts if p.loc["k"] != "in"]
        yield from self._wait(8)
        for i in range(12):
            self._add_part("raw", {"k": "in", "slot": i})
        self.pallet_in["present"], self.pallet_in["busy"] = True, False
        self.log("operator", 'Operator places a full input pallet (12 raw parts) and presses "Pallet loaded"')

    def _swap_output(self):
        self.pallet_out["busy"] = True
        self.log("operator", "Operator takes the full output pallet away (PX-52 OFF)")
        self.pallet_out["present"] = False
        self.parts = [p for p in self.parts if p.loc["k"] != "out"]
        yield from self._wait(8)
        self.pallet_out["present"], self.pallet_out["busy"] = True, False
        self.log("operator", "Operator places an empty output pallet")

    def _operator_proc(self):
        while True:
            yield from self._until(lambda: self.auto_operator and (self._need_input() or self._need_output()))
            t0 = self.t
            yield from self._until(lambda: self.t - t0 >= 45 or not self.auto_operator or not (self._need_input() or self._need_output()))
            if not self.auto_operator:
                continue
            if self._need_input():
                yield from self._reload_input()
            if self._need_output():
                yield from self._swap_output()

    # ================================================================== physics
    def _physics(self, h):
        b = self.belt
        b["cmd"] = self.output("BELT.motor")
        b["v"] = min(self.v_max, b["v"] + self.acc * h) if b["cmd"] else max(0.0, b["v"] - self.acc * h)
        if b["v"] > 0:
            for p in self.parts:
                if p.loc["k"] == "conv":
                    p.loc["x"] = min(BELT_LENGTH, p.loc["x"] + b["v"] * h)
        if self.cnc["state"] == "RUN":
            self.stats["run_time"] += h
        self._prune_window()

    # ================================================================== log
    def log(self, cat, msg):
        self.logs.append((self.t, cat, msg))
