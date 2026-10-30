# Pallet capacity and combined faults: step A2.5

Prepared on 2026-10-30 (PROJECT_STATUS.md §15, A2.5). Runs: `source/verify_pallet.js`, results in
`verification/pallet_capacity.json`. Search on the local computer (Windows 11, 15.4 GB RAM).

## 0. Result

| Question | Answer | Evidence |
|---|---|---|
| Does the verification of a 2-slot output pallet hold for the real 12 slots? | **Yes, for the safety properties (P1–P12) and no deadlock, for every capacity N ≥ 2, in all five runs**; for L1–L3 also yes by a counter game in three runs (none, process, camwrong) | §1–§3 |
| Capacity 3 compared with capacity 2 | Same verdicts: 15 properties hold, 0 deadlocks, in the three runs that fit (none, process, camwrong); 1.26–1.35 × the states | §4 |
| `faults: 'all'` (sensor and process faults combined) | **Out of reach** with the explicit search: about 1.4 × 10⁹ states, about 140 GB | §5 |
| Largest combined run reached | Sensor faults + timeouts + missed picks + master check out of tolerance (everything of `all` except undersized parts): 79,680,713 states, 15 properties hold, 0 deadlocks | §5 |

## 1. What the logic reads of the count

The machines and the properties read the output-pallet count `outCount` only through three
comparisons: `PALLET.empty` (`outCount = 0`), `PALLET.full` (`outCount >= slots`) and P6
(`outCount < slots` when Robot 2 places). The only update is "place one part" (`outCount + 1`) and
"operator swaps the pallet" (`outCount := 0`). The input pallet is already abstract in the model:
`inParts` is a Boolean and every pick chooses freely whether parts are left.

## 2. Safety for every capacity: the abstraction `slots: 'any'`

With `build(2, {slots: 'any'})` the count has three abstract values: 0 empty, 1 partly filled, 2
full. A place goes 0 → 1, 1 → {1, 2} (still room, or now full), 2 → 2 (the place itself is what
P6 forbids). For any capacity N ≥ 2 the map `0 ↦ 0`, `1..N−1 ↦ 1`, `N ↦ 2` sends every concrete
step to an abstract step, and keeps the value of the three comparisons of §1. So every run of the
cell with an N-slot pallet is a run of the abstract model with the same controller states, and
a safety property or deadlock freedom that holds in the abstract model holds for every N ≥ 2,
12 included. (N = 1 is excluded: the first place would fill the pallet, 0 → 2.)

Result: in all five runs of `verify.js` the abstract model has **exactly the same states as
capacity 2** (297,136 / 68,790,749 / 8,855,602 / 17,046,483 / 79,819,587), only more transitions
(the step 1 → 1). All 15 properties hold, 0 deadlocks. The step is new in `cell-verify.js`
(update kind `step`, also exported to NuSMV as a nested `case`); the published `.smv` models use
capacity 2 and are unchanged.

## 3. Liveness (L1–L3) for every capacity: the counter game

L1–L3 are "eventually" properties (AG EF). The abstraction of §2 is not enough for them: the
abstract model may reach the goal only through the step 1 → 2, which a concrete pallet of 12 takes
only after 11 places. The search therefore also solves a game (`check(ir, {counters: [...]})`): the
cell and the plant choose the step, an adversary chooses the new value of the count variables
(`outCount` and `inParts`), and the goal must be in the attractor of every reachable state. A
winning strategy for the cell does not depend on how many places fill the pallet or how many picks
empty the input pallet, so L1–L3 hold for any capacity of both pallets.

| Run | States | L1 | L2 | L3 |
|---|---:|---|---|---|
| none | 297,136 | holds | holds | holds |
| process | 8,855,602 | holds | holds | holds |
| camwrong | 17,046,483 | holds | holds | holds |

Negative test, to show the game can fail: with the CNC variable also given to the adversary (on
`nok`, capacity `any`), L2 fails in 869,947 states, as it should. The game needs about 3 × the
memory of the search; for `sensor` and `sensor_camwrong` (69–80 million states) it does not fit.
For those two runs L2 still transfers: a shortest path to its goal contains no place step, so it
does not depend on the count. L1 and L3 of those two runs are proved for capacity 2 and for the
abstract model only; for 12 slots they remain an argument (the sensor faults do not touch the
output pallet, and the game holds for the other runs).

## 4. Capacity 3 compared with capacity 2

| Run | States, capacity 2 | States, capacity 3 | Ratio | Properties | Deadlocks |
|---|---:|---:|---:|---|---:|
| none | 297,136 | 374,739 | 1.26 | 15 hold | 0 |
| process | 8,855,602 | 11,479,617 | 1.30 | 15 hold | 0 |
| camwrong | 17,046,483 | 23,007,294 | 1.35 | 15 hold | 0 |

Capacity 3 adds the states with one part on the pallet that is neither the first nor the last. It
widens the evidence but is not what carries the case of 12: §2 and §3 do.

## 5. Combined faults

Measured factor on the states of the nominal run (297,136) for each class alone: mismatch × 46,
camera × 12.6, grip × 1.02, timeout × 1.55, undersized part (nok) × 17.4, master check × 1.12. The
factors multiply (process predicted × 30.8, measured × 29.8). `all` = sensor + process is about
1.37 × 10⁹ states; at about 100 bytes per state that is 140 GB, against 15.4 GB in this computer
(practical limit about 120 million states). It is out of reach of the explicit search; NuSMV did
not finish the smaller `sensor_camwrong` invariants in 12 h, so it is not an alternative either.

Largest combined run reached: every class of `all` except `nok`.

| Run | Fault classes | States | Transitions | Time | Properties | Deadlocks |
|---|---|---:|---:|---:|---|---:|
| all_but_nok | mismatch, camera, timeout, grip, master | 79,680,713 | 385,911,904 | 44 min | 15 hold | 0 |
| sensor_camwrong (§9.3) | mismatch, camera, camfp, camfn, stale, timeout | 79,819,587 | 402,849,626 | 50 min | 15 hold | 0 |

So sensor faults are now verified together with every process fault except undersized parts. The
undersized part and the sensor faults act on different machines (the gauge decision of Robot 2 and
the quality hold, against the checks of Robots 1 and 2 and the belt); the only shared paths are the
quality hold and the line stop, both reached in `process` and in `sensor`. This is an argument, not
a run.

## 6. Limits

- The abstraction of §2 holds because the logic compares the count only with 0 and with the
  capacity. A rule that read another value (for example "slow down at 10 parts") would break it;
  `lint()` does not check this.
- The game of §3 was solved for three of the five runs; memory decides, not time.
- `all` was not run; §5 is a measured estimate.
- Everything else of PROJECT_STATUS.md §9 still applies: untimed plant, one source wrong at a
  time, interleaving semantics.
