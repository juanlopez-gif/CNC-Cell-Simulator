# Regression references of Setup 2

`source/regress.js` collects a fingerprint of everything in Setup 2 that must not change when the
code is reorganized: the model KPIs and nominal state times, the NuSMV models of the verification runs, the SVG figures, the browser trace of two deterministic one-hour scenarios (and any page
error), and the Python engine's traces of deterministic and seeded random runs (`engine/regress.py`).

```
cd source
node regress.js > ../regression/<file>.json                  # record
npm run regress                                              # compare with setup2_reference.json
node regress.js --compare ../regression/setup2_baseline.json # compare with another reference
```

| File | Recorded | What it is |
|---|---|---|
| `setup2_baseline.json` | 2026-10-23, commit `2d3173b` | Setup 2 **before** step A1 removed Setup 1 from the code |
| `setup2_a1.json` | 2026-10-23, end of step A1 | Setup 2 after A1 (was `setup2_reference.json` until A2.1) |
| `setup2_a21.json` | 2026-10-28, end of step A2.1 | Setup 2 after A2.1 (was `setup2_reference.json` until A2.2) |
| `setup2_reference.json` | 2026-10-29, end of step A2.2 | The current reference; `npm run regress` and CI compare with it |

## Step A1: removing Setup 1

Comparison of the code after A1 with `setup2_baseline.json`: identical KPIs, nominal state times,
NuSMV models (all three), browser traces and Python traces (deterministic and the seeded 2 h and 8 h
random runs). The only differences are intended:

- figures `fig01`, `fig05`, `fig06`, `fig08` removed (they showed only Setup 1);
- `fig02`, `fig09`, `fig10`, `fig11` changed in their texts only (no more "Setup 1 / Setup 2"
  labels; the timing chart shows Setup 1 as a fixed baseline row);
- the new field `browser.pageErrors` (empty), added after A1 caught a page error that the trace
  comparison could not see.

A change that makes `npm run regress` fail must be explained before a new reference is recorded, and
the reason goes into the decision log of `PROJECT_STATUS.md`.

## Step A2.1: camera policy

Comparison of the code at the end of A2.1 with `setup2_a1.json`. KPIs and nominal state times are
identical, and so are the browser trace and the Python traces of the nominal runs. The differences
are all intended:

- NuSMV models: every model has more commands (P11, the guards of the FAULT-recovery changes, the
  disagreement rules) and the runs `camwrong` and `sensor_camwrong` are new;
- figures `fig03`, `fig04`, `fig07` changed in their texts only ("the camera decides" replaced by
  the rule of the checkpoint);
- scenario `cp2fault` (dead PE-41 from t = 300 s): with CP-2 = absent Robot 1 goes to FAULT on the
  missing confirmation, so the scenario now clears FAULTs as an operator would (browser and Python);
  447 → 453 state changes, browser and Python identical;
- Python 8 h random run: 9 FAULTs cleared instead of 3 (the cost of the safe values with stuck
  sensors, PROJECT_STATUS.md §5.3), 1549 jobs instead of 1542;
- Python fingerprints: times are now written as JavaScript writes them (`300`, not `300.0`). This
  changed the hash of the nominal Python runs without changing their traces; the browser and Python
  hashes of the same scenario are now equal.

## Step A2.2: gauge policy

Comparison of the code at the end of A2.2 with `setup2_a21.json` (39 differences). KPIs and the
nominal state times of Robot 1 and the conveyor are identical. The differences are all intended:

- state times of Robot 2: E0 1.5 → 8.5 s (master check `r2Master` 6 s and the move home after it),
  E1 1 → 7 s (the conditional master check counted as if it ran), E3 3.5 → 4 s (`blowOff` 0.5 s);
- NuSMV models: one more variable (`due`) and more commands in every run (P12, the steps of the
  master check, the 4-h timer; `process` also the class `master`);
- figures `fig10` (Robot 2 times) and `fig13` (Robot 2 diagram: E0, E1, E3, E4 texts, guard band);
- deterministic scenarios `nominal` and `cp2fault`: same number of state changes, later times on
  Robot 2 (blow-off, master check at start-up), browser and Python identical;
- Python random runs: the 2 h nominal run has one more job; the 8 h run injects "master check out of
  tolerance" (a new disturbance, 5 % of them, taken from the share of undersized parts), so its
  counts differ (2 master faults, 1 undersized part instead of 3).
