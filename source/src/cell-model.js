/* Shared model of the machine-tending cell: timing, rules, sensors, checkpoints and the four
   state machines (states, steps, transitions and guards) as data.
   The diagram generator, the browser simulation, the Word report and the NuSMV export read this
   file. None of them contains state names, transitions or guard texts of its own. */
(function (root) {
  // ---------------------------------------------------------------- timing (s)
  const T = {
    cncCycle: 120,
    unlock: 0.5, lock: 0.5, cycleStart: 0.5,
    homeToDoor: 1.5, doorToHome: 1.5, park: 1.5,
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
  // Names of the time components, used in the CNC idle build-up table.
  const TLABEL = {
    unlock: 'Door unlock', lock: 'Door lock', cycleStart: 'Cycle start', homeToDoor: 'Home to door',
    doorToHome: 'Door to home', park: 'Park at home', doorOpen: 'Open door', doorClose: 'Close door',
    enterCnc: 'Enter CNC', exitCnc: 'Exit CNC', grip: 'Grip part', release: 'Release', viseOpen: 'Open vise',
    viseClamp: 'Clamp', lift: 'Lift out', placeInVise: 'Place in vise', seatCheck: 'Seat check',
    swapGripper: 'Swap A/B + air blast', doorToConv: 'To conveyor', placeConv: 'Place on conveyor',
    convToPallet: 'To input pallet', pickPallet: 'Pick raw part', palletToDoor: 'To CNC door',
    beltStart: 'Belt start', beltTravel: 'Transport', beltStop: 'Belt stop', zeroSpeed: 'Zero speed',
    r2ToExit: 'To conveyor exit', r2Pick: 'Grip and lift', r2ToPallet: 'To output pallet', r2Place: 'Place',
    r2Home: 'Home', r2ToGauge: 'To gauge', r2LoadGauge: 'Load gauge', measure: 'Measure', r2Repick: 'Re-pick',
    r2ToNok: 'To NOK chute', r2Drop: 'Drop',
  };

  // ---------------------------------------------------------------- rules
  const RULES = {
    mismatchWindow: 600,     // s  (10 min sliding window)
    mismatchLimit: 3,        // mismatches inside the window that stop the line
    settle: 0.3,             // s  scene must be static before a check
    debounce: 0.05,          // s  proximity input filter
    retrigger: 0.3,          // s  second camera image after an invalid one
    confirmTimeout: 1.0,     // s  a confirmation that does not arrive in time raises a FAULT
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

  // ================================================================ STATE MACHINES AS DATA
  // Four machines run in parallel in the cell PLC. Each one fills a slot; the Robot 1 and Robot 2
  // slots hold a different machine in Setup 1 and Setup 2.
  const SLOTS = {
    R1: { label: 'Robot 1 + CNC', ref: 'Robot 1' },
    CONV: { label: 'Conveyor', ref: 'Conveyor' },
    R2: { label: 'Robot 2 + pallet', ref: 'Robot 2' },
    SUP: { label: 'Cross-check', ref: 'Supervisor' },
  };

  // Every name a guard can read. on / off = the text shown on the diagrams for the true / false
  // value ({TAG} sensor, [CP-n] checkpoint, *bold*). kind tells where the value comes from:
  //   sensor   a device signal; the simulation reads its plant, the verifier an abstract plant
  //   check    fused result of the last camera + proximity check made by the machine that reads it
  //            (the camera decides; one machine never reads another machine's check)
  //   var      PLC variable written by the steps of the machines
  //   input    operator or technician input (HMI button)
  //   derived  defined by an expression over other names (def)
  // ask = question text when the signal decides a choice; tags = sensors behind the signal.
  const SIGNALS = {
    'HMI.auto': { kind: 'sensor', on: 'Auto mode ON' },
    'HMI.loaded': { kind: 'sensor', on: 'operator: "pallet loaded"', tags: ['PX-11'] },
    'HMI.clear': { kind: 'input', on: 'operator clears the fault' },
    'HMI.verify': { kind: 'input', on: 'technician starts the check' },
    'HMI.reset': { kind: 'input', on: 'operator reset' },
    'HMI.release': { kind: 'input', on: 'tool and offsets checked' },
    'VERIFY.pass': { kind: 'input', on: 'all CP tests pass' },
    'VERIFY.fail': { kind: 'input', on: 'test fails' },
    // robots: UR controller status and safety planes
    'R1.home': { kind: 'sensor', on: 'Robot home', off: 'Robot 1 away from home' },
    'R2.home': { kind: 'sensor', on: 'Robot home', off: 'Robot 2 away from home' },
    'R1.clearCnc': { kind: 'sensor', on: 'R1 clear of CNC', off: 'R1 inside the CNC' },
    'R1.clearConv': { kind: 'sensor', on: 'R1 clear of conveyor', off: 'R1 at the conveyor' },
    'R2.clearConv': { kind: 'sensor', on: 'R2 clear of conveyor', off: 'R2 at the conveyor' },
    'R2.clearGauge': { kind: 'sensor', on: 'R2 clear of the laser paths', off: 'R2 in the gauge' },
    // CNC robot interface
    'CNC.ready': { kind: 'sensor', on: 'CNC ready' },
    'CNC.run': { kind: 'sensor', on: 'CNC in cycle', off: 'CNC not in cycle' },
    'CNC.done': { kind: 'sensor', on: 'CNC cycle complete (M30) · spindle stopped' },
    'CNC.empty': { kind: 'sensor', on: 'CNC empty (first cycle)' },
    // door kit and vise
    'ZS-31': { kind: 'sensor', on: '{ZS-31} door open = ON', off: '{ZS-31} = OFF' },
    'ZS-32': { kind: 'sensor', on: '{ZS-32} door closed = ON', off: '{ZS-32} = OFF' },
    'ZS-33': { kind: 'sensor', on: '{ZS-33} locked', off: '{ZS-33} guard lock released' },
    'ZS-34': { kind: 'sensor', on: '{ZS-34} vise open', off: '{ZS-34} = OFF' },
    'ZS-35': { kind: 'sensor', on: '{ZS-35} clamped', off: '{ZS-35} = OFF' },
    'PS-36': { kind: 'sensor', on: '{PS-36} part seated', off: '{PS-36} = OFF (fixture empty)', ask: ['Part in the', 'vise? {PS-36}'] },
    // grippers
    'GR-21': { kind: 'sensor', on: '{GR-21} grip OK', off: '{GR-21} gripper open' },
    'GR-21A': { kind: 'sensor', on: '{GR-21A} grip OK', off: '{GR-21A} gripper A open' },
    'GR-21B': { kind: 'sensor', on: '{GR-21B} part in gripper B', off: '{GR-21B} gripper B empty', ask: ['Finished part', 'in B? {GR-21B}'] },
    'GR-51': { kind: 'sensor', on: '{GR-51} grip OK', off: '{GR-51} gripper open' },
    // conveyor
    'ENC-43': { kind: 'sensor', on: '{ENC-43} belt moving', off: '{ENC-43} zero speed' },
    'PE-42': { kind: 'sensor', on: '{PE-42} ON' },
    'ROI-C': { kind: 'sensor', on: '{CAM-2} sees it', tags: ['CAM-2'] },
    'BELT.free': { kind: 'derived', def: '!ENC-43 & (CONV=C1 | CONV=C5) & !partPlaced', on: 'belt stopped ({ENC-43} = 0), conveyor in C1 or C5 and the last part placed already taken over' },
    // checkpoints (fused result of the last check)
    'CP-1': { kind: 'check', on: '[CP-1] pallet present ({PX-11} + {CAM-1})', off: '[CP-1] no input pallet' },
    'CAM-1.part': { kind: 'check', on: '{CAM-1} part found (pick pose)', off: 'no parts left ({CAM-1})' },
    'CP-2': { kind: 'check', on: '[CP-2] part present ({PE-41} + {CAM-1})', off: '[CP-2] entry clear' },
    'CP-3': { kind: 'check', on: '[CP-3] part at exit ({PE-42} + {CAM-2})', off: '[CP-3] exit clear' },
    'CP-4': { kind: 'check', on: '[CP-4] pallet present ({PX-52} + {CAM-2})', off: '[CP-4] no output pallet' },
    'CP-5': { kind: 'check', on: '[CP-5] part in nest ({PX-64} + {CAM-2})', off: '[CP-5] nest empty' },
    // output pallet
    'PX-52': { kind: 'sensor', on: '{PX-52} ON', off: '{PX-52} OFF (pallet removed)' },
    'CAM-2.slot': { kind: 'sensor', on: '{CAM-2}: slot occupied', tags: ['CAM-2'] },
    'outCount': { kind: 'sensor', num: true, text: 'count', tags: ['CAM-2'] },
    'PALLET.full': { kind: 'derived', def: 'outCount>=slots', on: 'count = 12', off: 'count < 12', ask: ['Output pallet', 'full?'] },
    'PALLET.empty': { kind: 'derived', def: 'outCount=0', on: 'count = 0' },
    // gauge (Setup 2)
    'GAUGE.zeroed': { kind: 'sensor', on: 'gauge verified', tags: ['MST-60'] },
    'GAUGE.valid': { kind: 'sensor', on: '3 valid readings', tags: ['LS-61', 'LS-62', 'LS-63'] },
    'GAUGE.ok': { kind: 'sensor', on: 'OK part', off: 'undersized', ask: ['L, W and H', '≥ 48.00 mm?'], tags: ['LS-61', 'LS-62', 'LS-63'] },
    'PE-65': { kind: 'sensor', on: '{PE-65} part dropped' },
    // PLC variables
    // handshakes: the sender sets them only after its own check confirmed the fact
    'partPlaced': { kind: 'var', on: 'Robot 1 "part placed" ([CP-2] part present)' },
    'pickAllowed': { kind: 'var', on: '"pick allowed" + pick pose ({CAM-2})' },
    'partPicked': { kind: 'var', on: 'Robot 2 "part picked" ([CP-3] exit clear)' },
    'consecNok': { kind: 'var', num: true, max: RULES.consecutiveNokHold, text: 'NOK parts in a row' },
    'QH': { kind: 'var', on: 'quality hold', off: 'no quality hold',
      logOn: 'QUALITY HOLD: 2 NOK parts in a row → the CNC finishes its part and does not start a new cycle until the tool and offsets are checked' },
    'mismatches': { kind: 'var', num: true, max: RULES.mismatchLimit, text: 'mismatches in 10 min',
      phrases: { '>0': 'mismatch at any CP', '>=limit': '3rd mismatch within 10 min', '=0': 'no mismatch for 10 min (window empty)' } },
    'CAM_FAULT': { kind: 'var', on: 'camera fault (after 1 retry)', off: 'cameras OK' },
    // derived
    'lineStop': { kind: 'derived', def: 'SUP=X3 | SUP=X4', on: 'LINE STOP', off: 'no line stop' },
    'FAULT.any': { kind: 'derived', def: 'R1=F | CONV=F | R2=F', on: 'a machine in FAULT' },
    'CELL.stopped': { kind: 'derived', def: 'R1.home & R2.home & !ENC-43', on: 'all stopped' },
    'HOLD.req': { kind: 'derived', def: 'lineStop | CAM_FAULT', on: 'LINE STOP or camera fault' },
    // job running on each robot slot (program number reported by the controller)
    'R1.job': { kind: 'sensor', on: 'job of the Robot 1 machine' },
    'R2.job': { kind: 'sensor', on: 'job of the Robot 2 machine' },
    // physical truth, for the properties only (the PLC cannot read these)
    'TRUE.entryPart': { kind: 'truth', on: 'a part is at the conveyor entry' },
    'TRUE.outPallet': { kind: 'truth', on: 'the output pallet is in place' },
    'TRUE.r2Nok': { kind: 'truth', on: 'Robot 2 holds an undersized part' },
  };
  const CONST = { limit: RULES.mismatchLimit, slots: RULES.palletSlots, nokHold: RULES.consecutiveNokHold };

  // PLC logic outside the state machines: rungs evaluated every scan.
  const RUNGS = [
    { when: 'HMI.release & QH', set: { QH: false, consecNok: 0 }, text: 'tool and offsets checked → quality hold released' },
  ];

  // Properties of the design. The verifier checks them on every reachable state of the abstract
  // model; the simulation monitors the safety ones while it runs.
  //   never: must not hold in a stable state (after the supervisor has reacted)
  //   start + require: must hold whenever one of the jobs starts
  //   eventually (verifier only): from every reachable state this can still be reached
  const PROPERTIES = [
    { id: 'P1', text: 'No robot is at the conveyor while the belt moves', never: '(!R1.clearConv | !R2.clearConv) & ENC-43' },
    { id: 'P2', text: 'CYCLE START only with the door closed and the guard locked', start: ['CNC.start'], require: 'ZS-32 & ZS-33' },
    { id: 'P3', text: 'Robot 1 is inside the CNC only with the door open and the spindle stopped', never: '!R1.clearCnc & (!ZS-31 | CNC.run)' },
    { id: 'P4', text: 'The door is opened only after the cycle, with the guard lock released', start: ['R1.openDoor', 'R1.openDoorFromHome'], require: '!CNC.run & !ZS-33' },
    { id: 'P5', text: 'A part is placed on the conveyor only at a free entry of a stopped belt', start: ['R1.placeConv', 'R1.placeConvB'], require: '!TRUE.entryPart & !ENC-43' },
    { id: 'P6', text: 'Robot 2 places a part only on an output pallet that is in place and not full', start: ['R2.placePallet'], require: 'TRUE.outPallet & outCount<slots' },
    { id: 'P7', text: 'An undersized part never reaches the output pallet', setup: 2, start: ['R2.placePallet'], require: '!TRUE.r2Nok' },
    { id: 'P8', text: 'No CYCLE START during a quality hold', setup: 2, start: ['CNC.start'], require: '!QH' },
    { id: 'P9', text: 'Three mismatches in the window always stop the line', never: 'mismatches>=limit & !lineStop' },
    { id: 'P10', text: 'A camera fault always stops the line', never: 'CAM_FAULT & !lineStop' },
    { id: 'L1', text: 'A new CNC cycle can always be started again', eventually: 'R1.job=CNC.start' },
    { id: 'L2', text: 'Robot 2 can always deliver a part again', eventually: 'R2.job=R2.placePallet' },
    { id: 'L3', text: 'After any stop the supervisor can return to NORMAL', eventually: 'SUP=X1' },
  ];

  // PLC outputs that follow the states (Moore outputs).
  const OUTPUTS = {
    'BELT.motor': { def: 'CONV=C3', text: 'conveyor motor ON' },
    'LT-53': { def: 'R2=D4 | R2=E7', text: 'blue beacon: output pallet ready for pickup' },
    'LT-01.red': { def: 'lineStop | FAULT.any', text: 'stack light red' },
    'LT-01.amber': { def: '!lineStop & !FAULT.any & (mismatches>0 | QH | R1=W1)', text: 'stack light amber' },
    'LT-01.green': { def: '!lineStop & !FAULT.any & !(mismatches>0 | QH | R1=W1)', text: 'stack light green' },
  };

  // Jobs: robot programs or device commands that a step starts and that report "done".
  //   time  components of the planning estimate (keys of T); zone = where the robot is while it runs;
  //   at: 'home' = the job ends at the home position; move = [from, to] part transfer and
  //   set = device state after the job, both used by the abstract plant of the verifier;
  //   canFail: 'grip' = the pick can miss (fault injection, verification with faults).
  const JOBS = {
    'R1.home': { robot: 'R1', time: ['doorToHome'], zone: 'free', at: 'home', text: 'move home' },
    'R1.park': { robot: 'R1', time: ['park'], zone: 'free', at: 'home', text: 'park at home' },
    'R1.openDoorFromHome': { robot: 'R1', time: ['homeToDoor', 'doorOpen'], zone: 'door', set: { door: 'open' }, text: 'open the CNC door' },
    'R1.openDoor': { robot: 'R1', time: ['doorOpen'], zone: 'door', set: { door: 'open' }, text: 'open the CNC door (gripper B)' },
    'R1.closeDoor': { robot: 'R1', time: ['doorClose'], zone: 'door', set: { door: 'closed' }, text: 'close the CNC door' },
    'R1.unload': { robot: 'R1', time: ['enterCnc', 'grip', 'viseOpen', 'lift', 'exitCnc'], zone: 'cnc', move: ['cnc', 'r1S'], set: { vise: 'open' }, text: 'unload the CNC' },
    'R1.toConveyor': { robot: 'R1', time: ['doorToConv'], zone: 'free', text: 'move above the conveyor entry' },
    'R1.placeConv': { robot: 'R1', time: ['placeConv'], zone: 'conv', move: ['r1S', 'entry'], text: 'place on the conveyor' },
    'R1.pickRaw': { robot: 'R1', time: ['convToPallet', 'pickPallet'], zone: 'pallet', move: ['in', 'r1S'], canFail: 'grip', text: 'pick a raw part' },
    'R1.load': { robot: 'R1', time: ['palletToDoor', 'enterCnc', 'placeInVise', 'viseClamp', 'seatCheck', 'release', 'exitCnc'], zone: 'cnc', move: ['r1S', 'cnc'], set: { vise: 'clamped' }, text: 'load the CNC' },
    'R1.pickRawA': { robot: 'R1', time: ['convToPallet', 'pickPallet'], zone: 'pallet', move: ['in', 'r1A'], canFail: 'grip', labels: { pickPallet: 'Gripper A picks raw part' }, text: 'pick a raw part with gripper A' },
    'R1.toDoorReady': { robot: 'R1', time: ['palletToDoor'], zone: 'free', text: 'move to the CNC door' },
    'R1.enterCnc': { robot: 'R1', time: ['enterCnc'], zone: 'cnc', text: 'enter the CNC' },
    'R1.unloadB': { robot: 'R1', time: ['grip', 'viseOpen', 'lift'], zone: 'cnc', move: ['cnc', 'r1B'], set: { vise: 'open' }, labels: { grip: 'Gripper B grips part' }, text: 'unload with gripper B' },
    'R1.loadA': { robot: 'R1', time: ['swapGripper', 'placeInVise', 'viseClamp', 'seatCheck', 'release', 'exitCnc'], zone: 'cnc', move: ['r1A', 'cnc'], set: { vise: 'clamped' }, labels: { placeInVise: 'Gripper A places part' }, text: 'turn the wrist and load with gripper A' },
    'R1.toConveyorB': { robot: 'R1', time: ['doorToConv'], zone: 'free', text: 'move above the conveyor entry' },
    'R1.placeConvB': { robot: 'R1', time: ['placeConv'], zone: 'conv', move: ['r1B', 'entry'], text: 'place the finished part on the conveyor' },
    'DOOR.lock': { robot: null, time: ['lock'], set: { lock: true }, text: 'engage the guard lock' },
    'CNC.start': { robot: null, time: ['cycleStart'], set: { cnc: 'run' }, text: 'send cycle start' },
    'R2.home': { robot: 'R2', time: ['r2Home'], zone: 'free', at: 'home', text: 'move home' },
    'R2.park': { robot: 'R2', time: ['park'], zone: 'free', at: 'home', text: 'park at home' },
    'R2.pickConv': { robot: 'R2', time: ['r2ToExit', 'r2Pick'], zone: 'conv', move: ['exit', 'r2S'], text: 'pick from the conveyor' },
    'R2.placePallet': { robot: 'R2', time: ['r2ToPallet', 'r2Place'], zone: 'pallet', move: ['r2S', 'out'], text: 'place on the output pallet' },
    'R2.loadGauge': { robot: 'R2', time: ['r2ToGauge', 'r2LoadGauge'], zone: 'gauge', move: ['r2S', 'nest'], text: 'load the gauge nest' },
    'R2.repick': { robot: 'R2', time: ['r2Repick'], zone: 'gauge', move: ['nest', 'r2S'], text: 're-pick from the nest' },
    'R2.dropNok': { robot: 'R2', time: ['r2ToNok', 'r2Drop'], zone: 'nok', move: ['r2S', 'nok'], text: 'drop into the NOK chute' },
    'GAUGE.measure': { robot: null, time: ['measure'], set: { measured: true }, tags: ['LS-61', 'LS-62', 'LS-63'], text: 'measure L, W, H' },
    'GAUGE.master': { robot: null, time: [], set: { zeroed: true }, tags: ['MST-60', 'LS-61', 'LS-62', 'LS-63'], text: 'master cube check' },
  };

  // Machine format
  //   initial: { to, when, do?, text? }   first transition (from the black dot)
  //   states[id]: name, desc (lines in the box), kind (color), band (run | idle | stop | move),
  //     wait: true = waiting state without confirmation timeout; hold: false = a LINE STOP does not
  //     interrupt the waiting (a running transport finishes);
  //     do: steps run in order on entry:
  //       { job, when?, confirm? }   start a job and wait for "done"; skipped when `when` is false;
  //                                  `confirm` must hold afterwards, otherwise FAULT
  //       { check: 'CP-n', quick?, confirm?, until? }  camera + proximity cross-check (quick = no settling
  //                                  time); : repeat the check every T.check until it holds
  //       { await: expr }            wait until expr holds
  //       { set: { var: value }, when? } · { inc: var }   write PLC variables
  //     next: transitions, evaluated in order after the steps:
  //       { to, when, text? (label prefix), for? (T key: guard must hold this long), hold?: false,
  //         do?: [{ set, text }] (actions, shown after "→") }
  //     faults: [{ after, when?, text }]  timed faults while waiting in the state
  //     choice states: { choice: signal, yes, no, yesText?, noText? }
  //   hold / fault: the global H and F states (desc, steps, exit). H is entered when HOLD.req holds:
  //   at a transition (then the pending state follows), while waiting (then the state is entered
  //   again), or at once after a camera fault (then the same check is repeated). F is entered when a
  //   confirmation is missing or a timer expires; after `exit` (the operator clears it) the state
  //   is repeated.
  //   view: diagram layout only (main column order, side states next to an anchor, or a grid).
  const HOLD_NOTE = [
    '*F FAULT* and *H HOLD* can be entered from any state. FAULT = a confirmation is missing or a timeout',
    'expired (the alarm names the sensor, no automatic robot retries). HOLD = LINE STOP from the cross-check',
    'supervisor: the robot finishes the running step, parks, and continues from there after the reset.',
  ];
  const ROBOT_FH = (r) => ({
    hold: { desc: ['LINE STOP: finish the step,', 'park, wait for the reset'], do: [{ job: r + '.park' }], exit: '!HOLD.req' },
    fault: { desc: ['From any state: timeout or a', 'missing confirmation · red light'], exit: 'HMI.clear' },
  });
  const W1 = (back) => ({
    name: 'WAIT FOR INPUT PALLET', kind: 'op', wait: true,
    desc: ['HMI: "Load input pallet"', 'amber light · robot waits'],
    log: 'Input pallet empty → HMI: "Load input pallet" · amber light',
    hmi: { cls: 'op', title: 'Input pallet empty', text: 'CAM-1 finds no raw parts. Robot 1 waits at home; load a new pallet.', act: 'load' },
    do: [{ job: 'R1.park', when: '!R1.home' }],
    next: [{ to: back, when: 'HMI.loaded' }],
  });
  const FULL = (back) => ({
    name: 'WAIT FOR PALLET SWAP', kind: 'op', wait: true,
    desc: ['{LT-53} blue light ON · wait until', 'the full pallet is gone, then', 'check the new one ([CP-4])'],
    log: 'Output pallet full → LT-53 blue light ON · HMI: "Pallet ready for pickup"',
    hmi: { cls: 'op', title: 'Output pallet full · ready for pickup', text: 'LT-53 blue light ON. Robot 2 waits until the full pallet is taken away and CP-4 confirms a new empty pallet.', act: 'swap' },
    do: [{ job: 'R2.home', when: '!R2.home' }, { await: 'PALLET.empty' }, { check: 'CP-4', until: 'CP-4' }],
    next: [{ to: back, when: 'CP-4 & PALLET.empty', text: 'pallet swapped:' }],
  });
  const PICK_CONV = {
    name: 'PICK FROM CONVEYOR', short: 'pick',
    desc: ['Move to the {CAM-2} pick pose · grip ·', 'lift · retract · [CP-3] exit clear'],
    do: [{ job: 'R2.pickConv' }, { check: 'CP-3', quick: true }, { set: { partPicked: true, pickAllowed: false }, when: 'GR-51 & !CP-3' }],
  };

  const MACHINES = {
    R1S1: {
      slot: 'R1', setup: 1,
      title: 'State diagram: Robot 1 + CNC (Setup 1, single gripper)',
      sub: 'Arrow label = the confirmation that allows the transition · {TAG} sensor · [CP-n] camera + proximity cross-check',
      initial: { to: 'A0', when: 'HMI.auto' },
      ...ROBOT_FH('R1'), note: HOLD_NOTE,
      view: { main: ['A0', 'A1', 'A2', 'Q_A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'], side: { W1: 'A5' } },
      states: {
        A0: { name: 'START-UP CHECKS', desc: ['Home robot · check CNC ready and', 'door closed ({ZS-32})'],
          do: [{ job: 'R1.home', when: '!R1.home' }],
          next: [{ to: 'A1', when: 'R1.home & CNC.ready & ZS-32' }] },
        A1: { name: 'WAIT FOR CNC', band: 'run', wait: true,
          desc: ['Move home, clear of CNC and conveyor ·', 'CNC machining the part (120 s)'],
          do: [{ job: 'R1.home', when: '!R1.home' }],
          next: [{ to: 'A2', when: '(CNC.done & !ZS-33) | CNC.empty' }] },
        A2: { name: 'OPEN CNC DOOR', band: 'idle', short: 'door',
          desc: ['Empty gripper grips the door handle, slides', 'the door open, releases it, retracts'],
          do: [{ job: 'R1.openDoorFromHome' }],
          next: [{ to: 'Q_A2', when: 'ZS-31 & !ZS-32' }] },
        Q_A2: { choice: 'PS-36', yes: 'A3', no: 'A5', yesText: 'finished part', noText: 'CNC empty (first cycle)' },
        A3: { name: 'UNLOAD CNC', band: 'idle', short: 'unload',
          desc: ['Enter · grip finished part · open vise ·', 'lift the part out · exit the machine'],
          do: [{ job: 'R1.unload' }],
          next: [{ to: 'A4', when: 'GR-21 & ZS-34 & !PS-36 & R1.clearCnc' }] },
        A4: { name: 'PLACE ON CONVEYOR', band: 'idle', short: 'to belt',
          desc: ['Wait for belt stopped ({ENC-43} = 0) and', 'entry clear ([CP-2]) · place · release'],
          do: [{ job: 'R1.toConveyor' }, { await: 'BELT.free' }, { check: 'CP-2', quick: true, confirm: '!CP-2' },
            { job: 'R1.placeConv' }, { check: 'CP-2' }, { set: { partPlaced: true }, when: 'CP-2' }],
          next: [{ to: 'A5', when: 'CP-2 & R1.clearConv' }] },
        A5: { name: 'PICK RAW PART', band: 'idle', short: 'pick',
          desc: ['[CP-1] pallet present ({PX-11} + {CAM-1}) ·', '{CAM-1} gives the pick pose · pick'],
          do: [{ check: 'CP-1' }, { job: 'R1.pickRaw', when: 'CP-1 & CAM-1.part' }],
          next: [{ to: 'A6', when: 'GR-21' }, { to: 'W1', when: '!CP-1 | !CAM-1.part' }] },
        A6: { name: 'LOAD CNC', band: 'idle', short: 'load',
          desc: ['Enter · place part in the vise · clamp ·', 'open gripper · exit the machine'],
          do: [{ job: 'R1.load' }],
          next: [{ to: 'A7', when: 'ZS-35 & PS-36 & !GR-21 & R1.clearCnc' }] },
        A7: { name: 'CLOSE CNC DOOR', band: 'idle', short: 'door',
          desc: ['Empty gripper slides the door closed,', 'releases the handle · guard lock engages'],
          do: [{ job: 'R1.closeDoor' }, { job: 'DOOR.lock' }],
          next: [{ to: 'A8', when: 'ZS-32 & ZS-33' }] },
        A8: { name: 'START CYCLE', band: 'idle', short: 'start',
          desc: ['Send CYCLE START through the CNC', 'robot interface'],
          do: [{ job: 'CNC.start' }],
          next: [{ to: 'A1', when: 'CNC.run | CNC.done' }] },
        W1: W1('A5'),
      },
    },

    R1S2: {
      slot: 'R1', setup: 2,
      title: 'State diagram: Robot 1 + CNC (Setup 2, dual gripper A / B)',
      sub: 'Gripper A carries the raw part, gripper B the finished part. The raw part is picked while the CNC is still machining.',
      initial: { to: 'B0', when: 'HMI.auto' },
      ...ROBOT_FH('R1'), note: HOLD_NOTE,
      view: { main: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'Q_B6', 'B7'], side: { W1: 'B1' } },
      states: {
        B0: { name: 'START-UP CHECKS', desc: ['Home robot · check CNC ready and', 'door closed ({ZS-32})'],
          do: [{ job: 'R1.home', when: '!R1.home' }],
          next: [{ to: 'B1', when: 'R1.home & CNC.ready & ZS-32' }] },
        B1: { name: 'PICK RAW PART (A)', band: 'run', short: 'pick A',
          desc: ['[CP-1] pallet present ({PX-11} + {CAM-1}) ·', '{CAM-1} pick pose · gripper A picks'],
          do: [{ check: 'CP-1' }, { job: 'R1.pickRawA', when: 'CP-1 & CAM-1.part' }],
          next: [{ to: 'B2', when: 'GR-21A' }, { to: 'W1', when: '!CP-1 | !CAM-1.part' }] },
        B2: { name: 'WAIT AT CNC DOOR', band: 'run', wait: true, short: '',
          desc: ['Raw part in gripper A, gripper B empty ·', 'wait at the door while the CNC finishes'],
          do: [{ job: 'R1.toDoorReady' }],
          next: [{ to: 'B3', when: '(CNC.done & !ZS-33) | CNC.empty' }] },
        B3: { name: 'OPEN DOOR (B)', band: 'idle', short: 'door',
          desc: ['Empty gripper B grips the handle, slides', 'the door open, releases it'],
          do: [{ job: 'R1.openDoor' }],
          next: [{ to: 'B4', when: 'ZS-31 & !ZS-32' }] },
        B4: { name: 'EXCHANGE PARTS', band: 'idle', short: 'exchange B / A',
          desc: ['B takes the finished part out of the vise ·', 'wrist turns 180° · A places the raw part'],
          do: [{ job: 'R1.enterCnc' }, { job: 'R1.unloadB', when: 'PS-36', confirm: 'GR-21B & ZS-34 & !PS-36' }, { job: 'R1.loadA' }],
          next: [{ to: 'B5', when: 'ZS-35 & PS-36 & !GR-21A & R1.clearCnc' }] },
        B5: { name: 'CLOSE DOOR (A)', band: 'idle', short: 'door',
          desc: ['Empty gripper A slides the door closed,', 'releases the handle · guard lock engages'],
          do: [{ job: 'R1.closeDoor' }, { job: 'DOOR.lock' }],
          next: [{ to: 'B6', when: 'ZS-32 & ZS-33' }] },
        B6: { name: 'START CYCLE', band: 'idle', short: 'start',
          desc: ['Send CYCLE START (not during a quality', 'hold) · CNC idle time ends'],
          do: [{ await: '!QH' }, { job: 'CNC.start' }],
          next: [{ to: 'Q_B6', when: 'CNC.run | CNC.done' }] },
        Q_B6: { choice: 'GR-21B', yes: 'B7', no: 'B1', yesText: 'finished part in B', noText: 'first cycle, B is empty' },
        B7: { name: 'PLACE ON CONVEYOR (B)', band: 'run', short: 'to belt',
          desc: ['Wait for {ENC-43} = 0 and [CP-2] entry clear', '· place the finished part · release'],
          do: [{ job: 'R1.toConveyorB' }, { await: 'BELT.free' }, { check: 'CP-2', quick: true, confirm: '!CP-2' },
            { job: 'R1.placeConvB' }, { check: 'CP-2' }, { set: { partPlaced: true }, when: 'CP-2' }],
          next: [{ to: 'B1', when: 'CP-2 & R1.clearConv' }] },
        W1: W1('B1'),
      },
    },

    CONV: {
      slot: 'CONV', setup: 0,
      title: 'State diagram: Conveyor',
      sub: 'Robots pick or place at the belt only when it is stopped ({ENC-43} = 0); the belt starts only when both robots are clear.',
      initial: { to: 'C1', do: [{ check: 'CP-2', quick: true }, { check: 'CP-3', quick: true }], when: '!CP-2 & !CP-3', text: 'Start-up:' },
      hold: { desc: ['A running transport finishes at', 'the stop; no new transport starts'], exit: '!HOLD.req' },
      fault: { desc: ['Missing confirmation or a', 'transport timer expired (belt /', 'drive fault, jam, lost part)'], exit: 'HMI.clear' },
      note: [
        '*Stop logic:* stopping uses *OR* ({PE-42} or {CAM-2}) because stopping is the safe direction;',
        'confirming the part for the pick uses the cross-check [CP-3] (both must agree, otherwise the camera decides).',
      ],
      view: { main: ['C1', 'C2', 'C3', 'C4', 'C5'] },
      states: {
        C1: { name: 'EMPTY - STOPPED', band: 'stop', wait: true, hold: false,
          desc: ['Belt stopped ({ENC-43} = 0)', 'Robot 1 may place a part at the entry'],
          do: [{ set: { partPicked: false, pickAllowed: false } }],
          next: [{ to: 'C2', when: 'partPlaced' }] },
        C2: { name: 'PART AT ENTRY', band: 'stop',
          desc: ['Belt still stopped · wait for the', 'transport permissives'],
          do: [{ set: { partPlaced: false } }, { await: 'R1.clearConv & R2.clearConv' }, { check: 'CP-3', quick: true, confirm: '!CP-3' }],
          next: [{ to: 'C3', when: 'R1.clearConv & R2.clearConv & !CP-3' }] },
        C3: { name: 'TRANSPORTING', band: 'move', wait: true, hold: false, short: 'transport', time: ['beltStart', 'beltTravel'],
          desc: ['Motor ON · {ENC-43} must count pulses', 'within 1 s · exit reached within 15 s'],
          faults: [{ after: 1, when: '!ENC-43', text: 'no {ENC-43} pulses within 1 s' }, { after: 15, text: 'no {PE-42} within 15 s' }],
          next: [{ to: 'C4', when: 'PE-42 | ROI-C', text: 'Part at the end stop:', hold: false }] },
        C4: { name: 'STOPPING', band: 'move', time: ['beltStop'],
          desc: ['Motor OFF · wait for zero speed'],
          next: [{ to: 'C5', when: '!ENC-43', for: 'zeroSpeed', hold: false }] },
        C5: { name: 'PART AT EXIT - READY TO PICK', band: 'stop', wait: true, hold: false,
          desc: ['[CP-3] part at exit ({PE-42} + {CAM-2}) ·', '{CAM-2} pick pose · "pick allowed" to R2'],
          do: [{ set: { pickAllowed: false } }, { check: 'CP-3', confirm: 'CP-3' }, { set: { pickAllowed: true } }],
          next: [{ to: 'C1', when: 'partPicked & R2.clearConv' }] },
      },
    },

    R2S1: {
      slot: 'R2', setup: 1,
      title: 'State diagram: Robot 2 + output pallet (Setup 1)',
      sub: 'The blue light {LT-53} is the "pallet ready for pickup" signal required by the assignment.',
      initial: { to: 'D0', when: 'HMI.auto' },
      ...ROBOT_FH('R2'), note: HOLD_NOTE,
      view: { main: ['D0', 'D1', 'D2', 'D3', 'Q_D3'], side: { D4: 'Q_D3' } },
      states: {
        D0: { name: 'START-UP CHECKS', desc: ['Home · [CP-4] pallet present ({PX-52} + {CAM-2})', '{CAM-2} reads the slot map, sets the count'],
          do: [{ job: 'R2.home', when: '!R2.home' }, { check: 'CP-4' }],
          next: [{ to: 'D1', when: 'R2.home & CP-4 & !PALLET.full' }] },
        D1: { name: 'WAIT FOR PART', wait: true, desc: ['Move home, clear of the conveyor'],
          do: [{ job: 'R2.home', when: '!R2.home' }],
          next: [{ to: 'D2', when: 'CONV=C5 & pickAllowed & !ENC-43' }] },
        D2: Object.assign({}, PICK_CONV, { next: [{ to: 'D3', when: 'GR-51 & !CP-3 & R2.clearConv' }] }),
        D3: { name: 'PLACE ON OUTPUT PALLET', desc: ['[CP-4] pallet present ({PX-52} + {CAM-2}) ·', '{CAM-2} next free slot · place · release'],
          do: [{ check: 'CP-4', confirm: 'CP-4' }, { job: 'R2.placePallet' }],
          next: [{ to: 'Q_D3', when: 'CAM-2.slot & !GR-51' }] },
        Q_D3: { choice: 'PALLET.full', yes: 'D4', no: 'D1' },
        D4: FULL('D1'),
      },
    },

    R2S2: {
      slot: 'R2', setup: 2,
      title: 'State diagram: Robot 2 + gauge + sorting (Setup 2)',
      sub: 'Every part is measured. Accept only if length, width and height are all ≥ 48.00 mm (50 mm nominal − 2 mm).',
      initial: { to: 'E0', when: 'HMI.auto' },
      ...ROBOT_FH('R2'),
      note: [
        '*Quality hold:* 2 consecutive NOK parts → the CNC finishes the current part and starts no new cycle until the tool',
        'and offsets are checked and the operator releases the hold. *One point per face is enough:* squareness and',
        'flatness < 0.1 mm. *F FAULT* and *H HOLD* are entered from any state (see the Robot 1 diagram).',
      ],
      view: { main: ['E0', 'E1', 'E2', 'E3', 'E4', 'Q_E4', 'E5', 'Q_E5'], side: { E6: 'Q_E4', E7: 'Q_E5' } },
      states: {
        E0: { name: 'START-UP CHECKS', desc: ['Home · [CP-4] pallet · [CP-5] nest empty ·', 'master cube check of the 3 lasers'],
          do: [{ job: 'R2.home', when: '!R2.home' }, { check: 'CP-4' }, { check: 'CP-5', quick: true }, { job: 'GAUGE.master' }],
          next: [{ to: 'E1', when: 'R2.home & CP-4 & !CP-5 & GAUGE.zeroed' }] },
        E1: { name: 'WAIT FOR PART', wait: true, desc: ['Move home, clear of the conveyor'],
          do: [{ job: 'R2.home', when: '!R2.home' }],
          next: [{ to: 'E2', when: 'CONV=C5 & pickAllowed & !ENC-43' }] },
        E2: Object.assign({}, PICK_CONV, { next: [{ to: 'E3', when: 'GR-51 & !CP-3 & R2.clearConv' }] }),
        E3: { name: 'LOAD GAUGE', short: 'gauge',
          desc: ['Place in the corner nest · push against the', '3 datums (force control) · release · retract'],
          do: [{ job: 'R2.loadGauge' }, { check: 'CP-5' }],
          next: [{ to: 'E4', when: 'CP-5 & R2.clearGauge' }] },
        E4: { name: 'MEASURE L, W, H', short: 'measure',
          desc: ['{LS-61}/{LS-62}/{LS-63}: average of 10 samples', 'size = 50.000 + (d master − d part)'],
          do: [{ job: 'GAUGE.measure' }],
          next: [{ to: 'Q_E4', when: 'GAUGE.valid' }] },
        Q_E4: { choice: 'GAUGE.ok', yes: 'E5', no: 'E6' },
        E5: { name: 'PLACE OK PART ON PALLET', kind: 'ok', short: 'sort',
          desc: ['Re-pick from nest · [CP-4] pallet present ·', '{CAM-2} next free slot · place · release'],
          do: [{ set: { consecNok: 0 } }, { job: 'R2.repick' }, { check: 'CP-4', confirm: 'CP-4' }, { job: 'R2.placePallet' }],
          next: [{ to: 'Q_E5', when: 'CAM-2.slot & !GR-51' }] },
        Q_E5: { choice: 'PALLET.full', yes: 'E7', no: 'E1' },
        E6: { name: 'PLACE IN NOK CHUTE', kind: 'stop',
          desc: ['Re-pick · drop into the locked chute', '{PE-65} confirms · NOK count + 1 ·', '2 NOK in a row → quality hold'],
          do: [{ job: 'R2.repick' }, { job: 'R2.dropNok' }, { inc: 'consecNok' }, { set: { QH: true }, when: 'consecNok>=nokHold' }],
          next: [{ to: 'E1', when: 'PE-65' }] },
        E7: FULL('E1'),
      },
    },

    SUP: {
      slot: 'SUP', setup: 0, urgent: true,      // reacts in the same scan as the check that caused it
      title: 'State diagram: cross-check supervisor (camera vs proximity)',
      sub: 'Runs in parallel with the other state machines and counts disagreements in a 10-minute sliding window.',
      initial: { to: 'X1' },
      note: ['*The camera never overrides safety:*', 'door interlock, E-stops and scanners', 'stay hardwired to the safety relay.'],
      view: { grid: { X1: [0, 0], X2: [1, 0], X3: [1, 1], X4: [0, 1] } },
      states: {
        X1: { name: 'NORMAL', kind: 'ok', wait: true, desc: ['All checkpoints agree', 'stack light {LT-01} green'],
          next: [{ to: 'X3', when: 'CAM_FAULT' }, { to: 'X2', when: 'mismatches>0' }] },
        X2: { name: 'MISMATCH WARNING', kind: 'warn', wait: true, desc: ['1–2 mismatches in the last 10 min', 'camera value used · amber flashing'],
          next: [{ to: 'X3', when: 'mismatches>=limit | CAM_FAULT' }, { to: 'X1', when: 'mismatches=0' }] },
        X3: { name: 'LINE STOP', kind: 'stop', wait: true, desc: ['Controlled stop: robots finish the step', 'and park, belt stops · red light'],
          log: 'LINE STOP: controlled stop · the CNC finishes its part, the robots finish the step and park, no new transport',
          hmi: { cls: 'bad', title: 'Line stopped · sensor verification required', act: 'verify' },
          next: [{ to: 'X4', when: 'CELL.stopped & HMI.verify' }] },
        X4: { name: 'SENSOR VERIFICATION', kind: 'check', wait: true, desc: ['Technician cleans and aligns sensors,', 'tests each CP, checks camera calibration'],
          hmi: { cls: 'bad', title: 'Sensor verification in progress', act: 'reset', proc: 'verify' },
          next: [{ to: 'X1', when: 'VERIFY.pass & HMI.reset', do: [{ set: { mismatches: 0, CAM_FAULT: false }, text: 'counter cleared' }] },
            { to: 'X4', when: 'VERIFY.fail', do: [{ text: 'repair or replace the sensor, re-test' }] }] },
      },
    },
  };
  const SETUP_MACHINES = { 1: ['R1S1', 'CONV', 'R2S1', 'SUP'], 2: ['R1S2', 'CONV', 'R2S2', 'SUP'] };
  const IDLE_MACHINE = { 1: 'R1S1', 2: 'R1S2' };

  // ================================================================ guard expressions
  // or := and ('|' and)* ; and := unary ('&' unary)* ; unary := '!' unary | '(' or ')' | name [rel value]
  // rel := = | != | < | <= | > | >= ; names may contain letters, digits, '.', '_' and '-'.
  const PARSED = new Map();
  function parse(src) {
    if (PARSED.has(src)) return PARSED.get(src);
    const toks = (src.match(/!=|<=|>=|[!&|()=<>]|[A-Za-z0-9_.-]+|\S/g) || []);
    let i = 0;
    const fail = (m) => { throw new Error(`guard "${src}": ${m}`); };
    const peek = () => toks[i];
    const take = (t) => { if (t && toks[i] !== t) fail(`expected ${t} at token ${i}`); return toks[i++]; };
    const or = () => { const a = [and()]; while (peek() === '|') { take(); a.push(and()); } return a.length > 1 ? { op: 'or', args: a } : a[0]; };
    const and = () => { const a = [unary()]; while (peek() === '&') { take(); a.push(unary()); } return a.length > 1 ? { op: 'and', args: a } : a[0]; };
    const unary = () => {
      const t = take();
      if (t === undefined) fail('unexpected end');
      if (t === '!') return { op: 'not', arg: unary() };
      if (t === '(') { const e = or(); take(')'); return e; }
      if (!/^[A-Za-z0-9_.-]+$/.test(t)) fail(`unexpected "${t}"`);
      if (['=', '!=', '<', '<=', '>', '>='].includes(peek())) { const rel = take(); const v = take(); return { op: 'cmp', name: t, rel, value: v }; }
      return { op: 'sig', name: t };
    };
    const e = or();
    if (i !== toks.length) fail(`unexpected "${toks[i]}"`);
    PARSED.set(src, e);
    return e;
  }
  const constVal = (v) => (v in CONST ? CONST[v] : /^-?\d+(\.\d+)?$/.test(v) ? +v : v);
  // Evaluate with read(name) -> value; slots (R1, CONV, ...) read as their current state id.
  function evaluate(e, read) {
    if (typeof e === 'string') e = parse(e);
    switch (e.op) {
      case 'and': return e.args.every((a) => evaluate(a, read));
      case 'or': return e.args.some((a) => evaluate(a, read));
      case 'not': return !evaluate(e.arg, read);
      case 'sig': {
        const s = SIGNALS[e.name];
        if (s && s.def) return evaluate(s.def, read);
        return !!read(e.name);
      }
      case 'cmp': {
        const a = SIGNALS[e.name] && SIGNALS[e.name].def ? evaluate(SIGNALS[e.name].def, read) : read(e.name);
        const b = constVal(e.value);
        switch (e.rel) {
          case '=': return a === b; case '!=': return a !== b;
          case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
        }
      }
    }
    throw new Error('bad expression node ' + JSON.stringify(e));
  }
  // Names an expression reads (derived signals expanded when deep = true).
  function names(e, deep, out) {
    out = out || new Set();
    if (typeof e === 'string') e = parse(e);
    if (e.op === 'and' || e.op === 'or') e.args.forEach((a) => names(a, deep, out));
    else if (e.op === 'not') names(e.arg, deep, out);
    else {
      out.add(e.name);
      const s = SIGNALS[e.name];
      if (deep && s && s.def) names(s.def, deep, out);
    }
    return out;
  }
  // Text of one literal for the diagrams.
  function phrase(e, neg) {
    if (e.op === 'not') return phrase(e.arg, !neg);
    if (e.op === 'sig') {
      const s = SIGNALS[e.name];
      if (!s) return (neg ? 'NOT ' : '') + e.name;
      return neg ? (s.off || 'not ' + s.on) : s.on;
    }
    if (e.op === 'cmp') {
      const rel = neg ? { '=': '!=', '!=': '=', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[e.rel] : e.rel;
      if (SLOTS[e.name]) return `${SLOTS[e.name].ref} ${rel === '=' ? 'in' : 'not in'} ${e.value}`;
      const s = SIGNALS[e.name] || {};
      const key = rel + e.value;
      if (s.phrases && s.phrases[key]) return s.phrases[key];
      const sym = { '=': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥' }[rel];
      return `${s.text || e.name} ${sym} ${constVal(e.value)}`;
    }
    const parts = e.args.map((a) => phrase(a, neg));
    return parts.join((e.op === 'and') !== !!neg ? ' · ' : ' or ');
  }
  // Guard as alternatives of conjunct phrases: [[a, b], [c]] reads "a · b, or c".
  function terms(e) {
    if (typeof e === 'string') e = parse(e);
    const conj = (x) => (x.op === 'and' ? x.args.map((a) => phrase(a)) : [phrase(x)]);
    return e.op === 'or' ? e.args.map(conj) : [conj(e)];
  }
  // Wrap a guard (plus optional prefix and "→ action" texts) into label lines of at most `width`
  // visible characters; breaks fall on the " · " separators, inside a long item between words.
  const visible = (s) => s.replace(/[{}[\]*]/g, '').length;
  function wrapItems(items, width, first) {
    const lines = [];
    let cur = first || '';
    const sep = () => (!cur ? '' : cur === 'or' || cur.endsWith(':') || cur.endsWith('→') ? ' ' : ' · ');
    const add = (piece, s) => {
      const cand = cur ? cur + s + piece : piece;
      const keep = cur === 'or' || cur === '→' || (cur.endsWith(':') && visible(cur) < 14);
      if (cur && visible(cand) > width && !keep) { lines.push(cur); cur = piece; } else cur = cand;
    };
    items.forEach((it) => {
      if (visible(it) <= width) { add(it, sep()); return; }
      it.split(' ').forEach((w, k) => add(w, k ? ' ' : sep()));
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function label(tr, width) {
    width = width || 50;
    let lines = [];
    if (tr.when) terms(tr.when).forEach((items, k) => { lines = lines.concat(wrapItems(items, width, k ? 'or' : tr.text || '')); });
    else if (tr.text) lines = wrapItems([tr.text], width);
    const acts = (tr.do || []).map((a) => a.text).filter(Boolean);
    if (acts.length) {
      const tail = wrapItems(acts, width, '→');
      if (lines.length && visible(lines[lines.length - 1] + ' ' + tail[0]) <= width) {
        lines[lines.length - 1] += ' ' + tail[0];
        lines = lines.concat(tail.slice(1));
      } else lines = lines.concat(tail);
    }
    return lines.filter((l) => l.length);
  }
  const plain = (s) => s.replace(/[{}[\]*]/g, '');

  // ================================================================ derived data
  const STATES = {};
  Object.keys(MACHINES).forEach((k) => {
    const m = MACHINES[k], o = {};
    Object.keys(m.states).forEach((id) => { if (!m.states[id].choice) o[id] = m.states[id].name; });
    if (m.hold) o.H = 'HOLD (LINE STOP)';
    if (m.fault) o.F = 'FAULT';
    STATES[k] = o;
  });
  STATES.XCHK = STATES.SUP;
  const r1 = (x) => Math.round(x * 10) / 10;
  const jobTime = (j) => JOBS[j].time.reduce((s, k) => s + T[k], 0);
  // Nominal step times of a state: every step runs, checks take T.check unless quick.
  function stateSteps(mk, id) {
    const s = MACHINES[mk].states[id], rows = [];
    (s.do || []).forEach((st) => {
      if (st.job) JOBS[st.job].time.forEach((k) => rows.push([(JOBS[st.job].labels || {})[k] || TLABEL[k] || k, T[k]]));
      else if (st.check && !st.quick) rows.push([`Check ${st.check}`, T.check]);
    });
    (s.time || []).forEach((k) => rows.push([TLABEL[k] || k, T[k]]));
    (s.next || []).forEach((tr) => { if (tr.for) rows.push([TLABEL[tr.for] || tr.for, T[tr.for]]); });
    return rows;
  }
  const stateTime = (mk, id) => r1(stateSteps(mk, id).reduce((a, x) => a + x[1], 0));
  // CNC idle per cycle = from "cycle complete" to the next "cycle start": the door unlock of the
  // CNC plus every state of the Robot 1 machine in the idle band.
  function idleList(setup) {
    const mk = IDLE_MACHINE[setup], m = MACHINES[mk];
    let rows = [[TLABEL.unlock, T.unlock]];
    m.view.main.forEach((id) => { if (m.states[id].band === 'idle') rows = rows.concat(stateSteps(mk, id)); });
    return rows;
  }
  const idleSetup1 = idleList(1), idleSetup2 = idleList(2);
  const sum = (a) => r1(a.reduce((s, x) => s + x[1], 0));
  const KPI = (() => {
    const i1 = sum(idleSetup1), i2 = sum(idleSetup2);
    const c1 = T.cncCycle + i1, c2 = T.cncCycle + i2;
    return {
      idle1: i1, idle2: i2, cycle1: c1, cycle2: c2,
      util1: T.cncCycle / c1, util2: T.cncCycle / c2,
      pph1: 3600 / c1, pph2: 3600 / c2,
    };
  })();

  // ================================================================ consistency checks
  // Returns a list of problems; empty = the model is consistent.
  function lint() {
    const errs = [];
    const allStates = {};
    Object.keys(SLOTS).forEach((s) => { allStates[s] = new Set(['H', 'F']); });
    Object.values(MACHINES).forEach((m) => Object.keys(m.states).forEach((id) => allStates[m.slot].add(id)));
    const sensorTags = new Set();
    SENSORS.forEach((s) => s.tag.split(' / ').forEach((t, i, a) => sensorTags.add(i && /^\d+$/.test(t) ? a[0].replace(/\d+$/, t) : t)));
    ['ZS-34', 'ZS-35', 'GR-21A', 'GR-21B', 'SC-01', 'SC-02', 'LS-61', 'LS-62', 'LS-63'].forEach((t) => sensorTags.add(t));
    const checkName = (n, where, val) => {
      if (SLOTS[n]) { if (val !== undefined && !allStates[n].has(val)) errs.push(`${where}: ${n} has no state ${val}`); return; }
      if (!SIGNALS[n]) errs.push(`${where}: unknown signal ${n}`);
      if (val !== undefined && n.endsWith('.job')) { if (!JOBS[val]) errs.push(`${where}: unknown job ${val}`); return; }
      if (val !== undefined && !(val in CONST) && !/^-?\d+$/.test(val)) errs.push(`${where}: unknown constant ${val}`);
    };
    const checkExpr = (src, where) => {
      let e; try { e = parse(src); } catch (x) { errs.push(`${where}: ${x.message}`); return; }
      const walk = (x) => { if (x.op === 'and' || x.op === 'or') x.args.forEach(walk); else if (x.op === 'not') walk(x.arg); else checkName(x.name, where, x.op === 'cmp' ? x.value : undefined); };
      walk(e);
    };
    Object.keys(SIGNALS).forEach((k) => { if (SIGNALS[k].def) checkExpr(SIGNALS[k].def, 'signal ' + k); });
    Object.keys(OUTPUTS).forEach((k) => checkExpr(OUTPUTS[k].def, 'output ' + k));
    PROPERTIES.forEach((p) => {
      ['never', 'require', 'eventually'].forEach((k) => { if (p[k]) checkExpr(p[k], 'property ' + p.id); });
      (p.start || []).forEach((j) => { if (!JOBS[j]) errs.push(`property ${p.id}: unknown job ${j}`); });
    });
    RUNGS.forEach((r, i) => { checkExpr(r.when, 'rung ' + (i + 1)); Object.keys(r.set).forEach((v) => { if (!SIGNALS[v] || SIGNALS[v].kind !== 'var') errs.push(`rung ${i + 1}: ${v} is not a PLC variable`); }); });
    Object.keys(JOBS).forEach((j) => JOBS[j].time.forEach((k) => { if (!(k in T)) errs.push(`job ${j}: unknown time ${k}`); }));
    Object.keys(MACHINES).forEach((mk) => {
      const m = MACHINES[mk], ids = Object.keys(m.states);
      const refs = new Set(), tags = new Set();
      const useExpr = (src, where) => { checkExpr(src, where); try { names(src, true).forEach((n) => { if (SIGNALS[n] && SIGNALS[n].kind === 'truth') errs.push(`${where}: the PLC cannot read ${n}`); }); } catch (x) { /* reported */ } try { names(src, true).forEach((n) => { refs.add(n); (SIGNALS[n] && SIGNALS[n].tags || []).forEach((t) => tags.add(t)); if (sensorTags.has(n)) tags.add(n); }); } catch (x) { /* reported */ } };
      const steps = (list, where) => (list || []).forEach((st, i) => {
        const w = `${where} step ${i + 1}`;
        if (st.job) { if (!JOBS[st.job]) errs.push(`${w}: unknown job ${st.job}`); else (JOBS[st.job].tags || []).forEach((t) => tags.add(t)); }
        if (st.check) { const cp = CHECKPOINTS.find((c) => c.id === st.check); if (!cp) errs.push(`${w}: unknown checkpoint ${st.check}`); else { tags.add(cp.prox); tags.add(cp.cam); tags.add(cp.id); } }
        ['when', 'confirm', 'await', 'until'].forEach((f) => { if (st[f]) useExpr(st[f], w); });
        if (st.set) Object.keys(st.set).forEach((v) => { if (!SIGNALS[v] || SIGNALS[v].kind !== 'var') errs.push(`${w}: ${v} is not a PLC variable`); });
        if (st.inc && (!SIGNALS[st.inc] || !SIGNALS[st.inc].num)) errs.push(`${w}: ${st.inc} is not a counter`);
        if (!st.job && !st.check && !st.await && !st.set && !st.inc && !st.text) errs.push(`${w}: empty step`);
      });
      const exists = (id, where) => { if (!m.states[id]) errs.push(`${mk} ${where}: unknown state ${id}`); };
      exists(m.initial.to, 'initial');
      if (m.initial.when) useExpr(m.initial.when, `${mk} initial`);
      steps(m.initial.do, `${mk} initial`);
      if (m.hold) { steps(m.hold.do, `${mk} H`); if (m.hold.exit) useExpr(m.hold.exit, `${mk} H`); else errs.push(`${mk} H: no exit condition`); }
      if (m.fault) { if (m.fault.exit) useExpr(m.fault.exit, `${mk} F`); else errs.push(`${mk} F: no exit condition`); }
      ids.forEach((id) => {
        const s = m.states[id], w = `${mk} ${id}`;
        if (s.choice) {
          useExpr(s.choice, w); exists(s.yes, w); exists(s.no, w);
          const sig = SIGNALS[s.choice];
          if (!sig || !sig.ask) errs.push(`${w}: choice signal needs an "ask" text`);
          return;
        }
        steps(s.do, w);
        (s.next || []).forEach((tr, i) => {
          exists(tr.to, `${w} transition ${i + 1}`);
          useExpr(tr.when, `${w} transition ${i + 1}`);
          if (tr.for && !(tr.for in T)) errs.push(`${w}: unknown time ${tr.for}`);
          (tr.do || []).forEach((a) => { if (a.set) Object.keys(a.set).forEach((v) => { if (!SIGNALS[v] || SIGNALS[v].kind !== 'var') errs.push(`${w}: ${v} is not a PLC variable`); }); });
        });
        (s.faults || []).forEach((f) => { if (f.when) useExpr(f.when, w + ' fault'); });
        if (!s.next || !s.next.length) errs.push(`${w}: no outgoing transition`);
      });
      // reachability from the initial state
      const seen = new Set(), stack = [m.initial.to];
      while (stack.length) {
        const id = stack.pop(); if (seen.has(id) || !m.states[id]) continue; seen.add(id);
        const s = m.states[id];
        if (s.choice) stack.push(s.yes, s.no); else (s.next || []).forEach((tr) => stack.push(tr.to));
      }
      ids.filter((id) => !seen.has(id)).forEach((id) => errs.push(`${mk}: state ${id} cannot be reached`));
      // diagram layout covers every state exactly once
      const v = m.view, placed = v.grid ? Object.keys(v.grid) : v.main.concat(Object.keys(v.side || {}));
      ids.forEach((id) => { if (placed.filter((x) => x === id).length !== 1) errs.push(`${mk}: view places ${id} ${placed.filter((x) => x === id).length} times`); });
      placed.forEach((id) => { if (!m.states[id]) errs.push(`${mk}: view names unknown state ${id}`); });
      // outputs that follow this machine's states
      Object.keys(OUTPUTS).forEach((o) => {
        const e = parse(OUTPUTS[o].def), hit = [];
        const walk = (x) => { if (x.op === 'and' || x.op === 'or') x.args.forEach(walk); else if (x.op === 'not') walk(x.arg); else if (x.op === 'cmp' && x.name === m.slot && m.states[x.value]) hit.push(x); else if (x.op === 'sig' && SIGNALS[x.name] && SIGNALS[x.name].def) walk(parse(SIGNALS[x.name].def)); };
        walk(e);
        if (hit.length) tags.add(o.split('.')[0]);
      });
      // every sensor tag or checkpoint named in a text is really used by the machine
      const texts = [];
      ids.forEach((id) => (m.states[id].desc || []).forEach((l) => texts.push([id, l])));
      ['hold', 'fault'].forEach((k) => m[k] && m[k].desc.forEach((l) => texts.push([k, l])));
      texts.forEach(([id, l]) => {
        (l.match(/\{([^}]+)\}/g) || []).forEach((t) => { const tag = t.slice(1, -1); if (!tags.has(tag) && !refs.has(tag)) errs.push(`${mk} ${id}: text names ${tag} but no step or guard of the machine uses it`); });
        (l.match(/\[(CP-\d)\]/g) || []).forEach((t) => { const cp = t.slice(1, -1); if (!tags.has(cp) && !refs.has(cp)) errs.push(`${mk} ${id}: text names ${cp} but no step or guard of the machine uses it`); });
      });
    });
    return errs;
  }

  const MODEL = {
    T, TLABEL, KPI, RULES, CHECKPOINTS, SENSORS, STATES, idleSetup1, idleSetup2,
    SLOTS, SIGNALS, CONST, OUTPUTS, RUNGS, PROPERTIES, JOBS, MACHINES, SETUP_MACHINES, IDLE_MACHINE,
    expr: { parse, evaluate, names, terms, label, plain, visible, constVal },
    jobTime, stateSteps, stateTime, lint,
  };
  root.CellModel = MODEL;
  if (typeof module !== 'undefined' && module.exports) module.exports = MODEL;
})(typeof window !== 'undefined' ? window : globalThis);
