/* Shared model for the machine-tending cell: timing, sensors, checkpoints, states.
   Used by the diagram generator, the Word report and the browser simulation. */
(function (root) {
  // ---------------------------------------------------------------- timing (s)
  const T = {
    cncCycle: 120,
    unlock: 0.5, lock: 0.5, cycleStart: 0.5,
    homeToDoor: 1.5, doorToHome: 1.5,
    doorOpen: 4.0, doorClose: 4.0,           // robot grips handle, slides door, releases
    enterCnc: 2.0, exitCnc: 2.0,
    grip: 0.5, release: 0.5,
    viseOpen: 1.0, viseClamp: 1.0, lift: 1.0, placeInVise: 1.0, seatCheck: 0.5,
    swapGripper: 1.5,                        // wrist rotation A/B + air blast of the vise
    doorToConv: 2.5, placeConv: 2.0,
    convToPallet: 2.0, pickPallet: 2.0, palletToDoor: 2.5,
    check: 0.5,                              // settle + camera snapshot + compare
    beltTravel: 8.0,                         // 2.0 m at 0.25 m/s
    beltStart: 0.3, beltStop: 0.3, zeroSpeed: 0.2,
    r2ToExit: 1.5, r2Pick: 1.0, r2ToPallet: 1.5, r2Place: 1.0, r2Home: 1.0,
    r2ToGauge: 1.5, r2LoadGauge: 1.5, measure: 1.0, r2Repick: 1.0, r2ToNok: 1.5, r2Drop: 0.5,
  };

  // CNC idle per cycle = time from "cycle complete" to the next "cycle start".
  const idleSetup1 = [
    ['Door unlock', T.unlock], ['Home to door', T.homeToDoor], ['Open door', T.doorOpen],
    ['Enter CNC', T.enterCnc], ['Grip part', T.grip], ['Open vise', T.viseOpen], ['Lift out', T.lift],
    ['Exit CNC', T.exitCnc], ['To conveyor', T.doorToConv], ['Place on conveyor', T.placeConv],
    ['Check CP-2', T.check], ['To input pallet', T.convToPallet], ['Check CP-1 + locate', T.check],
    ['Pick raw part', T.pickPallet], ['To CNC door', T.palletToDoor], ['Enter CNC', T.enterCnc],
    ['Place in vise', T.placeInVise], ['Clamp', T.viseClamp], ['Seat check', T.seatCheck],
    ['Release', T.release], ['Exit CNC', T.exitCnc], ['Close door', T.doorClose],
    ['Door lock', T.lock], ['Cycle start', T.cycleStart],
  ];
  const idleSetup2 = [
    ['Door unlock', T.unlock], ['Open door', T.doorOpen], ['Enter CNC', T.enterCnc],
    ['Gripper B grips part', T.grip], ['Open vise', T.viseOpen], ['Lift out', T.lift],
    ['Swap A/B + air blast', T.swapGripper], ['Gripper A places part', T.placeInVise],
    ['Clamp', T.viseClamp], ['Seat check', T.seatCheck], ['Release', T.release],
    ['Exit CNC', T.exitCnc], ['Close door', T.doorClose], ['Door lock', T.lock],
    ['Cycle start', T.cycleStart],
  ];
  const sum = (a) => Math.round(a.reduce((s, x) => s + x[1], 0) * 10) / 10;
  const KPI = (() => {
    const i1 = sum(idleSetup1), i2 = sum(idleSetup2);
    const c1 = T.cncCycle + i1, c2 = T.cncCycle + i2;
    return {
      idle1: i1, idle2: i2, cycle1: c1, cycle2: c2,
      util1: T.cncCycle / c1, util2: T.cncCycle / c2,
      pph1: 3600 / c1, pph2: 3600 / c2,
    };
  })();

  // ---------------------------------------------------------------- rules
  const RULES = {
    mismatchWindow: 600,     // s  (10 min sliding window)
    mismatchLimit: 3,        // mismatches inside the window that stop the line
    settle: 0.3,             // s  scene must be static before a check
    debounce: 0.05,          // s  proximity input filter
    minSize: 48.0,           // mm acceptance limit (50 mm nominal - 2 mm)
    nominal: 50.0,
    consecutiveNokHold: 2,   // consecutive NOK parts that hold the CNC
    palletSlots: 12,         // 3 x 4 positions, input and output pallets
  };

  // ---------------------------------------------------------------- checkpoints
  const CHECKPOINTS = [
    { id: 'CP-1', where: 'Input pallet', prox: 'PX-11', cam: 'CAM-1', roi: 'ROI-A', fact: 'Input pallet present and seated', setup: 1 },
    { id: 'CP-2', where: 'Conveyor entry', prox: 'PE-41', cam: 'CAM-1', roi: 'ROI-B', fact: 'Part at conveyor entry', setup: 1 },
    { id: 'CP-3', where: 'Conveyor exit', prox: 'PE-42', cam: 'CAM-2', roi: 'ROI-C', fact: 'Part at the end stop', setup: 1 },
    { id: 'CP-4', where: 'Output pallet', prox: 'PX-52', cam: 'CAM-2', roi: 'ROI-D', fact: 'Output pallet present', setup: 1 },
    { id: 'CP-5', where: 'Gauge nest', prox: 'PX-64', cam: 'CAM-2', roi: 'ROI-E', fact: 'Part in gauge nest', setup: 2 },
  ];

  // ---------------------------------------------------------------- sensors / signals
  // group: zone name; kind: prox | cam | door | safety | vise | enc | grip | laser | light | robot | cnc | ctrl
  const SENSORS = [
    { tag: 'PX-11', zone: 'Input pallet', kind: 'prox', setup: 1,
      type: 'IR diffuse photoelectric proximity sensor, M18, PNP',
      where: 'Input-pallet locating corner, looking at the pallet edge',
      confirms: 'Input pallet present and seated against the locators (CP-1)',
      example: 'AutomationDirect FFI7-0P-1E (IR diffuse, 400 mm) or Balluff BOS 18M' },
    { tag: 'CAM-1', zone: 'Robot 1 area', kind: 'cam', setup: 1,
      type: '2D industrial camera with LED bar light, calibrated to the robot frame',
      where: 'Overhead frame (~2 m) above the input pallet and the conveyor entry',
      confirms: 'ROI-A: pallet present, part positions (x, y, angle), parts left. ROI-B: part at conveyor entry (CP-1, CP-2)',
      example: 'Cognex In-Sight 2800 / Keyence IV3, or Luxonis OAK-D Pro PoE (budget)' },
    { tag: 'GR-21', zone: 'Robot 1', kind: 'grip', setup: 1,
      type: 'Electric parallel gripper with grip detection and finger-width feedback',
      where: 'Robot 1 tool flange (Setup 2: dual gripper GR-21A / GR-21B)',
      confirms: 'Part gripped (fingers stop at about 50 mm) or missed (fingers fully closed)',
      example: 'OnRobot RG2 or Robotiq 2F-85; Setup 2: OnRobot Dual Quick Changer + 2 grippers' },
    { tag: 'R1 / R2', zone: 'Robots', kind: 'robot', setup: 1,
      type: 'UR10e controller status and configurable safety I/O',
      where: 'Robot control boxes',
      confirms: 'Robot at home, clear of CNC, clear of conveyor (safety planes), program state',
      example: 'Universal Robots UR10e (EtherNet/IP, PROFINET, Modbus TCP; 17 safety functions)' },
    { tag: 'CNC I/O', zone: 'CNC', kind: 'cnc', setup: 1,
      type: 'Robot interface of the CNC (discrete I/O or fieldbus, M-code handshake)',
      where: 'CNC control cabinet (manufacturer robot-interface kit)',
      confirms: 'CNC ready, in cycle, cycle complete, spindle stopped, alarm; cell sends cycle start',
      example: 'Machine builder robot interface (for example the Haas robot interface box)' },
    { tag: 'ZS-31', zone: 'CNC door', kind: 'door', setup: 1,
      type: 'Non-contact door position sensor (inductive or coded magnetic) - door kit',
      where: 'End of the door track, open position',
      confirms: 'Door fully open: robot may enter the machine',
      example: 'Supplied in the CNC door kit (inductive M12 type)' },
    { tag: 'ZS-32', zone: 'CNC door', kind: 'door', setup: 1,
      type: 'Non-contact door position sensor - door kit',
      where: 'Door frame, closed position',
      confirms: 'Door fully closed',
      example: 'Supplied in the CNC door kit' },
    { tag: 'ZS-33', zone: 'CNC door', kind: 'safety', setup: 1,
      type: 'Safety interlock switch with guard locking (solenoid, coded, dual channel)',
      where: 'Door frame, closed position',
      confirms: 'Door locked; stays locked while the spindle turns, unlocks only when stopped',
      example: 'Supplied in the CNC door kit (IDEM KL1-P-221002 if not supplied)' },
    { tag: 'ZS-34 / ZS-35', zone: 'CNC vise', kind: 'vise', setup: 1,
      type: 'Cylinder position sensors (magnetic reed) on the pneumatic vise',
      where: 'Vise cylinder',
      confirms: 'Vise open (ZS-34) / vise clamped (ZS-35)',
      example: 'SMC D-M9 series auto switches (workholding kit)' },
    { tag: 'PS-36', zone: 'CNC vise', kind: 'vise', setup: 1,
      type: 'Air-gap (air catch) sensor in the fixture datum',
      where: 'Vise fixed jaw / datum face',
      confirms: 'Part seated flat on the datum, no chip under the part',
      example: 'SMC ISA3 digital gap sensor' },
    { tag: 'PE-41', zone: 'Conveyor', kind: 'prox', setup: 1,
      type: 'IR through-beam photoelectric pair across the belt',
      where: 'Conveyor entry (place position of Robot 1)',
      confirms: 'Part at conveyor entry (CP-2)',
      example: 'AutomationDirect QMIHD-0P-0F (IR through-beam pair)' },
    { tag: 'PE-42', zone: 'Conveyor', kind: 'prox', setup: 1,
      type: 'IR through-beam photoelectric pair across the belt',
      where: 'Conveyor exit, 30 mm before the hard stop',
      confirms: 'Part at the end stop: stop the belt (CP-3)',
      example: 'AutomationDirect QMIHD-0P-0F (IR through-beam pair)' },
    { tag: 'ENC-43', zone: 'Conveyor', kind: 'enc', setup: 1,
      type: 'Incremental rotary encoder, 600 ppr, on an idler roller',
      where: 'Idler (non-driven) roller, so it follows the real belt motion',
      confirms: 'Belt moving or at zero speed; detects slip or a drive that does not move',
      example: 'Koyo TRD-N600-RZWD' },
    { tag: 'CAM-2', zone: 'Robot 2 area', kind: 'cam', setup: 1,
      type: '2D industrial camera with LED bar light',
      where: 'Overhead above the conveyor exit and the output pallet (Setup 2: also gauge and NOK chute)',
      confirms: 'ROI-C: part at exit + pick pose. ROI-D: pallet present + slot occupancy. ROI-E: part in gauge (CP-3, CP-4, CP-5)',
      example: 'Same model as CAM-1' },
    { tag: 'GR-51', zone: 'Robot 2', kind: 'grip', setup: 1,
      type: 'Electric parallel gripper with grip detection',
      where: 'Robot 2 tool flange',
      confirms: 'Part gripped / released',
      example: 'OnRobot RG2' },
    { tag: 'PX-52', zone: 'Output pallet', kind: 'prox', setup: 1,
      type: 'IR diffuse photoelectric proximity sensor',
      where: 'Output-pallet locating corner',
      confirms: 'Output pallet present (CP-4); OFF then ON = pallet swapped',
      example: 'AutomationDirect FFI7-0P-1E' },
    { tag: 'LT-53', zone: 'Output pallet', kind: 'light', setup: 1,
      type: 'Blue LED beacon (IEC 60204-1: operator action required)',
      where: 'Pole at the output pallet, visible from the aisle',
      confirms: 'Output pallet full: ready to be picked up',
      example: 'Patlite 1-tier LED signal light, blue lens' },
    { tag: 'LT-01', zone: 'Cell', kind: 'light', setup: 1,
      type: 'Stack light red / amber / green with buzzer',
      where: 'Cell control cabinet',
      confirms: 'Green running, amber warning (mismatch, pallet empty), red line stopped / fault',
      example: 'Patlite LR6 3-tier (LR6-302WJBW-RYG)' },
    { tag: 'SC-01 / SC-02', zone: 'Cell', kind: 'safety', setup: 1,
      type: 'Safety laser scanner (or light curtain) at the operator stations',
      where: 'Input and output pallet loading sides',
      confirms: 'Operator in the loading zone: robot reduced speed / protective stop',
      example: 'SICK nanoScan3 or Keyence SZ-V' },
    { tag: 'PLC-01', zone: 'Cell', kind: 'ctrl', setup: 1,
      type: 'Cell PLC + HMI + safety relay',
      where: 'Cell control cabinet',
      confirms: 'Runs the state machines, the camera/proximity cross-check and the alarms',
      example: 'AutomationDirect BRX BX-DM1E-18ED13-D (budget) or Allen-Bradley CompactLogix' },
    // ------------------------------------------------ Setup 2 additions
    { tag: 'LS-61 / 62 / 63', zone: 'Gauge station', kind: 'laser', setup: 2,
      type: 'Laser displacement sensors (triangulation), one per axis',
      where: 'Gauge nest, facing the three free faces (length X, width Y, height Z)',
      confirms: 'Length, width and height of every part; reject if any value < 48.00 mm',
      example: 'Keyence IL-065 (55-105 mm range, 2 um repeatability) + IL amplifiers' },
    { tag: 'PX-64', zone: 'Gauge station', kind: 'prox', setup: 2,
      type: 'IR diffuse photoelectric proximity sensor',
      where: 'Gauge nest base',
      confirms: 'Part in the nest (CP-5)',
      example: 'AutomationDirect FFI7-0P-1E' },
    { tag: 'PE-65', zone: 'NOK chute', kind: 'prox', setup: 2,
      type: 'IR through-beam photoelectric pair',
      where: 'Mouth of the non-conforming chute',
      confirms: 'Rejected part really dropped into the locked NOK bin',
      example: 'AutomationDirect QMIHD-0P-0F' },
    { tag: 'MST-60', zone: 'Gauge station', kind: 'ctrl', setup: 2,
      type: 'Certified 50.000 mm master cube + holder',
      where: 'Next to the gauge, reachable by Robot 2',
      confirms: 'Zero-setting of LS-61/62/63 at start-up and after every sensor verification',
      example: 'Gauge block / master cube with calibration certificate' },
  ];

  // ---------------------------------------------------------------- state names
  const STATES = {
    R1S1: {
      A0: 'START-UP CHECKS', A1: 'WAIT FOR CNC', A2: 'OPEN CNC DOOR', A3: 'UNLOAD CNC',
      A4: 'PLACE ON CONVEYOR', A5: 'PICK RAW PART', A6: 'LOAD CNC', A7: 'CLOSE CNC DOOR',
      A8: 'START CYCLE', W1: 'WAIT FOR INPUT PALLET', H: 'HOLD (LINE STOP)', F: 'FAULT',
    },
    R1S2: {
      B0: 'START-UP CHECKS', B1: 'PICK RAW PART (A)', B2: 'WAIT AT CNC DOOR', B3: 'OPEN DOOR (B)',
      B4: 'EXCHANGE PARTS', B5: 'CLOSE DOOR (A)', B6: 'START CYCLE', B7: 'PLACE ON CONVEYOR (B)',
      W1: 'WAIT FOR INPUT PALLET', H: 'HOLD (LINE STOP)', F: 'FAULT',
    },
    CONV: {
      C1: 'EMPTY - STOPPED', C2: 'PART AT ENTRY', C3: 'TRANSPORTING', C4: 'STOPPING',
      C5: 'PART AT EXIT - READY TO PICK', H: 'HOLD (LINE STOP)', F: 'FAULT',
    },
    R2S1: {
      D0: 'START-UP CHECKS', D1: 'WAIT FOR PART', D2: 'PICK FROM CONVEYOR',
      D3: 'PLACE ON OUTPUT PALLET', D4: 'PALLET FULL - WAIT FOR SWAP', H: 'HOLD (LINE STOP)', F: 'FAULT',
    },
    R2S2: {
      E0: 'START-UP CHECKS', E1: 'WAIT FOR PART', E2: 'PICK FROM CONVEYOR', E3: 'LOAD GAUGE',
      E4: 'MEASURE L, W, H', E5: 'PLACE OK PART ON PALLET', E6: 'PLACE IN NOK CHUTE',
      E7: 'PALLET FULL - WAIT FOR SWAP', H: 'HOLD (LINE STOP)', F: 'FAULT',
    },
    XCHK: {
      X1: 'NORMAL', X2: 'MISMATCH WARNING', X3: 'LINE STOP', X4: 'SENSOR VERIFICATION',
    },
  };

  const MODEL = { T, KPI, RULES, CHECKPOINTS, SENSORS, STATES, idleSetup1, idleSetup2 };
  root.CellModel = MODEL;
  if (typeof module !== 'undefined' && module.exports) module.exports = MODEL;
})(typeof window !== 'undefined' ? window : globalThis);
