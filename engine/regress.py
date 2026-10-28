"""Fingerprints of the Python engine for the regression check (source/regress.js): the trace of
deterministic and seeded random Setup 2 scenarios, hashed, with the counters and the KPIs.

    python regress.py
"""
import hashlib
import json

from cellsim import CellSim, run_random
from trace import scenario_trace


def digest(trace):
    # times rounded to 1 µs and written as JavaScript does (300, not 300.0), so that the browser and
    # Python fingerprints of the same trace are equal
    rows = [[(lambda t: int(t) if t == int(t) else t)(round(e[0], 6)), e[1], e[2], e[3]] for e in trace]
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def fingerprint(trace, sim_or_result):
    return {"changes": len(trace), "sha256": digest(trace), **sim_or_result}


def main():
    out = {}
    for scenario in ("nominal", "cp2fault"):
        r = scenario_trace(2, 3600, scenario)
        out["det_" + scenario] = fingerprint(r["trace"], {k: r[k] for k in ("cycles", "mismatches", "stops", "parts")}
                                             | {"errors": len(r["errors"])})
    for name, hours, faults, seed in (("random_nominal_2h", 2, False, 2), ("random_faults_8h", 8, True, 4)):
        sim, injected, actions = run_random(2, hours, faults=faults, seed=seed)
        trace = [[e["t"], e["slot"], e["from"], e["to"]] for e in sim.trace]
        k = sim.kpis()
        out[name] = fingerprint(trace, {"cycles": sim.stats["cycles"], "errors": len(sim.errors),
                                        "injected": injected, "actions": actions,
                                        "kpis": {key: (round(v, 6) if isinstance(v, float) else v) for key, v in k.items()}})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
