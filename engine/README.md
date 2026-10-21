# cellsim: the simulation engine without graphics (Python)

The same engine as the browser simulator, separated from the drawing: an interpreter runs the four
state machines of the shared model, and a plant model supplies the robots, the CNC, the belt, the
sensors, the operator and the technician. It needs Python 3.9 or later and nothing else.

The model is not copied by hand. `cellsim/cell_model.json` is exported from
`source/src/cell-model.js` by `node source/export_model.js`, so the Python engine, the browser
simulator, the diagrams and the verifier all run the same state machines. After changing the model,
run the export again (the tests check that the JSON is up to date).

## Use

```
python run.py                                  # Setup 1, 8 h, nominal
python run.py --setup 2 --hours 24 --faults    # random disturbances (seeded)
python run.py --setup 2 --hours 2 --log 30     # also the last 30 log lines
```

```python
from cellsim import CellSim
sim = CellSim(setup=2, seed=1)
sim.advance(3600)                  # one hour of simulated time
sim.inject_undersized()            # disturbances: also inject_glitch(cp), toggle_sensor_fault(cp),
                                   # inject_bad_frame(), inject_camera_failure(), inject_grip_miss()
sim.advance(600)
print(sim.state("R2"), sim.kpis())
sim.press("qh")                    # HMI buttons: verify, resume, clear, qh, swap, load
```

`sim.trace` holds every state change, `sim.logs` the event log, `sim.stats` the counters, and
`sim.errors` every disagreement with the model (a job that takes another time than the model, a
violated property); it must stay empty.

## Checks

- `python -m unittest -v test_engine`: CNC idle time equal to the model value in every cycle; a
  faulty CP-2 sensor stops the line after the 3rd mismatch and the verification and reset bring it
  back; two undersized parts cause a quality hold with no cycle start; 4 h runs with random
  disturbances where every state change is a transition of the model and no property is violated.
- `node source/test_sim.js engine`: the browser simulator and this engine give the same state
  changes at the same instants (one hour of each setup, nominal and with a faulty CP-2 sensor).

## Files

| File | What it is |
|---|---|
| `cellsim/model.py` | Reads the model; the guard language (parser, evaluator, texts) |
| `cellsim/sim.py` | Interpreter of the state machines, scheduler, plant, property monitors |
| `cellsim/scenarios.py` | Long runs with random disturbances; conformance check against the model |
| `cellsim/cell_model.json` | The model, exported from `source/src/cell-model.js` |
| `run.py` | Command line |
| `test_engine.py` | Tests |
| `trace.py` | Trace of a scenario as JSON, for the comparison with the browser simulator |
