"""Bridge between the PLC program (source/plc/cell.st running in OpenPLC) and the plant of the Python
engine (step A3.3, PROJECT_STATUS.md §5.16).

The bridge is a Modbus TCP slave device; the OpenPLC runtime is the master and polls it (mbconfig.cfg
written by write_mbconfig). Its addresses come from source/plc/io_map.json, generated with the PLC
program. Every cycle the bridge reads what the PLC wrote (coils, holding registers), applies it to the
plant (CellSim(external=True)), advances the plant by the elapsed wall-clock time, and writes the
inputs back (discrete inputs, input registers). The plant runs in real time because the PLC does.

    python -m cellsim.plc_bridge --seconds 900 --port 5020 --out run.json

Handshakes (§5.16 point 6): a job starts on the rising edge of <slot>_Start; Done is raised
RULES.debounce plus one scan after the job ended, so that the debounced sensors it changed are
already stable in the PLC when it evaluates the confirmation; Done drops when Start is low. A camera
answers a trigger at once (the settle time is the PLC's own) and drops Done when the trigger is low.
"""
import argparse
import asyncio
import json
import os
import threading
import time

from .sim import CellSim

HERE = os.path.dirname(os.path.abspath(__file__))
IO_MAP = os.path.join(HERE, "..", "..", "source", "plc", "io_map.json")
PULSE = 0.3          # s an HMI button stays on (the PLC latches its rising edge)


def write_mbconfig(path, io, port, polling_ms=10):
    """mbconfig.cfg of the OpenPLC runtime: one TCP slave device, the bridge."""
    n = {k: len(io[k]) for k in ("discreteInputs", "coils", "inputRegisters", "holdingRegisters")}
    lines = [
        'Num_Devices = "1"', f'Polling_Period = "{polling_ms}"', 'Timeout = "1000"',
        'device0.name = "bridge"', 'device0.slave_id = "1"', 'device0.protocol = "TCP"',
        'device0.address = "127.0.0.1"', f'device0.IP_Port = "{port}"',
        'device0.RTU_Baud_Rate = "115200"', 'device0.RTU_Parity = "None"', 'device0.RTU_Data_Bits = "8"',
        'device0.RTU_Stop_Bits = "1"', 'device0.RTU_TX_Pause = "0"',
        'device0.Discrete_Inputs_Start = "0"', f'device0.Discrete_Inputs_Size = "{n["discreteInputs"]}"',
        'device0.Coils_Start = "0"', f'device0.Coils_Size = "{n["coils"]}"',
        'device0.Input_Registers_Start = "0"', f'device0.Input_Registers_Size = "{n["inputRegisters"]}"',
        'device0.Holding_Registers_Read_Start = "0"', 'device0.Holding_Registers_Read_Size = "0"',
        'device0.Holding_Registers_Start = "0"', f'device0.Holding_Registers_Size = "{n["holdingRegisters"]}"',
    ]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


class Bridge:
    """Plant side of the PLC I/O, independent of the transport (read_outputs / write_inputs)."""

    def __init__(self, sim, io):
        self.sim, self.io = sim, io
        self.jobs = io["jobs"]
        self.states = io["states"]
        self.prox_cp = {c["prox"]: c["id"] for c in sim.M.CHECKPOINTS}
        self.job = {}        # slot -> {"start": bool, "running": bool, "done": bool, "ready_at": t | None}
        self.cam = {}        # (slot, cp) -> {"done", "valid", "cam", "also"}
        self.pulse = {}      # HMI input -> time it went on
        self.hb = False
        self.scan = io["scanMs"] / 1000.0
        self.plc_faults = []  # (t, slot, code)
        self._fault_last = {}

    # ---- PLC outputs -> plant
    def apply_outputs(self, coils, regs):
        sim, io = self.sim, self.io
        val = {}
        for e, v in zip(io["coils"], coils):
            val[e["st"]] = bool(v)
        for e, v in zip(io["holdingRegisters"], regs):
            val[e["st"]] = int(v)
        job_no = {e["slot"]: val[e["st"]] for e in io["holdingRegisters"] if e["k"] == "jobNo"}
        faults = {e["slot"]: val[e["st"]] for e in io["holdingRegisters"] if e["k"] == "fault"}
        for e in io["holdingRegisters"]:
            if e["k"] == "state":
                code = val[e["st"]]
                sid = self.states[e["slot"]].get(str(code), "")
                f = faults.get(e["slot"], 0)
                if f and self._fault_last.get(e["slot"]) != f:
                    self.plc_faults.append((round(sim.t, 3), e["slot"], f))
                self._fault_last[e["slot"]] = f
                sim.ext_state(e["slot"], sid, f"PLC fault code {f}" if f else None)
            elif e["k"] == "var":
                sim.ext["vars"][e["name"]] = val[e["st"]]
        for e in io["coils"]:
            v = val[e["st"]]
            if e["k"] == "output":
                sim.ext["out"][e["name"]] = v
            elif e["k"] == "var":
                sim.ext["vars"][e["name"]] = v
            elif e["k"] == "jobStart":
                j = self.job.setdefault(e["slot"], {"start": False, "running": False, "done": False, "ready_at": None})
                # the master writes the coils before the registers: a job starts only when its number
                # has arrived too (the PLC sets JobNo to 0 whenever it drops Start)
                if v and not j["start"] and not j["running"] and not j["done"] and job_no[e["slot"]] > 0:
                    name = self.jobs[job_no[e["slot"]] - 1]
                    sim.log("plc", f"{e['slot']} starts job {name}")
                    sim.ext_job(e["slot"], name)
                    j["running"] = True
                if not v and j["done"]:
                    j["done"] = False
                j["start"] = v and (j["running"] or j["done"])
            elif e["k"] == "camTrig":
                c = self.cam.setdefault((e["slot"], e["cp"]), {"done": False, "valid": False, "cam": False, "also": False})
                if v and not c["done"]:
                    c["valid"], c["cam"], c["also"] = sim.ext_camera(e["cp"])
                    c["done"] = True
                elif not v and c["done"]:
                    c["done"] = False

    # ---- plant -> PLC inputs
    def inputs(self):
        sim = self.sim
        for slot, j in self.job.items():
            if j["running"] and sim.ext["done"].get(slot) is not None:
                if j["ready_at"] is None:
                    j["ready_at"] = sim.ext["done"][slot] + sim.RU["debounce"] + self.scan
                if sim.t >= j["ready_at"]:
                    j["running"], j["done"], j["ready_at"] = False, True, None
        for key, flag in (("HMI.verify", "verify"), ("HMI.reset", "reset"), ("HMI.release", "release")):
            if sim.inputs[flag]:
                sim.inputs[flag] = False
                self.pulse[key] = sim.t
        self.hb = not self.hb
        di = []
        for e in self.io["discreteInputs"]:
            k = e["k"]
            if k == "hb":
                v = self.hb
            elif k == "jobDone":
                v = self.job.get(e["slot"], {}).get("done", False)
            elif k in ("camDone", "camValid", "cam", "camAlso"):
                c = self.cam.get((e["slot"], e["cp"]), {})
                v = c.get({"camDone": "done", "camValid": "valid", "cam": "cam", "camAlso": "also"}[k], False) if c.get("done") else False
            elif k == "input":
                n = e["name"]
                if n == "HMI.clear":
                    v = sim.t - sim.inputs["clear_at"] < PULSE
                elif n in self.pulse:
                    v = sim.t - self.pulse[n] < PULSE
                else:
                    v = sim._input(n, None)
            elif k == "sensor":
                n = e["name"]
                v = sim._prox_live(self.prox_cp[n]) if n not in sim.M.SIGNALS and n in self.prox_cp else sim.read(n)
            else:
                raise KeyError(f"unknown input kind {k}")
            di.append(bool(v))
        ir = [int(sim.read(e["name"])) for e in self.io["inputRegisters"]]
        return di, ir


def serve(port, io, seconds, seed, log_every=60.0):
    """Run the plant against the PLC for `seconds` of wall-clock time; return the result."""
    from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext, ModbusSlaveContext
    from pymodbus.server import StartAsyncTcpServer

    sim = CellSim(seed=seed, external=True, auto_operator=True)
    br = Bridge(sim, io)
    n = {k: max(1, len(io[k])) for k in ("discreteInputs", "coils", "inputRegisters", "holdingRegisters")}
    store = ModbusSlaveContext(di=ModbusSequentialDataBlock(0, [0] * n["discreteInputs"]),
                               co=ModbusSequentialDataBlock(0, [0] * n["coils"]),
                               ir=ModbusSequentialDataBlock(0, [0] * n["inputRegisters"]),
                               hr=ModbusSequentialDataBlock(0, [0] * n["holdingRegisters"]), zero_mode=True)
    ctx = ModbusServerContext(slaves=store, single=True)
    threading.Thread(target=lambda: asyncio.run(StartAsyncTcpServer(context=ctx, address=("127.0.0.1", port))),
                     daemon=True).start()

    def exchange():
        coils = store.getValues(1, 0, len(io["coils"]))
        regs = store.getValues(3, 0, len(io["holdingRegisters"]))
        br.apply_outputs(coils, regs)
        di, ir = br.inputs()
        store.setValues(2, 0, di)
        if ir:
            store.setValues(4, 0, ir)

    # wait until the PLC runs (Robot 1 left its initial state), feeding it the inputs meanwhile
    t_wait = time.monotonic()
    while sim.mch["R1"]["state"] == "":
        exchange()
        if time.monotonic() - t_wait > 120:
            raise RuntimeError("the PLC did not start within 120 s (no state from Robot 1)")
        time.sleep(0.002)
    print(f"PLC running after {time.monotonic() - t_wait:.1f} s; plant clock starts")
    t0 = last = time.monotonic()
    next_log = log_every
    while True:
        now = time.monotonic()
        if now - t0 >= seconds:
            break
        exchange()
        sim.advance(now - last)
        last = now
        if sim.t >= next_log:
            next_log += log_every
            m = sim.measures()
            print(f"t = {sim.t:7.1f} s: {sim.stats['cycles']} CNC cycles, {m['parts_out']} parts out, "
                  f"states {[sim.mch[s]['state'] for s in sim.M.SLOTS]}, errors {len(sim.errors)}, "
                  f"violations {sim.stats['violations']}, PLC faults {len(br.plc_faults)}", flush=True)
        time.sleep(0.001)
    return {"seconds": round(sim.t, 3), "seed": seed, "cycles": sim.stats["cycles"], "measures": sim.measures(),
            "kpis": sim.kpis(), "errors": sim.errors, "violations": sim.stats["violations"],
            "plc_faults": br.plc_faults, "trace": [[round(x["t"], 3), x["slot"], x["from"], x["to"]] for x in sim.trace],
            "logs": [[round(t, 3), c, m] for t, c, m in sim.logs]}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seconds", type=float, default=900)
    ap.add_argument("--port", type=int, default=5020)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--io", default=IO_MAP)
    ap.add_argument("--mbconfig", help="write the OpenPLC mbconfig.cfg to this path and exit")
    ap.add_argument("--out", default="plc_run.json")
    a = ap.parse_args()
    with open(a.io) as f:
        io = json.load(f)
    if a.mbconfig:
        write_mbconfig(a.mbconfig, io, a.port)
        print("written", a.mbconfig)
        return
    r = serve(a.port, io, a.seconds, a.seed)
    with open(a.out, "w") as f:
        json.dump(r, f, indent=1)
    print(f"{r['seconds']} s: {r['cycles']} CNC cycles, {r['measures']['parts_out']} parts out, "
          f"{len(r['errors'])} plant errors, {r['violations']} property violations, {len(r['plc_faults'])} PLC faults")
    if r["errors"]:
        print("plant errors:", *r["errors"][:10], sep="\n  ")


if __name__ == "__main__":
    main()
