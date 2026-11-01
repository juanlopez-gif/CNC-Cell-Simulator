"""S4 (A5, PROJECT_STATUS §5.18): NOK rate and quality holds. Every part is undersized with
probability p, independently; the operator releases a quality hold after 2, 10 or 30 min.

    python -m studies.s4_nok               n = 20 seeds per point, 8 h, random step times
    python -m studies.s4_nok --quick       n = 2, 0.5 h, no plots

The hold rule (2 NOK parts in a row; the counter is reset by an OK part and by the release) gives,
for independent parts, p² / (1 + p) holds per measured part outside a hold: the chain "NOK parts in
a row" 0 → 1 → hold has the stationary share p / (1 + p) in state 1. The parts measured during a
hold start no new run, so the expected count uses the parts measured outside a hold.
"""
import argparse
import os
import time

from studies.common import args, plot, run_tasks, summarize, write_csv

NOK = [0.005, 0.01, 0.02, 0.05, 0.10, 0.20]
RELEASE_MIN = [2, 10, 30]
MEASURES = ["quality_holds", "expected_holds", "lost_quality_hold_s", "good_parts_per_hour", "parts_per_hour",
            "nok_share", "machining_share"]


def extra(sim):
    """Parts measured outside a hold (from the log: one 'Part #' line per measured part) and the
    expected number of holds of the rule for independent parts."""
    p = sim.nok_rate
    holds = sim.stats["qh"]

    def in_hold(t):
        return any(a < t and (b is None or t <= b) for a, b in holds)
    measured = [t for t, c, m in sim.logs if c == "measure" and m.startswith("Part #")]
    outside = sum(1 for t in measured if not in_hold(t))
    parts = sim.ok_parts + sim.nok_parts
    return {"parts_measured_outside_hold": outside, "expected_holds": outside * p * p / (1 + p),
            "nok_share": sim.nok_parts / parts if parts else None}


def tasks(n, hours):
    out = []
    for p in NOK:
        for r in RELEASE_MIN:
            for seed in range(1, n + 1):
                out.append({"study": "S4", "point": {"nok_rate": p, "release_min": r}, "seed": seed, "hours": hours,
                            "sim": {"nok_rate": p}, "drive": {"release_after": 60.0 * r},
                            "extra": "studies.s4_nok.extra"})
    return out


def main():
    a = args(argparse.ArgumentParser(description=__doc__.split("\n")[0]), n=20, hours=8.0)
    t0 = time.time()
    ts = tasks(a.n, a.hours)
    print(f"S4: {len(ts)} runs of {a.hours:g} h")
    rows = run_tasks(ts, a.procs)
    for r in rows:
        r["lost_quality_hold_s"] = r.get("lost_quality_hold_s", 0.0)
    summary = summarize(rows, ["nok_rate", "release_min"], MEASURES)
    write_csv(os.path.join(a.out, "s4_runs.csv"), rows)
    write_csv(os.path.join(a.out, "s4_summary.csv"), summary)
    bad = [r for r in rows if r["model_errors"] or r["violations"]]
    print(f"S4 done in {time.time() - t0:.0f} s; runs with model errors or violations: {len(bad)}")
    if not a.quick:
        figures(summary, a.out)
    return 1 if bad else 0


def figures(summary, out):
    def series(m, scale=1.0, expected=False):
        out = []
        for r in RELEASE_MIN:
            ss = [s for s in summary if s["release_min"] == r]
            xs = [100 * s["nok_rate"] for s in ss]
            out.append((f"release after {r} min", xs, [s[m] * scale for s in ss], [(s[m + "_ci"] or 0) * scale for s in ss]))
        if expected:
            ss = [s for s in summary if s["release_min"] == RELEASE_MIN[0]]
            out.append(("expected, independent parts (2 min)", [100 * s["nok_rate"] for s in ss],
                        [s["expected_holds"] for s in ss], [0] * len(ss)))
        return out
    plot(os.path.join(out, "s4_quality_holds.png"), [
        ("NOK parts (%)", "quality holds per shift", series("quality_holds", expected=True)),
        ("NOK parts (%)", "time lost to quality holds (min per shift)", series("lost_quality_hold_s", 1 / 60)),
        ("NOK parts (%)", "good parts per hour", series("good_parts_per_hour")),
    ], "S4: NOK rate and quality holds (8 h, no other disturbances)")


if __name__ == "__main__":
    raise SystemExit(main())
