"""Print the state-change trace of one scenario as JSON (used by source/test_sim.js engine to
compare the Python engine with the browser simulator).

    python trace.py 2 <seconds> <nominal|cp2fault|camwrong>      (2 = Setup 2, the only setup)
"""
import json
import sys

from cellsim import CellSim

# camwrong scenario: t (s) -> (injection, checkpoint); the same table is in source/test_sim.js
CAMWRONG = {300: ("camwrong", "CP-4"), 600: ("stale", "CP-2"), 900: ("camwrong", "CP-3"), 1200: ("camwrong", "CP-5"),
            1500: ("camwrong", "CP-1"), 1800: ("stale", "CP-4"), 2100: ("camwrong", "CP-2"), 2400: ("glitch", "CP-3")}


def scenario_trace(setup, seconds, scenario):
    sim = CellSim(setup=setup, seed=1, instant_verify=True)
    t = 0
    while t < seconds:
        if scenario == "cp2fault" and t == 300:
            sim.toggle_sensor_fault("CP-2")       # faulty PE-41 from t = 300 s
        if scenario == "camwrong" and t in CAMWRONG:
            k, cp = CAMWRONG[t]
            {"camwrong": sim.inject_camera_wrong, "stale": sim.inject_stale_image, "glitch": sim.inject_glitch}[k](cp)
        sim.advance(10)
        t += 10
        if scenario == "camwrong" and any(sim.faults.values()):
            sim.press("clear")
        if scenario in ("cp2fault", "camwrong"):
            if sim.state("SUP") == "X3" and not sim.inputs["verify"]:
                sim.press("verify")
            if sim.state("SUP") == "X4" and sim.verify and sim.verify["done"] and not sim.inputs["reset"]:
                sim.press("resume")
    return {"trace": [[e["t"], e["slot"], e["from"], e["to"]] for e in sim.trace],
            "cycles": sim.stats["cycles"], "mismatches": sim.stats["mismatches"], "stops": sim.stats["stops"],
            "parts": sim.ok_parts, "errors": sim.errors}


if __name__ == "__main__":
    print(json.dumps(scenario_trace(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3])))
