# Camera policy: evidence for the decision of step A2.1

Prepared on 2026-10-28 for the author's decision (PROJECT_STATUS.md §15, A2.1). Sections 1–6 are
the evidence as presented before the decision; the decision and what followed are in §0.

## 0. Decision (2026-10-28)

The author chose: **CP-1 camera, CP-2 absent, CP-3 absent, CP-4 absent, CP-5 present.** The four
recovery changes of §3 were applied with it, because CP-2 = absent is safe only with them (the
author confirmed them explicitly later the same day). Both are in `source/src/cell-model.js` and logged in
PROJECT_STATUS.md §17.

Found after the decision, while re-running the tests:

- With a **dead proximity sensor** (stuck, not a one-off error) at CP-2, CP-3 or CP-4, the safe value
  makes the confirmation after each place / pick fail, so the robot goes to FAULT; the operator
  clears it and the third mismatch stops the line. With `camera` the line kept running until the
  third mismatch. Python engine, 1 h after the sensor dies: line stop after ~150 s instead of ~300 s,
  3 FAULTs cleared instead of 0, 26–27 good parts either way, no violation. Over 10 random 8 h runs
  with all fault types: 123.3 instead of 124.7 good parts, 12.4 instead of 4.0 FAULTs cleared.
- **HMI defect** made reachable by this: during a line stop the banner offered only the sensor
  verification, which waits until both robots are parked, and a robot in FAULT parks only after the
  fault is cleared. The banner now also offers "clear fault" during a line stop.
- With the safe values a wrong reading is recovered by the PLC confirmation timeout. Every
  verification run with sensor faults now includes the class `timeout` (without it the search finds
  robots waiting forever: 330 deadlock states in the `sensor` run).

## 1. What was tested

**New fault classes** (verifier, browser simulator and Python engine):

| Class | Meaning | Verifier | Simulators |
|---|---|---|---|
| proximity wrong | the proximity sensor gives the wrong answer (existing *mismatch* class) | `mismatch` | *Glitch* |
| camera false positive | valid image, the camera sees an object that is not there | `camfp` | *Cam wrong* |
| camera false negative | valid image, the camera misses an object that is there | `camfn` | *Cam wrong* |
| stale image | the camera answers from its previous image; wrong only if the fact changed | `stale` | *Stale* |

One source is wrong at a time. Both wrong in the same direction (common mode) is not modelled: then
the two agree and no rule can detect it. Every disagreement is still counted as a mismatch, so three
in 10 min still stop the line (P9).

**Rules** (`CHECKPOINTS[].rule` in the model; value used when the two sources disagree):

| Rule | Value used on disagreement |
|---|---|
| camera | the camera value (the original rule) |
| prox | the proximity value |
| present | "present": the place is treated as occupied / the pallet as there |
| absent | "absent": the place is treated as free / the pallet as missing |
| ask | none: line stop, the operator looks, the check is repeated after the reset (in the verifier: the camera-fault path) |

**New property P11**: Robot 2 loads the gauge only into an empty nest. No property covered a part
loaded on top of another before.

**Runs**

1. *Exhaustive, one checkpoint at a time* (`source/camera_study.js`): for every checkpoint and every
   rule, wrong readings at that checkpoint only, the others correct. Twice: without and with the PLC
   confirmation timeouts (fault class `timeout`). The run with timeouts is the realistic one: the PLC
   raises a FAULT when a confirmation does not arrive, and the operator clears it, after which the
   state is repeated. 25 runs each, 0.5–26 million states per run.
2. *Timed* (`engine/camera_sim.py`): Python engine, 3 seeds × 8 h per checkpoint and rule; every
   10 s a wrong reading at that checkpoint with probability 0.012 (≈ 4 per hour: half camera wrong,
   a quarter stale image, a quarter proximity wrong). Operator clears a FAULT after 60 s; the
   technician answers line stops. Nominal without wrong readings: **25.50 good parts/h**.
3. *All checkpoints at once*: wrong readings at every checkpoint, with timeouts, the recovery changes
   of §3 and a candidate rule set.

## 2. Results with the model as it is

Exhaustive, with timeouts. Without timeouts (`camera_study/exhaustive_no_timeouts.md`) P5 and P11 do
not appear, because there is no FAULT to recover from: the same situations end in silent deadlocks
(65–170 deadlock states per run at CP-2, CP-3 and CP-5), and P6 at CP-4 fails as here.

| Checkpoint | camera | prox | present | absent | ask |
|---|---|---|---|---|---|
| CP-1 input pallet | pass | pass | pass | pass | pass |
| CP-2 conveyor entry | **P5**, deadlock | **P5**, deadlock | deadlock | **P5** | pass |
| CP-3 conveyor exit | livelock (L1 L2) | livelock | livelock | pass | pass |
| CP-4 output pallet | **P6** | **P6** | **P6** | pass | pass |
| CP-5 gauge nest | **P11** | **P11** | pass | **P11**, livelock | pass |

Timed, 8 h (mean of 3 seeds; *viol.* = property violations in the 3 runs together):

| CP | Rule | Good parts/h | Lost | Line stops | FAULTs | Time in stop + FAULT | Viol. |
|---|---|---:|---:|---:|---:|---:|---|
| CP-1 | camera / prox / present / absent | 25.50 | 0 % | 1.3 | 0 | 0.4 min | 0 |
| CP-1 | ask | 25.50 | 0 % | 28.0 | 0 | 7.0 min | 0 |
| CP-2 | camera | 23.38 | **8.3 %** | 1.7 | 53 | 69 min | **3 × P5** |
| CP-2 | prox | 25.46 | 0.2 % | 1.3 | 10 | 13 min | 0 |
| CP-2 | present | 25.33 | 0.7 % | 1.7 | 35 | 45 min | 0 |
| CP-2 | absent | 25.00 | 2.0 % | 1.0 | 9 | 11 min | **2 × P5** |
| CP-2 | ask | 25.50 | 0 % | 33.7 | 0.3 | 9 min | 0 |
| CP-3 | camera | 25.50 | 0 % | 1.7 | 20 | 26 min | 0 |
| CP-3 | prox | 25.50 | 0 % | 0.7 | 10 | 12 min | 0 |
| CP-3 | present | 25.50 | 0 % | 1.7 | 29 | 36 min | 0 |
| CP-3 | absent | 25.50 | 0 % | 0.7 | 1.7 | 2 min | 0 |
| CP-3 | ask | 25.50 | 0 % | 29.3 | 0 | 7 min | 0 |
| CP-4 | camera | 25.46 | 0.2 % | 2.0 | 19 | 25 min | 0 |
| CP-4 | prox | 25.50 | 0 % | 2.3 | 10 | 14 min | 0 |
| CP-4 | present | 25.50 | 0 % | 2.3 | 0 | 0.5 min | 0 |
| CP-4 | absent | 25.46 | 0.2 % | 2.0 | 29 | 38 min | 0 |
| CP-4 | ask | 25.50 | 0 % | 28.7 | 0 | 7 min | 0 |
| CP-5 | camera | 25.46 | 0.2 % | 2.0 | 20 | 26 min | **59 × P11** |
| CP-5 | prox | 25.50 | 0 % | 2.3 | 10 | 14 min | **30 × P11** |
| CP-5 | present | 25.50 | 0 % | 2.3 | 0 | 0.6 min | 0 |
| CP-5 | absent | 25.46 | 0.2 % | 2.0 | 30 | 39 min | **89 × P11** |
| CP-5 | ask | 25.50 | 0 % | 28.7 | 0 | 7 min | 0 |

The timed runs miss rare cases the exhaustive search finds: P6 at CP-4 needs a camera false positive
exactly while the output pallet is being changed, which never happened in 24 h. A clean timed row is
not evidence of safety; the exhaustive table is.

## 3. What the counterexamples show: three recovery defects

Most failures are not caused by the rule but by **how a FAULT is recovered**: after the operator
clears a FAULT, the state is entered again from its first step (§5 of PROJECT_STATUS.md). That is
wrong for a step that moves a part and has already been done:

| Where | Sequence | Consequence |
|---|---|---|
| Robot 1, B7 (CP-2) | part placed → the check after the place misses it → timeout FAULT → cleared → B7 again: pre-place check misses it again → **place motion onto the occupied entry** | P5 |
| Robot 2, E2 (CP-3) | part picked → the check after the pick still sees a part → FAULT → cleared → **pick again with the part in the gripper** | livelock (part lost in the abstract plant; physically a pick with a full gripper) |
| Robot 2, E3 (CP-5) | part loaded → the check misses it → FAULT → cleared → **load again into the occupied nest** | P11 |

A fourth defect is not a recovery problem: the conveyor start-up checks (CP-2, CP-3) run once; a
single wrong "occupied" leaves the conveyor waiting forever without an alarm (deadlock).

**Proposed changes** (tested in memory, not yet in the model):

1. B7: the pre-place check and `R1.placeConvB` only `when: 'GR-21B'` (gripper B still holds the part).
2. E2: `R2.pickConv` only `when: '!GR-51'` (gripper empty).
3. E3: `R2.loadGauge` only `when: 'GR-51'` (gripper holds the part).
4. Conveyor start-up: both checks repeated `until` they read clear.

General rule behind 1–3, worth writing into §5: *a step that moves a part runs only if the gripper
state shows it has not run yet*, so repeating a state after a FAULT is always safe.

## 4. Results with the recovery changes

Exhaustive, with timeouts:

| Checkpoint | camera | prox | present | absent | ask |
|---|---|---|---|---|---|
| CP-1 input pallet | pass | pass | pass | pass | pass |
| CP-2 conveyor entry | pass | pass | pass | pass | pass |
| CP-3 conveyor exit | pass | pass | pass | pass | pass |
| CP-4 output pallet | **P6** | **P6** | **P6** | pass | pass |
| CP-5 gauge nest | pass | pass | pass | pass | pass |

Timed, with the changes (only the rows that changed; all others as in §2):

| CP | Rule | Good parts/h | Lost | FAULTs | Time in stop + FAULT | Viol. |
|---|---|---:|---:|---:|---:|---|
| CP-2 | camera | 25.42 | 0.3 % | 26 | 33 min | 0 (was 3 × P5) |
| CP-2 | absent | 25.50 | 0 % | 1.0 | 1.7 min | 0 (was 2 × P5) |
| CP-5 | camera | 25.46 | 0.2 % | 20 | 26 min | 0 (was 59 × P11) |
| CP-5 | prox | 25.50 | 0 % | 10 | 14 min | 0 (was 30 × P11) |
| CP-5 | absent | 25.46 | 0.2 % | 30 | 39 min | 0 (was 89 × P11) |

All checkpoints at once (wrong readings everywhere, timeouts, the changes, CP-4 = absent and the
others = camera): **28,933,373 states, every property P1–P11 and L1–L3 holds, no deadlock.**

## 5. The decision, checkpoint by checkpoint

With the recovery changes, the rule decides safety only at **CP-4**. At the other checkpoints every
rule is safe and the choice is about lost time and operator load.

| CP | What a wrong answer costs | Alternatives (safe ones in bold) | Recommendation |
|---|---|---|---|
| CP-1 input pallet | time only: a pick attempt on a missing pallet becomes a grip miss; a missed pallet makes Robot 1 wait in W1 | **camera, prox, present, absent** (no cost); **ask** (28 stops / 8 h) | keep **camera** |
| CP-2 conveyor entry | collision of Robot 1 with a part at the entry; protected by the `partPlaced` handshake and change 1 | **all five** with the changes; cost from 1.7 min (absent) to 45 min (present) per 8 h | **camera** (no change) or **absent** (cheapest). *absent* treats a doubtful entry as free: safe here only because the handshake and change 1 also protect it |
| CP-3 conveyor exit | time: pick from an empty exit, or a part reported still there after the pick | **all five** with the changes; absent cheapest (2 min / 8 h) | **absent** |
| CP-4 output pallet | **a part placed on a missing pallet (falls)**, P6 | **absent** (29 FAULTs, 38 min / 8 h), **ask** (29 line stops, 7 min / 8 h); camera, prox and present fail P6 | **absent**, or **ask** if a stop is preferred to a FAULT at the robot |
| CP-5 gauge nest | **a part loaded on top of another** (P11), protected by change 3 | **all five** with the changes; present cheapest (0.6 min / 8 h) | **present** |

What the decision changes: the original rule "the camera decides" stays at CP-1 (and CP-2 if chosen)
and is replaced by conservative fusion where a wrong answer costs safety (CP-4) or where it is
cheaper (CP-3, CP-5). The cost of the recommended set in the timed runs is under 1 % of good parts.

**To decide:**

1. Accept the four recovery changes of §3 (they are defects, not policy, but they change the
   behaviour of the machines).
2. The rule of each checkpoint (table above).

After the decision: the rules and changes go into `cell-model.js`, the verification is run again for
the chosen set (alone and combined with the other fault classes), `verification/results.md`,
PROJECT_STATUS.md §1.1, §5, §13 and §17 are updated, and the decision is logged.

## 6. Limits of this evidence

- Common-mode errors (both sources wrong the same way) are not modelled; no fusion rule detects them.
- Wrong readings at all checkpoints at once were checked for one rule set only (§4).
- *ask* is modelled with the camera-fault path (line stop, sensor verification, reset); at the
  conveyor start-up there is no hold, so there it is modelled as repeating the check.
- The camera-only measurements (pick pose, parts left on the input pallet, output-pallet slot) are not
  cross-checked; their errors appear as grip misses (process fault class).
- The error rate of the timed runs (≈ 4 wrong readings per hour at one checkpoint) is chosen to make
  the effects visible, not measured.

## 7. Files

`camera_study/`: `exhaustive_no_timeouts.*`, `exhaustive_timeouts.*`,
`exhaustive_timeouts_recovery_changes.*` (output of `source/camera_study.js`), `timed.txt`,
`timed_recovery_changes.txt` (output of `engine/camera_sim.py`), `all_checkpoints_recovery_changes.txt`,
and the scripts that apply the recovery changes in memory (`patch_model.js`, `study_fixed.js`,
`sim_fixed.py`). Commands: `cd source && FAULTS=mismatch,camwrong,timeout node --max-old-space-size=8000
camera_study.js` and `cd engine && python camera_sim.py --hours 8 --seeds 1,2,3`.
