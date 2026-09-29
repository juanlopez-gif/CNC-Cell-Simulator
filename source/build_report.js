// Word report for the Sensors Design Task (Setup 1 + Setup 2).
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, ImageRun, PageOrientation, Footer, PageNumber, LevelFormat, ExternalHyperlink,
  TabStopType, VerticalAlign,
} = require('docx');
const M = require('./src/cell-model.js');

const OUT = process.argv[2] || path.join(__dirname, 'out', 'Sensors_Design_Report.docx');
const FIG = path.join(__dirname, 'out', 'doc');
const SHOT = path.join(__dirname, 'out');
const K = M.KPI, T = M.T;

const FONT = 'Calibri', MONO = 'Consolas';
const C = { ink: '15202B', muted: '5A6773', blue: '0B5AA6', cp: '7B3FB5', head: '1F3A56', rule: 'C3CCD5', th: 'E2E8EE', zebra: 'F6F8FA', note: 'F2F5F8' };

// ------------------------------------------------------------------ text helpers
// mini markup: {TAG} sensor tag (mono, blue) · [CP-n] cross-check reference (purple, bold) · *bold*
function runs(text, base) {
  base = base || {};
  const out = [];
  let i = 0, m;
  const re = /\{([^}]+)\}|\[([^\]]+)\]|\*([^*]+)\*/g;
  const sz = base.size || 21;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(new TextRun({ text: text.slice(i, m.index), ...base }));
    if (m[1]) out.push(new TextRun({ text: m[1], ...base, font: MONO, size: sz - 2, color: C.blue }));
    else if (m[2]) out.push(new TextRun({ text: m[2], ...base, bold: true, color: C.cp }));
    else out.push(new TextRun({ text: m[3], ...base, bold: true }));
    i = re.lastIndex;
  }
  if (i < text.length) out.push(new TextRun({ text: text.slice(i), ...base }));
  return out;
}
const para = (text, o) => {
  o = o || {};
  return new Paragraph({
    children: runs(text, o.run), alignment: o.align, keepNext: o.keepNext, keepLines: o.keepLines,
    spacing: { before: o.before || 0, after: o.after === undefined ? 120 : o.after, line: o.line || 270 },
    indent: o.indent,
  });
};
const h1 = (t, o) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: !!(o && o.page), children: [new TextRun(t)] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(t)] });
const h3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, keepNext: true, children: [new TextRun(t)] });
const bullet = (text, lvl) => new Paragraph({ numbering: { reference: 'bullets', level: lvl || 0 }, children: runs(text), spacing: { after: 70, line: 264 } });
let listN = 0;
const steps = (items) => { const inst = ++listN; return items.map((t) => new Paragraph({ numbering: { reference: 'steps', level: 0, instance: inst }, children: runs(t), spacing: { after: 60, line: 264 } })); };

// ------------------------------------------------------------------ tables
let tabN = 0;
function caption(text, newPage) { return new Paragraph({ keepNext: true, pageBreakBefore: !!newPage, spacing: { before: 160, after: 80 }, children: runs(text, { bold: true, size: 19, color: C.head }) }); }
function table(cols, rows, o) {
  o = o || {};
  const W = cols.reduce((s, c) => s + c.w, 0);
  const b = { style: BorderStyle.SINGLE, size: 4, color: C.rule };
  const size = o.size || 18;
  const cell = (text, w, head, shade, keep) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: head ? { fill: C.th, type: ShadingType.CLEAR, color: 'auto' } : shade ? { fill: C.zebra, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 45, bottom: 45, left: 85, right: 85 },
    verticalAlign: VerticalAlign.TOP,
    children: String(text).split('\n').map((line) => new Paragraph({ keepNext: keep, children: runs(line, { size, bold: head || undefined, color: head ? C.head : C.ink }), spacing: { after: 15, line: 235 } })),
  });
  return new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: cols.map((c) => c.w),
    borders: { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: cols.map((c) => cell(c.h, c.w, true, false, true)) }),
      ...rows.map((r, i) => new TableRow({ cantSplit: true, children: r.map((t, j) => cell(t, cols[j].w, false, i % 2 === 1, !!o.keep && i < rows.length - 1)) })),
    ],
  });
}
function tbl(title, cols, rows, o) { return [caption(`Table ${++tabN}. ${title}`, o && o.newPage), table(cols, rows, o), para('', { after: 60 })]; }
function noteBox(lines, W) {
  const b = { style: BorderStyle.SINGLE, size: 4, color: C.rule };
  return new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: [W],
    borders: { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b },
    rows: [new TableRow({ children: [new TableCell({ width: { size: W, type: WidthType.DXA }, shading: { fill: C.note, type: ShadingType.CLEAR, color: 'auto' }, margins: { top: 110, bottom: 90, left: 160, right: 160 }, children: lines })] })],
  });
}

// ------------------------------------------------------------------ figures
let figN = 0;
function pngSize(file) { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
function figure(file, cap, maxWin, maxHin) {
  const { w, h } = pngSize(file);
  let dw = maxWin * 96, dh = (dw * h) / w;
  if (dh > maxHin * 96) { dh = maxHin * 96; dw = (dh * w) / h; }
  const n = ++figN;
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 100, after: 50 }, children: [new ImageRun({ type: 'png', data: fs.readFileSync(file), transformation: { width: Math.round(dw), height: Math.round(dh) }, altText: { title: `Figure ${n}`, description: cap, name: path.basename(file) } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, children: runs(`Figure ${n}. ${cap}`, { italics: true, size: 18, color: C.muted }) }),
  ];
}
const fig = (name, cap, w, h) => figure(path.join(FIG, name + '.png'), cap, w, h);

// ------------------------------------------------------------------ page setup
const PORTRAIT = { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1000, left: 1152, right: 1152, header: 500, footer: 500 } };
const LANDSCAPE = { size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE }, margin: { top: 1000, bottom: 900, left: 1152, right: 1152, header: 480, footer: 480 } };
const PW = 12240 - 2 * 1152;   // 9936 DXA text width portrait (6.9 in)
const LW = 15840 - 2 * 1152;   // 13536 DXA text width landscape (9.4 in)
const footer = (w) => new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: w }], children: [new TextRun({ text: 'Sensors Design Task · Machine-tending cell · Week 2', size: 16, color: C.muted }), new TextRun({ text: '\tPage ', size: 16, color: C.muted }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: C.muted })] })] });
const section = (orient, children) => ({ properties: { page: orient === 'L' ? LANDSCAPE : PORTRAIT }, footers: { default: footer(orient === 'L' ? LW : PW) }, children });

// ------------------------------------------------------------------ data
const SIG = {
  'PX-11': 'DI, PNP', 'CAM-1': 'EtherNet/IP (or TCP)', 'GR-21': 'UR tool I/O', 'R1 / R2': 'EtherNet/IP + safety I/O', 'CNC I/O': 'DI/DO or fieldbus',
  'ZS-31': 'DI', 'ZS-32': 'DI', 'ZS-33': 'safety input (2 ch.)', 'ZS-34 / ZS-35': 'DI', 'PS-36': 'DI', 'PE-41': 'DI, PNP', 'PE-42': 'DI, PNP (fast)',
  'ENC-43': 'high-speed counter', 'CAM-2': 'EtherNet/IP (or TCP)', 'GR-51': 'UR tool I/O', 'PX-52': 'DI, PNP', 'LT-53': 'DO 24 V', 'LT-01': 'DO 24 V',
  'SC-01 / SC-02': 'safety input', 'PLC-01': '–', 'LS-61 / 62 / 63': 'analog 0-10 V / 4-20 mA', 'PX-64': 'DI, PNP', 'PE-65': 'DI, PNP', 'MST-60': '–',
};
const sensRow = (s) => [`{${s.tag}}`, s.where, s.type, s.confirms, s.example, SIG[s.tag] || ''];
const sensorCols = [
  { h: 'Tag', w: 1180 }, { h: 'Location', w: 2250 }, { h: 'Sensor type', w: 2650 },
  { h: 'What it confirms', w: 3150 }, { h: 'Example product', w: 2850 }, { h: 'Signal', w: 1456 },
];
const S1 = M.SENSORS.filter((s) => s.setup === 1);
const S2 = M.SENSORS.filter((s) => s.setup === 2);

// ------------------------------------------------------------------ content
const titleBlock = [
  new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Sensors Design Task', font: FONT, size: 44, bold: true, color: C.head })] }),
  new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Machine-tending cell: CNC, two UR10e robots and a conveyor', size: 28, color: C.ink })] }),
  new Paragraph({ spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: C.head, space: 6 } }, children: [new TextRun({ text: 'Week 2 Design Assignment · Setup 1 and Setup 2 · sensor selection, placement and work-flow logic · September 28, 2026', size: 19, color: C.muted })] }),
];

const summary = noteBox([
  new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'Summary', bold: true, size: 23, color: C.head })] }),
  bullet('Four state machines run in the cell PLC: *Robot 1 + CNC*, *Conveyor*, *Robot 2 + output pallet* and a *cross-check supervisor* (Figure 2). No step starts on a timer: every command is confirmed by a sensor before the next step, and every confirmation has a timeout that raises an alarm naming the sensor.'),
  bullet('At five checkpoints ([CP-1] … [CP-5]) an IR proximity sensor and a camera confirm the same fact. *They must agree. If they disagree, the camera value is used and the mismatch is logged. Three mismatches within 10 minutes stop the line for sensor verification* (Section 3).'),
  bullet('Robot 1 opens and closes the CNC door itself. The CNC door kit supplies door-open and door-closed position sensors, a guard-locking safety interlock and the robot interface signals (Section 2.3).'),
  bullet('An encoder on an idler roller measures that the belt has really stopped. Robots pick or place at the belt only at zero speed.'),
  bullet(`Setup 2 adds a laser gauge at Robot 2 that measures length, width and height of every part and sends any part below 48.00 mm to a locked non-conforming chute. A dual gripper and pre-picking cut the CNC idle time per part from ${K.idle1} s to ${K.idle2} s (CNC utilization ${(K.util1 * 100).toFixed(1)} % → ${(K.util2 * 100).toFixed(1)} %, ${K.pph1.toFixed(1)} → ${K.pph2.toFixed(1)} parts per hour).`),
  bullet('An interactive HTML simulation runs all the state machines live and lets you inject sensor faults (Section 6).'),
], PW);

const sec1 = [
  ...titleBlock,
  summary,
  h1('1. Design basis'),
  h2('1.1 Assumptions'),
  bullet('*Parts:* aluminum blocks 50 × 50 × 50 mm (about 0.34 kg). The input and output pallets hold 12 parts (3 × 4) and sit against locating stops on their tables.'),
  bullet('*Robots:* two Universal Robots UR10e (payload 12.5 kg, reach 1300 mm, pose repeatability ±0.05 mm, 17 configurable safety functions, EtherNet/IP, PROFINET and Modbus TCP). Robot 1 tends the CNC; Robot 2 unloads the conveyor.'),
  bullet('*CNC:* vertical machining center with a sliding front door and a pneumatic vise; cycle time 120 s. The robot opens and closes the door like an operator; the machine builder\'s kit adds the door sensors and the robot interface.'),
  bullet('*Conveyor:* 2 m belt at 0.25 m/s with a hard stop at the exit.'),
  bullet('*Control:* one cell PLC with HMI and safety relay runs the logic. Step times are planning estimates for a UR10e cell (Appendix B).'),
  h2('1.2 Design rules'),
  bullet('*Rule 1: confirm every step.* The PLC sends a command, waits for the confirming signal and only then starts the next step. Each wait has a timeout; on timeout the sequence goes to FAULT, the alarm names the sensor, and robot moves are not retried automatically.'),
  bullet('*Rule 2: conveyor interlock.* A robot may pick or place at the belt only when {ENC-43} confirms zero speed; the belt may start only when both robots report "clear of conveyor".'),
  bullet('*Rule 3: camera + proximity cross-check* (Section 3). The camera decides when the two disagree; repeated disagreement stops the line.'),
  bullet('*Rule 4: safety stays hardwired.* The door guard lock, E-stops, safety scanners and the UR10e safety I/O are safety-rated functions. The camera and the sequence logic never override them.'),
  h1('2. Setup 1: sensor selection and placement'),
  h2('2.1 Layout'),
  para('Figure 1 (next page) shows where every sensor sits. The arrangement is the one given in the assignment: CNC on the left, input pallet above Robot 1, conveyor in the middle, output pallet at the far end and Robot 2 below the conveyor exit. Two overhead cameras cover the robot work areas: {CAM-1} sees the input pallet (ROI-A) and the conveyor entry (ROI-B); {CAM-2} sees the conveyor exit (ROI-C) and the output pallet (ROI-D). Table 1 lists every sensor with its location, type, purpose and an example product.'),
  para('Two choices follow from the part material and the conveyor: aluminum is not ferrous, so standard inductive sensors lose most of their range on the parts, and IR photoelectric sensors plus cameras are used for part detection. The encoder sits on an idler (non-driven) roller, which only turns when the belt really moves, so belt slip or a drive that does not move is detected.'),
];

const sec2 = [
  ...fig('fig01_layout_setup1', 'Setup 1 cell layout with sensor placement (top view, not to scale). Tags are listed in Table 1.', 9.4, 5.95),
  ...tbl('Setup 1 sensors and signals', sensorCols, S1.map(sensRow), { size: 16, newPage: true }),
];

const sec3 = [
  h2('2.2 Control architecture'),
  para('The cell PLC runs four state machines in parallel (Figure 2). Each one moves only on its own sensors and on the handshake signals written on the arrows: Robot 1 tells the conveyor "part placed", the conveyor tells both robots "belt stopped", Robot 2 receives "pick allowed" with the pick pose from {CAM-2}, and every machine sends its checkpoint results to the cross-check supervisor, which can command a line stop.'),
  ...fig('fig02_control_architecture', 'Control architecture: four state machines in the cell PLC and their handshake signals.', 6.9, 4.0),

  h2('2.3 CNC door opened by the robot'),
  para('In Setup 1 the single gripper cannot hold a part and the door handle at the same time, so the door is opened before the unload (gripper empty) and closed after the load (gripper empty again). The steps and their confirming signals are:', { keepNext: true }),
  para('*Opening* (after the machining cycle):', { after: 40, keepNext: true }),
  ...steps([
    'The CNC reports *cycle complete* (M30) and *spindle stopped* through the robot interface.',
    'The guard lock releases: {ZS-33} = unlocked.',
    'Robot 1 grips the door handle with the empty gripper, slides the door open and releases the handle.',
    '{ZS-31} (door open) turns ON and {ZS-32} (door closed) turns OFF within 8 s. Only then may the robot enter the machine.',
  ]),
  para('*Closing* (after loading):', { after: 40, before: 60, keepNext: true }),
  ...steps([
    'Robot 1 is outside the machine: the UR10e safety plane at the door line reports "R1 clear of CNC".',
    'The robot grips the handle, slides the door closed and releases it.',
    '{ZS-32} turns ON and {ZS-31} turns OFF within 8 s.',
    'The guard lock engages: {ZS-33} = locked. Only now may the PLC send cycle start.',
  ]),
  ...tbl('Sensors and signals supplied by the CNC door and robot-interface kit', [
    { h: 'Kit item', w: 2200 }, { h: 'Sensor type', w: 3736 }, { h: 'Purpose in the work flow', w: 4000 },
  ], [
    ['Door-closed position', 'Non-contact inductive or coded magnetic sensor ({ZS-32})', 'Door fully closed; condition for cycle start'],
    ['Door-open position', 'Non-contact sensor at the end of the door travel ({ZS-31})', 'Door fully open; condition for the robot to enter'],
    ['Safety interlock with guard locking', 'Coded solenoid interlock, dual channel, safety-rated ({ZS-33})', 'Keeps the door locked while the spindle turns; unlocks only when the machine is stopped'],
    ['Robot interface', 'Discrete I/O or fieldbus with M-code handshake (for example the Haas robot interface box)', 'Cycle start, cycle complete, spindle stopped, alarm, door and vise commands, fence and E-stop chain'],
    ['Vise clamp position', 'Cylinder reed switches ({ZS-34} open, {ZS-35} clamped), optional pressure switch', 'Part clamped before the cycle starts; vise open before the unload'],
    ['Part-seated sensor', 'Air-gap (air catch) sensor in the datum face ({PS-36}), for example SMC ISA3', 'Part lies flat on the datum, no chip under it'],
    ['Automatic door (option)', 'Pneumatic actuator with its own end-of-travel sensors (for example Haas Auto Door, M80 / M81)', 'Door opens and closes by M-code; see Section 5.3'],
  ]),
  h1('3. Camera + proximity cross-check', { page: true }),
  para('At five checkpoints a camera and a proximity sensor look at the same fact (Table 3). The proximity sensor is fast and simple; the camera sees the whole area and also gives the pick position. The design follows one rule: *the two sources must agree; if they do not, trust the camera; if disagreements repeat within a short time, stop the line and verify the sensors.*'),
  ...tbl('Checkpoints where the camera and the proximity sensor are compared', [
    { h: 'CP', w: 760 }, { h: 'Location', w: 1350 }, { h: 'Proximity', w: 1050 }, { h: 'Camera ROI', w: 1250 }, { h: 'Fact compared', w: 2126 }, { h: 'Checked when', w: 3400 },
  ], [
    ['[CP-1]', 'Input pallet', '{PX-11}', '{CAM-1} ROI-A', 'Pallet present and seated', 'Before every pick'],
    ['[CP-2]', 'Conveyor entry', '{PE-41}', '{CAM-1} ROI-B', 'Part at the entry', 'Before placing (must be clear) and after placing (must be present)'],
    ['[CP-3]', 'Conveyor exit', '{PE-42}', '{CAM-2} ROI-C', 'Part at the end stop', 'Before a transport (clear), at the stop (present), after the pick (clear)'],
    ['[CP-4]', 'Output pallet', '{PX-52}', '{CAM-2} ROI-D', 'Pallet present', 'Before every place and after a pallet swap'],
    ['[CP-5]', 'Gauge nest (Setup 2)', '{PX-64}', '{CAM-2} ROI-E', 'Part in the nest', 'After loading the gauge'],
  ], { keep: true }),
  ...tbl('Decision table applied at every checkpoint', [
    { h: 'Proximity sensor', w: 1800 }, { h: 'Camera', w: 2000 }, { h: 'Value used by the sequence', w: 3736 }, { h: 'Counted as', w: 2400 },
  ], [
    ['ON', 'object seen', 'Object present', '–'],
    ['OFF', 'no object', 'Object absent', '–'],
    ['OFF', 'object seen', 'Object present (camera)', 'Mismatch'],
    ['ON', 'no object', 'Object absent (camera)', 'Mismatch'],
    ['any', 'image not valid', 'Re-trigger once; a second invalid image is a camera fault', 'Camera fault → line stop'],
  ], { keep: true }),
  bullet('*When a check is made.* Only with a static scene: the robot is outside the ROI and the belt is stopped, followed by 0.3 s of settling. The proximity input is debounced for 50 ms and the camera takes a fresh image.'),
  bullet('*Why the camera decides.* The camera sees the whole region, knows where the object is (it also sends the pick pose) and checks itself on every image: an image counts only if the exposure is correct and the calibration marks are found. A photoelectric sensor sees one point, and its usual failures (dirty lens, misaligned beam, loose bracket) make it miss objects without any warning.'),
  bullet('*Mismatch.* The sequence continues with the camera value. The PLC logs the time, the checkpoint and both readings, flashes the amber light and names the sensor on the HMI.'),
  bullet('*Line stop.* The supervisor keeps a 10-minute sliding window. The 3rd mismatch inside the window stops the line in a controlled way: the CNC finishes the part in the machine, the robots finish the current step and park, and the belt starts no new transport. One mismatch can be a reflection or a part slightly out of place; three within 10 minutes (about four CNC cycles) point to a degraded sensor, and then neither source can be trusted blindly.'),
  bullet('*Sensor verification (state X4).* The technician cleans and inspects the sensors named on the HMI, checks brackets and through-beam alignment, tests every checkpoint with a test part (both sources ON with the part, both OFF without it), checks the camera calibration target and, in Setup 2, measures the master cube. The operator reset clears the counter and the line resumes.'),
  bullet('*Stopping versus confirming.* To stop the belt either source is enough ({PE-42} OR {CAM-2}), because stopping is the safe direction. To confirm a part before a robot move, the cross-check is used.'),
  bullet('*Parameters (HMI):* window 10 min, limit 3 mismatches, settling 0.3 s, debounce 50 ms. Figure 3 shows the decision logic and Figure 4 the supervisor states.'),
  ...fig('fig03_crosscheck_flow', 'Decision logic executed at every checkpoint.', 6.9, 8.4),
  ...fig('fig04_supervisor_states', 'State diagram of the cross-check supervisor (runs in parallel with the other state machines).', 6.9, 4.2),

  h1('4. Setup 1: work flow and state diagrams', { page: true }),
  para('Figure 5 follows one part through the cell; Table 5 gives the same sequence with the timeout that applies to each confirmation. The state diagrams (Figures 6 to 8) show the logic that each state machine executes. In every state diagram the label on an arrow is the condition that allows the transition. FAULT (timeout or missing confirmation) and HOLD (line stop from the supervisor) can be entered from any state; after a HOLD the machine resumes at the same step.'),
  ...fig('fig05_flow_setup1', 'Work flow of one part in Setup 1 with the confirming signal of every step.', 6.9, 6.2),
  ...tbl('Setup 1 sequence with confirmations and timeouts', [
    { h: '#', w: 420 }, { h: 'Step', w: 1900 }, { h: 'Command', w: 2100 }, { h: 'Confirmation that allows the next step', w: 3816 }, { h: 'Timeout → alarm', w: 1700 },
  ], [
    ['1', 'Check input pallet', '{CAM-1} snapshot', '[CP-1] {PX-11} + {CAM-1} pallet present; {CAM-1} part located (x, y, angle)', 'wait, HMI "Load input pallet"'],
    ['2', 'Open CNC door', 'Robot 1 door routine', 'Cycle complete + spindle stopped + {ZS-33} unlocked → {ZS-31} ON, {ZS-32} OFF', '8 s: door not open'],
    ['3', 'Unload part', 'Grip, vise open, lift', '{GR-21} grip OK · {ZS-34} vise open · {PS-36} OFF · R1 clear of CNC', '3 s per signal'],
    ['4', 'Place on conveyor', 'Place at the entry', 'Before: {ENC-43} = 0, [CP-2] entry clear. After: [CP-2] {PE-41} + {CAM-1} part present · R1 clear', '2 s'],
    ['5', 'Pick raw part', 'Pick at the {CAM-1} pose', '{GR-21} grip OK · {CAM-1} slot now empty', '2 s: grip not confirmed'],
    ['6', 'Load CNC', 'Place, vise close', '{ZS-35} clamped · {PS-36} seated · gripper open · R1 clear of CNC', '3 s: part not seated'],
    ['7', 'Close CNC door', 'Robot 1 door routine', '{ZS-32} ON, {ZS-31} OFF · {ZS-33} locked', '8 s: door not locked'],
    ['8', 'Cycle start', 'Cycle start via the robot interface', 'CNC in cycle', '2 s'],
    ['9', 'Machining', '–', 'Cycle complete (M30) + spindle stopped', '150 s: cycle overrun'],
    ['10', 'Transport', 'Belt run', '{ENC-43} pulses within 1 s · part at the stop: {PE-42} or {CAM-2}', '1 s / 15 s: belt or jam'],
    ['11', 'Stop and verify', 'Belt stop', '{ENC-43} zero speed for 0.2 s · [CP-3] {PE-42} + {CAM-2} · pick pose', '2 s'],
    ['12', 'Pick from conveyor', 'Robot 2 pick', '{GR-51} grip OK · [CP-3] exit clear · R2 clear of conveyor', '2 s'],
    ['13', 'Place on output pallet', 'Robot 2 place', '[CP-4] {PX-52} + {CAM-2} pallet present · {CAM-2} slot occupied · count + 1', '2 s'],
    ['14', 'Pallet full', '{LT-53} blue light ON', '{PX-52} OFF → ON and {CAM-2} empty pallet → count = 0, {LT-53} OFF', 'wait for the operator'],
  ], { size: 16 }),
  ...fig('fig06_states_robot1_setup1', 'State diagram of Robot 1 + CNC tending, Setup 1 (single gripper). The amber band is the time the CNC waits for the robot.', 6.9, 8.95),
  ...fig('fig07_states_conveyor', 'State diagram of the conveyor.', 6.9, 6.0),
  ...fig('fig08_states_robot2_setup1', 'State diagram of Robot 2 and the output pallet, Setup 1.', 6.9, 5.4),
  h2('4.1 Pallet-full light'),
  para('Robot 2 counts the parts it places and {CAM-2} confirms the occupied slots. When the count reaches 12 and {CAM-2} sees all 12 slots full, the blue beacon {LT-53} turns ON (blue means "operator action required" in IEC 60204-1) and the HMI shows "Pallet ready for pickup". The light turns OFF only after {PX-52} sees the pallet removed (OFF) and a new pallet placed (ON) and {CAM-2} confirms that it is empty; the count then resets to 0. If the count and the camera disagree, for example because the operator took a part off the pallet, the camera value is used, as in Section 3.'),

  h1('5. Setup 2: dimensional check and CNC time', { page: true }),
  para('Parts undersized by more than 2 mm in length, width or height must not reach the finished-part pallet. The acceptance limit is therefore *48.00 mm in each of the three dimensions*. A part at exactly 48.00 mm is undersized by 2 mm, not by more, and is accepted.'),
  h2('5.1 Changes to the cell'),
  bullet('A *dimensional gauge station* at Robot 2, between the conveyor exit and the robot, with three laser displacement sensors {LS-61}, {LS-62}, {LS-63} and a part-in-nest sensor {PX-64}.'),
  bullet('A locked *non-conforming (NOK) chute* next to the output pallet with the drop sensor {PE-65}. Only QA can open the bin.'),
  bullet('A *dual gripper* on Robot 1: gripper A carries the raw part and gripper B the finished part.'),
  bullet('The {CAM-2} field of view is extended to the gauge nest (ROI-E), which adds checkpoint [CP-5].'),
  bullet('Optional: the automatic door actuator of the CNC kit (M80 / M81).'),
  para('Figure 9 shows the reconfigured layout, Table 6 lists the added sensors and Figure 10 compares the timing of both setups.'),
  h2('5.2 Dimensional gauge station'),
  bullet('*Method.* Robot 2 places the part in a corner nest with three hardened datum faces (X, Y and Z), pushes it gently against them with the UR10e force control, releases it and retracts out of the laser paths. Each laser displacement sensor looks at the free face opposite its datum. With the master cube in the nest a sensor reads d master; with a part it reads d part. The size is 50.000 + (d master − d part) mm, because a smaller part leaves a larger gap.'),
  bullet('*One point per face is enough.* Squareness and flatness are below 0.1 mm, so each face is a good plane and one reading per face gives the dimension; the form error is small compared with the 2 mm limit.'),
  bullet('*No cleaning station.* The CNC has already cleaned the parts, so no coolant film or chips disturb the optical reading or the seating.'),
  bullet('*Sensor choice.* Keyence IL-065 laser displacement heads (range 55 to 105 mm, repeatability 2 µm) are mounted so that the face of a 50 mm part sits near the 65 mm reference distance; a 48 mm face is then 2 mm further away, well inside the range. The IL series adjusts its gain for shiny machined metal. The decision only needs a 2 mm band, so a gauge R&R should confirm a total measurement variation below 10 % of it (0.2 mm).'),
  bullet('*Decision.* Each sensor takes 10 samples and the PLC averages them. OK = L ≥ 48.00 and W ≥ 48.00 and H ≥ 48.00 mm. A reading outside the plausible range (40 to 56 mm) or a sensor alarm triggers one more measurement; if it is still invalid the part goes to the NOK chute as "not verified" and a sensor error is logged. The three values of every part are stored for traceability.'),
  bullet('*Calibration.* At start-up and after every sensor verification Robot 2 measures a certified 50.000 mm master cube ({MST-60}); each channel must read within ±0.02 mm.'),
  bullet('*Quality hold.* Two NOK parts in a row point to tool wear or a wrong offset rather than a random error. The CNC finishes the part in the machine, but the next cycle start is blocked until the operator checks the tool and offsets and releases the hold.'),
  bullet('*Alternative.* Three spring-loaded linear probes (Gefran PY2, 10 mm stroke) against the same datums are a cheaper contact option (Appendix A); they need a retract mechanism and wear slowly.'),
];

const sec4 = [
  ...fig('fig09_layout_setup2', 'Setup 2 cell layout: gauge station, NOK chute and dual gripper added (top view, not to scale).', 9.4, 5.95),
  ...tbl('Sensors added in Setup 2', sensorCols, [
    ...S2.map(sensRow),
    ['{GR-21A} / {GR-21B}', 'Robot 1 dual gripper', 'Two electric grippers on a dual adapter', 'Raw part held (A) / finished part held (B)', 'OnRobot Dual Quick Changer + 2 × RG2', 'UR tool I/O'],
    ['{CAM-2} ROI-E', 'Gauge nest, seen by CAM-2', 'Extra region of interest of the same camera', 'Part in the nest ([CP-5] with {PX-64})', 'Same camera as Setup 1', 'EtherNet/IP'],
  ], { size: 16 }),
  ...fig('fig10_timing_setup1_vs_setup2', 'Timing of one CNC cycle in both setups. In Setup 2 only the door and the part exchange happen while the CNC waits.', 9.4, 3.7),
];

const sec5 = [
  h2('5.3 Making the best use of the CNC time'),
  para(`The CNC is the bottleneck (120 s cycle), so the goal is to keep the time between "cycle complete" and the next "cycle start" as short as possible. In Setup 1 Robot 1 unloads, goes to the conveyor, picks a raw part and loads it while the CNC waits: ${K.idle1} s per part. Setup 2 reorders the work so that only the part exchange happens while the CNC waits:`),
  ...steps([
    'During machining, Robot 1 places the previous finished part on the conveyor, pre-picks the next raw part with gripper A and waits at the door.',
    'At cycle complete, the empty gripper B opens the door and takes the finished part out of the vise; the CNC blows the vise clean while the wrist turns; gripper A places the raw part; gripper A, now empty, closes the door; cycle start.',
    'The inspection is done by Robot 2 after the conveyor, in parallel with machining, so the quality check never delays the CNC. Robot 2 needs about 15 s of work per cycle.',
  ]),
  ...tbl('Setup 1 versus Setup 2', [{ h: '', w: 3300 }, { h: 'Setup 1', w: 3100 }, { h: 'Setup 2', w: 3536 }], [
    ['CNC idle per part', `${K.idle1} s`, `${K.idle2} s`],
    ['Time per part (idle + 120 s)', `${K.cycle1} s`, `${K.cycle2} s`],
    ['CNC utilization', `${(K.util1 * 100).toFixed(1)} %`, `${(K.util2 * 100).toFixed(1)} %`],
    ['Output', `${K.pph1.toFixed(1)} parts per hour`, `${K.pph2.toFixed(1)} parts per hour (+${((K.pph2 / K.pph1 - 1) * 100).toFixed(0)} %)`],
    ['Robot 1 during machining', 'waits at home', 'places on the conveyor, pre-picks, waits at the door (≈ 12 s of work)'],
    ['Dimensional inspection', 'none', 'Robot 2 gauge, in parallel with machining'],
  ], { keep: true }),
  para('Robot 1 has about 108 s free per cycle and could also do the measuring, but with the exchange-first sequence the next part is already in the CNC before any inspection, so moving the check to Robot 2 costs no feedback time, keeps the Robot 1 path short and puts the NOK chute next to the output pallet, where QA collects it.'),
  para('Further options that are not included in the numbers above: the automatic door of the CNC kit (M80 / M81) can open while the robot approaches and saves a few seconds per cycle; a "cycle ending" M-code a few seconds before M30 lets the robot pre-position; and a second output-pallet position lets the operator swap a full pallet while Robot 2 fills the other one, so a late operator never blocks the CNC.'),
  h2('5.4 Setup 2 work flow and state diagrams'),
  ...fig('fig11_flow_setup2', 'Work flow of one part in Setup 2.', 6.9, 5.8),
  ...fig('fig12_states_robot1_setup2', 'State diagram of Robot 1 + CNC tending, Setup 2 (dual gripper). Only states B3 to B6 make the CNC wait.', 6.9, 8.95),
  ...fig('fig13_states_robot2_setup2', 'State diagram of Robot 2 with the gauge and the sorting decision, Setup 2.', 6.9, 8.95),

  h1('6. Simulation', { page: true }),
  para('The folder contains *simulation/index.html*, a self-contained page that runs the four state machines of this report in the browser. It shows the cell with live sensor LEDs and camera snapshots, the current state of each machine highlighted on its state diagram, the cross-check table with the 10-minute mismatch window, and an event log. Buttons inject a single false reading or a faulty sensor at any checkpoint, a bad camera frame or a camera failure, a missed pick and, in Setup 2, an undersized part. The simulated CNC idle times match the design values of Table 7.'),
  para('*Suggested demonstration.* Select Setup 1 and press *Fault* on [CP-2] ({PE-41}). Every part placed on the belt now gives a mismatch; the camera keeps the line running (amber warning). The third mismatch within 10 minutes stops the line; start the sensor verification and reset. Then select Setup 2 and press *Next part undersized* twice to see the NOK chute and the quality hold.'),
  ...figure(path.join(SHOT, 'sim_setup1_warning.png'), 'Simulation, Setup 1: PE-41 is faulty, the camera value is used, 2 of 3 mismatches in the 10-minute window.', 6.9, 4.4),
  ...figure(path.join(SHOT, 'sim_setup2_gauge.png'), 'Simulation, Setup 2: an undersized part has been measured and dropped in the NOK chute.', 6.9, 4.4),
];

const budgetRows = [
  ['{PX-11}, {PX-52}', 'IR diffuse proximity sensor', 'AutomationDirect FFI7-0P-1E', '2', '$92', '$184'],
  ['{PE-41}, {PE-42}', 'IR through-beam pair', 'AutomationDirect QMIHD-0P-0F', '2', '$81', '$162'],
  ['{ZS-31}, {ZS-32}', 'Door position switches, only if the kit has none', 'AutomationDirect AEM2G42X11-3', '2', '$35.50', '$71'],
  ['{ZS-33}', 'Guard-locking interlock, only if the kit has none', 'IDEM KL1-P-221002', '1', '$252', '$252'],
  ['{ENC-43}', 'Incremental encoder, 600 ppr', 'Koyo TRD-N600-RZWD', '1', '$196', '$196'],
  ['{CAM-1}, {CAM-2}', 'Camera (budget option)', 'Luxonis OAK-D Pro PoE', '2', '$579', '$1,158'],
  ['–', 'LED bar lights for the cameras', 'AutomationDirect PD01ZD5UY', '2', '$469', '$938'],
  ['{LT-53}', 'Pallet-full beacon, blue', 'Patlite 1-tier LED light (red ME-102P-R lists at $106)', '1', '≈ $106', '≈ $106'],
  ['{PLC-01}', 'PLC, extra inputs, safety relay, power supply, terminals', 'AutomationDirect BRX BX-DM1E-18ED13-D + accessories', '1', '–', '$864'],
  ['', '*Setup 1 catalog items*', '', '', '', '*≈ $3,931*'],
  ['{LS-61..63}', 'Laser displacement sensors (recommended)', 'Keyence IL-065 + IL amplifiers', '3', 'quote', 'quote'],
  ['{LS-61..63} alt.', 'Spring-loaded linear probes (contact option)', 'Gefran PY2-F-0010-S-L', '3', '$209', '$627'],
  ['–', 'Analog input module + terminal block for the probes', 'BRX BX-04AD-2B + BX-RTB10', '1', '–', '$276'],
  ['–', '5 V supply for the probes', 'AutomationDirect PSV5-25S', '1', '$55', '$55'],
  ['{PX-64}, {PE-65}', 'Gauge-nest sensor + NOK-chute through-beam', 'FFI7-0P-1E + QMIHD-0P-0F', '2', '$92 / $81', '$173'],
  ['', '*Setup 2 additions, probe option*', '', '', '', '*≈ $1,131*'],
];

const sec6 = [
  h1('Appendix A. Preliminary component budget', { page: true }),
  para('Catalog list prices in USD, checked on the vendor pages in September 2026 for FFI7-0P-1E ($92), QMIHD-0P-0F ($81), TRD-N600-RZWD ($196), PY2-F-0010-S-L ($209) and ME-102P-R ($106); the other prices come from the preliminary study and should be confirmed with a quote. Taxes, shipping and installation are not included. The CNC, both robots and the conveyor are assumed to exist.'),
  ...tbl('Preliminary component budget', [
    { h: 'Tag', w: 1350 }, { h: 'Item', w: 2900 }, { h: 'Model', w: 2886 }, { h: 'Qty', w: 600 }, { h: 'Unit', w: 1000 }, { h: 'Subtotal', w: 1200 },
  ], budgetRows, { size: 16 }),
  para('Not included, by quote: the CNC door kit and robot interface (machine builder), grippers (two OnRobot RG2 were about $11,160 in the preliminary study), the dual gripper adapter, the LT-01 stack light (Patlite LR6-302WJBW-RYG), the safety scanners, industrial smart cameras (Cognex In-Sight 2800 or Keyence IV3) if chosen over the budget cameras, and the mechanical parts (gauge nest, master cube, NOK chute, brackets). The installed cost with wiring, cabinet, programming and commissioning is several times the component cost; the preliminary study estimated $15,000 to $37,000 for Setup 1 and $5,000 to $12,000 more for Setup 2, which is a planning figure, not a quote.'),
  h1('Appendix B. Step times used for the timing'),
  para('Planning estimates for a UR10e at moderate speed with approach and retract moves. They are the values used in Figure 10, Table 7 and the simulation.', { keepNext: true }),
  ...tbl('CNC idle time build-up (from cycle complete to the next cycle start)', [
    { h: 'Setup 1 step', w: 3900 }, { h: 's', w: 1068 }, { h: 'Setup 2 step', w: 3900 }, { h: 's', w: 1068 },
  ], (() => {
    const a = M.idleSetup1, b = M.idleSetup2, n = Math.max(a.length, b.length), rows = [];
    for (let i = 0; i < n; i++) rows.push([a[i] ? a[i][0] : '', a[i] ? String(a[i][1]) : '', b[i] ? b[i][0] : '', b[i] ? String(b[i][1]) : '']);
    rows.push(['*Total CNC idle*', `*${K.idle1}*`, '*Total CNC idle*', `*${K.idle2}*`]);
    return rows;
  })(), { size: 16 }),
  para(`Other values: CNC cycle ${T.cncCycle} s; belt transport ${T.beltTravel} s (2 m at 0.25 m/s); each camera + proximity check ${T.check} s (settling and image); Robot 2 pick ${T.r2ToExit + T.r2Pick} s, gauge load ${T.r2ToGauge + T.r2LoadGauge} s, measurement ${T.measure} s.`),
  h1('References'),
  ...[
    ['Universal Robots UR10e technical specifications', 'https://www.universal-robots.com/products/ur10e/'],
    ['Keyence IL-065 laser displacement sensor head', 'https://www.keyence.com/products/sensor/positioning/il/models/il-065/'],
    ['SMC ISA3 digital gap (air catch) sensor', 'https://www.smcusa.com/products/isa3-digital-gap-sensor-2-screen-3-color-ip67~161491'],
    ['Haas M80 / M81 automatic door open / close', 'https://www.haascnc.com/service/codes-settings.type=mcode.machine=mill.value=M81.html'],
    ['Haas automatic door option for mills', 'https://www.haascnc.com/productivity/product-options/auto-door-mill.html'],
    ['AutomationDirect FFI7-0P-1E photoelectric sensor', 'https://www.automationdirect.com/adc/shopping/catalog/sensors_-z-_encoders/photoelectric_sensors/diffuse/ffi7-0p-1e'],
    ['AutomationDirect QMIHD-0P-0F through-beam pair', 'https://www.automationdirect.com/adc/shopping/catalog/sensors_-z-_encoders/photoelectric_sensors/through-beam/qmihd-0p-0f'],
    ['Koyo TRD-N600-RZWD rotary encoder', 'https://www.automationdirect.com/adc/shopping/catalog/sensors_-z-_encoders/encoders/rotary_encoders/trd-n600-rzwd'],
    ['Gefran PY2-F-0010-S-L linear position sensor', 'https://www.automationdirect.com/adc/shopping/catalog/sensors_-z-_encoders/linear_position_sensors/spring_loaded_slide/py2-f-0010-s-l'],
    ['Patlite ME-102P-R signal light', 'https://www.automationdirect.com/adc/shopping/catalog/stacklights/industrial_signal_lights/me-102p-r'],
    ['Patlite LR6-302WJBW-RYG signal tower', 'https://shop.patlite.com/60mm-Signal-Tower-Red-Green-Amber-p/lr6-302wjbw-ryg.htm'],
    ['Cognex: how laser displacement sensors work (course reference)', 'https://www.cognex.com/blogs/machine-vision/how-laser-displacement-sensors-work'],
    ['Balluff and Keyence sensor catalogs (course references)', 'https://www.balluff.com/en-us/products/areas/A0001'],
  ].map(([t, u]) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 50 }, children: [new TextRun({ text: t + ': ', size: 19 }), new ExternalHyperlink({ link: u, children: [new TextRun({ text: u, style: 'Hyperlink', size: 17 })] })] })),
];

// ------------------------------------------------------------------ document
const doc = new Document({
  creator: 'Sensors Design Task',
  title: 'Sensors Design Task: machine-tending cell',
  description: 'Sensor selection, placement and work-flow logic for Setup 1 and Setup 2',
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: C.ink } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 30, bold: true, color: C.head }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 25, bold: true, color: C.head }, paragraph: { spacing: { before: 220, after: 90 }, keepNext: true, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 22, bold: true, color: C.ink }, paragraph: { spacing: { before: 160, after: 70 }, keepNext: true, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 240 } } } }] },
      { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 300 } } } }] },
    ],
  },
  sections: [section('P', sec1), section('L', sec2), section('P', sec3), section('L', sec4), section('P', sec5), section('P', sec6)],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log('wrote', OUT, buf.length, 'bytes', 'figures', figN, 'tables', tabN); });
