"""Tests of the Python engine (Setup 2).   python -m unittest -v test_engine   (from engine/)

- the model export is up to date with source/src/cell-model.js (needs Node; skipped without it)
- nominal operation: the CNC idle time of every cycle equals the KPI derived from the model
- random step times in their intervals (A4.4): the CNC idle of every cycle lies in the bounds that
  UPPAAL found (B1, verification/timed_results.md)
- a faulty CP-2 sensor: the camera keeps the line running, the 3rd mismatch stops it, the sensor
  verification and the reset bring it back
- two undersized parts in a row cause a quality hold; no cycle start during the hold
- gauge (A2.2): a part in the guard band is rejected; a master check out of tolerance is a FAULT and
  no part is measured until a master check passes; the master check is repeated every 4 h
- KPI measures (A2.4): machining time and the time lost by cause add up to the run time; nominal
  operation loses nothing beyond start-up and the nominal exchange; an absent operator is charged
  to the pallet change, a quality hold to the quality hold
- long runs with random disturbances: every state change is a transition of the model, no property
  is violated and every job takes its model time
"""
import os
import re
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
        sim = CellSim(seed=1)
        sim.advance(2 * 3600)
        self.assertClean(sim)
        kpi = sim.M.KPI["idle2"]
        self.assertGreater(len(sim.stats["idles"]), 30)
        for idle in sim.stats["idles"]:
            self.assertAlmostEqual(idle, kpi, delta=0.005)

    def test_random_times_within_uppaal_bounds(self):
        # A4.4: every step time drawn in its interval; the idle of every cycle (the first excluded,
        # cycles with time lost to another cause than the exchange excluded, condition 3 of §5.17)
        # lies in [inf, sup] of B1 found by UPPAAL (verification/timed_results.md)
        with open(os.path.join(HERE, "..", "verification", "timed_results.md"), encoding="utf-8") as f:
            text = f.read()
        lo = float(re.search(r"B1 CNC idle per cycle, infimum \| satisfied; inf (\d+)", text).group(1)) / 100
        hi = float(re.search(r"B1 CNC idle per cycle, supremum[^|]*\| satisfied; sup (\d+)", text).group(1)) / 100
        sim = CellSim(seed=1, random_times=True)
        sim.advance(6 * 3600)
        self.assertClean(sim)
        idles = [i for i, o in zip(sim.stats["idles"], sim.stats["idle_other"]) if o < 1e-6]
        self.assertGreater(len(idles), 100)
        for idle in idles:
            self.assertGreaterEqual(idle, lo - 0.011)
            self.assertLessEqual(idle, hi + 0.011)
        self.assertGreater(max(idles) - min(idles), 2.0, "the times are not drawn")

    def test_faulty_sensor_stops_the_line(self):
        sim = CellSim(seed=1, instant_verify=True)
        sim.advance(300)
        sim.toggle_sensor_fault("CP-2")
        # CP-2 rule "absent": PE-41 misses the part placed, so Robot 1 goes to FAULT (missing
        # confirmation) and the operator clears it; the third mismatch stops the line
        clears = 0
        while sim.state("SUP") != "X3" and sim.t < 3600:
            sim.advance(5)
            if sim.faults.get("R1"):
                sim.press("clear")
                clears += 1
        self.assertEqual(sim.state("SUP"), "X3", "no line stop")
        self.assertLessEqual(clears, 3)
        self.assertEqual(sim.stats["violations"], 0)
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

    def test_broken_sensor_is_replaced(self):
        # A6.2: a broken PE-41 fails its test in the verification (VERIFY.fail), the technician
        # replaces it in T.sensorReplace, the re-test passes and only then the line can be reset
        sim = CellSim(seed=1, instant_verify=True)
        sim.advance(300)
        sim.toggle_sensor_fault("CP-2", broken=True)
        while sim.state("SUP") != "X3" and sim.t < 3600:
            sim.advance(5)
            if sim.faults.get("R1"):
                sim.press("clear")
        self.assertEqual(sim.state("SUP"), "X3", "no line stop")
        sim.advance(200)
        sim.press("verify")
        sim.advance(1)
        self.assertEqual(sim.state("SUP"), "X4")
        self.assertTrue(sim.cps["CP-2"]["found"], "the test of CP-2 fails")
        self.assertFalse(sim.verify["done"])
        t_fail = sim.t
        sim.press("resume")                                 # pressed early: it stays latched, no reset before the re-test
        sim.advance(sim.T["sensorReplace"] - 10)
        self.assertEqual(sim.state("SUP"), "X4")
        self.assertTrue(sim.ev("TRUE.brokenFound"))
        sim.advance(20)
        self.assertEqual(sim.state("SUP"), "X1", "reset as soon as the re-test passed")
        reset_at = [e["t"] for e in sim.trace if e["slot"] == "SUP" and e["to"] == "X1"][-1]
        self.assertGreaterEqual(reset_at - t_fail, sim.T["sensorReplace"] - 1)
        self.assertFalse(sim.cps["CP-2"]["fault"] or sim.cps["CP-2"]["broken"], "the sensor is replaced")
        self.assertTrue(any("FAILED" in m for _, c, m in sim.logs))
        sim.advance(1800)
        self.assertNotEqual(sim.state("R1"), "H")
        self.assertClean(sim)

    def test_cnc_alarm_waits_and_restarts(self):
        # A6.3: an alarm at half of the cycle; Robot 1 waits in W2 (not a FAULT), the operator resets
        # the CNC after T.cncReset, the program restarts with the same part, the time is charged to
        # the cause "CNC alarm"
        sim = CellSim(seed=1, instant_verify=True)
        sim.advance(300)
        cycles = sim.stats["cycles"]
        sim.inject_cnc_alarm()
        sim.advance(sim.M.T["cncCycle"])
        self.assertEqual(sim.cnc["state"], "ALARM")
        self.assertFalse(sim.read("CNC.ready"))
        self.assertTrue(sim.cnc["locked"], "the door stays locked")
        self.assertEqual(sim.state("R1"), "W2")
        self.assertFalse(any(sim.faults.values()))
        part = sim.cnc["part"]
        sim.advance(sim.T["cncReset"])
        self.assertEqual(sim.cnc["state"], "RUN")
        self.assertIs(sim.cnc["part"], part, "the same part")
        self.assertEqual(sim.state("R1"), "B2")
        sim.advance(sim.M.T["cncCycle"] + 30)
        self.assertGreater(sim.stats["cycles"], cycles)
        self.assertEqual(sim.stats["cnc_alarms"], 1)
        lost = sim.measures()["lost_s"]["CNC alarm"]
        self.assertGreater(lost, sim.T["cncReset"])
        self.assertLess(lost, sim.T["cncReset"] + sim.M.T["cncCycle"])
        self.assertClean(sim)

    def test_tool_change_and_size_warning(self):
        # A6.4: at the end of the tool life Robot 1 waits in W3 before opening the door, the operator
        # changes the tool (T.toolChange), the counter starts again; no CYCLE START while it is due.
        # An offset error lowers the sizes (still OK): the mean of the last 5 falls below the warning
        # limit, the light turns amber, the operator corrects the offset (T.offsetCheck), no stop.
        sim = CellSim(seed=1, instant_verify=True)
        sim.advance(300)
        sim.inject_tool_life_end()
        cycles = sim.stats["cycles"]
        t0 = sim.t
        while sim.state("R1") != "W3" and sim.t - t0 < 600:
            sim.advance(1)
        self.assertEqual(sim.state("R1"), "W3")
        self.assertTrue(sim.ev("TOOL.due"))
        self.assertTrue(sim.output("LT-01.amber"))
        self.assertEqual(sim.cnc["state"], "DONE", "between two cycles")
        sim.advance(sim.T["toolChange"] - 5)
        self.assertEqual(sim.state("R1"), "W3", "no CYCLE START while the change is due")
        self.assertEqual(sim.stats["cycles"], cycles + 1)
        sim.advance(10)
        self.assertNotEqual(sim.state("R1"), "W3")
        self.assertEqual(sim.vars["toolCount"], 0)
        self.assertEqual(sim.stats["tool_changes"], 1)
        self.assertGreater(sim.measures()["lost_s"]["tool change"], sim.T["toolChange"] - 6)
        sim.advance(300)
        self.assertIn(sim.vars["toolCount"], (1, 2, 3))
        sim.inject_offset_error()
        t0 = sim.t
        while not sim.read("GAUGE.warn") and sim.t - t0 < 3600:
            sim.advance(1)
        self.assertTrue(sim.read("GAUGE.warn"))
        self.assertTrue(sim.output("LT-01.amber"))
        self.assertEqual(sim.nok_parts, 0, "the warning comes before a NOK part")
        sim.advance(sim.T["offsetCheck"] + 1)
        self.assertFalse(sim.read("GAUGE.warn"))
        self.assertEqual(sim.stats["offset_checks"], 1)
        self.assertEqual(sim.cnc["offset_err"], 0.0)
        sim.advance(1800)
        self.assertEqual(sim.nok_parts, 0)
        self.assertClean(sim)

    def test_safety_stops(self):
        # A6.5: a person in the protective field while Robot 1 picks: protective stop (S3), the pick pauses
        # and ends after the person has left; an E-stop while Robot 1 opens the door: every machine to F,
        # CNC not stopped (door open), the move is finished after the reset and the state is repeated.
        sim = CellSim(seed=1, instant_verify=True)
        sim.advance(400)
        while sim.mch["R1"]["job"] != "R1.pickRawA":
            sim.advance(0.05)
        sim.inject_person(1, 15)
        sim.advance(5)
        self.assertEqual(sim.state("SAF"), "S3")
        self.assertTrue(sim.read("R1.safeStop"))
        self.assertEqual(sim.mch["R1"]["job"], "R1.pickRawA", "the pick is paused, not ended")
        self.assertFalse(sim.read("TRUE.jobRuns"))
        sim.advance(20)
        self.assertEqual(sim.state("SAF"), "S1")
        self.assertEqual(sim.stats["protective_stops"], 1)
        while sim.mch["R1"]["job"] != "R1.openDoor":
            sim.advance(0.05)
        sim.advance(1)
        sim.press_estop(20)
        sim.advance(1)
        self.assertEqual(sim.state("SAF"), "S4")
        self.assertEqual([sim.state(s) for s in ("R1", "CONV", "R2")], ["F", "F", "F"])
        self.assertTrue(sim.output("LT-01.red"))
        self.assertFalse(sim.read("TRUE.jobRuns"))
        sim.advance(20)
        self.assertEqual(sim.state("SAF"), "S5")
        self.assertEqual(sim.state("R1"), "F", "no restart before the relay is reset")
        sim.advance(sim.T["safetyReset"] + 1)
        self.assertEqual(sim.state("SAF"), "S1")
        self.assertNotEqual(sim.state("R1"), "F")
        self.assertGreater(sim.measures()["lost_s"]["safety stop"], 40)
        sim.advance(1800)
        self.assertEqual(sim.stats["estops"], 1)
        self.assertGreater(sim.stats["cycles"], 12)
        self.assertClean(sim)

    def test_quality_hold_after_two_nok_parts(self):
        sim = CellSim(seed=1)
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

    def test_kpi_measures(self):
        sim = CellSim(seed=1)
        sim.advance(2 * 3600)
        m = sim.measures()
        self.assertAlmostEqual(m["machining_s"] + sum(m["lost_s"].values()), sim.t, places=3)
        self.assertAlmostEqual(m["exchange_beyond_nominal_s"], 0, places=3)
        self.assertEqual({c for c, v in m["lost_s"].items() if v > 0}, {"start-up", "exchange"})
        self.assertEqual(m["parts_per_hour"], m["good_parts_per_hour"])
        # without the operator the output pallet fills and Robot 2 waits in E7: from then on every
        # second is a pallet-change loss
        sim.auto_operator = False
        sim.advance(3600)
        before = sim.measures()["lost_s"]["pallet change"]
        self.assertEqual(sim.state("R2"), "E7")
        sim.advance(600)
        self.assertAlmostEqual(sim.measures()["lost_s"]["pallet change"] - before, 600, places=3)
        # two NOK parts in a row: the quality hold keeps the CNC idle until it is released
        sim = CellSim(seed=1)
        sim.advance(600)
        sim.inject_undersized()
        sim.inject_undersized()
        while not sim.vars["QH"] and sim.t < 3 * 3600:
            sim.advance(5)
        sim.advance(600)
        self.assertGreater(sim.measures()["lost_s"]["quality hold"], 0)
        self.assertClean(sim)

    def test_gauge_policy(self):
        sim = CellSim(seed=1)
        sim.advance(600)
        sim.inject_guard_band()
        n = sim.nok_parts
        while sim.nok_parts == n and sim.t < 3600:
            sim.advance(5)
        self.assertEqual(sim.nok_parts, n + 1, 'the part in the guard band was not rejected')
        self.assertTrue(any('rejected in guard band' in m for _, c, m in sim.logs if c == 'measure'))
        # 4 h after the start-up master check the next one is made before the next part
        sim.advance(4 * 3600 - sim.t + 300)
        checks = [t for t, c, m in sim.logs if m.startswith('Master cube')]
        self.assertEqual(len(checks), 2)
        self.assertLess(checks[1] - checks[0] - sim.RU['masterEvery'], 200)
        # a master check out of tolerance: gauge FAULT, no measurement until a master check passes
        sim.inject_master_fault()
        sim.gauge['due'] = True
        while sim.state('R2') != 'F' and sim.t < 6 * 3600:
            sim.advance(5)
        self.assertEqual(sim.state('R2'), 'F')
        self.assertFalse(sim.gauge['zeroed'])
        t_fault = sim.t
        sim.advance(120)
        self.assertFalse([t for t, c, m in sim.logs if c == 'measure' and m.startswith('Part #') and t > t_fault])
        sim.press('clear')
        sim.advance(600)
        self.assertTrue(sim.gauge['zeroed'])
        last_pass = max(t for t, c, m in sim.logs if m.startswith('Master cube') and 'gauge OK' in m)
        first_part = min(t for t, c, m in sim.logs if c == 'measure' and m.startswith('Part #') and t > t_fault)
        self.assertLess(last_pass, first_part)
        self.assertClean(sim)

    def test_random_disturbances(self):
        for seed in (3, 4):
            with self.subTest(seed=seed):
                sim, injected, actions = run_random(2, 4, faults=True, seed=seed, safety=True)
                self.assertClean(sim)
                self.assertGreater(sum(injected.values()), 5)
                self.assertGreater(sim.stats["cycles"], 30)          # nominal ~92 in 4 h; stops and faults cost time


if __name__ == "__main__":
    unittest.main()
