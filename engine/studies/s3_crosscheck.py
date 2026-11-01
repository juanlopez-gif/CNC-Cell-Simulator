"""S3 (A5, PROJECT_STATUS §5.18): sensitivity of the cross-check rule (N mismatches within a window
stop the line) to false stops and to sensor faults that are not detected.

(a) No faulty sensor; transient errors only (single proximity glitch, camera wrong with a valid
    image, stale image) at 1 and 4 per hour at a random checkpoint: every line stop is a false stop.
(b) From t = 1 h one sensor, at a checkpoint drawn per run, misses the object at each check with
    probability q; the run ends at the first line stop after it (the technician finds the sensor) or
    after the shift (not detected).

    python -m studies.s3_crosscheck            (a) n = 10, (b) n = 10, 8 h, random step times
    python -m studies.s3_crosscheck --quick    n = 2, 0.5 h ((b) from 0.1 h), no plots
"""
import argparse
import os
import random
import time

from studies.common import args, episodes, plot, run_tasks, summarize, wilson, write_csv

LIMITS = [2, 3, 4, 5]
WINDOWS_MIN = [5, 10, 20, 30]
TRANSIENT_RATES = [1, 4]                   # per hour, scenario (a)
MISS_Q = [0.1, 0.3, 1.0]                   # scenario (b)
CPS = ["CP-1", "CP-2", "CP-3", "CP-4", "CP-5"]


def hook_transient(sim, seed, rate, step=10.0):
    rnd = random.Random(f"transient-{seed}")
    p = rate * step / 3600

    def every(s):
        if rnd.random() < p:
            cp = CPS[int(rnd.random() * len(CPS))]
            k = rnd.random()
            if k < 1 / 3:
                s.inject_glitch(cp)
            elif k < 2 / 3:
                s.inject_camera_wrong(cp)
            else:
                s.inject_stale_image(cp)
    return {"every": every}


def hook_sensor(sim, seed, q, onset):
    cp = CPS[random.Random(f"sensor-{seed}").randrange(len(CPS))]
    state = {"stops": None}                    # line stops before the sensor became faulty
    sim.stats["s3_cp"], sim.stats["s3_onset"] = cp, onset

    def every(s):
        if state["stops"] is None and s.t >= onset:
            s.set_sensor_miss(cp, q)
            state["stops"] = s.stats["stops"]

    def stop(s):
        return state["stops"] is not None and s.stats["stops"] > state["stops"]
    return {"every": every, "stop": stop}


def extra_transient(sim):
    return {"false_stops": len(episodes(sim)["stops"]), "mismatches": sim.stats["mismatches"],
            "faults": len(episodes(sim)["faults"])}


def extra_sensor(sim):
    onset = sim.stats["s3_onset"]
    ep = episodes(sim)
    after = [a for a, _ in ep["stops"] if a >= onset]
    det = after[0] if after else None
    return {"sensor_cp": sim.stats["s3_cp"], "detected": int(det is not None),
            "detection_min": (det - onset) / 60 if det is not None else None,
            "faults_before_detection": sum(1 for _, a, _ in ep["faults"] if a >= onset and (det is None or a <= det)),
            "mismatches": sim.stats["mismatches"]}


def tasks(n, hours, onset):
    out = []
    for lim in LIMITS:
        for w in WINDOWS_MIN:
            rules = {"RULES": {"mismatchLimit": lim, "mismatchWindow": 60.0 * w}}
            for r in TRANSIENT_RATES:
                for seed in range(1, n + 1):
                    out.append({"study": "S3a", "point": {"limit": lim, "window_min": w, "transient_per_h": r},
                                "seed": seed, "hours": hours, "model": rules, "hook": "studies.s3_crosscheck.hook_transient",
                                "hook_args": {"rate": r}, "extra": "studies.s3_crosscheck.extra_transient"})
            for q in MISS_Q:
                for seed in range(1, n + 1):
                    out.append({"study": "S3b", "point": {"limit": lim, "window_min": w, "miss_q": q},
                                "seed": seed, "hours": hours, "model": rules, "hook": "studies.s3_crosscheck.hook_sensor",
                                "hook_args": {"q": q, "onset": onset}, "extra": "studies.s3_crosscheck.extra_sensor"})
    return out


def main():
    a = args(argparse.ArgumentParser(description=__doc__.split("\n")[0]), n=10, hours=8.0)
    t0 = time.time()
    ts = tasks(a.n, a.hours, 360.0 if a.quick else 3600.0)
    print(f"S3: {len(ts)} runs of up to {a.hours:g} h")
    rows = run_tasks(ts, a.procs)
    ra = [r for r in rows if r["study"] == "S3a"]
    rb = [r for r in rows if r["study"] == "S3b"]
    sa = summarize(ra, ["limit", "window_min", "transient_per_h"], ["false_stops", "mismatches", "faults", "good_parts_per_hour"])
    sb = summarize(rb, ["limit", "window_min", "miss_q"], ["detection_min", "faults_before_detection"])
    for s in sb:
        rs = [r for r in rb if (r["limit"], r["window_min"], r["miss_q"]) == (s["limit"], s["window_min"], s["miss_q"])]
        k = sum(1 - r["detected"] for r in rs)
        s["not_detected"], s["not_detected_low"], s["not_detected_high"] = wilson(k, len(rs))
    write_csv(os.path.join(a.out, "s3_runs.csv"), rows)
    write_csv(os.path.join(a.out, "s3a_summary.csv"), sa)
    write_csv(os.path.join(a.out, "s3b_summary.csv"), sb)
    bad = [r for r in rows if r["model_errors"] or r["violations"]]
    print(f"S3 done in {time.time() - t0:.0f} s; runs with model errors or violations: {len(bad)}")
    if not a.quick:
        figures(sa, sb, a.out)
    return 1 if bad else 0


def figures(sa, sb, out):
    def ser_a(rate):
        res = []
        for w in WINDOWS_MIN:
            ss = [s for s in sa if s["window_min"] == w and s["transient_per_h"] == rate]
            res.append((f"window {w} min", [s["limit"] for s in ss], [s["false_stops"] for s in ss], [s["false_stops_ci"] or 0 for s in ss]))
        return res

    def ser_b(q, m, scale=1.0):
        res = []
        for w in WINDOWS_MIN:
            ss = [s for s in sb if s["window_min"] == w and s["miss_q"] == q]
            if m == "not_detected":
                ys = [100 * s[m] for s in ss]
                hw = [100 * (s["not_detected_high"] - s["not_detected_low"]) / 2 for s in ss]
            else:
                ys = [s[m] for s in ss]
                hw = [s[m + "_ci"] or 0 for s in ss]
            res.append((f"window {w} min", [s["limit"] for s in ss], ys, hw))
        return res
    plot(os.path.join(out, "s3a_false_stops.png"), [
        ("mismatch limit", f"false stops per shift ({r} transient errors / h)", ser_a(r)) for r in TRANSIENT_RATES
    ], "S3 (a): false line stops, no faulty sensor (8 h)")
    plot(os.path.join(out, "s3b_detection.png"), [
        ("mismatch limit", f"faults not detected in the shift (%), q = {q}", ser_b(q, "not_detected")) for q in MISS_Q
    ] + [("mismatch limit", "time to detection (min), q = 0.3", ser_b(0.3, "detection_min"))],
        "S3 (b): an intermittent sensor from t = 1 h (95 % intervals: Wilson for the share, t for the time)")


if __name__ == "__main__":
    raise SystemExit(main())
