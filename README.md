# CNC Cell Simulator

Sensors design and live state-machine simulation of a CNC machine-tending cell: a CNC with a
robot-operated door, two UR10e robots, a conveyor, and input and output pallets.

**Live simulator:** https://juanlopez-gif.github.io/CNC-Cell-Simulator/ (runs in the browser, nothing to install)

![CNC Cell Simulator, Setup 1 with a faulty PE-41 sensor: the camera value is used and 2 of 3 mismatches are in the 10-minute window](simulation/sim_setup1_warning.png)

This is the solution to the Week 2 Sensors Design Task, Setup 1 and Setup 2: sensor selection and
placement, work-flow logic, state diagrams, the camera + proximity cross-check rule, the dimensional
check and the CNC-time optimization.

## Branch `state-machines-as-data`

On this branch the four state machines are data in one file, `source/src/cell-model.js`: states,
steps (robot jobs, camera + proximity checks, waits), transitions with their guards, timers, HMI
messages and the properties the design must keep. The other parts are generated from it or run it:

| Part | What it takes from the model |
|---|---|
| State diagrams (`src/cell-diagrams.js`) | Every box and arrow; the arrow labels are generated from the guards. The generator stops if a transition cannot be drawn |
| Timing chart and CNC idle KPI | The step times of the states in the CNC idle band (36.5 s and 20.5 s are now computed, not typed) |
| Simulation (`sim-src/app.js`) | Nothing about states is written there: an interpreter runs the machines; the file only holds the plant (robot motions, CNC, belt, sensors, operator) |
| Verification (`src/cell-verify.js`, `verify.js`) | An abstract model of the same machines, explored state by state, exported to NuSMV (`verification/*.smv`) and checked again with NuSMV |

Checks: `M.lint()` (every name used exists, every sensor named in a diagram text is used, every state
is reachable), `node test_sim.js conform` (20 h of simulated operation with random faults: every
state change must be a transition of the model, every job must take its model time, no property may
be violated, and without faults the CNC idle time must equal the KPI) and `node verify.js` (every
reachable state of the abstract model, nominal and with sensor or process faults; see
`verification/results.md`). All 13 properties hold in all six verification runs (up to 14.7 million
states) and there is no deadlock. NuSMV 2.7.1, an independent symbolic model checker, checked the six
exported `.smv` files and agrees with the search on every property, on the absence of deadlocks, on
which machine states can be reached and on the number of reachable states. Both read the same
generated model, so this confirms the search and the export, not the abstraction itself.

These checks found five problems, all fixed in the model:

- Two latent problems of the original design, hidden by the timing of the simulation (found by the
  verifier): the cycle-start handshake waited for the short "CNC in cycle" signal, and Robot 2 did
  not consume the "pick allowed" signal, so it could try a second pick at an empty exit. Robot 1 now
  accepts "in cycle or cycle complete" and Robot 2 clears "pick allowed" when it reports the pick.
- One rule the original design left open: "wait until CP-2 shows the entry clear". The old
  simulation waited on the true part position, which a PLC cannot read. Robot 1 now waits until the
  conveyor has taken over the previous part (found by the random simulation run).
- Two errors of the first version of the model, caught before release: after a line stop the
  conveyor re-checked a part that Robot 2 had already picked (too general hold rule, random run), and
  one machine read a check result written by another one (verifier). The conveyor now waits through
  a line stop in C1 and C5, and each machine uses only its own checks.

The Word report and the PDFs are the versions of `main`; they were not regenerated on this branch.

## Contents

| Path | What it is |
|---|---|
| `Week2_Assignment_Answer.docx` / `.pdf` | The short assignment answer (4 pages): how it works, sensor list with brand and price, Setup 2 figures |
| `Sensors_Design_Report.docx` / `.pdf` | The full write-up (27 pages, 15 figures, 9 tables) |
| `simulation/index.html` | Interactive simulation of all state machines. Double-click to open it in a browser |
| `simulation/*.png` | Two screenshots of the simulation (also in the report) |
| `diagrams/` | Every figure as PNG (with title) and SVG (editable). Numbers match the report |
| `verification/` | NuSMV models of the cell, the NuSMV outputs and the results of the exhaustive verification |
| `source/` | The model and the scripts that generate the diagrams, the simulation, the verification and the report |

## Figures

| Figure | File |
|---|---|
| 1 | `fig01_layout_setup1` – cell layout and sensor placement, Setup 1 |
| 2 | `fig02_control_architecture` – the four state machines and their handshakes |
| 3 | `fig03_crosscheck_flow` – camera + proximity decision logic |
| 4 | `fig04_supervisor_states` – cross-check supervisor state diagram |
| 5 | `fig05_flow_setup1` – work flow of one part, Setup 1 |
| 6 | `fig06_states_robot1_setup1` – Robot 1 + CNC state diagram, Setup 1 |
| 7 | `fig07_states_conveyor` – conveyor state diagram |
| 8 | `fig08_states_robot2_setup1` – Robot 2 + output pallet state diagram, Setup 1 |
| 9 | `fig09_layout_setup2` – cell layout, Setup 2 |
| 10 | `fig10_timing_setup1_vs_setup2` – CNC idle time, Setup 1 vs Setup 2 |
| 11 | `fig11_flow_setup2` – work flow of one part, Setup 2 |
| 12 | `fig12_states_robot1_setup2` – Robot 1 + CNC state diagram, Setup 2 (dual gripper) |
| 13 | `fig13_states_robot2_setup2` – Robot 2 + gauge + sorting state diagram, Setup 2 |
| – | `fig14_dual_gripper_exchange` – how Robot 1 swaps the parts with the dual gripper (used in the short answer) |

## The cross-check rule in one paragraph

At five checkpoints (CP-1 input pallet, CP-2 conveyor entry, CP-3 conveyor exit, CP-4 output
pallet, CP-5 gauge nest) an IR proximity sensor and a camera confirm the same fact. They must
agree. If they disagree, the sequence uses the camera value and logs a mismatch. Three mismatches
within a 10-minute sliding window stop the line in a controlled way (the CNC finishes its part, the
robots park, the belt starts no new transport) until a technician verifies the sensors and resets.
Safety signals (door interlock, E-stops, scanners) are hardwired and never overridden by the camera.

## Key numbers

| | Setup 1 | Setup 2 |
|---|---|---|
| CNC idle per part | 36.5 s | 20.5 s |
| CNC utilization | 76.7 % | 85.4 % |
| Output | 23.0 parts/h | 25.6 parts/h |

Setup 2 rejects any part with a length, width or height below 48.00 mm into a locked NOK chute.

## Using the simulation

Open the live link above, or open `simulation/index.html` from a local copy. Choose Setup 1 or Setup 2, set the speed and watch the active state
move on the diagrams. Try **Fault** on CP-2: every part placed on the belt gives a mismatch, the camera
keeps the line running, and the third mismatch within 10 minutes stops the line. Then start the sensor
verification and reset. In Setup 2, press **Next part undersized** twice to see the NOK chute and the
quality hold. The page needs an internet connection only for its fonts.

## Rebuilding

Requires Node.js and Google Chrome. From `source/`:

```
npm install
node render.js out        # diagrams -> out/ (full) and out/doc/ (report versions)
node build_sim.js         # simulation -> out/sim/index.html
node test_sim.js all      # headless tests of the simulation, including the conformance run
node --max-old-space-size=10000 verify.js   # exhaustive verification -> out/verification/
node capture_sim.js       # simulation screenshots for the report
node build_report.js      # report -> out/Sensors_Design_Report.docx
```

With `NUSMV=<path to NuSMV.exe>` (or NuSMV on the PATH), `verify.js` also checks the six `.smv` files
with NuSMV and compares the verdicts; `NUSMV_ONLY=1` runs only that part again. NuSMV 2.7.1 is free
(LGPL) from https://nusmv.fbk.eu. The NuSMV checks take about an hour on a laptop with
`NUSMV_JOBS=8` (8 runs at a time), most of it for Setup 2 with sensor faults.

`render.js` and the other scripts expect Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`.
The state machines, step times and rules live in `src/cell-model.js`; change them there and rebuild.
The largest verification run (Setup 2 with sensor faults) needs a few minutes and about 2 GB of memory.
