"""Print the state-change trace of one scenario as JSON (used by source/test_sim.js engine to
compare the Python engine with the browser simulator).

    python trace.py 2 <seconds> <nominal|cp2fault|cp2broken|cncalarm|toolwear|safety|camwrong>      (2 = Setup 2, the only setup)
"""
import json
import sys

from cellsim import CellSim

# camwrong scenario: t (s) -> (injection, checkpoint); the same table is in source/test_sim.js
CAMWRONG = {300: ("camwrong", "CP-4"), 600: ("stale", "CP-2"), 900: ("camwrong", "CP-3"), 1200: ("camwrong", "CP-5"),
            1500: ("camwrong", "CP-1"), 1800: ("stale", "CP-4"), 2100: ("camwrong", "CP-2"), 2400: ("glitch", "CP-3")}
# safety scenario (A6.5): t (s) -> person at side 1 / 2 (20 s in the protective field) or E-stop (30 s); the same
# table is in source/test_sim.js. 310: during the pick of Robot 1 (protective stop), 430: E-stop while it opens
# the door, 530: during the place of Robot 2, 640: E-stop while Robot 1 loads the vise, 2250: E-stop while all wait
SAFETY = {310: "person1", 430: "estop", 530: "person2", 640: "estop", 1500: "person1", 2250: "estop"}


def scenario_trace(setup, seconds, scenario):
    sim = CellSim(setup=setup, seed=1, instant_verify=True)
    t = 0
    while t < seconds:
        if scenario in ("cp2fault", "cp2broken") and t == 300:
            sim.toggle_sensor_fault("CP-2", broken=scenario == "cp2broken")   # faulty (or broken, A6.2) PE-41 from t = 300 s
        if scenario == "cncalarm" and t in (300, 1500):
            sim.inject_cnc_alarm()                                            # A6.3
        if scenario == "toolwear" and t == 300:
            sim.inject_tool_life_end()                                        # A6.4
        if scenario == "toolwear" and t == 1200:
            sim.inject_offset_error()                                         # A6.4
        if scenario == "safety" and t in SAFETY:
            k = SAFETY[t]
            if k == "estop":
                sim.press_estop(30)                                           # A6.5
            else:
                sim.inject_person(int(k[-1]), 20)
        if scenario == "camwrong" and t in CAMWRONG:
            k, cp = CAMWRONG[t]
            {"camwrong": sim.inject_camera_wrong, "stale": sim.inject_stale_image, "glitch": sim.inject_glitch}[k](cp)
        sim.advance(10)
        t += 10
        if scenario != "nominal" and any(sim.faults.values()):
            sim.press("clear")
        if scenario != "nominal":
            if sim.state("SUP") == "X3" and not sim.inputs["verify"]:
                sim.press("verify")
            if sim.state("SUP") == "X4" and sim.verify and sim.verify["done"] and not sim.inputs["reset"]:
                sim.press("resume")
    return {"trace": [[e["t"], e["slot"], e["from"], e["to"]] for e in sim.trace],
            "cycles": sim.stats["cycles"], "mismatches": sim.stats["mismatches"], "stops": sim.stats["stops"],
            "parts": sim.ok_parts, "errors": sim.errors}


if __name__ == "__main__":
    print(json.dumps(scenario_trace(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3])))
