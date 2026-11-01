"""What the studies of step A5 share (PROJECT_STATUS §5.18): model copies with changed parameters,
one run of a shift, the operator and the technician, summaries with 95 % intervals, CSV and plots.

A study is a list of tasks (one per point and seed); run_tasks runs them in worker processes and
returns one row per run. The model file is never changed: model_with builds a copy in memory.
"""
import copy
import csv
import math
import os
from multiprocessing import Pool

from cellsim import CellSim, conformance
from cellsim.model import Model, load

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

_BASE = None


def base_data():
    global _BASE
    if _BASE is None:
        _BASE = load().data
    return _BASE


def model_with(T=None, RULES=None, scale=None):
    """A copy of the model with changed values. T: {key: nominal}, its interval keeps its factors;
    scale: {key: factor} on the nominal value and its interval; RULES: {key: value} (the mismatch
    limit is also CONST.limit for the guards)."""
    d = copy.deepcopy(base_data())
    for k, f in (scale or {}).items():
        d["T"][k] *= f
        d["TRANGE"][k] = [v * f for v in d["TRANGE"][k]]
    for k, v in (T or {}).items():
        f = v / d["T"][k]
        d["T"][k] = v
        d["TRANGE"][k] = [x * f for x in d["TRANGE"][k]]
    for k, v in (RULES or {}).items():
        d["RULES"][k] = v
        if k == "mismatchLimit":
            d["CONST"]["limit"] = v
    return Model(d)


def drive(sim, hours, step=10.0, clear_after=60.0, release_after=120.0, tech_after=0.0, every=None):
    """The operator and the technician answer the HMI as in run_random: a FAULT is cleared after
    clear_after s, a quality hold released after release_after s, the sensor verification started
    tech_after s after a line stop and the line reset when it is done. every(sim) is called after
    each step (disturbances)."""
    fault_since = qh_since = stop_since = None
    end = hours * 3600
    while sim.t < end - 1e-9:
        sim.advance(min(step, end - sim.t))
        if every:
            every(sim)
        if any(sim.faults.values()):
            fault_since = sim.t if fault_since is None else fault_since
            if sim.t - fault_since >= clear_after:
                sim.press("clear")
                fault_since = None
        else:
            fault_since = None
        if sim.vars["QH"]:
            qh_since = sim.t if qh_since is None else qh_since
            if sim.t - qh_since >= release_after:
                sim.press("qh")
                qh_since = None
        else:
            qh_since = None
        if sim.state("SUP") == "X3" and not sim.inputs["verify"]:
            stop_since = sim.t if stop_since is None else stop_since
            if sim.t - stop_since >= tech_after:
                sim.press("verify")
                stop_since = None
        if sim.state("SUP") == "X4" and sim.verify and sim.verify["done"] and not sim.inputs["reset"]:
            sim.press("resume")


def state_shares(sim):
    """Share of the run time each machine spent in each state, from the trace."""
    last, out = {}, {}
    for e in sim.trace:
        if e["slot"] in last:
            t0, s = last[e["slot"]]
            out.setdefault(e["slot"], {}).setdefault(s, 0.0)
            out[e["slot"]][s] += e["t"] - t0
        last[e["slot"]] = (e["t"], e["to"])
    for slot, (t0, s) in last.items():
        out.setdefault(slot, {}).setdefault(s, 0.0)
        out[slot][s] += sim.t - t0
    return {slot: {s: v / sim.t for s, v in d.items()} for slot, d in out.items()}


def measures_row(sim):
    """The KPI measures of §5.15 and the counts every study reports, flat for the CSV."""
    m = sim.measures()
    errs, _ = conformance(sim)
    row = {
        "parts_per_hour": m["parts_per_hour"], "good_parts_per_hour": m["good_parts_per_hour"],
        "mean_cnc_idle_s": m["mean_cnc_idle_s"], "machining_share": m["machining_share"],
        "cycles": sim.stats["cycles"], "nok_parts": sim.nok_parts,
        "line_stops": sim.stats["stops"], "quality_holds": len(sim.stats["qh"]),
        "model_errors": len(sim.errors) + len(errs), "violations": sim.stats["violations"],
    }
    for c, v in m["lost_s"].items():
        row["lost_" + c.replace(" ", "_").replace("-", "_") + "_s"] = v
    return row


def _run(task):
    """One run: task = {study, point (dict), seed, hours, model (kwargs of model_with), sim (kwargs of
    CellSim), drive (kwargs of drive), random_times}. Extra measures come from task['extra'], the name
    of a function of the study module (fn(sim) -> dict)."""
    model = model_with(**task.get("model", {})) if task.get("model") else None
    sim = CellSim(seed=task["seed"], model=model, instant_verify=True,
                  random_times=task.get("random_times", True), **task.get("sim", {}))
    drive(sim, task["hours"], **task.get("drive", {}))
    row = {"study": task["study"], **task["point"], "seed": task["seed"], "hours": task["hours"],
           "random_times": int(task.get("random_times", True))}
    row.update(measures_row(sim))
    if task.get("extra"):
        mod, fn = task["extra"].rsplit(".", 1)
        row.update(getattr(__import__(mod, fromlist=[fn]), fn)(sim))
    return row


def run_tasks(tasks, procs=None, progress=True):
    rows = []
    with Pool(procs or os.cpu_count()) as pool:
        for i, row in enumerate(pool.imap(_run, tasks), 1):
            rows.append(row)
            if progress and (i % max(1, len(tasks) // 20) == 0 or i == len(tasks)):
                print(f"  {i}/{len(tasks)} runs", flush=True)
    return rows


# Student t, 0.975 quantile, by degrees of freedom (1-30); above 30 the normal value is close enough
_T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145,
         2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048,
         2.045, 2.042]


def mean_ci(xs):
    """Mean and half-width of its 95 % interval (Student t over independent replications)."""
    xs = [x for x in xs if x is not None]
    n = len(xs)
    if n == 0:
        return None, None
    m = sum(xs) / n
    if n == 1:
        return m, None
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))
    t = _T975[n - 2] if n - 1 <= len(_T975) else 1.96
    return m, t * sd / math.sqrt(n)


def wilson(k, n):
    """95 % Wilson interval of a proportion k / n: (p, low, high)."""
    if n == 0:
        return None, None, None
    z, p = 1.96, k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return p, max(0.0, c - h), min(1.0, c + h)


def summarize(rows, keys, measures):
    """One row per point (the values of keys): n, and mean and 95 % half-width of each measure."""
    groups = {}
    for r in rows:
        groups.setdefault(tuple(r[k] for k in keys), []).append(r)
    out = []
    for g in groups:                                   # in the order of the tasks
        rs = groups[g]
        s = dict(zip(keys, g))
        s["n"] = len(rs)
        for m in measures:
            s[m], s[m + "_ci"] = mean_ci([r.get(m) for r in rs])
        out.append(s)
    return out


def write_csv(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cols = []
    for r in rows:
        cols += [k for k in r if k not in cols]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: (round(v, 6) if isinstance(v, float) else v) for k, v in r.items()})


def plot(path, panels, title):
    """panels: [(x label, y label, [(series label, xs, ys, half-widths)])], drawn side by side with
    the 95 % intervals as error bars. Needs matplotlib (only the full runs plot)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axs = plt.subplots(1, len(panels), figsize=(4.2 * len(panels), 3.4), squeeze=False)
    for ax, (xl, yl, series) in zip(axs[0], panels):
        for label, xs, ys, hw in series:
            ax.errorbar(xs, ys, yerr=[h or 0 for h in hw], marker="o", ms=3, capsize=3, lw=1.2, label=label)
        ax.set_xlabel(xl)
        ax.set_ylabel(yl)
        ax.grid(alpha=0.3)
        if len(series) > 1:
            ax.legend(fontsize=7)
    fig.suptitle(title, fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def args(parser, n, hours):
    parser.add_argument("--quick", action="store_true", help="n = 2, 0.5 h, no plots (the CI test)")
    parser.add_argument("--n", type=int, default=n, help=f"seeds per point (default {n})")
    parser.add_argument("--hours", type=float, default=hours)
    parser.add_argument("--procs", type=int, default=None, help="worker processes (default: all cores)")
    parser.add_argument("--out", default=OUT)
    a = parser.parse_args()
    if a.quick:
        a.n, a.hours = 2, 0.5
    return a
