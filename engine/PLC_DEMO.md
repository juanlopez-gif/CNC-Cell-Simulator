# Recorded demo of the PLC (step A3)

The generated PLC program (`source/plc/cell.st`) runs in the OpenPLC v3 runtime on a PC and controls
the plant of the Python engine through the Modbus bridge (`cellsim/plc_bridge.py`). **A software PLC
controlling a simulated cell, not industrial hardware**: the video says so at the start.

The same run is checked automatically in CI (`.github/workflows/plc-run.yml`, PROJECT_STATUS.md
§5.16); the demo shows it with the OpenPLC web interface, in about 5 minutes.

## 1. Install (once, about 30 minutes)

Everything runs in Ubuntu 22.04 under WSL 2, as in CI.

1. In a PowerShell **as administrator**: `wsl --install -d Ubuntu-22.04`, restart Windows, open
   "Ubuntu 22.04" from the Start menu and choose a user name and password.
2. In the Ubuntu terminal:

   ```bash
   sudo apt update && sudo apt install -y git python3-venv python3-pip
   cd ~ && git clone https://github.com/thiagoralves/OpenPLC_v3.git
   cd OpenPLC_v3 && ./install.sh linux          # 10-20 min
   cd ~ && git clone -b a3-plc https://github.com/juanlopez-gif/CNC-Cell-Simulator.git
   python3 -m venv ~/cellenv && ~/cellenv/bin/pip install pymodbus==3.6.9
   ```

## 2. Configure OpenPLC (once)

1. Start the runtime: `cd ~/OpenPLC_v3 && ./start_openplc.sh` (leave this terminal open; if it
   complains about permissions, `sudo ./start_openplc.sh`).
2. On Windows, open <http://localhost:8080> and log in with the default user of OpenPLC (its README
   gives it; change the password afterwards under *Users*).
3. **Settings**: *Slave devices polling period* = **10** ms, *Timeout* = 1000 ms; leave the Modbus
   server on. Save. (With the default 100 ms the delays are larger than the bound of A3.4.)
4. **Slave Devices → Add new device**:

   | Field | Value |
   |---|---|
   | Device name | bridge |
   | Device protocol | Generic Modbus TCP device |
   | Slave ID | 1 |
   | IP address / IP port | 127.0.0.1 / 5020 |
   | Discrete Inputs (%IX100.0) | start 0, size 64 |
   | Coils (%QX100.0) | start 0, size 19 |
   | Input Registers (%IW100) | start 0, size 1 |
   | Holding Registers - Read (%IW100) | start 0, size 0 |
   | Holding Registers - Write (%QW100) | start 0, size 44 |

   The sizes are the lengths of the four lists in `source/plc/io_map.json`; if the model changes,
   take them from there.
5. **Programs → Upload Program**: `~/CNC-Cell-Simulator/source/plc/cell.st` (from Windows:
   `\\wsl$\Ubuntu-22.04\home\<user>\CNC-Cell-Simulator\source\plc\cell.st`), then *Launch program*.
   The compilation must end without errors. Do not start the PLC yet.

## 3. Rehearse, then record

Order matters: **the bridge first, then the PLC** (the bridge must see the first state changes).
If the PLC is running from an earlier try, *Stop PLC* first.

Second Ubuntu terminal:

```bash
cd ~/CNC-Cell-Simulator/engine
~/cellenv/bin/python -m cellsim.plc_bridge --scenario demo --seconds 300 --wait 600 --live --out demo_run.json
```

Then *Start PLC* in the dashboard. The terminal prints every state change as it happens; lines with
`**` are the scripted disturbance and the operator, `!!` a fault code of the PLC. After 300 s it
prints the summary; then *Stop PLC*. Check against the model:

```bash
~/cellenv/bin/python -m cellsim.plc_compare ref --scenario demo --seconds 600 --out demo_ref.json
~/cellenv/bin/python -m cellsim.plc_compare compare demo_ref.json demo_run.json --out demo_compare.json
```

It must end with `PASS`.

**What happens in the demo scenario** (plant time; the PLC is about 1 s behind the model by then):

| Time | Event |
|---|---|
| 0 s | The machines leave their initial states; Robot 1 loads the CNC (B1-B6) |
| ~30 s | `** camwrong CP-4`: the next answer of the output-pallet camera will be wrong |
| ~145-170 s | First CNC cycle ends; Robot 1 exchanges the parts, the conveyor carries the finished part |
| ~189 s | Robot 2 checks CP-4 before placing: proximity and camera disagree → `R2 E5 -> F`, `!! PLC fault` |
| ~194 s | `** clear R2`: the operator clears the fault 5 s later; `R2 F -> E5`, the part is placed |
| 300 s | End: summary (no plant error, no property violation) |

**Recording** (Windows 11: Snipping Tool, `Win + Shift + R`, or OBS Studio). Suggested script,
about 5 minutes:

1. (20 s) Title: "CNC cell: the generated PLC program in OpenPLC, a software PLC controlling a
   simulated cell, not industrial hardware".
2. (30 s) `source/src/cell-model.js` (a machine of the model) and the generated `source/plc/cell.st`
   (its function block).
3. (20 s) OpenPLC dashboard: the program `cell.st`, the slave device `bridge`.
4. (3.5 min) Terminal and browser side by side: start the bridge, *Start PLC*; the state changes
   scroll; *Monitoring* shows `R1_state`, `CONV_state`, `R2_state`, `SUP_state`; at ~189 s the fault
   of Robot 2 and its clearing.
5. (30 s) The summary and `plc_compare compare` ending with `PASS`.

Keep the video out of the repository (size); put its link in PROJECT_STATUS.md §15 (A3).
