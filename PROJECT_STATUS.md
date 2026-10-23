# CNC Cell Simulator: project status and technical reference

Checkpoint of the project on **2026-10-23**. This file describes what exists, how every part works,
how the parts depend on each other, what has been checked, what is out of date, and how to extend
the project without breaking it. `README.md` is the public summary; this file is the engineering
reference behind it.

---

## 0. Snapshot

| Item | Value |
|---|---|
| Repository | https://github.com/juanlopez-gif/CNC-Cell-Simulator (public) |
| Live simulator | https://juanlopez-gif.github.io/CNC-Cell-Simulator/ (GitHub Pages from `main`, root `index.html` redirects to `simulation/`) |
| Scope | **Setup 2 only** (dual gripper on Robot 1, gauge and NOK sorting on Robot 2) since step A1 |
| Branch `main` | Step A1 merged (Setup 2 only, CI, one build command, regression references) |
| Branch `legacy-setup1-setup2` | Commit `1f4b8ad`: the last version with Setup 1 and Setup 2, frozen |
| Branch `state-machines-as-data` | Commit `6204b09`; history only, no work on it |
| Continuous integration | GitHub Actions `checks` on every push; `full verification` (NuSMV) by hand (§11) |
| Toolchain used | Node.js 24, Python 3.11, Google Chrome (headless via puppeteer-core), NuSMV 2.7.1; Windows 11 locally, Ubuntu in CI |
| Built by | Claude Code (one agent, model Claude Opus 5.5) directed by the author |

### Health check at the end of step A1 (2026-10-23)

| Check | Command | Result |
|---|---|---|
| Lint and generated files | `npm run check` | lint `[]`; 15 generated files identical to what the sources give |
| Python engine tests | `python -m unittest test_engine` | 5 tests OK |
| Browser tests | `npm test` (basic, fault, quality hold, phone width, 20 h conformance, Python parity) | all pass, no page errors |
| Regression | `npm run regress` | Setup 2 identical to `regression/setup2_reference.json`; against the pre-A1 baseline only the intended figure changes (`regression/README.md`) |
| Exhaustive verification + NuSMV | `npm run verify` with `NUSMV` | 3 runs, 13 properties hold, no deadlock, NuSMV agrees on every verdict and state count; numbers identical to before A1 (§9.3) |
| KPIs | `M.KPI` | idle 20.5 s, cycle 140.5 s, 85.4 % of the cycle machining, 25.6 parts/h; baseline `M.BASELINE` 36.5 s |

### Decided versus implemented

| Item | Decided | In `main` today |
|---|---|---|
| Work continues with Setup 2 only | Yes (2026-10-23) | Yes (step A1): the code, the figures, the tests and this file describe Setup 2 only |
| Both setups frozen in `legacy-setup1-setup2` | Yes | Yes |
| Claims limited to what the evidence shows (§1.1) | Yes | Yes (this revision) |
| Cross-check rule tested against camera errors | Planned (A2.1) | **No.** The abstract model and the simulators assume the camera is always right; only the documentation was corrected |
| Roadmap A1–A6, B, C (§15) | Yes | A0 and A1 done; next A2; progress table in §15 |

---

## 1. What the project is

It started as the solution to the ISE 401 Week 2 "Sensors Design Task" for a CNC machine-tending
cell, which had two setups. Since 2026-10-23 the project continues with **Setup 2 only**; Setup 1
remains as the baseline of the comparison and in the branch `legacy-setup1-setup2`.

- **Setup 1 (baseline, not developed).** An operator loads a pallet of 50 × 50 × 50 mm aluminium blocks. Robot 1 (UR10e)
  opens the CNC door, loads a block into the vise, and after the 120 s cycle unloads the finished
  part onto a conveyor. Robot 2 picks it at the conveyor exit and places it on an output pallet
  (12 slots). A blue light signals a full pallet. Robots pick or place at the belt only while it is
  stopped.
- **Setup 2 (the project).** Same cell, but every part is measured; any length, width or height below 48.00 mm (nominal 50 −
  2 mm) goes to a locked NOK chute. CNC time is optimized with a dual gripper on Robot 1 and a gauge
  served by Robot 2 while the CNC machines.
- **The author's design rule.** At each checkpoint a proximity/photoelectric sensor and a camera
  must agree. On disagreement the camera value is used and a mismatch is logged. Three mismatches
  within 10 minutes stop the line until a technician verifies the sensors. Safety is hardwired and
  never overridden by the camera.

The project grew from that assignment into a **model-driven** system: the four state machines of the
cell are data in one file, and the diagrams, the browser simulator, the Python engine and the
formal verification are all generated from or interpret that file.

### 1.1 What the evidence supports

| Claim | Evidence | Assumptions and limits |
|---|---|---|
| The model is internally consistent | `lint()` | Structural only: names exist, states reachable, texts match the logic. Says nothing about whether the logic is right |
| The browser and Python simulators run the same controller logic | Export check; identical traces in 2 deterministic scenarios (1 h each) | Shows that the Python port reproduces the browser in those scenarios. Python is a line-by-line port, so an error in the original would be reproduced, not detected |
| Both simulators follow the model | Conformance runs, 20 h with random faults | Only with the simulated plant and the faults it can inject |
| 13 properties hold and there is no deadlock | Exhaustive search of the abstract model, 3 runs (nominal, sensor faults, process faults) | Untimed plant; **the fused check result always equals the physical truth** (a mismatch only adds to the counter, the camera is never wrong); output pallet of 2 slots; sensor and process faults never combined in one run; L1–L3 are AG EF: the goal can always still be reached, not that it will be reached |
| The search and the NuSMV export agree | Same verdicts and state counts in all 3 runs | Additional evidence of consistency. Both start from the same intermediate representation (`build()`), so an error made there would be shared |
| CNC idle 36.5 s → 20.5 s; 23.0 → 25.6 parts/h | Setup 2: sum of nominal step times of the states in the idle band, reproduced by the simulators without faults. Setup 1: fixed baseline numbers (`M.BASELINE`) computed before A1 | Planning estimates, not measurements. Nominal exchange only: excludes material shortage, pallet changes, holds and repairs. Idle time falls 43.8 %, output rises 11.4 %. The 85.4 % is the share of the nominal cycle spent machining, not availability or OEE |
| Removing Setup 1 (A1) did not change Setup 2 | `regression/`: identical KPIs, NuSMV models, browser and Python traces (deterministic and seeded random runs) | Covers the recorded scenarios and the three abstract models, not every possible run |
| The cross-check rule ("the camera decides") is safe | — | **Not shown.** Camera errors with a valid image are not modelled (§9.1, §13) |
| The design is validated for a real cell | — | **Not claimed.** No hardware, no measured times; sensors and prices come from catalogues |

---

## 2. History in one table

| Date | Commit | What changed |
|---|---|---|
| 2026-09-28 | `7d29395` | First complete version from one prompt: 27-page report, 14 diagrams, browser simulation. State machines were written separately in the diagrams and in the simulator. |
| 2026-09-28 | `7697eae`, `99bc009` | GitHub Pages entry page; README link to the live simulator. |
| 2026-09-30 | `331205c` | Human-caught error fixed: the dual-gripper exchange is now drawn and simulated clearly (fig14). 4-page short answer added. Demo video added. |
| 2026-10-01 | `9846a4d` | **Machines as data**: states, steps, transitions and guards moved into `src/cell-model.js`. Diagrams and simulator generated from / interpret it. KPIs computed. Lint and conformance test added. |
| 2026-10-01 | `0986e51` | Exhaustive verifier (`src/cell-verify.js`, `verify.js`), 13 properties, NuSMV export, results. |
| 2026-10-02 | `26572f1` | NuSMV 2.7.1 run on all six models; encoding fixed for speed (IVAR command, stutter, invariants); verdicts and state counts agree. |
| 2026-10-21 | `6204b09` | Python engine `engine/cellsim` (no graphics), JSON export of the model, browser-vs-Python trace comparison. Merged to `main` and pushed. |
| 2026-10-23 | `1f4b8ad` … `2d3173b` | This file; roadmap; two external reviews triaged; both setups frozen in `legacy-setup1-setup2`. |
| 2026-10-23 | branch `a1-base` | **Step A1**: Setup 1 removed from the code, one build command with a check mode, Chrome path configurable, GitHub Actions, regression references, round-1 documents moved to `submission/`. |

Problems found by the checks after round 2 (all fixed, listed in `README.md`): 2 latent design bugs
(cycle-start handshake waiting for a short signal; "pick allowed" never consumed), 1 rule the
assignment left open (when CP-2 counts as clear; the old simulator read the true part position),
2 errors introduced while writing the model (too general hold rule; one machine reading another
machine's check result).

---

## 3. Repository map

```
Week2_Sensors_Design/
├── README.md                        public summary (figures, key numbers, rebuild commands)
├── PROJECT_STATUS.md                this file
├── index.html                       GitHub Pages entry: meta-refresh to simulation/
├── .nojekyll                        Pages serves files as they are
├── .gitignore                       node_modules, source/out, Office temp files, __pycache__, *.pyc
├── .github/workflows/checks.yml     CI: the checks of §11 on every push
├── .github/workflows/full-verification.yml   full verification with NuSMV, started by hand
├── submission/                      round-1 course submission, historical (answer, report, video, README)
├── diagrams/                        10 figures as SVG (editable) and PNG (2x), generated
├── simulation/
│   ├── index.html                   the simulator, one self-contained file (≈ 225 kB), generated
│   └── sim_*.png                    screenshots used in the README
├── verification/
│   ├── cell_setup2_{none,sensor,process}.smv        NuSMV models, generated
│   ├── cell_setup2_{none,sensor,process}.nusmv.txt  NuSMV outputs
│   ├── results.json                 every number of the last verification run
│   └── results.md                   human-readable results (tables of runs and properties)
├── regression/
│   ├── README.md                    what is compared, and the result of step A1
│   ├── setup2_baseline.json         fingerprint of Setup 2 before A1
│   └── setup2_reference.json        current reference (npm run regress, CI)
├── engine/                          Python engine, no graphics (see §7)
│   ├── README.md
│   ├── cellsim/__init__.py          exports CellSim, Model, load, conformance, run_random
│   ├── cellsim/model.py             loads the JSON model; guard parser/evaluator/text
│   ├── cellsim/sim.py               interpreter, scheduler, plant, property monitors
│   ├── cellsim/scenarios.py         random long runs; conformance check
│   ├── cellsim/cell_model.json      the model exported from JS (generated, do not edit)
│   ├── run.py                       command line
│   ├── test_engine.py               5 unit tests
│   ├── trace.py                     prints a scenario trace as JSON (used by test_sim.js engine)
│   └── regress.py                   fingerprints of fixed scenarios (used by regress.js)
└── source/                          everything that generates the outputs
    ├── package.json                 dep: puppeteer-core; scripts build, check, test, regress, verify
    ├── src/cell-model.js            ★ THE MODEL (single source of truth)
    ├── src/cell-diagrams.js         SVG generator for all figures + cell layout
    ├── src/cell-verify.js           abstract model, explicit-state search, NuSMV export
    ├── sim-src/app.js               simulator: interpreter + plant + drawing + UI
    ├── sim-src/app.css, body.html   simulator style and markup
    ├── figures.js                   the list of figures (name → generator)
    ├── chrome.js                    Chrome path (CHROME or the usual location per platform)
    ├── build_all.js                 npm run build / npm run check
    ├── build_sim.js                 bundles model + diagrams + app into one HTML file
    ├── render.js                    writes every figure as SVG and PNG (Chrome)
    ├── export_model.js              writes engine/cellsim/cell_model.json (--check mode)
    ├── verify.js                    runs the 3 verification runs (+ NuSMV), writes results
    ├── regress.js                   regression fingerprint and comparison
    ├── compare_verification.js      compares two verification results.json
    ├── test_sim.js                  headless tests: basic | fault | s2 | mobile | conform | engine | all
    ├── capture_sim.js               simulator screenshots for the README
    └── capture_exchange.js          crops of the dual-gripper exchange and the overview screenshot
```

Outside the repository (on purpose):

- `ISE 401 TFG/tools/NuSMV-2.7.1-win64/bin/NuSMV.exe`: the NuSMV binary used for the checks.
- `ISE 401 TFG/tools/work/`: scratch files of the NuSMV runs and PDF printing.
- Research notes and talk material kept outside the public repo.
- Private claude.ai pages: the simulator (https://claude.ai/artifact/HgSKTvKdnatiaWJAGKfh6e), the
  "how we built it" guide (https://claude.ai/artifact/S1Qjp6tfkap7N9mtdTudAJ) and the talk deck.

---

## 4. Architecture

### 4.1 One model, many consumers

```mermaid
flowchart LR
  M["source/src/cell-model.js<br/>timing · rules · sensors · signals<br/>jobs · 4 machines · properties"]
  M -->|"require / script tag"| D["src/cell-diagrams.js<br/>SVG figures"]
  M -->|"interpreted"| S["sim-src/app.js<br/>browser simulator"]
  M -->|"build()"| V["src/cell-verify.js<br/>abstract model"]
  V -->|"check()"| R["explicit-state search<br/>verification/results.*"]
  V -->|"toSmv()"| N["verification/*.smv<br/>→ NuSMV 2.7.1"]
  M -->|"export_model.js"| J["engine/cellsim/cell_model.json"]
  J --> P["engine/cellsim (Python)"]
  D --> S
  S -. "same trace" .- P
  R -. "same verdicts and state counts" .- N
```

Rules that keep it consistent:

1. **No state name, transition or guard text exists anywhere except `cell-model.js`.** The
   diagrams generate arrow labels from guards; the simulator and the Python engine interpret the
   machines; the verifier compiles them.
2. **Plant ≠ controller.** The model is the controller (what the PLC would run). Each consumer
   brings its own plant: the browser and Python have a timed plant (robot motions, belt physics,
   sensors, operator); the verifier has a nondeterministic, untimed plant.
3. **Generated files are committed** so the repo works without building: `diagrams/`,
   `simulation/index.html`, `verification/*`, `engine/cellsim/cell_model.json`. After changing the
   model, `npm run build` regenerates them and `npm run check` (also in CI) fails if one is stale.

### 4.2 How the browser loads it

`build_sim.js` concatenates into one HTML page: Google Fonts link, `app.css`, `D.CSS`,
`body.html`, then three `<script>` blocks in order: `cell-model.js` (sets `window.CellModel`),
`cell-diagrams.js` (`window.CellDiagrams`), `app.js`. The same JS files also work in Node through
`module.exports`. Output: `out/sim/index.html` (stand-alone) and `out/sim/artifact.html` (no
document skeleton, for claude.ai). `npm run build` writes `simulation/index.html` directly.

---

## 5. The model (`source/src/cell-model.js`)

Exported object `MODEL`:
`T, TLABEL, KPI, BASELINE, RULES, CHECKPOINTS, SENSORS, STATES, idleSetup2, SLOTS, SIGNALS,
CONST, OUTPUTS, RUNGS, PROPERTIES, JOBS, MACHINES, SETUP_MACHINES, IDLE_MACHINE,
expr: { parse, evaluate, names, terms, label, plain, visible, constVal }, jobTime, stateSteps,
stateTime, lint`.

### 5.1 Timing `T` (seconds)

| Group | Values |
|---|---|
| CNC | `cncCycle` 120 · `unlock` 0.5 · `lock` 0.5 · `cycleStart` 0.5 |
| Robot 1 door work | `doorToHome` 1.5 · `park` 1.5 · `doorOpen` 4.0 · `doorClose` 4.0 |
| Robot 1 in the CNC | `enterCnc` 2.0 · `exitCnc` 2.0 · `grip` 0.5 · `release` 0.5 · `viseOpen` 1.0 · `viseClamp` 1.0 · `lift` 1.0 · `placeInVise` 1.0 · `seatCheck` 0.5 · `swapGripper` 1.5 |
| Robot 1 transfers | `doorToConv` 2.5 · `placeConv` 2.0 · `convToPallet` 2.0 · `pickPallet` 2.0 · `palletToDoor` 2.5 |
| Checks | `check` 0.5 (settle + snapshot + compare) |
| Belt | `beltTravel` 8.0 (2 m at 0.25 m/s) · `beltStart` 0.3 · `beltStop` 0.3 · `zeroSpeed` 0.2 |
| Robot 2 | `r2ToExit` 1.5 · `r2Pick` 1.0 · `r2ToPallet` 1.5 · `r2Place` 1.0 · `r2Home` 1.0 · `r2ToGauge` 1.5 · `r2LoadGauge` 1.5 · `measure` 1.0 · `r2Repick` 1.0 · `r2ToNok` 1.5 · `r2Drop` 0.5 |

`TLABEL` gives each key a readable name for the CNC-idle build-up table.

### 5.2 Rules `RULES`

`mismatchWindow` 600 s · `mismatchLimit` 3 · `settle` 0.3 s · `debounce` 0.05 s · `retrigger` 0.3 s
(second image after an invalid one) · `confirmTimeout` 1.0 s · `minSize` 48.0 mm · `nominal` 50.0 mm
· `consecutiveNokHold` 2 · `palletSlots` 12. `CONST` exposes `limit`, `slots`, `nokHold` to guards.

### 5.3 Checkpoints `CHECKPOINTS`

| Id | Where | Proximity | Camera / ROI | Fact |
|---|---|---|---|---|
| CP-1 | Input pallet | PX-11 | CAM-1 / ROI-A | Input pallet present and seated |
| CP-2 | Conveyor entry | PE-41 | CAM-1 / ROI-B | Part at conveyor entry |
| CP-3 | Conveyor exit | PE-42 | CAM-2 / ROI-C | Part at the end stop |
| CP-4 | Output pallet | PX-52 | CAM-2 / ROI-D | Output pallet present |
| CP-5 | Gauge nest | PX-64 | CAM-2 / ROI-E | Part in gauge nest |

### 5.4 Sensors `SENSORS`

Each entry: `tag, zone, kind, type, where, confirms, example` (catalogue example, no prices; the
priced list is only in the round-1 answer in `submission/`). Tags used across the project:

- Robot 1 / CNC: PX-11, CAM-1, GR-21A / GR-21B (dual gripper), ZS-31 door open, ZS-32 door
  closed, ZS-33 guard lock, ZS-34 vise open, ZS-35 clamped, PS-36 part seated (SMC ISA3 air gap).
- Conveyor: PE-41, PE-42 (through-beams), ENC-43 (encoder on an idler roller), CAM-2.
- Robot 2 / output: GR-51, PX-52, LT-53 blue beacon.
- Cell: LT-01 stack light, SC-01/SC-02 area scanners, PLC-01.
- Gauge and sorting: LS-61/62/63 laser displacement sensors (Keyence IL-065), PX-64, PE-65 NOK
  drop, MST-60 master cube.

### 5.5 Signals `SIGNALS` (everything a guard can read)

Every name has a `kind`:

| kind | Meaning | Examples |
|---|---|---|
| `sensor` | Device signal. Simulator reads its plant; verifier an abstract plant | `ZS-31`, `ENC-43`, `CNC.done`, `R1.clearCnc`, `GAUGE.ok`, `outCount` |
| `check` | Fused result of the **last cross-check made by the machine that reads it** (camera decides). A machine never reads another machine's check | `CP-1`…`CP-5`, `CAM-1.part` |
| `var` | PLC variable written by steps | `partPlaced`, `pickAllowed`, `partPicked`, `QH`, `consecNok`, `mismatches`, `CAM_FAULT` |
| `input` | Operator / technician button | `HMI.clear`, `HMI.verify`, `HMI.reset`, `HMI.release`, `VERIFY.pass`, `VERIFY.fail` |
| `derived` | Defined by `def` (expression) | `BELT.free`, `PALLET.full`, `PALLET.empty`, `lineStop`, `FAULT.any`, `CELL.stopped`, `HOLD.req` |
| `truth` | Physical truth, **only for properties** (lint forbids them in guards) | `TRUE.entryPart`, `TRUE.outPallet`, `TRUE.r2Nok` |

Other fields: `on` / `off` (diagram text for true / false; `{TAG}` = sensor, `[CP-n]` =
checkpoint, `*bold*`), `ask` (question text when the signal decides a choice state), `tags`
(sensors behind the signal), `num`/`max`/`text`/`phrases` (counters).

Important derived signals:

- `BELT.free = !ENC-43 & (CONV=C1 | CONV=C5) & !partPlaced` — the fix of the "CP-2 entry clear" rule.
- `lineStop = SUP=X3 | SUP=X4`; `HOLD.req = lineStop | CAM_FAULT`.
- `CELL.stopped = R1.home & R2.home & !ENC-43`.

### 5.6 Guard language

Grammar (in `parse`): `or := and ('|' and)*`, `and := unary ('&' unary)*`,
`unary := '!' unary | '(' or ')' | name [rel value]`, `rel := = != < <= > >=`. Names may contain
letters, digits, `.`, `_`, `-`. A slot name (`R1`, `CONV`, `R2`, `SUP`) reads that machine's
current state id (`CONV=C5`); `R1.job` reads the running job (`R1.job=CNC.start`). Values may be
constants from `CONST`. `evaluate(expr, read)` expands derived signals; `label()` turns a guard into
wrapped diagram text; the Python `model.py` reimplements the same parser and evaluator.

### 5.7 Jobs `JOBS`

A job is a robot program or device command that a step starts and that reports "done". Fields:
`robot` (R1, R2 or null), `time` (list of `T` keys, the planning estimate), `zone` (where the robot
is while it runs: free, door, cnc, conv, pallet, gauge, nok), `at: 'home'`, `move: [from, to]` (part
transfer, used by the verifier's plant), `set` (device state after the job), `canFail: 'grip'`,
`labels`, `tags`, `text`.

22 jobs: `R1.home, R1.park, R1.openDoor, R1.closeDoor, R1.pickRawA, R1.toDoorReady, R1.enterCnc,
R1.unloadB, R1.loadA, R1.toConveyorB, R1.placeConvB, DOOR.lock, CNC.start, R2.home, R2.park,
R2.pickConv, R2.placePallet, R2.loadGauge, R2.repick, R2.dropNok, GAUGE.measure, GAUGE.master`.

### 5.8 Machine format

```
MACHINE = { slot, setup (2, or 0 for the shared CONV and SUP), title, sub, note, urgent?, view,
            initial: { to, when?, do?, text? },
            hold?:  { desc, do, exit },     // global H state (LINE STOP)
            fault?: { desc, exit },         // global F state
            states: { id: STATE | CHOICE } }

STATE  = { name, desc[], kind?, band? (run|idle|stop|move), wait?, hold?: false, short?, time?[],
           log?, hmi?, do: [STEP...], next: [TRANSITION...], faults?: [{ after, when?, text }] }
STEP   = { job, when?, confirm? }                 start a job, wait for done; confirm must hold, else FAULT
       | { check: 'CP-n', quick?, confirm?, until? } camera + proximity cross-check
       | { await: expr }                          wait until expr holds
       | { set: {var: value}, when? } | { inc: var }
TRANSITION = { to, when, text?, for? (T key: guard must hold this long), hold?: false, do?: [{ set?, text }] }
CHOICE = { choice: signal, yes, no, yesText?, noText? }   pseudo-state (diamond in diagrams)
```

Semantics shared by both simulators:

- On entry a state runs its `do` steps in order, then evaluates `next` in order; the first true
  guard fires.
- `wait: true` = waiting state without confirmation timeout. Otherwise a confirmation that does not
  arrive within `RULES.confirmTimeout` sends the machine to **F** (the alarm names the missing
  sensor). After `HMI.clear` the state is repeated. No automatic robot retries.
- **H (HOLD)** is entered when `HOLD.req` holds: at a transition (the pending state follows after
  the hold), while waiting (the state is entered again), or at once after a camera fault (the same
  check is repeated). `hold: false` on a state or transition = a LINE STOP does not interrupt it
  (a running transport finishes). Robots park in H; exit when `!HOLD.req`.
- `SUP` is `urgent`: it reacts in the same scan as the check that caused it.
- `band` drives the CNC-idle KPI and the timing chart: every Robot 1 state with `band: 'idle'`
  counts toward CNC idle time.

### 5.9 The four machines

`SETUP_MACHINES = { 2: [R1S2, CONV, R2S2, SUP] }` (the key 2 keeps the names `R1S2`, `R2S2` and
`cell_setup2_*` stable). The single-gripper machines `R1S1` and `R2S1` exist only in the branch
`legacy-setup1-setup2`.

**R1S2 — Robot 1 + CNC, dual gripper A (raw) / B (finished)**

| State | Does | Leaves when |
|---|---|---|
| B0 START-UP CHECKS | home | `R1.home & CNC.ready & ZS-32` → B1 |
| B1 PICK RAW PART (A) (run) | check CP-1, `R1.pickRawA` | `GR-21A` → B2; no pallet/part → W1 |
| B2 WAIT AT CNC DOOR (run, wait) | `R1.toDoorReady` | `(CNC.done & !ZS-33) \| CNC.empty` → B3 |
| B3 OPEN DOOR (B) (idle) | `R1.openDoor` | `ZS-31 & !ZS-32` → B4 |
| B4 EXCHANGE PARTS (idle) | `R1.enterCnc`; `R1.unloadB` if `PS-36` (confirm `GR-21B & ZS-34 & !PS-36`); `R1.loadA` | `ZS-35 & PS-36 & !GR-21A & R1.clearCnc` → B5 |
| B5 CLOSE DOOR (A) (idle) | close, lock | `ZS-32 & ZS-33` → B6 |
| B6 START CYCLE (idle) | await `!QH`, `CNC.start` | `CNC.run \| CNC.done` → Q_B6 |
| Q_B6 choice `GR-21B` | | yes → B7, no → B1 (first cycle) |
| B7 PLACE ON CONVEYOR (B) (run) | to conveyor, await `BELT.free`, quick check CP-2 must be clear, `R1.placeConvB`, check CP-2, set `partPlaced` | `CP-2 & R1.clearConv` → B1 |
| W1 WAIT FOR INPUT PALLET | park | `HMI.loaded` → B1 |

The finished part goes to the belt **while the CNC already machines** the next part (B7 is in the
run band), which is where the 16 s of CNC idle time are saved compared with the Setup 1 baseline.

**CONV — Conveyor**

| State | Does | Leaves when |
|---|---|---|
| initial | quick checks CP-2, CP-3 | `!CP-2 & !CP-3` → C1 |
| C1 EMPTY - STOPPED (wait, hold:false) | clear `partPicked`, `pickAllowed` | `partPlaced` → C2 |
| C2 PART AT ENTRY | clear `partPlaced`, await both robots clear, quick CP-3 must be clear | `R1.clearConv & R2.clearConv & !CP-3` → C3 |
| C3 TRANSPORTING (move, wait, hold:false) | motor on (output `BELT.motor`) | `PE-42 \| ROI-C` → C4 (OR logic: stopping is the safe direction). Faults: no ENC-43 pulses in 1 s; no PE-42 in 15 s |
| C4 STOPPING (move) | motor off | `!ENC-43` for `zeroSpeed` → C5 |
| C5 PART AT EXIT (wait, hold:false) | check CP-3 (confirm), set `pickAllowed` | `partPicked & R2.clearConv` → C1 |

**R2S2 — Robot 2 + gauge + sorting**

E0 start-up (home, CP-4, CP-5 nest empty, `GAUGE.master`) → E1 wait for part → E2 pick → E3 load
gauge (check CP-5) → E4 measure (`GAUGE.measure`, until `GAUGE.valid`) → Q_E4 `GAUGE.ok`:
yes → E5 place OK part (consecNok = 0, re-pick, CP-4, place) → Q_E5 `PALLET.full` → E7 swap or E1;
no → E6 NOK chute (re-pick, drop, `inc consecNok`, `QH = true` when `consecNok >= 2`; leaves on
`PE-65`). The rung `HMI.release & QH → QH=false, consecNok=0` releases the quality hold.

**SUP — cross-check supervisor (urgent)**

X1 NORMAL → X3 on `CAM_FAULT`, → X2 on `mismatches>0`. X2 MISMATCH WARNING → X3 on
`mismatches>=3 | CAM_FAULT`, → X1 when the window is empty. X3 LINE STOP → X4 on
`CELL.stopped & HMI.verify`. X4 SENSOR VERIFICATION → X1 on `VERIFY.pass & HMI.reset` (clears
`mismatches` and `CAM_FAULT`); `VERIFY.fail` stays in X4.

### 5.10 Outputs `OUTPUTS` (Moore outputs)

`BELT.motor = CONV=C3` · `LT-53 = R2=E7` (blue, pallet full) · `LT-01.red = lineStop |
FAULT.any` · `LT-01.amber` = no red and (`mismatches>0 | QH | R1=W1`) · `LT-01.green` otherwise.

### 5.11 Properties `PROPERTIES`

| Id | Kind | Expression |
|---|---|---|
| P1 | never | `(!R1.clearConv \| !R2.clearConv) & ENC-43` |
| P2 | at start of `CNC.start` | `ZS-32 & ZS-33` |
| P3 | never | `!R1.clearCnc & (!ZS-31 \| CNC.run)` |
| P4 | at start of `R1.openDoor` | `!CNC.run & !ZS-33` |
| P5 | at start of `R1.placeConvB` | `!TRUE.entryPart & !ENC-43` |
| P6 | at start of `R2.placePallet` | `TRUE.outPallet & outCount<slots` |
| P7 | at start of `R2.placePallet` | `!TRUE.r2Nok` |
| P8 | at start of `CNC.start` | `!QH` |
| P9 | never | `mismatches>=limit & !lineStop` |
| P10 | never | `CAM_FAULT & !lineStop` |
| L1 | AG EF (goal stays reachable) | `R1.job=CNC.start` |
| L2 | AG EF | `R2.job=R2.placePallet` |
| L3 | AG EF | `SUP=X1` |

"never" is checked in stable states (after the supervisor reacted). The simulators monitor the
safety ones live; only the verifier checks the AG EF ones. AG EF means that from every reachable
state some path still leads to the goal (no deadlock and no trap). It does not mean the cell will
reach the goal: a run that waits forever while a way out still exists satisfies it. Guaranteed
progress (AG AF under fairness assumptions on the operator, the jobs and the faults) is not checked;
it is an option in step A4. The key `eventually` in `PROPERTIES` keeps its name in the code.

### 5.12 Derived data

- `STATES[machine]` id → name, incl. `H` and `F`.
- `stateSteps(mk, id)` nominal step times; `stateTime`; `jobTime`.
- `idleSetup2`: CNC idle build-up = door unlock + all `idle`-band states of R1S2.
- `KPI`: `idle2` 20.5 s; `cycle2` = 120 + idle; `util2` = 120 / cycle (share of the nominal cycle
  spent machining); `pph2` parts per hour.
- `BASELINE`: the Setup 1 numbers (idle 36.5 s, cycle 156.5 s), fixed values computed before A1,
  used by the timing chart and the README. Not derived from the current machines.

### 5.13 `lint()` — what it guarantees

Returns a list of problems (empty = OK). It checks: every guard parses; every name is a known
signal, slot state, job or constant; `truth` signals are not read by any machine; `set`/`inc` only
on PLC variables/counters; every job's time keys exist; every transition target exists; choice
signals have an `ask` text; every state has an outgoing transition; **every state is reachable from
the initial state**; the diagram `view` places every state exactly once; every `{TAG}` or `[CP-n]`
mentioned in a state's text is really used by a step or guard of that machine. `verify.js` and
`export_model.js` refuse to run if lint fails; `cell-diagrams.js` stops if a transition cannot be drawn.

---

## 6. Browser simulator (`source/sim-src/app.js`)

- **Interpreter.** `runMachine(slot)` / `runState` / `runSteps` / `runJob` execute the model's
  machines; `setState` records every change in `TRACE` (`[t, slot, from, to]`). Nothing in this
  file names a state of the machines except UI display.
- **Scheduler.** Each process is a generator: `yield {k:'t', until}` waits for a time,
  `yield {k:'c', fn}` for a condition. `advance(dt)` steps exactly to the next timed wake-up (this
  is what makes the idle time equal the KPI to the decimal).
- **Plant.** `SENSE` maps every sensor signal to the plant (`ZS-31 = door position > 0.99`,
  `ENC-43 = belt speed > 0.5`, `PS-36 = part in fixture`, …); `INPUT` maps HMI buttons. `read()`
  throws if a signal has no plant reader, so a new signal in the model must get one here (and in
  Python `sim.py::_sense`).
- **Robot jobs** (`JOB` table) animate motions that take exactly the model's step times; the dual
  gripper turns its wrist (`startTurn`, `turnWrist`).
- **Cross-check** (`check()`): settle (unless quick), camera snapshot, compare with the proximity
  value; on mismatch the camera value is used and an event goes into the 10-min window
  (`SUP.events`); an invalid frame triggers one re-trigger; a camera failure sets `CAM_FAULT`.
- **Property monitors**: `monitorStart` at job starts, `monitorStable` after each scan; violations
  are logged and counted (the tests require zero).
- **Fault injection (UI)**: per checkpoint *Glitch* (one-off) and *Fault* (stuck sensor); *Bad
  frame*, *Camera failure*, *Grip miss*, *Next part undersized* (`#btnBadFrame`, `#btnCamFail`,
  `#btnGripMiss`, `#btnUnder`). Operator: `#btnLoadIn`, `#btnSwapOut`; auto-operator option.
- **HMI actions** (`data-act`): `verify`, `resume`, `clear`, `qh`, `swap`, `load`.
- **UI**: cell mimic (layout SVG with moving parts and robots), live state diagrams with the active
  state highlighted (tabs), checkpoint table, KPIs, event log, banner, stack light. Works at phone
  width and in dark mode.
- **Test hooks**: `window.CellSim = { S, W, MCH, TRACE, logs, ev, newSim, advance, instantVerify, press }`.
- There is no setup selector any more; **Reset** starts a new run.

---

## 7. Python engine (`engine/cellsim`)

A line-by-line port of the interpreter and plant of `app.js`, without drawing. Reads
`cell_model.json` (exported by `node source/export_model.js`; `--check` fails if stale).

```python
from cellsim import CellSim
sim = CellSim(seed=1, auto_operator=True, instant_verify=False, verify_step_time=0.65)   # setup=2 only
sim.advance(3600)                 # seconds of simulated time
sim.inject_undersized()           # also inject_glitch(cp), toggle_sensor_fault(cp),
                                  # inject_bad_frame(), inject_camera_failure(), inject_grip_miss()
sim.press("qh")                   # verify, resume, clear, qh, swap, load
sim.state("R2"); sim.kpis(); sim.trace; sim.logs; sim.stats; sim.errors  # errors must stay empty
```

- `run.py --hours H --faults --seed N --log N`.
- `scenarios.run_random(setup, hours, faults, seed)` (about one disturbance every 14 min) and
  `scenarios.conformance(sim)` (every state change must be a model transition).
- Tests (`test_engine.py`): export current; nominal idle = KPI every cycle; faulty CP-2 stops the
  line at the 3rd mismatch and verification + reset recover; two undersized parts → quality hold,
  no cycle start; 4 h random runs conform with no property violation.
- Parity: `node source/test_sim.js engine` runs 1 h nominal and 1 h with a faulty CP-2 in the
  browser and in Python (`trace.py`) and requires identical traces (same changes, same instants
  within 1e-6 s). Last result: identical in both.
- `regress.py`: fingerprints of the deterministic runs and of seeded random runs (2 h nominal, 8 h
  with faults) for `source/regress.js`.

The parity test uses only deterministic scenarios (nominal and a stuck CP-2 sensor). Random runs are
checked separately in each simulator by conformance, not by comparing traces. The parity shows that
the port reproduces the original in those scenarios; it cannot find an error that both share.

---

## 8. Diagrams (`source/src/cell-diagrams.js`, `render.js`)

- Functions: `smRobot1S2, smConveyor, smRobot2S2, smSupervisor` (state diagrams from `MACHINES`,
  labels from guards via `expr.label`), `flowCrossCheck`, `archDiagram`, `flowSetup2`,
  `timingChart` (Setup 2 from `idleSetup2`, Setup 1 as a fixed baseline row from `BASELINE`),
  `exchangeStrip` (fig14), `layoutSvg({ snapshot, noTitle, standalone, sim })` (cell layout, also
  the simulator mimic). `LAYOUT` holds all coordinates. `CSS` holds the shared diagram style.
- `figures.js` lists the 10 figures; `render.js` writes them as SVG and PNG (2× via headless
  Chrome, web fonts loaded once); `npm run build` copies them to `diagrams/` and removes figures that
  are no longer listed. File numbers follow the round-1 report; 1, 5, 6 and 8 (Setup 1 only) are gone.

---

## 9. Formal verification

### 9.1 Abstract model (`src/cell-verify.js::build(setup, {faults, slots})`)

- **Controller**: taken from `MACHINES` without change. Each blocking step (`job`, `check`,
  `await`) is a location `State_i`; each state has an exit location `State_x`; `I_*` for initial
  steps; `H_*` for hold steps; a `<slot>_res` variable stores where to resume after H / F.
- **Variables**: machine locations; PLC vars (`partPlaced, pickAllowed, partPicked, CAM_FAULT`,
  `QH`); `mismatches` 0..3; `consecNok` 0..2; per-machine check results `res_<slot>_<CP>`; plant:
  door, lock, vise, part in CNC, run, gripper contents (`r1A`/`r1B`, `r2S`), belt
  `beltEntry/beltMid/beltExit`, moving, input pallet present / has parts, output pallet present,
  `outCount` 0..N, robots home, gauge nest, measured, zeroed, pe65. `build(2)` refuses any other setup.
- **Plant**: no times. Jobs finish in any order relative to other machines; the CNC finishes when
  it likes (part OK, or undersized if process faults are on); the belt moves the part in three
  steps; the operator swaps pallets whenever allowed; mismatches leave the window at any time.
  **Output pallet capacity is 2, not 12**, to keep the state space finite and small.
- **Fault classes**: `none`; `sensor` = camera/proximity mismatches and camera faults; `process` =
  missed picks, confirmation timeouts, transport timer faults, undersized parts.
- **Camera assumption.** Every check result equals the physical truth (`TRUTH[cp]`). The
  "mismatch" variant only increments `mismatches`; the camera is never wrong. Camera
  misclassification (valid image, wrong answer) and stale images are not modelled, so the rule
  "the camera decides" is not tested against camera errors. The simulators also inject faults only
  into the proximity sensors (glitch, stuck) and into camera availability (bad frame, failure).
- **No combined faults.** `faults: 'all'` exists in `build()` but was never run; sensor and
  process faults were verified separately.
- **Pallet of 2.** Argument (not a proof) for why capacity 2 should represent 12: the machines
  and properties read the count only through `PALLET.empty` (`=0`), `PALLET.full` (`>=slots`) and
  P6 (`<slots`), so the logic distinguishes only empty, partly full and full. To be tested with
  capacity 3 in step A2.
- Interleaving semantics: one command = one step of one machine or of the plant; commands with the
  same guard and updates are deduplicated.

### 9.2 Explicit search (`check(ir)`)

Breadth-first search over all reachable states, stored as bytes in one buffer with an
open-addressing hash table (≈ nv + 20 bytes per state). Safety properties checked during the
search, with counterexample traces. "Eventually" (AG EF) checked afterwards: iterative Tarjan on the
implicit graph finds the bottom SCCs; the property holds if every bottom SCC contains a goal state.
Also records deadlocks and which machine states are never reached.

### 9.3 Results (`verification/results.md`, re-run at the end of A1)

| Run | States | Transitions | Failed |
|---|---:|---:|---|
| none | 212,303 | 870,229 | none |
| sensor | 14,685,160 | 66,124,127 | none |
| process | 5,327,386 | 27,709,028 | none |

0 deadlocks; all 13 properties hold. The numbers are identical to the run of 2026-10-02, as expected
from identical `.smv` files. The Setup 1 runs (55,600 / 3,359,887 / 88,132 states) are in the legacy
branch. Never-reached states are listed per run
(e.g. `R2: E6` without process faults, which is expected: no undersized parts).

### 9.4 NuSMV export (`toSmv(ir)`) and cross-check

- `IVAR cmd` (the chosen command is an input, not state); each guard a `DEFINE g<i>`; every
  variable's `next()` is a `case` over `cmd = c<i> & g<i> [& !urgent]`; a disabled command leaves
  the state unchanged (stutter); constant variables get a frame `next()`. No `TRANS`. Result: NuSMV
  reaches exactly the states of the explicit search.
- Specs: safety and job-start properties as `INVARSPEC` (start properties use `next()`);
  `INVARSPEC no_deadlock` (`enabled`); `INVARSPEC unreachable_<slot>_<state>` for coverage; only
  L1–L3 are CTL `AG EF`.
- `verify.js` runs each model in two NuSMV processes (invariants; CTL), each spec its own command so
  output appears as it finishes, matches results by formula and compares verdicts and reachable
  state counts. 46 specs per model; all agree; NuSMV time up to ~2 h for the sensor-fault model
  (≈ 1 h total wall clock with 8 parallel jobs).
- Manual run of one file: `NuSMV -dynamic -dcx -r cell_setup2_none.smv`.

What the agreement means: additional evidence that the explicit search and the NuSMV export are
consistent for these three models and these specifications. Both start from the same intermediate
representation (`build()`), so an error made there would be shared and not detected. It says
nothing about whether the abstraction matches the real cell or the timed simulators.

### 9.5 `verify.js` options

`node --max-old-space-size=10000 verify.js [outDir]` (default `source/out/verification/`; copy to
`verification/` to publish). Env: `ONLY=setup2_sensor,...`, `NUSMV=<path>` (or NuSMV on PATH),
`NUSMV_ONLY=1`, `NUSMV_JOBS=n` (default 4), `NUSMV_TIMEOUT=s` (default 4 h), `REPORT_ONLY=1`.
Largest run needs ~2 GB RAM and ~10 min.

---

## 10. Documents

The round-1 course submission is in `submission/` with its own README: the 4-page answer, the
27-page report and the demo video. They describe the first version (both setups, machines written
twice), are kept as submitted and are not regenerated. The scripts that produced them
(`build_report.js`, `build_answer.js`, docx library) were removed from `main` in A1 and live in the
branch `legacy-setup1-setup2`.

---

## 11. Tests and checks — what each one checks

| Command (from `source/` unless noted) | What it checks |
|---|---|
| `npm run check` | Lint (§5.13) and that every generated text file (10 SVG figures, the simulator page, the model JSON, the 3 `.smv` files) is exactly what the sources give; stale figure files; missing PNGs |
| `node export_model.js --check` | The JSON read by Python matches `cell-model.js` (not that the Python interpreter is correct) |
| `node test_sim.js basic` | Simulator loads, runs, no console errors |
| `node test_sim.js fault` | CP-2 fault → 3 mismatches → line stop → verify → reset works |
| `node test_sim.js s2` | Two undersized parts → NOK chute and quality hold |
| `node test_sim.js mobile` | No horizontal scroll at 400 px |
| `node test_sim.js conform` | 20 h of simulated operation (2 h nominal; 2 h, 8 h and 8 h with random faults; seeds 1–4): every state change is a model transition, every job takes its model time, no property violated, nominal idle = KPI |
| `node test_sim.js engine` | Browser and Python traces identical (2 scenarios × 1 h) |
| `npm test` | All the `test_sim.js` modes |
| `npm run regress` | Setup 2 fingerprint identical to `regression/setup2_reference.json` (KPIs, state times, NuSMV models, figures, browser and Python traces, no page errors) |
| `python -m unittest test_engine` (in `engine/`) | §7 |
| `npm run verify` | §9 (and with `NUSMV=…` the NuSMV cross-check) |

**Continuous integration** (`.github/workflows/checks.yml`, Ubuntu, clean `npm ci`): `npm run
check`, the Python tests, the nominal verification run, all browser tests and the regression, on
every push and pull request. NuSMV and the two large verification runs are not in `checks` (about
an hour or more). They run in the workflow **`full verification`**
(`.github/workflows/full-verification.yml`), started by hand from the Actions tab or with
`gh workflow run full-verification`: it downloads NuSMV 2.7.1 (checksum verified), runs `verify.js`
with NuSMV, uploads `out/verification/` as an artifact and compares it with the committed
`verification/results.json` (`source/compare_verification.js`). When the model changes on purpose,
download the artifact and commit it to `verification/`. No local computer is needed for it.

None of these checks validates the design against a real cell. §1.1 lists what each one supports.

---

## 12. Environment and rebuild

Prerequisites: Node.js (24 used), Python 3.9+ (3.11 used, standard library only), Google Chrome
(`CHROME=<path>` if it is not in the usual place for the platform, see `source/chrome.js`), NuSMV
2.7.1 (free, LGPL, https://nusmv.fbk.eu) for the cross-check, git and gh.

After a model change:

```bash
cd source
npm install                 # once
npm run build               # diagrams/, simulation/index.html, engine/cellsim/cell_model.json
npm run check               # must print "generated files up to date"
npm test                    # browser tests + conformance + engine parity
npm run regress             # differences must be explained before recording a new reference
npm run verify              # then copy out/verification/* to ../verification/
NUSMV="../../tools/NuSMV-2.7.1-win64/bin/NuSMV.exe" NUSMV_ONLY=1 NUSMV_JOBS=8 node --max-old-space-size=10000 verify.js
cd ../engine && python -m unittest -v test_engine
```

Gotchas met before:

- Very long Windows paths break Chrome file loading (ERR_FILE_NOT_FOUND) and PDF printing: scripts
  use `page.setContent()`; print from a short path (e.g. `ISE 401 TFG/tools/work`).
- Waiting for `networkidle0` with web fonts times out: fonts are loaded once with
  `document.fonts.load`, then figures are swapped in.
- Git converts line endings to CRLF on Windows; `build_sim.js`, `build_all.js` and `regress.js`
  normalize them, so the checks give the same result on Windows and in CI.
- NuSMV with `TRANS` constraints never finished the fair-state computation on the largest model;
  keep the IVAR + stutter encoding.

---

## 13. Known limitations and open items

1. **The documents in `submission/` describe round 1** (both setups, the first version of the
   machines). They are historical and marked as such.
2. **The abstraction is not verified.** The verifier checks an untimed abstract plant with a
   2-slot pallet. Timing properties (cycle time, idle time) come only from the simulators.
3. **Simulated plant, not hardware.** Sensor behaviour, robot motions and the CNC interface are
   idealized; prices and part numbers come from vendor catalogues (September 2026), never tested.
4. **`VERIFY.fail` is never true** in the simulators (the technician always succeeds); the
   verifier allows it.
5. **`CNC.ready` is always true** in the simulators; no CNC alarm model.
6. **Safety (E-stop, scanners SC-01/02, door interlock circuit)** is described as hardwired and not
   modelled in the state machines; properties P1–P4 check the PLC logic only.
7. **CI does not run NuSMV** nor the two large verification runs; they are run locally (§11).
8. **Private claude.ai simulator page** may lag behind `simulation/index.html` if the simulator is
   rebuilt; the GitHub Pages one is the reference.
9. Old private artifact `claude.ai/artifact/1BzXRhiHiZNo7q5AS3Rsb2` is the round-1 simulator (stale).
10. **Camera policy not justified.** "The camera decides" is the author's original rule. Camera
    false positives and false negatives with a valid image are not modelled anywhere, and three
    mismatches stopping the line does not protect the first wrong decision. Step A2.1.
11. **Gauge only partly defined.** Datums, conversion of distances to L, W, H, uncertainty of the
    whole station, chips and coolant, a guard band near 48.00 mm and calibration are not specified.
    The assignment gives only a lower limit. Step A2.2.
12. **Times without source or tolerance.** Every value in `T` is a planning estimate. Step A2.3.
13. **KPIs are nominal.** Idle time counts only the idle-band states of the exchange; waits for
    material, pallet changes, holds and repairs are not in it. Step A2.4.
14. **Fault coverage.** Sensor and process faults never combined; the 2-slot pallet is argued,
    not proved. Step A2.5.

---

## 14. How to extend (recipes)

Always: edit `cell-model.js` → `npm run build` → all checks of §12 → commit the generated files
together with the change. If `npm run regress` reports a difference, explain it in §17 before
recording a new reference.

**Change a time or a rule** (e.g. `T.beltTravel`, `RULES.mismatchLimit`): edit `T` / `RULES`.
KPIs, diagrams and both simulators follow. If you change `mismatchLimit` or `consecutiveNokHold`
the verifier domains change too (`mismatches 0..limit`). Update hard-coded numbers in `README.md`
(20.5 s, 85.4 %, …).

**Add a sensor read by a guard**:
1. Add it to `SENSORS` (catalogue data) and to `SIGNALS` with `kind: 'sensor'`, `on`/`off` text.
2. Use it in a guard or step.
3. Add a plant reader in `app.js` `SENSE` **and** in `engine/cellsim/sim.py::_sense` (both throw
   otherwise).
4. In `cell-verify.js`, map the signal to the abstract plant (section "signals of the model → IR");
   add a plant variable if needed.
5. If it is shown on the layout, place it in `cell-diagrams.js` `LAYOUT`.

**Add a state or transition**: edit the machine in `MACHINES`; add the id to its `view` (lint
fails otherwise); new jobs go into `JOBS` with `time` keys, `zone`, and `move`/`set` so the
verifier's plant knows the effect; implement the motion in `app.js` `JOB` and in Python
`_job_table`. If it is in the CNC idle path, give it `band: 'idle'`.

**Add a checkpoint**: add to `CHECKPOINTS` and `SIGNALS` (`kind: 'check'`), give it truth and
proximity behaviour in `app.js` `truth`/`proxLive` and Python `_truth`/`_prox_live`, check that the
UI checkpoint table (`#cpTable`) shows it, and the verifier creates `res_<slot>_<CP>` automatically for machines that check it.

**Add a property**: add to `PROPERTIES` with `never`, `start`+`require` or `eventually`. Use
`truth` signals for physical facts. Both simulators monitor safety ones automatically; the verifier
and NuSMV export pick it up. Re-run `verify.js` (+ NuSMV) and update `README.md`.

**Add a fault class to the verifier**: extend `FL` in `build()` and add the nondeterministic plant
commands guarded by `F.<class>`; add a run in `verify.js` `RUNS`.

**Another cell or layout**: not by adding a "Setup 3" next to Setup 2. That is Phase B (§15): the
cell becomes a template and the configuration becomes data.

**Use the Python engine for studies**: `scenarios.run_random` for long runs, read `sim.stats`,
`sim.kpis()`, `sim.trace`. It is the right place for parameter sweeps (e.g. belt speed vs CNC
idle), Monte Carlo fault studies, or connecting a real PLC/OPC-UA later, because it has no UI.

The planned order of the next steps is in §15.

---

## 15. Roadmap

Decided on 2026-10-23, revised the same day after an external review (see §17). Three phases, in
this order: a solid, demonstrable and honestly scoped base (A), the generalization (B), the factory
(C). Every step keeps the rule of §4.1 (the model is the only source), has a "done when" criterion,
and ends with every check of §11 green. Effort figures are indicative only.

### How we keep to the plan

1. **This section is the only plan.** Ideas from chat, reviews or meetings do not change it until
   they are written in the decision log (§17) with the reason.
2. **One step at a time.** A step starts only when the previous one meets its "done when". Work
   that belongs to a later step is noted there, not done now.
3. **New input is triaged, not acted on at once.** Each new point becomes: a fix inside the current
   step, an item placed in a later step, or a rejection. All three are logged in §17.
4. **Progress is recorded in the same commit** that finishes a step: the table below, §0, and the
   affected sections.
5. **Every working session starts the same way:** read §0, the progress table and the last
   entries of §17; then continue the step marked "In progress".
6. **A finished step can be reopened** when a defect is found that invalidates its conclusions.
   The defect, what has to be redone and why are logged in §17, and the progress table shows the
   step as "Reopened" until it meets its "done when" again. Sequential work must never stop a
   correction.

### Progress

| Step | Status | Branch | Finished |
|---|---|---|---|
| A0 Claims and assumptions stated | Done | `main` | 2026-10-23 |
| A1 Base: Setup 2 only, CI, one build | Done | `a1-base` → `main` | 2026-10-23 |
| A2 Design gaps: camera policy, gauge, times, KPIs, faults | Next | | |
| A3 PLC demonstration | Not started | | |
| A4 Timed verification (UPPAAL) | Not started | | |
| A5 Studies with the Python engine | Not started | | |
| A6 More realistic plant | Not started | | |
| B Generalization (cell template) | Not started | | |
| C Factory | Not started | | |

Numbering note: the first version of this roadmap (commit `31bff5e`) called the base tasks (remove
Setup 1, CI, one build command, `submission/`) "A0". On 2026-10-23 they became **A1**, and A0 became
the documentation step that states the claims and assumptions, done the same day (§17). Nothing of
the old A0 is done yet.

### Scope decision: Setup 2 only

- The version with both setups is frozen in the branch **`legacy-setup1-setup2`** (commit
  `1f4b8ad`, on GitHub). It is not developed further.
- All new work is for **Setup 2** (dual gripper on Robot 1, gauge and NOK sorting on Robot 2).
  The code of Setup 1 was removed from `main` in step A1.
- Setup 1's nominal idle time (36.5 s) remains only as the baseline for Setup 2 (20.5 s).

### Phase A — Solid, demonstrable base

**A0. Claims and assumptions stated** — Done (2026-10-23)

§1.1 lists what each piece of evidence shows and under which assumptions; §5.11, §7, §9 and §11
were reworded so that nothing claims more than it shows; §13 lists the gaps found by the review.

**A1. Base** (about 1 session)

- Remove Setup 1 from `main`: machines `R1S1`, `R2S1`, `SETUP_MACHINES[1]`, the Setup 1 button
  and branches in `app.js`, `sim.py`, `cell-verify.js`, `verify.js`, `test_sim.js`,
  `cell-diagrams.js`, and the figures that only show Setup 1.
- Continuous integration on GitHub Actions: `npm ci`, lint, `export_model.js --check`,
  `python -m unittest test_engine`, a nominal `verify.js` run, `test_sim.js basic conform`.
- Chrome path from `process.env.CHROME`; one build command (`npm run all`) that regenerates and
  copies every generated file.
- Move the report, the answer and the video to `submission/` with a visible note that they are
  the historical round-1 submission.
- Rewrite §0–§14 of this file for Setup 2 only.

Done when: every Setup 2 trace, state count and verdict is identical to before the removal, CI is
green on `main`, and the documents no longer describe Setup 1 as current.

Result (2026-10-23): done. A regression reference of Setup 2 was recorded first
(`regression/setup2_baseline.json`); after the removal the KPIs, nominal state times, the three NuSMV
models, the browser and Python traces (deterministic and seeded random runs) and the verification
numbers (212,303 / 14,685,160 / 5,327,386 states, all properties hold, NuSMV agrees) are identical.
The only differences are the intended figure changes, listed in `regression/README.md`. The tests
caught one defect introduced by the removal (a leftover variable that stopped the page from drawing);
it was fixed and the regression now also fails on page errors. CI passes from a clean install.

**A2. Design gaps** (2–3 sessions; must come before the PLC, because the PLC would freeze them)

1. **Camera policy.** Add a fault class "camera misclassification" (valid image, wrong answer:
   false positive and false negative) and "stale image" to the verifier and to both simulators.
   Run the properties and see which ones fail (P5 "place only at a free entry" is the obvious
   candidate). Then decide the policy **per checkpoint** according to the cost of a wrong answer:
   where a wrong "clear" can cause a collision, treat the place as occupied if either source says
   so (conservative fusion, as the belt stop already does with PE-42 OR CAM-2); keep "the camera
   decides" only where a wrong answer costs time, not safety. This changes the author's original
   rule. Before the author is asked to decide, present for each checkpoint the alternatives
   (camera decides; proximity decides; conservative fusion; stop and ask the operator), their
   consequences (safety, lost time, false stops) and the verification and simulation results of
   each. The author decides on that evidence, and the decision goes into §17.
2. **Gauge definition.** Datums and fixture geometry, how three distances become L, W and H,
   master-cube calibration and its frequency, measurement uncertainty of the whole station (not
   the sensor's repeatability), effect of chips, coolant, tilt and surface, a guard band and a
   rule for parts near 48.00 mm. The assignment gives only a lower limit; record that no upper
   limit is specified.
3. **Times.** For every value in `T`: its source (datasheet, estimate, measurement) and an
   interval [min, max]. These intervals feed A4 and A5.
4. **KPI definitions.** Separate and measure with the Python engine: nominal exchange idle (today's
   36.5 / 20.5 s), simulated time not machining, total parts per hour, good parts per hour, and
   time lost by cause (material shortage, pallet change, quality hold, line stop, fault).
   State clearly that the 85.4 % is the share of the nominal cycle spent machining, not
   availability or OEE.
5. **Fault coverage.** Run the verifier with sensor and process faults combined (`faults: 'all'`)
   for Setup 2, or document why it is out of reach. Write the argument for the 2-slot pallet
   (the logic only reads empty, not full and full) and test it with capacity 3. A capacity-3 run
   widens the evidence but does not prove the case of 12 by itself; the argument has to carry it.

Done when all five deliverables exist and §1.1, §13 and §17 are updated:

1. **Camera:** a policy table for CP-1 … CP-5 with the chosen rule and its reason; fault classes
   for camera false positive, false negative and stale image in the verifier and both simulators;
   verification runs with them alone and combined with the other classes; results in
   `verification/results.md`, with any failed property explained and fixed or accepted in §17.
2. **Gauge:** a written specification in this file (fixture and datums, distance-to-size formula,
   calibration procedure and interval, uncertainty budget, guard band and decision rule at
   48.00 mm, note that no upper limit is specified) and that decision rule implemented in the model.
3. **Times:** every value of `T` with its source and [min, max] in the model.
4. **KPIs:** the five measures of A2.4 computed by the Python engine and reported for nominal and
   faulty runs.
5. **Faults:** the combined-fault run for Setup 2 finished (or, if out of reach, the largest run
   reached and the limit documented), and the capacity-3 pallet run compared with capacity 2.

**A3. PLC demonstration** (4–6 sessions)

1. **Execution semantics first**, written in this file before any code: scan cycle (read inputs,
   execute machines in a fixed order, write outputs), when a guard sees a value written in the
   same scan, how job commands and "done" confirmations are latched and cleared, timers (`TON`
   for confirmation timeouts and transport timers), restart after a FAULT and after a loss of
   communication with the plant.
2. **Generator** `source/src/cell-st.js`: IEC 61131-3 Structured Text, one function block per
   machine (`R1S2`, `CONV`, `R2S2`, `SUP`), written generically so it serves the template of
   Phase B. Generated code committed in `source/plc/`.
3. **Run** it in OpenPLC on a PC, with `engine/cellsim/plc_bridge.py` connecting the Python engine
   as the plant over Modbus TCP. This is a software PLC controlling a simulated cell, not
   industrial hardware; the demo and the documents say so.
4. **Compare** with the model: the same sequence of state changes as the Python interpreter for
   the deterministic scenarios, and time differences within a stated bound (for example one scan
   plus the communication latency). Exact equal instants are not required.

Done when: the four scenarios pass that comparison, a 1 h nominal run conforms to the model, and a
short recorded demo exists.

**A4. Timed verification with UPPAAL** (3–4 sessions)

- `toUppaal(ir)` next to `toSmv`: one timed automaton per machine, job durations as the intervals
  of A2.3.
- Properties stated with their conditions, for example: *in nominal operation, with material
  available, no quality hold or line stop, and every operation inside its interval, the exchange
  at the CNC ends within X s.* X comes from the intervals, not from today's 20.5 s figure.
- Optionally, response properties (AG AF) under explicit fairness assumptions on the operator,
  the jobs and the faults, to go beyond the AG EF of L1–L3.

Done when: the bounds are proved or a counterexample explains why not, and they are compared
with the Python engine's measured values.

**A5. Studies with the Python engine** (about 2 sessions)

Parameter sweeps (belt speed, robot speeds, CNC cycle 90–180 s), Monte Carlo with fault rates
(availability, line stops per shift, time to restart), sensitivity of the cross-check rule (2–5
mismatches, 5–30 min window) to false stops and missed sensor faults, NOK rate versus quality
holds. Scripts in `engine/studies/`, CSV output, plots, many seeds, confidence intervals, using the
KPI definitions of A2.4.

**A6. More realistic plant** (about 1 session per item)

CNC alarms and `CNC.ready` going false; the `VERIFY.fail` path; an explicit safety machine
(E-stop, scanners SC-01/02) separate from the cross-check; tool wear that makes undersized parts
more likely over time. Each item adds signals, plant readers in both simulators, a fault class in
the verifier, properties, and regenerated PLC code.

### Phase B — Generalization

- The Setup 2 cell becomes a **template with parameters**, instantiated N times with its own tags.
- The configuration is data: instances, connections (buffers, conveyors), layout, and **part
  types** (dimensions, tolerances, process time per station, route).
- No fixed setup branches remain in the simulator, the verifier, the Python engine or the PLC
  generator.

Done when: one instance of the template gives exactly the same traces, state counts, verdicts and
PLC code as the Setup 2 cell before the change.

### Phase C — Factory (future)

A second CNC served by the same robot; a process before and after, with buffers; several part
types with their routes; three more lines in parallel; a factory overview with zoom into each cell;
verification per cell template with its buffer interface and of the factory as an abstract model of
black-box cells, plus long simulation; factory studies; one generated PLC program per cell plus a
coordinator.

### How to run each step with the agent

1. One branch per step (`git switch -c a1-base`), merged into `main` only when its "done when" is met.
2. Start the prompt with: *"Read PROJECT_STATUS.md (§0, §15, §17). Continue step Ax. Setup 2 only.
   Keep the model the single source. Do not touch the legacy branch or the round-1 documents."*
3. Change the model first, then the generators, then the checks; run lint and the tests after
   every change and report failures with their output.
4. Review by looking: the regenerated diagrams, the simulator, and the diff of `cell-model.js`.
5. Close the step by updating the progress table, §0, §1.1, §13 and §17 in the same commit.

---

## 16. Glossary

| Term | Meaning here |
|---|---|
| Checkpoint (CP) | A place where a proximity sensor and a camera ROI confirm the same fact |
| Mismatch | The two disagree; camera value used; counted in the 10-min window |
| Line stop | Supervisor X3: controlled stop, robots finish the step and park, belt starts nothing new |
| H / F | Global HOLD (line stop) and FAULT states of a machine |
| Band | Diagram/KPI grouping of a state: run, idle (CNC waiting), stop, move |
| Job | Robot program or device command started by a step, reporting done |
| Guard | Boolean expression on signals that enables a transition |
| Plant | Everything around the controller: robots, CNC, belt, sensors, operator |
| Conformance | Every state change of a simulator run is a transition of the model |
| Explicit-state search | Enumerating every reachable state one by one (our verifier) |
| Symbolic model checking | Representing sets of states as BDDs (NuSMV) |
| AG EF goal | "From every reachable state the goal can still be reached" |
| Stutter | A step that changes nothing; used so NuSMV needs no TRANS constraints |

---

## 17. Decision log

Newest last. Every change to the plan or to a design rule is written here first (§15).

| Date | Decision | Reason |
|---|---|---|
| 2026-10-23 | Continue with Setup 2 only; freeze both setups in `legacy-setup1-setup2` | Focus the project; Setup 1 stays as the baseline |
| 2026-10-23 | Order: base (A) → generalization (B) → factory (C); PLC is the priority of phase A | A demonstrable base before growing; a template is needed before a factory |
| 2026-10-23 | External review triaged. Accepted: claims reworded (§1.1, §5.11, §7, §9, §11); camera policy, gauge definition, time sources, KPI definitions and fault coverage added as step A2 **before** the PLC; PLC execution semantics and a tolerance-based comparison added to A3; the UPPAAL bound made conditional in A4; OpenPLC described as a software PLC. Not changed: the order of phases and the PLC as the main demonstration | The review was right that several statements claimed more than the evidence shows and that the camera rule was never tested against camera errors (confirmed in `cell-verify.js`: the check result always equals the truth). Fixing the design gaps first avoids freezing them into the PLC code |
| 2026-10-23 | Second review triaged, all accepted: the A0/A1 renumbering is explained under the progress table; A2 gets concrete deliverables as its "done when"; rule 6 allows reopening a finished step; before the author decides the camera rule, alternatives, consequences and test results are presented; the decided-versus-implemented table states that the camera behaviour is still untested | The plan must stay unambiguous and must not block corrections; the author decides the operating rule, but on technical evidence |
| 2026-10-23 | Third review triaged: it confirms starting A1 and proposes an order (reference first, then remove Setup 1, then build and CI, then documents). Accepted as the working order of A1. Its remark that a capacity-3 pallet run does not prove the case of 12 is added to A2.5 | No change to the plan was needed |
| 2026-10-23 | **A1 closed.** Setup 2 identical to the recorded reference except the intended figure changes; one defect introduced and fixed (page stopped drawing); `regress.js` extended to fail on page errors. With Setup 1 gone, the two nominal conformance runs were identical, so one was replaced by a 2 h run with faults (20 h total: 2 h nominal, 18 h with faults). The build scripts of the round-1 documents and the `docx` dependency left `main` | Done-when of A1 met: regression documented, CI green from a clean install, documents describe Setup 2 |
| 2026-10-23 | Add the workflow `full verification` (NuSMV in GitHub Actions, by hand) and try to continue the work in a cloud session | The author wants to work without the local computer running; Remote Control is blocked by the organization. Infrastructure only, no change to the steps of the plan |
