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
| `setup2_a5.json` | 2026-10-29, end of step A2.2 | Setup 2 after A2.2, unchanged through A2.3–A5 (was `setup2_reference.json` until A6.2) |
| `setup2_reference.json` | 2026-11-02, end of step A6.2 | The current reference; `npm run regress` and CI compare with it |

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

## Step A6.2: a broken sensor and `VERIFY.fail`

Comparison of the code at the end of A6.2 with `setup2_a5.json` (17 differences). KPIs, nominal
state times, figures, the browser traces and the deterministic Python traces are identical. The
differences are all intended:

- NuSMV models of the five runs: the new invariant P13 (no other change: `VERIFY.fail` was already a
  free input of the abstract model, so the state space is the same);
- Python 8 h random run: 30 % of the new sensor faults are broken sensors (`BROKEN_SHARE`, drawn from
  a stream of their own, so the other draws are as before). In this run 3 of the 6 sensor faults are
  broken; each costs a sensor replacement of 15 min during the line stop, so the run has 77 CNC cycles
  instead of 89 (1385 instead of 1596 state changes).

The parity test has a fourth scenario, `cp2broken` (broken PE-41 from t = 300 s): browser and Python
identical (351 state changes).

## Step A6.3: CNC alarm, state W2 and P14

Comparison of the code at the end of A6.3 with `setup2_a62.json` (13 differences). KPIs, nominal
state times, the browser traces and the Python fingerprints are identical. The differences are all
intended:

- state times of Robot 1: the new state W2 WAIT FOR CNC (0 s, it is not entered in nominal operation);
- NuSMV models of the five runs: the new property P14 and the W2 transitions; `process` also the
  class `cncalarm` (one more variable `alarm` and the alarm and reset commands of the CNC);
- figure `fig12` (Robot 1 diagram: W2 next to B2).

The Python 8 h random run (seed 4) draws no CNC alarm: its CNC machines only 2.6 h (the absent
operator), at 0.5 alarms per hour of machining. The 8 h run with seed 1 has 3 alarms, with no
transition outside the model and no violation. The parity test has a fifth scenario, `cncalarm`
(alarms injected at t = 300 s and 1500 s): browser and Python identical (359 state changes).

## Step A6.4: tool change (W3, P15), size drift and early warning

Comparison of the code at the end of A6.4 with `setup2_a63.json` (13 differences). KPIs, nominal
state times, the browser traces and the Python fingerprints are identical: the drift lowers the
sizes (at most 0.8 mm before a tool change) but changes no gauge verdict in the recorded runs. The
differences are all intended:

- state times of Robot 1: the new state W3 TOOL CHANGE (0 s, it is not entered in nominal operation);
- NuSMV models of the five runs: the new property P15, the W3 transitions and the B6 guard; `process`
  also the class `toolwear` (one more variable `toolCount`, 0 in its life / 1 change due);
- figure `fig12` (Robot 1 diagram: W3 next to B2).

The parity test has a sixth scenario, `toolwear` (tool life end at t = 300 s, offset error at
t = 1200 s): browser and Python identical.

## Step A6.5: safety status (machine SAF, P16, P17)

Comparison of the code at the end of A6.5 with `setup2_a64.json` (38 differences). KPIs and the state
times of the four machines are identical; every recorded trace has one state change more, the start
of SAF (S1 at t = 0.05 s), and is otherwise the same. The differences are all intended:

- state times: new entries for SAF S1 to S5 (all 0 in the fingerprint, which times the states of the
  robots, the conveyor and the supervisor only);
- NuSMV models of the five runs: one more variable (the location of SAF), the awaits of B1 and E5
  (`!SC-01.prot`, `!SC-02.prot`), the fault exits `HMI.clear & !ESTOP.active`, the new properties
  P16 and P17; two new models, `estop` and `person`;
- figures `fig07`, `fig12`, `fig13` (texts of the FAULT boxes and of B1 / E5) and the new `fig15`
  (safety status);
- browser and Python traces (`det_nominal`, `det_cp2fault`, `random_nominal_2h`, `random_faults_8h`):
  +1 state change each (SAF).

The parity test has a seventh scenario, `safety` (persons in the loading zones during the pick of
Robot 1 and the place of Robot 2, E-stops while Robot 1 opens the door, loads the vise and waits):
browser and Python identical.

## End of A6: published models with `slots: 'any'`

The published NuSMV models are now built with the output pallet of any capacity (`V.PUBLISHED`,
used by `verify.js`, `build_all.js` and `regress.js`). Comparison with the reference of A6.5: 7
differences, the hashes of the seven NuSMV models (same variables and commands; the place step of
the count becomes a nested `case` with the step 1 → 1); everything else identical. The reference
`setup2_reference.json` was updated in these 7 entries only.
