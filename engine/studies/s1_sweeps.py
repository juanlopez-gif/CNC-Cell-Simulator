"""S1 (A5, PROJECT_STATUS §5.18): parameter sweeps without disturbances, one factor at a time around
the nominal cell: belt speed, robot speed, CNC cycle.

    python -m studies.s1_sweeps            n = 10 seeds per point, 8 h, random step times; plus every
                                           point once with nominal times
    python -m studies.s1_sweeps --quick    n = 2, 0.5 h, no plots
"""
import argparse
import os
import time

from studies.common import args, base_data, plot, run_tasks, state_shares, summarize, write_csv

BELT_LENGTH = 2.0                     # m (layout), beltTravel 8 s at 0.25 m/s
BELT = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50]               # m/s
ROBOT = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3]               # speed factor: every robot time / factor
CNC = [90, 105, 120, 135, 150, 165, 180]                   # s
MEASURES = ["parts_per_hour", "good_parts_per_hour", "mean_cnc_idle_s", "machining_share",
            "r1_wait_at_door", "r2_wait_for_part"]


def points():
    d = base_data()
    robot_keys = [k for k, s in d["TSRC"].items() if s["kind"] == "robot"]
    nominal_v = BELT_LENGTH / d["T"]["beltTravel"]
    out = []
    for v in BELT:
        out.append(({"factor": "belt speed", "value": v}, {"scale": {"beltTravel": nominal_v / v}}))
    for s in ROBOT:
        out.append(({"factor": "robot speed", "value": s}, {"scale": {k: 1 / s for k in robot_keys}}))
    for c in CNC:
        out.append(({"factor": "CNC cycle", "value": c}, {"T": {"cncCycle": c}}))
    return out


def extra(sim):
    """Who waits for whom: Robot 1 at the CNC door (the CNC is the bottleneck while it waits there),
    Robot 2 for a part at the belt exit."""
    sh = state_shares(sim)
    return {"r1_wait_at_door": sh.get("R1", {}).get("B2", 0.0), "r2_wait_for_part": sh.get("R2", {}).get("E1", 0.0)}


def tasks(n, hours):
    out = []
    for point, model in points():
        out.append({"study": "S1", "point": point, "seed": 0, "hours": hours, "model": model,
                    "random_times": False, "extra": "studies.s1_sweeps.extra"})
        for seed in range(1, n + 1):
            out.append({"study": "S1", "point": point, "seed": seed, "hours": hours, "model": model,
                        "random_times": True, "extra": "studies.s1_sweeps.extra"})
    return out


def main():
    a = args(argparse.ArgumentParser(description=__doc__.split("\n")[0]), n=10, hours=8.0)
    t0 = time.time()
    ts = tasks(a.n, a.hours)
    print(f"S1: {len(ts)} runs of {a.hours:g} h")
    rows = run_tasks(ts, a.procs)
    summary = summarize(rows, ["factor", "value", "random_times"], MEASURES)
    write_csv(os.path.join(a.out, "s1_runs.csv"), rows)
    write_csv(os.path.join(a.out, "s1_summary.csv"), summary)
    bad = [r for r in rows if r["model_errors"] or r["violations"]]
    print(f"S1 done in {time.time() - t0:.0f} s; runs with model errors or violations: {len(bad)}")
    if not a.quick:
        figures(summary, a.out)
    return 1 if bad else 0


def figures(summary, out):
    units = {"belt speed": "belt speed (m/s)", "robot speed": "robot speed factor", "CNC cycle": "CNC cycle (s)"}
    for m, yl, name in (("parts_per_hour", "parts per hour", "s1_parts_per_hour.png"),
                        ("mean_cnc_idle_s", "mean CNC idle per part (s)", "s1_cnc_idle.png"),
                        ("r1_wait_at_door", "share of time Robot 1 waits at the door", "s1_robot1_wait.png")):
        panels = []
        for f, xl in units.items():
            series = []
            for rt, label in ((1, "random step times (95 % interval)"), (0, "nominal times")):
                ss = [s for s in summary if s["factor"] == f and s["random_times"] == rt]
                series.append((label, [s["value"] for s in ss], [s[m] for s in ss], [s[m + "_ci"] for s in ss]))
            panels.append((xl, yl, series))
        plot(os.path.join(out, name), panels, f"S1: {yl}, one factor at a time (8 h, no disturbances)")


if __name__ == "__main__":
    raise SystemExit(main())
