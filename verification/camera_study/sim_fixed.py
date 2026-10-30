"""Timed camera study (engine/camera_sim.py) with the recovery changes of ../camera_policy.md §3.
    cd engine && python ../verification/camera_study/sim_fixed.py --hours 8 --seeds 1,2,3
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine"))
import cellsim.sim as S
from cellsim.model import load
M = load()
# same changes as patch_model.js
def setw(st, w): st["when"] = w
for m in M.MACHINES.values():
    st = m.get("states", {})
    if "B7" in st:
        setw(st["B7"]["do"][2], "GR-21B"); setw(st["B7"]["do"][3], "GR-21B")
    if "E2" in st:
        setw(st["E2"]["do"][0], "!GR-51"); setw(st["E3"]["do"][0], "GR-51")
    if "C1" in st:
        for x in m["initial"]["do"]:
            x["until"] = "!" + x["check"]
S.load = lambda *a, **k: M
import camera_sim
camera_sim.CellSim = lambda **kw: S.CellSim(model=M, **kw)
sys.argv = [sys.argv[0]] + sys.argv[1:]
camera_sim.main()
