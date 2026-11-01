"""Tests of the studies of step A5 (PROJECT_STATUS §5.18).   python -m unittest -v test_studies   (from engine/)

- the engine options of the studies: NOK parts at a given rate, an intermittent sensor, the instants
  of the quality holds
- model_with changes a copy, not the model
- every study runs in its short form (n = 2, 0.5 h) and writes complete CSVs; the nominal point of
  S1 with nominal times gives the nominal CNC idle of the model
"""
import csv
import os
import subprocess
import sys
import tempfile
import unittest

from cellsim import CellSim, conformance
from cellsim.model import load
from studies.common import drive, mean_ci, model_with, wilson

HERE = os.path.dirname(os.path.abspath(__file__))


def read(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class StudiesTest(unittest.TestCase):
    def test_nok_rate_and_quality_holds(self):
        sim = CellSim(seed=1, nok_rate=0.3)
        drive(sim, 2, release_after=120)
        self.assertEqual(sim.errors, [])
        self.assertGreater(sim.nok_parts, 5)
        self.assertGreater(len(sim.stats["qh"]), 0)
        for a, b in sim.stats["qh"]:
            self.assertTrue(b is None or b > a)

    def test_intermittent_sensor_is_found(self):
        sim = CellSim(seed=1, instant_verify=True)
        sim.advance(600)
        sim.set_sensor_miss("CP-3", 0.5)
        stops = sim.stats["stops"]
        drive(sim, 2)
        self.assertGreater(sim.stats["stops"], stops, "the intermittent sensor never stopped the line")
        self.assertEqual(sim.cps["CP-3"]["miss"], 0.0, "the technician repairs it")
        self.assertEqual(conformance(sim)[0], [])
        self.assertEqual(sim.errors, [])

    def test_model_with_changes_a_copy(self):
        m = model_with(T={"cncCycle": 90}, RULES={"mismatchLimit": 5}, scale={"beltTravel": 2.0})
        self.assertEqual(m.T["cncCycle"], 90)
        self.assertAlmostEqual(m.TRANGE["cncCycle"][0], 85.5)
        self.assertEqual(m.CONST["limit"], 5)
        self.assertEqual(m.T["beltTravel"], 16)
        base = load()
        self.assertEqual(base.T["cncCycle"], 120)
        self.assertEqual(base.CONST["limit"], 3)

    def test_statistics(self):
        m, h = mean_ci([1.0, 2.0, 3.0])
        self.assertAlmostEqual(m, 2.0)
        self.assertAlmostEqual(h, 4.303 * 1.0 / 3 ** 0.5, places=3)
        p, lo, hi = wilson(0, 10)
        self.assertEqual(p, 0)
        self.assertAlmostEqual(hi, 0.2775, places=3)

    def test_studies_quick(self):
        with tempfile.TemporaryDirectory() as out:
            for mod, n_points in (("studies.s1_sweeps", 20), ("studies.s4_nok", 18)):
                with self.subTest(study=mod):
                    r = subprocess.run([sys.executable, "-m", mod, "--quick", "--out", out], cwd=HERE,
                                       capture_output=True, text=True)
                    self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
                    name = mod.split(".")[1][:2]
                    runs, summary = read(os.path.join(out, f"{name}_runs.csv")), read(os.path.join(out, f"{name}_summary.csv"))
                    self.assertEqual(len({tuple(v for k, v in s.items() if k in ("factor", "value", "nok_rate", "release_min")) for s in summary}), n_points)
                    self.assertTrue(all(r["model_errors"] == "0" and r["violations"] == "0" for r in runs))
            nominal = [s for s in read(os.path.join(out, "s1_summary.csv"))
                       if s["factor"] == "CNC cycle" and float(s["value"]) == 120 and s["random_times"] == "0"]
            self.assertAlmostEqual(float(nominal[0]["mean_cnc_idle_s"]), load().KPI["idle2"], places=3)


if __name__ == "__main__":
    unittest.main()
