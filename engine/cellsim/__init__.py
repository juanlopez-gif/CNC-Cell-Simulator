"""cellsim: the simulation engine of the CNC machine-tending cell, without graphics.

    from cellsim import CellSim
    sim = CellSim(seed=1)          # Setup 2 (the only setup)
    sim.advance(3600)
    print(sim.kpis())
"""
from .model import Model, load
from .sim import CellSim
from .scenarios import conformance, run_random

__all__ = ["CellSim", "Model", "load", "conformance", "run_random"]
