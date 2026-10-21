"""Tests of the Python engine.   python -m unittest -v test_engine   (from engine/)

- the model export is up to date with source/src/cell-model.js (needs Node; skipped without it)
- nominal operation: the CNC idle time of every cycle equals the KPI derived from the model
- a faulty CP-2 sensor: the camera keeps the line running, the 3rd mismatch stops it, the sensor
  verification and the reset bring it back
- Setup 2: two undersized parts in a row cause a quality hold; no cycle start during the hold
- long runs with random disturbances: every state change is a transition of the model, no property
  is violated and every job takes its model time
"""
import os
import shutil
import subprocess
import unittest

from cellsim import CellSim, conformance, run_random

HERE = os.path.dirname(os.path.abspath(__file__))


class EngineTest(unittest.TestCase):
    def assertClean(self, sim):
        errs, _ = conformance(sim)
        self.assertEqual(errs, [], "state changes outside the model")
        self.assertEqual(sim.errors, [], "jobs with another duration than the model, or property violations")
        self.assertEqual(sim.stats["violations"], 0)

    @unittest.skipUnless(shutil.which("node"), "Node.js not installed")
    def test_model_export_is_current(self):
        r = subprocess.run(["node", os.path.join(HERE, "..", "source", "export_model.js"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_nominal_idle_equals_kpi(self):
        for setup in (1, 2):
            with self.subTest(setup=setup):
                sim = CellSim(setup=setup, seed=1)
                sim.advance(2 * 3600)
                self.assertClean(sim)
                kpi = sim.M.KPI["idle1" if setup == 1 else "idle2"]
                self.assertGreater(len(sim.stats["idles"]), 30)
                for idle in sim.stats["idles"]:
                    self.assertAlmostEqual(idle, kpi, delta=0.005)

    def test_faulty_sensor_stops_the_line(self):
        sim = CellSim(setup=1, seed=1, instant_verify=True)
        sim.advance(300)
        sim.toggle_sensor_fault("CP-2")
        while sim.state("SUP") != "X3" and sim.t < 3600:
            sim.advance(5)
            if sim.state("SUP") == "X1":
                self.assertEqual(sim.stats["mismatches"], 0)
        self.assertEqual(sim.state("SUP"), "X3", "no line stop")
        self.assertEqual(len(sim.events), 3)
        self.assertTrue(sim.ev("lineStop"))
        sim.advance(200)                                    # the CNC finishes, the robots park, the belt stops
        self.assertEqual(sim.state("R1"), "H")
        self.assertTrue(sim.ev("CELL.stopped"))
        sim.press("verify")
        sim.advance(1)
        self.assertEqual(sim.state("SUP"), "X4")
        self.assertFalse(sim.cps["CP-2"]["fault"], "the technician repairs the sensor")
        sim.press("resume")
        sim.advance(1)
        self.assertEqual(sim.state("SUP"), "X1")
        self.assertEqual(len(sim.events), 0)
        sim.advance(1800)
        self.assertNotEqual(sim.state("R1"), "H")
        self.assertClean(sim)

    def test_quality_hold_after_two_nok_parts(self):
        sim = CellSim(setup=2, seed=1)
        sim.advance(600)
        sim.inject_undersized()
        sim.inject_undersized()
        while not sim.vars["QH"] and sim.t < 3 * 3600:
            sim.advance(5)
        self.assertTrue(sim.vars["QH"], "no quality hold")
        self.assertEqual(sim.nok_parts, 2)
        starts = sim.stats["idle_n"]                         # one per cycle start after the first
        sim.advance(600)                                     # the running cycle may finish, but none starts
        self.assertEqual(sim.stats["idle_n"], starts)
        self.assertEqual(sim.state("R1"), "B6")
        sim.press("qh")
        sim.advance(600)
        self.assertFalse(sim.vars["QH"])
        self.assertGreater(sim.stats["idle_n"], starts)
        self.assertClean(sim)

    def test_random_disturbances(self):
        for setup, seed in ((1, 3), (2, 4)):
            with self.subTest(setup=setup):
                sim, injected, actions = run_random(setup, 4, faults=True, seed=seed)
                self.assertClean(sim)
                self.assertGreater(sum(injected.values()), 5)
                self.assertGreater(sim.stats["cycles"], 30)          # nominal ~92 in 4 h; stops and faults cost time


if __name__ == "__main__":
    unittest.main()
