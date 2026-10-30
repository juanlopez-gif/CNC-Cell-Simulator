"""Step A2.1, timed side: what each camera / proximity rule costs in production.

For every checkpoint and every rule (camera, prox, present, absent, ask) it runs the cell for HOURS
of simulated time with wrong readings at that checkpoint only: every 10 s, with probability RATE,
the next reading there is wrong (half the time the camera with a valid image, a quarter the
camera's previous image, a quarter the proximity sensor; one source wrong at a time). An operator
and a technician answer the HMI as in scenarios.run_random. It reports good parts per hour, the
time the cell spent in a line stop or a FAULT, the number of line stops and FAULTs, and the
property violations seen by the monitors (the same properties as the verifier).

    python camera_sim.py [--hours 8] [--rate 0.012] [--seeds 1,2,3] [--cp CP-4] [--json out.json]
"""
import argparse
import json
import random
import sys

from cellsim import CellSim

RULES = ["camera", "prox", "present", "absent", "ask"]
CPS = ["CP-1", "CP-2", "CP-3", "CP-4", "CP-5"]


def run(cp, rule, hours, rate, seed):
    rnd = random.Random(seed)
    sim = CellSim(setup=2, seed=seed, instant_verify=True, rules={cp: rule} if cp else None)
    fault_since = qh_since = None
    injected = {"camera wrong": 0, "stale image": 0, "proximity wrong": 0}
    t = 0.0
    while t < hours * 3600:
        sim.advance(10.0)
        t += 10.0
        if cp and rnd.random() < rate:
            k = rnd.random()
            if k < 0.5:
                sim.inject_camera_wrong(cp); injected["camera wrong"] += 1
            elif k < 0.75:
                sim.inject_stale_image(cp); injected["stale image"] += 1
            else:
                sim.inject_glitch(cp); injected["proximity wrong"] += 1
        if any(sim.faults.values()):
            fault_since = sim.t if fault_since is None else fault_since
            if sim.t - fault_since > 60:
                sim.press("clear"); fault_since = None
        else:
            fault_since = None
        if sim.vars["QH"]:
            qh_since = sim.t if qh_since is None else qh_since
            if sim.t - qh_since > 120:
                sim.press("qh"); qh_since = None
        else:
            qh_since = None
        if sim.state("SUP") == "X3" and not sim.inputs["verify"]:
            sim.press("verify")
        if sim.state("SUP") == "X4" and sim.verify and sim.verify["done"] and not sim.inputs["reset"]:
            sim.press("resume")
    # time spent in line stops (supervisor X3 / X4) and FAULT (any machine), from the trace
    stop_t, fault_t, faults = 0.0, 0.0, 0
    since = {}
    for e in sim.trace:
        key = (e["slot"], e["to"])
        if e["to"] == "F":
            faults += 1
        for (slot, st), t0 in list(since.items()):
            if slot == e["slot"]:
                if st in ("X3", "X4"):
                    stop_t += e["t"] - t0
                elif st == "F":
                    fault_t += e["t"] - t0
                del since[(slot, st)]
        if (e["slot"] == "SUP" and e["to"] in ("X3", "X4")) or e["to"] == "F":
            since[key] = e["t"]
    for (slot, st), t0 in since.items():
        if st in ("X3", "X4"):
            stop_t += sim.t - t0
        else:
            fault_t += sim.t - t0
    k = sim.kpis()
    viol = sorted({e.split()[1] for e in sim.errors if e.startswith("property ")})
    return {"cp": cp, "rule": rule, "seed": seed, "hours": hours, "good_parts": sim.ok_parts,
            "good_per_hour": sim.ok_parts / hours, "line_stops": k["line_stops"], "faults": faults,
            "stop_min": stop_t / 60, "fault_min": fault_t / 60, "mismatches": k["mismatches"],
            "violations": k["property_violations"], "violated": viol, "injected": injected,
            "other_errors": [e for e in sim.errors if not e.startswith("property ")][:5]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=8)
    ap.add_argument("--rate", type=float, default=0.012)
    ap.add_argument("--seeds", default="1,2,3")
    ap.add_argument("--cp", default=",".join(CPS))
    ap.add_argument("--rules", default=",".join(RULES))
    ap.add_argument("--json")
    a = ap.parse_args()
    seeds = [int(s) for s in a.seeds.split(",")]
    rows = []
    base = [run(None, None, a.hours, 0, s) for s in seeds]
    nominal = sum(r["good_per_hour"] for r in base) / len(base)
    print(f"nominal (no wrong readings): {nominal:.2f} good parts/h")
    print(f"{'CP':5} {'rule':8} {'good/h':>7} {'lost %':>7} {'stops':>5} {'stop min':>8} {'FAULTs':>6} {'fault min':>9} {'viol':>4}  violated")
    for cp in a.cp.split(","):
        for rule in a.rules.split(","):
            rs = [run(cp, rule, a.hours, a.rate, s) for s in seeds]
            n = len(rs)
            agg = {"cp": cp, "rule": rule, "seeds": seeds, "hours": a.hours, "rate": a.rate,
                   "good_per_hour": sum(r["good_per_hour"] for r in rs) / n,
                   "line_stops": sum(r["line_stops"] for r in rs) / n, "stop_min": sum(r["stop_min"] for r in rs) / n,
                   "faults": sum(r["faults"] for r in rs) / n, "fault_min": sum(r["fault_min"] for r in rs) / n,
                   "violations": sum(r["violations"] for r in rs),
                   "violated": sorted({v for r in rs for v in r["violated"]}), "runs": rs}
            agg["lost_pct"] = 100 * (1 - agg["good_per_hour"] / nominal)
            rows.append(agg)
            print(f"{cp:5} {rule:8} {agg['good_per_hour']:7.2f} {agg['lost_pct']:7.1f} {agg['line_stops']:5.1f} {agg['stop_min']:8.1f} "
                  f"{agg['faults']:6.1f} {agg['fault_min']:9.1f} {agg['violations']:4}  {' '.join(agg['violated'])}")
            sys.stdout.flush()
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"nominal_good_per_hour": nominal, "rows": rows}, f, indent=1)


if __name__ == "__main__":
    main()
