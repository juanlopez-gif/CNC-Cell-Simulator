"""Run the cell without graphics and print its numbers.

    python run.py                          8 h, nominal
    python run.py --hours 24 --faults      random disturbances (seeded)
    python run.py --hours 2 --log 30       also show the last 30 log lines
"""
import argparse
import time

from cellsim import conformance, run_random


def main():
    ap = argparse.ArgumentParser(description="CNC cell simulation engine, Setup 2 (no graphics)")
    ap.add_argument("--hours", type=float, default=8.0)
    ap.add_argument("--faults", action="store_true", help="inject random disturbances (about one every 14 min)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--log", type=int, default=0, metavar="N", help="print the last N log lines")
    a = ap.parse_args()
    t0 = time.time()
    sim, injected, actions = run_random(2, a.hours, faults=a.faults, seed=a.seed)
    k = sim.kpis()
    errs, unvisited = conformance(sim)
    print(f"Setup 2, {a.hours:g} h simulated {'with' if a.faults else 'without'} disturbances (seed {a.seed}) in {time.time() - t0:.1f} s")
    rows = [
        ("parts on the output pallet", k["parts_on_pallet"]), ("NOK parts", k["nok_parts"]),
        ("CNC cycles", k["cnc_cycles"]),
        ("CNC utilization", f'{100 * k["cnc_utilization"]:.1f} %' if k["cnc_utilization"] is not None else "-"),
        ("mean CNC idle per part", f'{k["mean_cnc_idle_s"]:.2f} s (design {k["design_cnc_idle_s"]} s)' if k["mean_cnc_idle_s"] is not None else "-"),
        ("parts per hour", f'{k["parts_per_hour"]:.1f}'),
        ("mismatches / line stops", f'{k["mismatches"]} / {k["line_stops"]}'),
        ("property violations", k["property_violations"]),
        ("transitions outside the model", len(errs)),
    ]
    for name, v in rows:
        print(f"  {name:<32} {v}")
    if a.faults:
        print("  injected:", injected)
        print("  operator / technician:", actions)
    for e in (sim.errors + errs)[:10]:
        print("  !", e)
    if a.log:
        print("\nlast log lines:")
        for t, cat, msg in sim.logs[-a.log:]:
            print(f"  {int(t) // 3600:02d}:{int(t) // 60 % 60:02d}:{int(t) % 60:02d}  {cat:<9} {msg}")


if __name__ == "__main__":
    main()
