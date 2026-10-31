"""Comparison of the PLC run with the model (step A3.4, PROJECT_STATUS.md §5.16).

The same scenario is run twice: by the Python interpreter of the model (the reference) and by the PLC
program in OpenPLC against the plant (plc_bridge.py). Both runs use the Driver below, so the
disturbances and the operator act on the same events, not at fixed instants: the PLC run lags the
model by a growing amount (scan, polling and handshakes), and a disturbance at a fixed instant could
hit a different check in each run.

    python -m cellsim.plc_compare ref --scenario camwrong --seconds 3900 --out ref.json
    python -m cellsim.plc_compare compare ref.json plc_run.json

Criterion (§5.16 point 11): for every machine the PLC makes the same sequence of state changes as the
model; the lag of a change (PLC instant minus model instant, both from the first change of the run)
may exceed the largest lag of all earlier changes by at most the bound of that change, and is never
negative beyond one bridge cycle. The bound of a change grows with the handshakes of the state left.
"""
import argparse
import json
import sys

from .sim import CellSim
from .scenarios import conformance

# disturbance -> (machine, state, n): applied when the machine enters that state for the n-th time.
# The camwrong list follows the instants of trace.py (300 s, 600 s, ...: one R1 cycle is about 141 s);
# the glitch is applied when the conveyor enters C4, the state whose CP-3 check it must hit.
SCENARIOS = {
    "nominal": [],
    "cp2fault": [(("R1", "B2", 4), "fault", "CP-2")],
    "camwrong": [(("R1", "B2", 4), "camwrong", "CP-4"), (("R1", "B2", 6), "stale", "CP-2"),
                 (("R1", "B2", 8), "camwrong", "CP-3"), (("R1", "B2", 10), "camwrong", "CP-5"),
                 (("R1", "B2", 12), "camwrong", "CP-1"), (("R1", "B2", 14), "stale", "CP-4"),
                 (("R1", "B2", 16), "camwrong", "CP-2"), (("CONV", "C4", 17), "glitch", "CP-3")],
}
OPERATOR_DELAY = 5.0       # s from the state that needs the operator to the button
BRIDGE_CYCLE = 0.02        # s, upper bound of one bridge cycle (Modbus poll + exchange)
BASE_BOUND = 0.05          # s per state change: one scan, one poll, one bridge cycle
HANDSHAKE_BOUND = 0.15     # s per job or check of the state left: debounce, three scans, two polls


class Driver:
    """Disturbances and operator of a scenario; works on a CellSim in either mode (the reference
    interpreter or the plant of the PLC run), from its trace and states only."""

    def __init__(self, scenario):
        self.todo = list(SCENARIOS[scenario])
        self.seen, self.count, self.done = 0, {}, {}
        self.actions = []

    def step(self, sim):
        for e in sim.trace[self.seen:]:
            key = (e["slot"], e["to"])
            self.count[key] = self.count.get(key, 0) + 1
            for item in list(self.todo):
                (slot, sid, n), kind, cp = item
                if (slot, sid) == key and self.count[key] == n:
                    {"fault": sim.toggle_sensor_fault, "camwrong": sim.inject_camera_wrong,
                     "stale": sim.inject_stale_image, "glitch": sim.inject_glitch}[kind](cp)
                    self.actions.append([round(sim.t, 3), kind, cp])
                    self.todo.remove(item)
        self.seen = len(sim.trace)
        # the operator: clears a FAULT, asks for the verification, resets the line, each once per entry
        for slot in sim.M.SLOTS:
            x = sim.mch[slot]
            if x["state"] == "F" and sim.t - x["since"] >= OPERATOR_DELAY:
                self._press(sim, "clear", ("F", slot, x["since"]))
        x = sim.mch["SUP"]
        if x["state"] == "X3" and sim.t - x["since"] >= OPERATOR_DELAY:
            self._press(sim, "verify", ("X3", x["since"]))
        if x["state"] == "X4" and sim.verify and sim.verify["done"] and sim.t - x["since"] >= OPERATOR_DELAY:
            self._press(sim, "resume", ("X4", x["since"]))

    def _press(self, sim, act, key):
        if key in self.done:
            return
        self.done[key] = True
        sim.press(act)
        self.actions.append([round(sim.t, 3), act, key[1] if act == "clear" else ""])


def reference(scenario, seconds, seed=1, dt=0.01):
    """The scenario run by the Python interpreter of the model, with the driver every dt seconds."""
    sim = CellSim(seed=seed, instant_verify=True)
    drv = Driver(scenario)
    while sim.t < seconds:
        drv.step(sim)
        sim.advance(dt)
    return result(sim, drv, scenario, seed)


def result(sim, drv, scenario, seed):
    errs, _ = conformance(sim)
    return {"scenario": scenario, "seed": seed, "seconds": round(sim.t, 3), "cycles": sim.stats["cycles"],
            "trace": [[round(e["t"], 3), e["slot"], e["from"], e["to"]] for e in sim.trace],
            "actions": drv.actions, "pending": [list(x) for x in drv.todo], "conformance": errs,
            "errors": sim.errors, "violations": sim.stats["violations"]}


def handshakes(M, slot, sid):
    """Jobs and checks of a state (upper bound of the handshakes before it is left)."""
    if sid in ("", "H", "F"):
        return 1
    mk = next(k for k in M.SETUP_MACHINES["2"] if M.MACHINES[k]["slot"] == slot)
    s = M.MACHINES[mk]["states"].get(sid) or {}
    return sum(1 for st in s.get("do", []) if "job" in st or "check" in st)


def compare(ref, plc, M):
    """Report of the comparison; ok when the sequences agree and every lag is within its bound."""
    rows, problems = [], []
    t0r = ref["trace"][0][0] if ref["trace"] else 0.0
    t0p = plc["trace"][0][0] if plc["trace"] else 0.0
    by = lambda tr: {s: [e for e in tr if e[1] == s] for s in M.SLOTS}
    r_by, p_by = by(ref["trace"]), by(plc["trace"])
    for s in M.SLOTS:
        r, p = r_by[s], p_by[s]
        for k, e in enumerate(p):
            if k >= len(r):
                problems.append(f"{s}: change {k + 1} {e[2] or '(start)'} -> {e[3]} of the PLC is not in the reference")
                break
            if (e[2], e[3]) != (r[k][2], r[k][3]):
                problems.append(f"{s}: change {k + 1} differs: PLC {e[2] or '(start)'} -> {e[3]} at {e[0]:.2f} s, "
                                f"model {r[k][2] or '(start)'} -> {r[k][3]} at {r[k][0]:.2f} s")
                break
            rows.append({"slot": s, "from": e[2], "to": e[3], "tm": r[k][0] - t0r, "tp": e[0] - t0p,
                         "bound": BASE_BOUND + HANDSHAKE_BOUND * handshakes(M, s, e[2])})
    rows.sort(key=lambda x: (x["tm"], x["tp"]))
    run_max, worst = 0.0, None
    for x in rows:
        x["lag"] = x["tp"] - x["tm"]
        x["inc"] = x["lag"] - run_max
        if x["inc"] > x["bound"]:
            problems.append(f"{x['slot']} {x['from'] or '(start)'} -> {x['to']} at {x['tm']:.2f} s (model): lag "
                            f"{x['lag']:.3f} s, {x['inc']:.3f} s above the earlier lags, bound {x['bound']:.2f} s")
        if x["lag"] < -BRIDGE_CYCLE:
            problems.append(f"{x['slot']} {x['from'] or '(start)'} -> {x['to']} at {x['tm']:.2f} s (model): the PLC is "
                            f"{-x['lag']:.3f} s ahead of the model")
        if worst is None or x["inc"] - x["bound"] > worst["inc"] - worst["bound"]:
            worst = x
        run_max = max(run_max, x["lag"])
    # the PLC run must cover the reference up to its own end minus its lag
    t_end = plc["seconds"] - run_max - 10
    for s in M.SLOTS:
        missing = [e for e in r_by[s][len(p_by[s]):] if e[0] - t0r < t_end]
        if missing:
            problems.append(f"{s}: {len(missing)} changes of the model before {t_end:.0f} s are missing in the PLC run "
                            f"(first {missing[0][2] or '(start)'} -> {missing[0][3]} at {missing[0][0]:.2f} s)")
    for name, run in (("model", ref), ("PLC", plc)):
        if run.get("pending"):
            problems.append(f"{name}: disturbances not applied: {run['pending']}")
        if run.get("conformance"):
            problems.append(f"{name}: {len(run['conformance'])} changes are not transitions of the model: {run['conformance'][:3]}")
    incs = sorted(x["inc"] for x in rows)
    return {"ok": not problems, "problems": problems, "changes": len(rows),
            "model_changes": len(ref["trace"]), "plc_changes": len(plc["trace"]),
            "final_lag_s": round(rows[-1]["lag"], 3) if rows else None, "max_lag_s": round(run_max, 3),
            "max_inc_s": round(incs[-1], 3) if incs else None,
            "p99_inc_s": round(incs[int(0.99 * (len(incs) - 1))], 3) if incs else None,
            "closest_to_bound": worst and {k: (round(v, 3) if isinstance(v, float) else v) for k, v in worst.items()},
            "actions": {"model": ref["actions"], "PLC": plc["actions"]}}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ref", help="run the reference")
    a.add_argument("--scenario", choices=SCENARIOS, default="nominal")
    a.add_argument("--seconds", type=float, default=3900)
    a.add_argument("--seed", type=int, default=1)
    a.add_argument("--out", default="ref.json")
    c = sub.add_parser("compare", help="compare a PLC run with its reference")
    c.add_argument("ref")
    c.add_argument("plc")
    c.add_argument("--out", default="compare.json")
    args = ap.parse_args()
    if args.cmd == "ref":
        r = reference(args.scenario, args.seconds, args.seed)
        with open(args.out, "w") as f:
            json.dump(r, f, indent=1)
        print(f"reference {args.scenario}: {r['seconds']} s, {len(r['trace'])} state changes, {r['cycles']} CNC cycles, "
              f"{len(r['conformance'])} non-conforming changes, {len(r['errors'])} errors, {r['violations']} violations")
        return
    with open(args.ref) as f:
        ref = json.load(f)
    with open(args.plc) as f:
        plc = json.load(f)
    rep = compare(ref, plc, CellSim(seed=1, external=True).M)
    with open(args.out, "w") as f:
        json.dump(rep, f, indent=1)
    print(f"{plc.get('scenario')}: {rep['changes']} state changes compared ({rep['plc_changes']} in the PLC run, "
          f"{rep['model_changes']} in the reference); final lag {rep['final_lag_s']} s, largest increment "
          f"{rep['max_inc_s']} s (99 % below {rep['p99_inc_s']} s)")
    print("closest to its bound:", rep["closest_to_bound"])
    print("result:", "PASS" if rep["ok"] else "FAIL", *rep["problems"][:20], sep="\n  ")
    sys.exit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
