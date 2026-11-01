"""S2 (A5, PROJECT_STATUS §5.18): Monte Carlo of disturbances. Disturbances arrive at a rate per
hour (Poisson, checked every 10 s), with the mix of types of run_random; the technician arrives
0, 10 or 30 min after a line stop; the operator is always present, clears a FAULT after 60 s and
releases a quality hold after 120 s.

    python -m studies.s2_disturbances          n = 20 seeds per point, 8 h, random step times
    python -m studies.s2_disturbances --quick  n = 2, 0.5 h, no plots
"""
import argparse
import os
import random
import time

from studies.common import args, episodes, percentile, plot, run_tasks, summarize, write_csv

RATES = [0.5, 1, 2, 4]                      # disturbances per hour
TECH_MIN = [0, 10, 30]                      # technician arrival after a line stop
CPS = ["CP-1", "CP-2", "CP-3", "CP-4", "CP-5"]
# the mix of run_random (scenarios.py): share of each type
MIX = [(0.30, "glitch"), (0.15, "sensor fault"), (0.15, "bad frame"), (0.10, "camera failure"),
       (0.15, "grip miss"), (0.10, "undersized part"), (0.05, "master check out of tolerance")]
MEASURES = ["line_stops", "faults", "restart_line_stop_min", "restart_fault_min", "logic_availability",
            "good_parts_per_hour", "lost_fault_s", "lost_line_stop_s", "lost_quality_hold_s", "lost_exchange_s"]


def disturb(sim, kind, cp):
    if kind == "glitch":
        sim.inject_glitch(cp)
    elif kind == "sensor fault":
        if not sim.cps[cp]["fault"]:
            sim.toggle_sensor_fault(cp)          # stays faulty until the technician repairs it
    elif kind == "bad frame":
        sim.inject_bad_frame()
    elif kind == "camera failure":
        sim.inject_camera_failure()
    elif kind == "grip miss":
        sim.inject_grip_miss()
    elif kind == "undersized part":
        sim.inject_undersized()
    else:
        sim.inject_master_fault()


def hook(sim, seed, rate, mix=MIX, step=10.0):
    """Disturbances at rate per hour from their own seeded stream."""
    rnd = random.Random(f"disturb-{seed}")
    p = rate * step / 3600
    counts = sim.stats.setdefault("injected", {})

    def every(s):
        if rnd.random() < p:
            u, acc = rnd.random() * sum(w for w, _ in mix), 0.0
            for w, kind in mix:
                acc += w
                if u < acc:
                    break
            disturb(s, kind, CPS[int(rnd.random() * len(CPS))])
            counts[kind] = counts.get(kind, 0) + 1
    return {"every": every}


def extra(sim):
    ep = episodes(sim)
    stops = [(b - a) / 60 for a, b in ep["stops"] if b is not None]
    faults = [(b - a) / 60 for _, a, b in ep["faults"] if b is not None]
    return {"faults": len(ep["faults"]), "disturbances": sum(sim.stats.get("injected", {}).values()),
            "restart_line_stop_min": sum(stops) / len(stops) if stops else None,
            "restart_fault_min": sum(faults) / len(faults) if faults else None,
            "restart_line_stop_list": " ".join(f"{x:.3f}" for x in stops),
            "restart_fault_list": " ".join(f"{x:.3f}" for x in faults)}


def tasks(n, hours):
    out = []
    for r in RATES:
        for tm in TECH_MIN:
            for seed in range(1, n + 1):
                out.append({"study": "S2", "point": {"rate_per_h": r, "tech_min": tm}, "seed": seed, "hours": hours,
                            "drive": {"tech_after": 60.0 * tm}, "hook": "studies.s2_disturbances.hook",
                            "hook_args": {"rate": r}, "extra": "studies.s2_disturbances.extra"})
    return out


def main():
    a = args(argparse.ArgumentParser(description=__doc__.split("\n")[0]), n=20, hours=8.0)
    t0 = time.time()
    ts = tasks(a.n, a.hours)
    print(f"S2: {len(ts)} runs of {a.hours:g} h")
    rows = run_tasks(ts, a.procs)
    summary = summarize(rows, ["rate_per_h", "tech_min"], MEASURES)
    for s in summary:                      # 95th percentile over every episode of the point
        rs = [r for r in rows if r["rate_per_h"] == s["rate_per_h"] and r["tech_min"] == s["tech_min"]]
        for k in ("line_stop", "fault"):
            xs = [float(x) for r in rs for x in r[f"restart_{k}_list"].split()]
            s[f"restart_{k}_episodes"] = len(xs)
            s[f"restart_{k}_p95_min"] = percentile(xs, 0.95)
    write_csv(os.path.join(a.out, "s2_runs.csv"), rows)
    write_csv(os.path.join(a.out, "s2_summary.csv"), summary)
    bad = [r for r in rows if r["model_errors"] or r["violations"]]
    print(f"S2 done in {time.time() - t0:.0f} s; runs with model errors or violations: {len(bad)}")
    if not a.quick:
        figures(summary, a.out)
    return 1 if bad else 0


def figures(summary, out):
    def series(m, scale=1.0):
        res = []
        for tm in TECH_MIN:
            ss = [s for s in summary if s["tech_min"] == tm]
            res.append((f"technician after {tm} min", [s["rate_per_h"] for s in ss],
                        [None if s[m] is None else s[m] * scale for s in ss], [(s[m + "_ci"] or 0) * scale for s in ss]))
        return res
    plot(os.path.join(out, "s2_disturbances.png"), [
        ("disturbances per hour", "line stops per shift", series("line_stops")),
        ("disturbances per hour", "time to restart after a line stop (min)", series("restart_line_stop_min")),
        ("disturbances per hour", "logic availability (%)", series("logic_availability", 100)),
        ("disturbances per hour", "good parts per hour", series("good_parts_per_hour")),
    ], "S2: disturbances (8 h, operator present, rates chosen, not measured)")


if __name__ == "__main__":
    raise SystemExit(main())
