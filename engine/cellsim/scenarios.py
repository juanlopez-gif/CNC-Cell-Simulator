"""Long runs with random disturbances, and the conformance check against the model.

run_random drives a cell like the conformance test of the browser simulator (source/test_sim.js):
every 10 s of simulated time it may inject a disturbance (sensor glitch or fault, bad camera
frame, camera failure, missed pick, undersized part) or send the operator away, and an operator
and a technician answer the HMI (clear a fault after 60 s, release a quality hold after 120 s,
start the sensor verification and reset the line).
"""
import random

from .sim import CellSim


def run_random(setup, hours, faults=True, seed=1, model=None, step=10.0):
    """setup must be 2 (kept as a parameter for the callers)."""
    rnd = random.Random(seed)
    sim = CellSim(setup=setup, seed=seed, model=model, instant_verify=True)
    injected, actions = {}, {"clear": 0, "verify": 0, "reset": 0, "release": 0}

    def inj(k):
        injected[k] = injected.get(k, 0) + 1
    fault_since = qh_since = None
    t = 0.0
    while t < hours * 3600:
        sim.advance(step)
        t += step
        if faults and rnd.random() < 0.012:                     # about one disturbance every 14 min
            k = rnd.random()
            cps = ["CP-1", "CP-2", "CP-3", "CP-4", "CP-5"]
            cp = cps[int(rnd.random() * len(cps))]
            if k < 0.3:
                sim.inject_glitch(cp); inj("glitch")
            elif k < 0.45:
                sim.toggle_sensor_fault(cp); inj("sensor fault")
            elif k < 0.6:
                sim.inject_bad_frame(); inj("bad frame")
            elif k < 0.7:
                sim.inject_camera_failure(); inj("camera failure")
            elif k < 0.85:
                sim.inject_grip_miss(); inj("grip miss")
            else:
                sim.inject_undersized(); inj("undersized part")
        # the operator is sometimes away: the input pallet runs empty (Robot 1 waits in W1)
        if faults and rnd.random() < 0.003:
            sim.auto_operator = not sim.auto_operator
            inj("operator back" if sim.auto_operator else "operator away")
        if any(sim.faults.values()):
            fault_since = sim.t if fault_since is None else fault_since
            if sim.t - fault_since > 60:
                sim.press("clear"); actions["clear"] += 1; fault_since = None
        else:
            fault_since = None
        if sim.vars["QH"]:
            qh_since = sim.t if qh_since is None else qh_since
            if sim.t - qh_since > 120:
                sim.press("qh"); actions["release"] += 1; qh_since = None
        else:
            qh_since = None
        if sim.state("SUP") == "X3" and not sim.inputs["verify"]:
            sim.press("verify"); actions["verify"] += 1
        if sim.state("SUP") == "X4" and sim.verify and sim.verify["done"] and not sim.inputs["reset"]:
            sim.press("resume"); actions["reset"] += 1
    return sim, injected, actions


def conformance(sim):
    """Every state change of the run must be a transition of the model (or an entry into / exit
    from HOLD and FAULT). Returns (errors, states never visited per machine)."""
    M = sim.M
    by_slot = {M.MACHINES[k]["slot"]: k for k in M.SETUP_MACHINES[str(sim.setup)]}

    def resolve(m, target, out):
        s = m["states"].get(target)
        if s and s.get("choice"):
            resolve(m, s["yes"], out)
            resolve(m, s["no"], out)
        else:
            out.add(target)
        return out

    def successors(mk, sid):
        m, out = M.MACHINES[mk], set()
        for tr in m["states"][sid].get("next", []):
            resolve(m, tr["to"], out)
        return out
    errs, base, visited = [], {}, {}
    for e in sim.trace:
        mk = by_slot[e["slot"]]
        m = M.MACHINES[mk]
        visited.setdefault(mk, set()).add(e["to"])
        bad = f'{mk}: {e["from"] or "(start)"} -> {e["to"]} at t = {e["t"]:.1f} s is not a transition of the model'
        if not e["from"]:
            if e["to"] not in resolve(m, m["initial"]["to"], set()):
                errs.append(bad)
            continue
        if e["to"] in ("H", "F"):
            if not base.get(e["slot"]):
                base[e["slot"]] = e["from"]
            if not m.get("hold" if e["to"] == "H" else "fault"):
                errs.append(bad)
            continue
        if e["from"] in ("H", "F"):
            b = base.get(e["slot"])
            base[e["slot"]] = None
            if not (e["to"] == b or e["to"] in successors(mk, b)):
                errs.append(bad)
            continue
        if e["to"] not in successors(mk, e["from"]):
            errs.append(bad)
    unvisited = {}
    for mk, seen in visited.items():
        m = M.MACHINES[mk]
        all_states = [s for s in m["states"] if not m["states"][s].get("choice")] + (["H"] if m.get("hold") else []) + (["F"] if m.get("fault") else [])
        unvisited[mk] = [s for s in all_states if s not in seen]
    return errs, unvisited
