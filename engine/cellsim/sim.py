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
# causes of CNC time not machining, in the order of priority used by CellSim._loss_cause (A2.4)
LOSS_CAUSES = ("start-up", "safety stop", "fault", "CNC alarm", "line stop", "quality hold", "tool change", "material shortage", "pallet change", "exchange")

# Belt geometry. The browser simulator draws the belt 361 px long; the PLC sees a part at the entry
# (CP-2) in the first 30 px and at the end stop (CP-3) in the last 12 px. Here the same zones in metres.
BELT_LENGTH = 2.0                       # m, conveyor entry to the hard stop
_PX = BELT_LENGTH / 361.0
ENTRY_ZONE = 30 * _PX                   # part "at the entry" while x < this
EXIT_ZONE = 12 * _PX                    # part "at the end stop" while x > BELT_LENGTH - this
ENC_MIN_SPEED = 0.5 * _PX               # m/s, ENC-43 reports "moving" above this speed

LATCH = {"HMI.verify": "verify", "HMI.reset": "reset", "HMI.release": "release", "HMI.tool": "tool", "HMI.safety": "safety", "VERIFY.fail": "verify_fail"}
ESTOP_MSG = "E-stop: all motion stopped"
PERSON_WALK = 3.0                       # s a person needs to cross the warning field into the protective one (A6.5)
# value used when proximity and camera disagree, by checkpoint rule (rule "ask" stops the line instead)
FUSE = {"camera": lambda prox, cam: cam, "prox": lambda prox, cam: prox,
        "present": lambda prox, cam: True, "absent": lambda prox, cam: False}
RULE_WORD = {"camera": "camera value used", "prox": "proximity value used", "present": "treated as present", "absent": "treated as absent"}


class EStop(Exception):
    """Thrown into a machine process that waits (not in a job) when the E-stop forces it into F (A6.5)."""


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


class _Times:
    """Step times drawn uniformly in their intervals (M.TRANGE), for random_times=True (step A4.4).

    Inside a job every time component has one value, drawn when the job reads it first (a job may
    read a component in parts, e.g. r2Master as 0.3 + 0.4 + 0.3); outside a job (checks, CNC cycle,
    zero-speed window) every read is a new draw. The belt speed stays nominal (belt physics)."""

    def __init__(self, sim, seed):
        self.sim, self.rnd = sim, random.Random(f"times-{seed}")
        self.job = {}                        # process -> {component: drawn time} while it runs a job

    def __getitem__(self, k):
        lo, hi = self.sim.M.TRANGE[k]
        cache = self.job.get(self.sim._cur)
        if cache is None:
            return lo + self.rnd.random() * (hi - lo)
        if k not in cache:
            cache[k] = lo + self.rnd.random() * (hi - lo)
        return cache[k]


class CellSim:
    """One simulated cell. Typical use:

        sim = CellSim(setup=2, seed=1)
        sim.advance(3600)                 # one hour of simulated time
        print(sim.kpis())

    Disturbances: inject_glitch(cp), toggle_sensor_fault(cp), inject_camera_wrong(cp),
    inject_stale_image(cp), inject_bad_frame(), inject_camera_failure(), inject_grip_miss(),
    inject_undersized(), inject_cnc_alarm(), inject_offset_error(), inject_tool_life_end(), set_sensor_miss(cp, q); nok_rate = p: every part undersized with
    probability p (A5). rules={"CP-n": rule} overrides the fusion rule of the model at a
    checkpoint. Operator and technician:
    press("verify" | "resume" | "clear" | "qh" | "swap" | "load"), auto_operator.
    """

    def __init__(self, setup=2, seed=None, model=None, auto_operator=True, instant_verify=False,
                 verify_step_time=0.65, rules=None, external=False, random_times=False, nok_rate=0.0):
        if setup != 2:
            raise ValueError("only Setup 2 is simulated (Setup 1 is in the branch legacy-setup1-setup2)")
        self.M = model or load()
        self.RU = self.M.RULES
        # random_times = True: every step time drawn in its interval (A4.4), seeded with seed
        self._cur = None                     # the process the scheduler is running
        self.T = _Times(self, seed) if random_times else self.M.T
        self.setup = setup
        self.rnd = random.Random(seed)
        # studies (A5): undersized parts and intermittent sensors from their own streams, so that
        # the other draws stay as without them
        self.nok_rate = nok_rate
        self._nok_rnd = random.Random(f"nok-{seed}")
        self._miss_rnd = random.Random(f"miss-{seed}")
        self.auto_operator = auto_operator
        self.instant_verify = instant_verify
        self.verify_step_time = verify_step_time
        # external = True: the machines run in a PLC (step A3.3, plc_bridge.py); this object is then
        # the plant only: it runs the jobs and answers the cameras the PLC asks for, and mirrors the
        # PLC's states, variables and outputs (ext) so that logs, KPIs and property monitors still work
        self.external = external
        self.ext = {"out": {}, "vars": {}, "done": {}}
        self.t = 0.0
        self.logs = []                       # (t, category, message)
        self.trace = []                      # every state change: {t, slot, from, to}
        self.errors = []                     # model / plant disagreements (must stay empty)
        self.vars = {k: (0 if s.get("num") else False) for k, s in self.M.SIGNALS.items()
                     if s["kind"] == "var" and k != "mismatches"}
        self.cp_result = {}                  # slot -> {CP-n: fused result of its last check}
        self.inputs = {"verify": False, "reset": False, "release": False, "tool": False, "safety": False, "verify_fail": False, "clear_at": -1.0}
        # safety status (A6.5): E-stop circuit and the person in the fields of SC-01 (1) and SC-02 (2)
        self.safety = {"estop": False, "field": {1: "none", 2: "none"}}
        self.inject = {"under": 0, "band": 0, "master": False, "grip_miss": False, "cnc_alarm": False, "frames": {"CAM-1": 0, "CAM-2": 0}}
        self.faults = {}                     # slot -> fault message
        self.cam_fault = None
        self.ask_at = None                   # checkpoint whose disagreement stopped the line (rule ask)
        self.verify = None                   # sensor verification in progress
        self.stop_reason = ""
        self.events = []                     # mismatches in the 10-minute window: {t, cp, tag}
        self.cps = {c["id"]: dict(c, fault=False, glitch=False, cam_wrong=False, stale=False, last=None, count=0,
                                  miss=0.0, miss_now=False, broken=False, found=False)
                    for c in self.M.CHECKPOINTS}
        for cid, rule in (rules or {}).items():
            if rule not in ("camera", "prox", "present", "absent", "ask"):
                raise ValueError(f"unknown rule {rule} at {cid}")
            self.cps[cid]["rule"] = rule
        # plant
        self.parts, self._next_id = [], 1
        self.pallet_in = {"present": True, "busy": False}
        self.pallet_out = {"present": True, "busy": False}
        self.cnc = {"state": "EMPTY", "part": None, "locked": False, "start_cmd": False, "vise": "open",
                    "run_start": 0.0, "done_at": None, "drift_n": 0, "offset_err": 0.0}
        self.door = {"pos": 0.0, "anim": None}
        self.belt = {"cmd": False, "v": 0.0}
        self.v_max = BELT_LENGTH / self.M.T["beltTravel"]
        self.acc = self.v_max / self.M.T["beltStart"]
        self.r1, self.r2 = Robot("R1", True), Robot("R2", False)
        self.gauge = {"zeroed": False, "due": False, "valid": False, "ok": False, "d_master": None, "master_at": None, "hist": []}
        self.last_slot = None
        self.pe65 = -9.0
        self.ok_parts = 0
        self.nok_parts = 0
        self.stats = {"run_time": 0.0, "first_start": None, "last_idle": None, "idle_sum": 0.0, "idle_n": 0,
                      "idles": [], "idle_other": [], "qh": [], "cycles": 0, "cnc_alarms": 0, "tool_changes": 0, "offset_checks": 0, "estops": 0, "protective_stops": 0,
                      "mismatches": 0, "stops": 0, "jobs": 0, "violations": 0,
                      "lost": {c: 0.0 for c in LOSS_CAUSES}}
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
        self._mproc = {}                     # slot -> process of its machine (the E-stop throws into it)
        if not external:
            self._mproc["R1"] = self.spawn(self._run_machine("R1"), "R1")
        self.spawn(self._cnc_proc(), "CNC")
        if not external:
            for slot in ("CONV", "R2", "SUP", "SAF"):
                self._mproc[slot] = self.spawn(self._run_machine(slot), slot)
        self.spawn(self._operator_proc(), "operator")
        self.spawn(self._gauge_clock(), "gauge clock")
        self.spawn(self._tool_proc(), "tool")
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
        elif act == "safety":
            self.inputs["safety"] = True
            self.log("operator", "Operator resets the safety relay")
        else:
            raise ValueError("unknown action " + act)

    def inject_glitch(self, cp):
        self.cps[cp]["glitch"] = True
        self.log("info", f"Test: next {cp} reading of {self.cps[cp]['prox']} will be wrong (single glitch)")

    def inject_camera_wrong(self, cp):
        self.cps[cp]["cam_wrong"] = True
        self.log("info", f"Test: next {cp} answer of {self.cps[cp]['cam']} will be wrong with a valid image")

    def inject_stale_image(self, cp):
        self.cps[cp]["stale"] = True
        self.log("info", f"Test: next {cp} answer of {self.cps[cp]['cam']} will come from the previous image")

    def toggle_sensor_fault(self, cp, broken=False):
        """A dirty / misaligned sensor (cleaning repairs it) or, with broken=True, a broken one: its
        checkpoint test fails in the verification and the technician replaces it (A6.2)."""
        c = self.cps[cp]
        c["fault"] = not c["fault"]
        c["broken"] = c["fault"] and broken
        self.log("info", (f"Test: {c['prox']} broken (it misses the object; cleaning does not repair it)" if broken
                          else f"Test: {c['prox']} made faulty (dirty / misaligned: it misses the object)") if c["fault"]
                 else f"Test: {c['prox']} fault removed")

    def set_sensor_miss(self, cp, q):
        """An intermittent sensor (A5): it misses the object at each check with probability q, and
        its live reading follows the last check until the next one (q = 1 as toggle_sensor_fault)."""
        self.cps[cp]["miss"] = q
        self.log("info", f"Test: {self.cps[cp]['prox']} misses the object with probability {q:g} per check")

    def inject_bad_frame(self):
        self.inject["frames"]["CAM-1"] = 1
        self.log("info", "Test: the next CAM-1 image will be invalid once")

    def inject_camera_failure(self):
        self.inject["frames"]["CAM-2"] = 2
        self.log("info", "Test: CAM-2 will deliver two invalid images in a row")

    def inject_grip_miss(self):
        self.inject["grip_miss"] = True
        self.log("info", "Test: Robot 1 will miss its next pick")

    def inject_cnc_alarm(self):
        self.inject["cnc_alarm"] = True
        self.log("info", "Test: the CNC will raise an alarm in the middle of its running (or next) cycle")

    def inject_offset_error(self):
        self.cnc["offset_err"] = -1.85
        self.log("info", "Test: the tool offset is wrong by 1.85 mm: the next parts are 48.15 mm (still OK) until it is corrected")

    def inject_tool_life_end(self):
        self.vars["toolCount"] = self.RU["toolLife"] - 1
        self.log("info", "Test: the tool life counter is set to its last part")

    def press_estop(self, hold=60.0):
        """An E-stop button pressed for `hold` seconds; then the operator looks over the cell, resets the
        safety relay (T.safetyReset) and clears the faults (A6.5)."""
        self.spawn(self._estop_proc(hold), "E-stop")

    def inject_person(self, side, prot=20.0):
        """A person walks into the loading zone of side 1 (input pallet, SC-01) or 2 (output pallet,
        SC-02): warning field, `prot` seconds in the protective field, warning field, out (A6.5)."""
        self.spawn(self._person_proc(side, prot), "person")

    def inject_undersized(self):
        self.inject["under"] += 1
        self.log("info", "Test: the next part to finish will be undersized in one dimension")

    def inject_guard_band(self):
        self.inject["band"] += 1
        self.log("info", "Test: the next part to finish will be in the guard band (48.00–48.05 mm) in one dimension")

    def inject_master_fault(self):
        self.inject["master"] = True
        self.log("info", "Test: the next master check will read outside ± 0.010 mm")

    # ------------------------------------------------------------------ external controller (A3.3)
    def ext_job(self, slot, name):
        """Run a job the PLC started; ext["done"][slot] becomes the time it ended."""
        self.ext["done"][slot] = None

        def run():
            yield from self._run_job(slot, name)
            self.ext["done"][slot] = self.t
        self.spawn(run(), "job " + name)

    def ext_camera(self, cid):
        """Answer of the camera to a trigger at checkpoint cid: (valid image, fact seen, extra answer)."""
        cp = self.cps[cid]
        frames = self.inject["frames"]
        if frames[cp["cam"]] > 0:
            frames[cp["cam"]] -= 1
            return False, False, False
        t = self._truth(cid)
        cam = t
        if cp["cam_wrong"]:
            cam = not t
            cp["cam_wrong"] = False
        elif cp["stale"]:
            cam = cp["last"]["cam"] if cp["last"] else t
            cp["stale"] = False
        prox = self._prox_live(cid)
        cp["last"] = {"t": self.t, "prox": prox, "cam": cam, "agree": prox == cam}
        return True, cam, cid == "CP-1" and self._first_raw() >= 0

    def ext_state(self, slot, sid, fault=None):
        """Mirror the state of a PLC machine (and its fault, None = none)."""
        self.faults[slot] = fault
        if sid and sid != "F":
            self.mch[slot]["estop"] = False   # also for a machine without a running job (A6.5)
        if sid:
            self._set_state(slot, sid, "PLC")

    def kpis(self):
        st = self.stats
        util = st["run_time"] / (self.t - st["first_start"]) if st["first_start"] is not None and self.t > st["first_start"] else None
        mean_idle = st["idle_sum"] / st["idle_n"] if st["idle_n"] else None
        design_idle = self.M.KPI["idle2"]
        cycle = self.M.T["cncCycle"] + (mean_idle if mean_idle is not None else design_idle)
        return {
            "sim_time_h": self.t / 3600, "parts_on_pallet": self.ok_parts, "nok_parts": self.nok_parts,
            "cnc_cycles": st["cycles"], "cnc_utilization": util, "mean_cnc_idle_s": mean_idle,
            "design_cnc_idle_s": design_idle, "parts_per_hour": 3600 / cycle,
            "mismatches": st["mismatches"], "line_stops": st["stops"], "jobs": st["jobs"],
            "property_violations": st["violations"],
        }

    def measures(self):
        """The KPI measures of step A2.4 over the whole run (PROJECT_STATUS §5.15).

        Every instant in which the CNC is not machining is charged to one cause, the first of
        LOSS_CAUSES that applies at that instant (see _loss_cause)."""
        st, h = self.stats, self.t / 3600
        lost = dict(st["lost"])
        nominal = self.M.KPI["idle2"]
        return {
            "sim_time_h": h,
            "nominal_exchange_idle_s": nominal, "baseline_exchange_idle_s": self.M.BASELINE["idle"],
            "mean_cnc_idle_s": st["idle_sum"] / st["idle_n"] if st["idle_n"] else None,
            "machining_s": st["run_time"], "not_machining_s": self.t - st["run_time"],
            "machining_share": st["run_time"] / self.t if self.t else None,
            "parts_out": self.ok_parts + self.nok_parts, "good_parts": self.ok_parts,
            "parts_per_hour": (self.ok_parts + self.nok_parts) / h if h else None,
            "good_parts_per_hour": self.ok_parts / h if h else None,
            "lost_s": lost,
            "exchange_beyond_nominal_s": lost["exchange"] - st["idle_n"] * nominal,
        }

    def _loss_cause(self):
        """Why the CNC is not machining now: the first cause that applies."""
        if self.stats["first_start"] is None:
            return "start-up"
        if self.mch["SAF"]["state"] in ("S3", "S4", "S5") or any(f == ESTOP_MSG for f in self.faults.values()):
            return "safety stop"
        if any(self.faults.values()):
            return "fault"
        if self.cnc["state"] == "ALARM":
            return "CNC alarm"
        if self.ev("HOLD.req"):
            return "line stop"
        if self.vars["QH"]:
            return "quality hold"
        if self.mch["R1"]["state"] == "W3":
            return "tool change"
        if self.mch["R1"]["state"] == "W1":
            return "material shortage"
        if self.mch["R2"]["state"] == "E7":
            return "pallet change"
        return "exchange"

    # ================================================================== scheduler
    def spawn(self, gen, name=""):
        p = Proc(gen, name)
        self.procs.append(p)
        return p

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
                    self._cur = p
                    try:
                        p.wait = p.gen.send(None)
                    except StopIteration:
                        p.done = True
                        break
            self.procs = [p for p in self.procs if not p.done]
            if not self.external and self._eval_rungs():
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
            return c["state"] != "ALARM"
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
        if name == "GAUGE.due":
            return self.gauge["due"]
        if name == "GAUGE.valid":
            return self.gauge["valid"]
        if name == "GAUGE.ok":
            return self.gauge["ok"]
        if name == "GAUGE.warn":
            h = self.gauge["hist"]
            return len(h) >= self.RU["warnMean"] and sum(h) / len(h) < self.RU["warnLimit"]
        if name == "PE-65":
            return self.t - self.pe65 < 0.8
        if name == "TRUE.entryPart":
            return self._truth("CP-2")
        if name == "TRUE.outPallet":
            return self.pallet_out["present"]
        if name == "TRUE.r2Nok":
            return self._undersized(r2.hold["S"])
        if name == "TRUE.nestPart":
            return self._truth("CP-5")
        if name == "TRUE.brokenFound":
            return any(c["found"] for c in self.cps.values())
        if name == "ESTOP":
            return self.safety["estop"]
        if name in ("SC-01.warn", "SC-02.warn"):
            return self.safety["field"][int(name[4])] != "none"
        if name in ("SC-01.prot", "SC-02.prot"):
            return self.safety["field"][int(name[4])] == "prot"
        if name in ("R1.safeStop", "R2.safeStop"):
            r = r1 if name[1] == "1" else r2
            return self.safety["field"][int(name[1])] == "prot" and r.job is not None and r.zone == "pallet"
        if name == "TRUE.jobRuns":
            return any(self.mch[s]["job"] and self._rate(s, self._robot_of(self.mch[s]["job"])) > 0 for s in ("R1", "R2"))
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
        if name == "HMI.tool":
            return self.inputs["tool"]
        if name == "HMI.safety":
            return self.inputs["safety"]
        if name == "VERIFY.pass":
            return bool(self.verify and self.verify["done"])
        if name == "VERIFY.fail":
            return self.inputs["verify_fail"]
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
            if self.external:
                return self.ext["vars"].get(name, 0 if sig.get("num") else False)
            return len(self.events) if name == "mismatches" else self.vars[name]
        if kind == "input":
            return self._input(name, slot)
        return self._sense(name, slot)

    def ev(self, src, slot=None):
        return self.M.compile(src)(lambda n: self.read(n, slot))

    def output(self, name):
        if self.external:
            return bool(self.ext["out"].get(name))
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
            for j in p.get("start") or []:
                add(self._require(p, j))
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
                self.stop_reason = ((f"{self.ask_at}: proximity and camera disagree, the operator checks" if self.ask_at
                                     else f"{self.cam_fault or 'a camera'} gave two invalid images (camera fault)") if self.vars["CAM_FAULT"]
                                    else f"{len(self.events)} camera / proximity mismatches within 10 min ({self._window_summary()})")
            if (s.get("hmi") or {}).get("proc") == "verify":
                self._start_verify()
            if slot == "SAF" and sid == "S3":
                self.stats["protective_stops"] += 1
            if slot == "SAF" and sid == "S4":
                self._estop_all()
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
        self._set_state(slot, "H", (f"{self.ask_at} disagreement: line stop" if self.ask_at else f"{self.cam_fault or 'camera'} fault: line stop")
                        if self.vars["CAM_FAULT"] and not self.ev("lineStop")
                        else "LINE STOP from the cross-check supervisor")
        yield from self._run_steps(slot, m["hold"].get("do", []), False, 0)
        yield from self._resumable(slot, lambda: self._until(lambda: self.ev(m["hold"]["exit"], slot)))

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
                def check(st=st, i=i):
                    while True:
                        res = yield from self._check(st["check"], st.get("quick"), slot)
                        if res == "camfault":
                            return {"hold": True, "at": i}
                        if not st.get("until") or self.ev(st["until"], slot):
                            return None
                        if holdable and self.ev("HOLD.req", slot):
                            return {"hold": True}
                        yield from self._wait(self.T["check"])
                r = yield from self._resumable(slot, check)
                if r:
                    return r
                if st.get("confirm") and not self.ev(st["confirm"], slot):
                    return {"fault": f'missing confirmation at {st["check"]}: {self._missing(st["confirm"], slot)}'}
            elif "await" in st:
                def wait_for(cond=st["await"]):
                    while not self.ev(cond, slot):
                        if holdable and self.ev("HOLD.req", slot):
                            return {"hold": True}
                        yield ("c", lambda: self.ev(cond, slot) or (holdable and self.ev("HOLD.req", slot)), None)
                    return None
                r = yield from self._resumable(slot, wait_for)
                if r:
                    return r
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
        return (yield from self._resumable(slot, lambda: self._next_of(slot, sid, s, holdable)))

    def _next_of(self, slot, sid, s, holdable):
        """The first transition of state sid whose guard holds, a timed fault or a hold."""
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
        if v == "QH" and bool(val) != bool(before):
            if val:
                self.stats["qh"].append([self.t, None])
            elif self.stats["qh"]:
                self.stats["qh"][-1][1] = self.t
        if val is True and before is not True and self.M.SIGNALS[v].get("logOn"):
            self.log("quality" if v == "QH" else "info", self.M.SIGNALS[v]["logOn"])
        if v == "CAM_FAULT" and not val:
            self.cam_fault = None
            self.ask_at = None

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
                self.log("quality" if "QH" in r["set"] else "operator", r["text"])
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
        drawn = None
        if isinstance(self.T, _Times):
            drawn = self.T.job[self._cur] = {}
        cur = self._cur
        nominal = yield from self._drive(self.JOB[name](r), slot, r)
        if drawn is not None:
            del self.T.job[cur]
        if r:
            r.zone = "free"
            r.job = None
        self.mch[slot]["job"] = None
        self.stats["jobs"] += 1
        # with random times the job must take the sum of the times drawn for its components; a job slowed
        # or stopped by the safety functions (A6.5) takes that time of robot motion
        want = self.M.job_time(name) if drawn is None else sum(drawn.get(k, math.nan) for k in self.M.JOBS[name]["time"])
        if not abs(nominal - want) <= 0.011:
            self.errors.append(f"job {name}: {nominal:.3f} s in the simulation, {want} s in the model")

    # ================================================================== safety status (A6.5)
    def _robot_of(self, job):
        rb = self.M.JOBS[job]["robot"]
        return self.r1 if rb == "R1" else self.r2 if rb == "R2" else None

    def _estop_on(self):
        return self.mch["SAF"]["state"] in ("S4", "S5")

    def _rate(self, slot, r):
        """Speed of the jobs of a machine: 0 while the E-stop holds them or the robot is in a protective
        stop, 1 / reducedSpeed while a person is in the warning field of its loading side, else 1."""
        if self.mch[slot].get("estop") or self._estop_on():
            return 0.0
        if r is None:
            return 1.0
        f = self.safety["field"][1 if r is self.r1 else 2]
        if f == "prot" and r.zone == "pallet":
            return 0.0
        return 1.0 / self.RU["reducedSpeed"] if f != "none" else 1.0

    def _retime(self, slot, k):
        """The rate of the jobs of a machine changed to k: the door slide of Robot 1 follows it."""
        a = self.door["anim"]
        if slot == "R1" and a:
            a["p"], a["ts"], a["k"] = self._anim_u(a), self.t, k

    def _drive(self, gen, slot, r):
        """Run the plant side of a job; its time waits advance at the rate of the machine (_rate).
        Returns the time of robot motion it took (the sum of its waits at full speed)."""
        nominal, k = 0.0, None
        try:
            w = next(gen)
        except StopIteration:
            return 0.0
        while True:
            if w[0] == "t":
                rem = w[1] - self.t
                nominal += max(rem, 0.0)
                first = True
                while rem > EPS:
                    k2 = self._rate(slot, r)
                    if k is not None and k2 != k:
                        self._retime(slot, k2)
                    k = k2
                    if k == 0:
                        yield from self._paused(slot, r)
                        first = False
                        continue
                    t0 = self.t
                    until = w[1] if first and k == 1 else t0 + rem / k
                    first = False
                    yield ("c", lambda k=k: self._rate(slot, r) != k, until)
                    rem = 0.0 if self.t >= until - EPS else rem - (self.t - t0) * k
            else:
                yield w
            try:
                w = gen.send(None)
            except StopIteration:
                return nominal

    def _paused(self, slot, r):
        if self.mch[slot].get("estop"):
            # the job stays where the E-stop stopped it until the relay is reset and the fault cleared
            yield from self._estop_wait(slot)
            return
        yield from self._until(lambda: self._rate(slot, r) > 0)

    def _resumable(self, slot, make):
        """Run make() (a waiting step of a machine); when the E-stop interrupts it (EStop), wait in F
        for the reset and the clear, then run it again: the machine continues where it stopped."""
        while True:
            try:
                return (yield from make())
            except EStop:
                yield from self._estop_wait(slot)

    def _estop_wait(self, slot):
        x = self.mch[slot]
        if self.external:
            # the PLC takes the machine out of F itself (eRes); ext_state ends the wait
            yield from self._until(lambda: not x["estop"])
            return
        exit_expr = self._machine(slot)["fault"]["exit"]
        yield from self._until(lambda: self.ev(exit_expr, slot))
        x["estop"] = False
        self.faults[slot] = None
        self._set_state(slot, x["estop_sid"], "E-stop reset and fault cleared · the machine continues where it stopped")

    def _estop_all(self):
        """SAF entered S4: every machine with fault.force goes to F where it is. A running job stops (rate 0)
        and goes on after the reset; a waiting step is interrupted (EStop) and run again after it."""
        self.stats["estops"] += 1
        for slot, x in self.mch.items():
            m = self._machine(slot)
            if not (m.get("fault") or {}).get("force") or x["state"] in ("", "F"):
                continue
            x["estop"], x["estop_sid"] = True, x["state"]
            self.faults[slot] = ESTOP_MSG
            self._set_state(slot, "F", ESTOP_MSG)
            self.log("fault", f'{slot}: {ESTOP_MSG}' + (f' during "{self.M.JOBS[x["job"]]["text"]}"' if x["job"] else "")
                     + " → FAULT; it continues where it stopped after the reset and the clear")
            if not x["job"] and slot in self._mproc:
                p = self._mproc[slot]
                try:
                    p.wait = p.gen.throw(EStop())
                except StopIteration:
                    p.done = True

    def _estop_proc(self, hold):
        self.safety["estop"] = True
        self.log("fault", "E-stop button pressed")
        yield from self._wait(hold)
        self.safety["estop"] = False
        self.log("operator", "E-stop button released")
        yield from self._wait(self.T["safetyReset"])
        self.press("safety")
        yield from self._until(lambda: not self._estop_on())
        self.inputs["clear_at"] = self.t
        self.log("operator", "Operator clears the faults after the E-stop")

    def _person_proc(self, side, prot):
        f, tag = self.safety["field"], f"SC-0{side}"
        f[side] = "warn"
        self.log("operator", f"A person enters the loading zone of side {side} ({tag} warning field)")
        yield from self._wait(PERSON_WALK)
        f[side] = "prot"
        yield from self._wait(prot)
        f[side] = "warn"
        yield from self._wait(PERSON_WALK)
        f[side] = "none"
        self.log("operator", f"The person has left the loading zone of side {side}")

    # ================================================================== property monitors (same properties as the verifier)
    def _props(self):
        return list(self.M.PROPERTIES)

    def _violated(self, p):
        self.stats["violations"] += 1
        self.log("fault", f"PROPERTY {p['id']} VIOLATED: {p['text']}")
        self.errors.append(f"property {p['id']} violated at t = {self.t:.2f} s: {p['text']}")

    @staticmethod
    def _require(p, job):
        return p["require"] if isinstance(p["require"], str) else p["require"][job]

    def _monitor_start(self, job):
        for p in self._props():
            if job in (p.get("start") or []) and not self.ev(self._require(p, job)):
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
        c = self.cps[cp]
        return False if c["fault"] or c["miss_now"] else self._truth(cp)

    def _check(self, cid, quick, slot):
        """Both sources must agree; if not, the mismatch is counted and the rule of the checkpoint gives
        the value used (camera, prox, present, absent; ask = line stop until the operator has looked,
        then the check is repeated). An invalid image is re-triggered once; a second one is a camera
        fault (line stop)."""
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
        if cp["miss"]:
            cp["miss_now"] = self._miss_rnd.random() < cp["miss"]
        prox = False if cp["fault"] or cp["miss_now"] else t
        if cp["glitch"]:
            prox = not prox
            cp["glitch"] = False
        cam = t
        if cp["cam_wrong"]:                       # valid image, wrong answer
            cam = not t
            cp["cam_wrong"] = False
        elif cp["stale"]:                         # the previous image again
            cam = cp["last"]["cam"] if cp["last"] else t
            cp["stale"] = False
        cp["last"] = {"t": self.t, "prox": prox, "cam": cam, "agree": prox == cam}
        if prox != cam and cp["rule"] == "ask":
            cp["count"] += 1
            self.stats["mismatches"] += 1
            self.ask_at = cid
            self._set_var("CAM_FAULT", True)
            self.log("stop", f"{cid} {cp['where']}: {cp['prox']} = {'ON' if prox else 'OFF'} but {cp['cam']} sees "
                     f"{self._cam_word(cid, cam)} → line stop, the operator checks {cp['where'].lower()}")
            return "camfault"
        used = cam if prox == cam else FUSE[cp["rule"]](prox, cam)
        if prox != cam:
            self._mismatch(cp, prox, cam, used)
        res = self.cp_result.setdefault(slot, {})
        res[cid] = used
        if cid == "CP-1":
            res["CAM-1.part"] = used and self._first_raw() >= 0
        return used

    @staticmethod
    def _cam_word(cid, v):
        return ("a pallet" if v else "no pallet") if cid in ("CP-1", "CP-4") else ("a part" if v else "no part")

    def _mismatch(self, cp, prox, cam, used):
        cp["count"] += 1
        self.stats["mismatches"] += 1
        self.events.append({"t": self.t, "cp": cp["id"], "tag": cp["prox"]})
        self._prune_window()
        how = RULE_WORD[cp["rule"]] if cp["rule"] in ("camera", "prox") else f"{RULE_WORD[cp['rule']]} ({self._cam_word(cp['id'], used)})"
        self.log("mismatch", f"{cp['id']} {cp['where']}: {cp['prox']} = {'ON' if prox else 'OFF'} but {cp['cam']} sees "
                 f"{self._cam_word(cp['id'], cam)} → {how} ({len(self.events)} of {self.RU['mismatchLimit']} in 10 min)")

    def _window_summary(self):
        c = {}
        for e in self.events:
            c[e["tag"]] = c.get(e["tag"], 0) + 1
        return ", ".join(f"{k} ×{v}" for k, v in c.items())

    def _prune_window(self):
        self.events = [e for e in self.events if self.t - e["t"] <= self.RU["mismatchWindow"]]

    # ================================================================== sensor verification (technician)
    def _start_verify(self):
        faulty = [c["prox"] for c in self.cps.values() if (c["fault"] and not c["broken"]) or c["miss"]]
        tags = list(dict.fromkeys([e["tag"] for e in self.events] + faulty))
        steps = []
        if tags:
            steps.append(f"Inspect {', '.join(tags)}: " + (f"dirty / misaligned lens found on {', '.join(faulty)} → cleaned and realigned" if faulty else "lens cleaned, bracket tight"))
        if self.cam_fault:
            steps.append(f"{self.cam_fault}: cable reseated, lens cleaned, trigger test OK")
        steps.append("Check brackets and the alignment LEDs of the through-beams")
        for c in self.cps.values():
            if c["broken"]:
                steps.append(f"Test {c['id']} with a test part: {c['prox']} does not switch → test FAILED, sensor replaced and re-tested")
            else:
                steps.append(f"Test {c['id']} with a test part: {c['prox']} ON and {c['cam']} part · removed: both OFF")
        steps.append("Camera calibration target: CAM-1 and CAM-2 position error < 1 mm")
        steps.append("Master cube 50.000 mm: LS-61 / LS-62 / LS-63 within ±0.010 mm")
        self.verify = {"steps": steps, "i": 0, "done": False}
        self.log("stop", "Sensor verification started: all equipment stopped, technician in the cell")
        if self.instant_verify and not any(c["broken"] for c in self.cps.values()):
            self._finish_verify()
        else:
            self.spawn(self._technician(), "technician")

    def _technician(self):
        """Steps of the verification at verify_step_time each (none with instant_verify); a broken
        sensor fails its test (VERIFY.fail), is replaced in T.sensorReplace and passes the re-test."""
        v = self.verify
        step = 0.0 if self.instant_verify else self.verify_step_time
        while v is self.verify and not v["done"]:
            yield from self._wait(step)
            if v is not self.verify:
                return
            text = v["steps"][min(v["i"], len(v["steps"]) - 1)]
            c = next((c for c in self.cps.values() if c["broken"] and text.startswith(f"Test {c['id']} ")), None)
            if c:
                yield from self._replace_sensor(c)
                if v is not self.verify:
                    return
            v["i"] += 1
            if v["i"] >= len(v["steps"]):
                self._finish_verify()

    def _replace_sensor(self, c):
        c["found"] = True
        self.inputs["verify_fail"] = True
        self.log("stop", f"Test of {c['id']} FAILED: {c['prox']} does not switch (broken) → the technician replaces it")
        yield from self._wait(self.T["sensorReplace"])
        c["broken"] = c["found"] = c["fault"] = False
        self.log("stop", f"{c['prox']} replaced and aligned; {c['id']} re-tested: OK")

    def _finish_verify(self):
        self.verify["i"] = len(self.verify["steps"])
        self.verify["done"] = True
        for c in self.cps.values():                     # the technician repaired the sensors
            c["fault"] = c["broken"] = c["found"] = False
            c["miss"], c["miss_now"] = 0.0, False
            c["glitch"] = False
            c["cam_wrong"] = False
            c["stale"] = False
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

    def _anim_u(self, a):
        # progress of a slide: p at time ts, advancing at rate k over the full-speed duration D (A6.5)
        return min(1.0, max(0.0, a["p"] + (self.t - a["ts"]) * a["k"] / a["D"]))

    def _door_pos(self):
        a = self.door["anim"]
        if not a:
            return self.door["pos"]
        return a["from"] + (a["to"] - a["from"]) * ease(self._anim_u(a))

    def _move(self, r, to, dur):
        if not dur > 0:
            r.pos, r.moving = to, False
            return
        r.moving = True
        yield from self._wait(dur)
        r.pos, r.moving = to, False

    def _slide_door(self, r, frm, to, approach, t_key):
        k = self.T[t_key] / 4.0              # 0.5 s to the handle, 3 s of travel, 0.5 s to let go (nominal 4 s)
        yield from self._move(r, "handle", approach + 0.5 * k)
        self.door["anim"] = {"from": frm, "to": to, "ts": self.t, "p": 0.0, "k": self._rate("R1", r), "D": 3.0 * k}
        yield from self._move(r, "handle", 3.0 * k)
        self.door["pos"], self.door["anim"] = to, None
        yield from self._wait(0.5 * k)

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
            yield from self._wait(T["blowOff"])            # YV-66: chips and coolant off the nest and the part
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
            # each laser reads the distance to the free face; size = 50.000 + (d master - d part)
            RU = self.RU
            d_part = [RU["masterDist"] - (v - RU["nominal"]) - (self.rnd.random() - 0.5) * 0.004 for v in p.dims]
            p.meas = [RU["nominal"] + (self.gauge["d_master"][i] - d) for i, d in enumerate(d_part)]
            m = p.meas
            lo, hi = RU["validRange"]
            self.gauge["valid"] = all(lo <= v <= hi for v in m)
            if not self.gauge["valid"]:
                self.log("measure", f"Part #{p.id}: reading outside {lo}–{hi} mm → invalid, not a part size")
                return
            accept = RU["minSize"] + RU["guardBand"]
            self.gauge["ok"] = all(v >= accept for v in m)
            self.gauge["hist"] = (self.gauge["hist"] + [min(m)])[-RU["warnMean"]:]
            verdict = (f"OK, all ≥ {accept:.2f}" if self.gauge["ok"]
                       else "NOK, undersized" if any(v < RU["minSize"] for v in m) else "NOK, rejected in guard band")
            self.log("measure", f"Part #{p.id}: L {m[0]:.3f} · W {m[1]:.3f} · H {m[2]:.3f} mm → {verdict}")

        def master(r):
            RU = self.RU
            yield from self._move(r, "nest", T["r2Master"] * 0.3)
            yield from self._wait(T["r2Master"] * 0.4)
            read = [50.001, 49.999, 50.000]
            if self.inject["master"]:
                self.inject["master"] = False
                read[0] = 50.023
            ok = all(abs(v - RU["nominal"]) <= RU["masterTol"] + 1e-9 for v in read)
            self.gauge["zeroed"] = ok
            if ok:
                self.gauge["due"] = False
                self.gauge["d_master"] = [RU["masterDist"]] * 3
                self.gauge["master_at"] = self.t
            self.log("measure" if ok else "fault",
                     f"Master cube 50.000 mm: LS-61 {read[0]:.3f} · LS-62 {read[1]:.3f} · LS-63 {read[2]:.3f} mm → "
                     + ("gauge OK" if ok else "outside ± 0.010 mm: gauge FAULT, no part is measured"))
            yield from self._move(r, "nest_out", T["r2Master"] * 0.3)

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
            "R1.openDoor": lambda r: self._slide_door(r, 0.0, 1.0, 0.0, "doorOpen"),
            "R1.closeDoor": lambda r: self._slide_door(r, 1.0, 0.0, 0.0, "doorClose"),
            "DOOR.lock": door_lock, "CNC.start": cnc_start,
            "R1.toConveyorB": to_conveyor,
            "R1.placeConvB": lambda r: self._place_on_belt(r, "B"),
            "R1.pickRawA": lambda r: self._pick_raw(r, "A"),
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
            self.log("fault", f"GR-21{g}: fingers fully closed, no part at the input pallet")
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
                # time of this idle charged to a cause other than the exchange (a pallet change, a fault…)
                st["idle_other"].append(sum(v for k, v in st["lost"].items() if k != "exchange") - c["lost_at_done"])
            if st["first_start"] is None:
                st["first_start"] = self.t
            c["state"], c["run_start"] = "RUN", self.t
            while True:
                # an injected alarm (A6.3) stops the cycle at its half (one injected after the half
                # stops the next cycle): spindle stopped, door stays locked; after the reset the
                # program restarts from the start with the same part
                cycle = self.T["cncCycle"]
                end, half = self.t + cycle, self.t + cycle / 2
                yield ("c", lambda: (self.inject["cnc_alarm"] and self.t < half - EPS) or self._estop_on(), end)
                if self._estop_on():
                    # the E-stop puts the CNC into feed hold at once: an alarm as in A6.3 (A6.5)
                    self.log("fault", "E-stop → CNC feed hold: spindle stopped, CNC not ready (alarm), door stays locked")
                elif self.t >= end - EPS:
                    break
                else:
                    yield ("t", half)
                    self.inject["cnc_alarm"] = False
                    st["cnc_alarms"] += 1
                    self.log("fault", "CNC ALARM in the cycle → spindle stopped, CNC not ready, door stays locked")
                # the faces cut so far are cut again (in air): this time is lost, not machining
                st["run_time"] -= self.t - c["run_start"]
                st["lost"]["CNC alarm"] += self.t - c["run_start"]
                c["state"] = "ALARM"
                yield from self._wait(self.T["cncReset"])
                yield from self._until(lambda: not self._estop_on())
                self.log("operator", "Operator removed the cause and reset the CNC alarm → the program restarts with the same part")
                c["state"], c["run_start"] = "RUN", self.t
            p = c["part"]
            if p:
                p.st = "fin"
                # mean size: the offset drift since the last tool change or offset correction, and an
                # injected offset error (A6.4)
                mean = 50 - self.RU["offsetDrift"] * c["drift_n"] + c["offset_err"]
                c["drift_n"] += 1
                p.dims = [mean + (self.rnd.random() - 0.5) * 0.04 for _ in range(3)]
                if self.inject["under"] > 0:
                    self.inject["under"] -= 1
                    p.dims[int(self.rnd.random() * 3)] = 47.35 + self.rnd.random() * 0.5
                elif self.inject["band"] > 0:
                    self.inject["band"] -= 1
                    p.dims[int(self.rnd.random() * 3)] = 48.01 + self.rnd.random() * 0.03
                elif self.nok_rate and self._nok_rnd.random() < self.nok_rate:
                    p.dims[int(self._nok_rnd.random() * 3)] = 47.35 + self._nok_rnd.random() * 0.5
            c["state"], c["done_at"] = "DONE", self.t
            c["lost_at_done"] = sum(v for k, v in st["lost"].items() if k != "exchange")
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

    def _gauge_clock(self):
        """The master check is due RULES.masterEvery after the last passed one."""
        g = self.gauge
        while True:
            yield from self._until(lambda: g["zeroed"] and not g["due"])
            at = g["master_at"]
            yield from self._wait(at + self.RU["masterEvery"] - self.t)
            if g["zeroed"] and not g["due"] and g["master_at"] == at:
                g["due"] = True
                self.log("measure", "4 h since the last master check → master check due")

    def _reset_offset(self):
        self.cnc["drift_n"], self.cnc["offset_err"] = 0, 0.0
        self.gauge["hist"] = []

    def _tool_proc(self):
        """Operator at the CNC (A6.4): changes the tool when Robot 1 waits for it and confirms on the HMI;
        corrects the tool offset after a size warning (no stop). Both reset the size drift."""
        RU, st = self.RU, self.stats
        while True:
            yield from self._until(lambda: self.state("R1") == "W3" or self.read("GAUGE.warn"))
            if self.state("R1") == "W3":
                yield from self._wait(self.T["toolChange"])
                self._reset_offset()
                st["tool_changes"] += 1
                self.log("operator", f"Operator changed the tool ({RU['toolLife']} parts) and confirmed → tool life counter reset")
                self.inputs["tool"] = True
                yield from self._until(lambda: self.state("R1") != "W3")
            else:
                self.log("operator", f"Size warning: mean of the last {RU['warnMean']} sizes below {RU['warnLimit']:.2f} mm → operator checks the offset")
                yield from self._wait(self.T["offsetCheck"])
                self._reset_offset()
                st["offset_checks"] += 1
                self.log("operator", "Operator measured a part and corrected the tool offset → size drift reset, warning cleared")

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
        else:
            self.stats["lost"][self._loss_cause()] += h
        self._prune_window()

    # ================================================================== log
    def log(self, cat, msg):
        self.logs.append((self.t, cat, msg))
