// Short Word answer for the Week 2 Sensors Design Task (Setup 1 + Setup 2).
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, ImageRun, Footer, PageNumber, LevelFormat, ExternalHyperlink, TabStopType, VerticalAlign,
} = require('docx');
const M = require('./src/cell-model.js');

const OUT = process.argv[2] || path.join(__dirname, 'out', 'Week2_Assignment_Answer.docx');
const K = M.KPI;
const FONT = 'Calibri', MONO = 'Consolas';
const C = { ink: '15202B', muted: '5A6773', blue: '0B5AA6', cp: '7B3FB5', head: '1F3A56', rule: 'C3CCD5', th: 'E2E8EE', zebra: 'F6F8FA' };
const REPO = 'https://github.com/juanlopez-gif/CNC-Cell-Simulator';
const LIVE = 'https://juanlopez-gif.github.io/CNC-Cell-Simulator/';

// {TAG} sensor tag (mono blue) · *bold*
function runs(text, base) {
  base = base || {};
  const out = [];
  let i = 0, m;
  const re = /\{([^}]+)\}|\*([^*]+)\*/g;
  const sz = base.size || 21;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(new TextRun({ text: text.slice(i, m.index), ...base }));
    if (m[1]) out.push(new TextRun({ text: m[1], ...base, font: MONO, size: sz - 2, color: C.blue }));
    else out.push(new TextRun({ text: m[2], ...base, bold: true }));
    i = re.lastIndex;
  }
  if (i < text.length) out.push(new TextRun({ text: text.slice(i), ...base }));
  return out;
}
const para = (text, o) => { o = o || {}; return new Paragraph({ children: runs(text, o.run), keepNext: o.keepNext, spacing: { before: o.before || 0, after: o.after === undefined ? 110 : o.after, line: 270 } }); };
const h1 = (t, o) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: !!(o && o.page), children: [new TextRun(t)] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(t)] });
const bullet = (t) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runs(t), spacing: { after: 60, line: 264 } });
let listN = 0;
const steps = (items) => { const inst = ++listN; return items.map((t) => new Paragraph({ numbering: { reference: 'steps', level: 0, instance: inst }, children: runs(t), spacing: { after: 55, line: 264 } })); };

let figN = 0, tabN = 0;
function pngSize(file) { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
function figure(file, cap, maxWin, maxHin) {
  const { w, h } = pngSize(file);
  let dw = maxWin * 96, dh = (dw * h) / w;
  if (dh > maxHin * 96) { dh = maxHin * 96; dw = (dh * w) / h; }
  const n = ++figN;
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 80, after: 40 }, children: [new ImageRun({ type: 'png', data: fs.readFileSync(file), transformation: { width: Math.round(dw), height: Math.round(dh) }, altText: { title: `Figure ${n}`, description: cap, name: path.basename(file) } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: runs(`Figure ${n}. ${cap}`, { italics: true, size: 18, color: C.muted }) }),
  ];
}
function table(title, cols, rows) {
  const W = cols.reduce((s, c) => s + c.w, 0);
  const b = { style: BorderStyle.SINGLE, size: 4, color: C.rule };
  const cell = (text, w, head, shade, bold) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: head ? { fill: C.th, type: ShadingType.CLEAR, color: 'auto' } : shade ? { fill: C.zebra, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 }, verticalAlign: VerticalAlign.TOP,
    children: [new Paragraph({ children: runs(String(text), { size: 17, bold: head || bold || undefined, color: head ? C.head : C.ink }), spacing: { after: 10, line: 230 } })],
  });
  return [
    new Paragraph({ keepNext: true, spacing: { before: 120, after: 70 }, children: runs(`Table ${++tabN}. ${title}`, { bold: true, size: 19, color: C.head }) }),
    new Table({
      width: { size: W, type: WidthType.DXA }, columnWidths: cols.map((c) => c.w),
      borders: { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b },
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: cols.map((c) => cell(c.h, c.w, true)) }),
        ...rows.map((r, i) => new TableRow({ cantSplit: true, children: r.map((t, j) => cell(t, cols[j].w, false, i % 2 === 1, r.bold)) })),
      ],
    }),
  ];
}
const link = (text, url) => new ExternalHyperlink({ link: url, children: [new TextRun({ text, style: 'Hyperlink' })] });

const PW = 12240 - 2 * 1296;   // 9648 DXA (6.7 in)
const FIGDIR = path.join(__dirname, 'out', 'doc');

const sensorRows = [
  ['{PX-11}', 'IR diffuse proximity sensor', 'Input pallet present (checked together with CAM-1)', 'AutomationDirect FFI7-0P-1E', '$92'],
  ['{CAM-1}', 'Camera + LED bar light', 'Locates the parts on the input pallet; sees the conveyor entry', 'Luxonis OAK-D Pro PoE + AutomationDirect PD01ZD5UY', '$579 + $469'],
  ['{GR-21}', 'Electric gripper with grip sensing', 'Confirms that Robot 1 holds the part', 'OnRobot RG2', '$5,580*'],
  ['{ZS-31}', 'Door-open position sensor', 'Door fully open: the robot may enter the CNC', 'CNC door kit (or AutomationDirect AEM2G42X11-3)', 'kit ($35.50)'],
  ['{ZS-32}', 'Door-closed position sensor', 'Door closed: cycle start allowed', 'CNC door kit (or AutomationDirect AEM2G42X11-3)', 'kit ($35.50)'],
  ['{ZS-33}', 'Safety interlock with guard locking', 'Keeps the door locked while the spindle turns', 'CNC door kit (or IDEM KL1-P-221002)', 'kit ($252)'],
  ['{ZS-34} / {ZS-35}', 'Vise position sensors (reed switches)', 'Vise open / part clamped', 'SMC D-M9 (vise kit)', 'kit'],
  ['{PS-36}', 'Air-gap sensor in the vise', 'Part seated flat, no chip under it', 'SMC ISA3', 'kit'],
  ['{PE-41}', 'IR through-beam pair', 'Part at the conveyor entry (with CAM-1)', 'AutomationDirect QMIHD-0P-0F', '$81'],
  ['{ENC-43}', 'Rotary encoder, 600 ppr, on an idler roller', 'Belt really moving or stopped (robots only work at the belt when it is stopped)', 'Koyo TRD-N600-RZWD', '$196'],
  ['{PE-42}', 'IR through-beam pair', 'Part at the end stop: stops the belt (with CAM-2)', 'AutomationDirect QMIHD-0P-0F', '$81'],
  ['{CAM-2}', 'Camera + LED bar light', 'Pick position at the conveyor exit; free and full slots on the output pallet', 'Luxonis OAK-D Pro PoE + AutomationDirect PD01ZD5UY', '$579 + $469'],
  ['{GR-51}', 'Electric gripper with grip sensing', 'Confirms that Robot 2 holds the part', 'OnRobot RG2', '$5,580*'],
  ['{PX-52}', 'IR diffuse proximity sensor', 'Output pallet present; OFF then ON = pallet swapped (with CAM-2)', 'AutomationDirect FFI7-0P-1E', '$92'],
  ['{LT-53}', 'Blue LED beacon', 'Output pallet full, ready to be picked up', 'Patlite 1-tier LED signal light', '≈ $106'],
  ['{LT-01}', 'Stack light red / amber / green', 'Running, warning or line stopped', 'Patlite LR6-302WJBW-RYG', 'quote'],
  ['{PLC-01}', 'PLC + HMI connection', 'Runs the sequence and the camera / proximity check', 'AutomationDirect BRX BX-DM1E-18ED13-D', '$476'],
  ['–', 'Safety relay, power supply, extra I/O, terminals', 'Wiring for the sensors and the safety circuit', 'AutomationDirect (various)', '≈ $388'],
];
sensorRows.push(Object.assign(['', '*Total*', '*Sensors, cameras, lights and PLC*', '', '*≈ $3,608*'], { bold: false }));

const body = [
  new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: 'Sensors Design Task', size: 40, bold: true, color: C.head })] }),
  new Paragraph({ spacing: { after: 220 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: C.head, space: 6 } }, children: [new TextRun({ text: 'Week 2 · Machine-tending cell: CNC, two UR10e robots and a conveyor', size: 23, color: C.muted })] }),

  h1('Setup 1'),
  h2('How the cell works'),
  para('The cell PLC runs the cycle one step at a time. A step starts only after the sensor of the previous step confirms it; if the confirmation does not arrive in time, the cell stops with an alarm that names the sensor.'),
  ...steps([
    'The operator loads the input pallet. {PX-11} and {CAM-1} confirm the pallet, and {CAM-1} gives Robot 1 the position of the next part.',
    'When the CNC reports *cycle complete* and *spindle stopped*, the door lock {ZS-33} releases and Robot 1 slides the door open with its empty gripper ({ZS-31} confirms fully open).',
    'Robot 1 takes the finished part out of the vise ({ZS-34} open) and places it on the conveyor, only while the belt is stopped ({ENC-43} = 0). {PE-41} and {CAM-1} confirm the part is on the belt.',
    'Robot 1 picks a raw part ({GR-21} confirms the grip), loads it in the vise ({ZS-35} clamped, {PS-36} seated), closes the door ({ZS-32} closed, {ZS-33} locked) and sends cycle start.',
    'The belt carries the part to the end stop. {PE-42} stops the belt, {ENC-43} confirms zero speed and {CAM-2} gives Robot 2 the pick position.',
    'Robot 2 places the part on the output pallet. After the 12th part (count confirmed by {CAM-2}) the blue light {LT-53} turns on until the operator swaps the pallet ({PX-52} OFF → ON).',
  ]),
  para('*Camera + proximity rule.* At each detection point an IR proximity sensor and a camera must agree. If they disagree, the camera value is used and the event is logged. Three disagreements within 10 minutes stop the line until the sensors are checked and the operator resets. Safety devices (door interlock, E-stops) are hardwired and are never overridden by the camera.', { before: 80 }),
  para('*CNC door kit.* The CNC maker\'s kit normally supplies the door open and closed sensors ({ZS-31}, {ZS-32}), the guard-locking interlock ({ZS-33}), the vise clamp sensors ({ZS-34}, {ZS-35}), the part-seated air sensor ({PS-36}) and the robot interface signals (cycle start, cycle complete, alarm).'),
  ...table('Setup 1 sensors', [
    { h: 'Tag', w: 1150 }, { h: 'Sensor', w: 2050 }, { h: 'Function', w: 2900 }, { h: 'Brand / model', w: 2400 }, { h: 'Price (USD)', w: 1148 },
  ], sensorRows),
  para('Catalog list prices checked on the vendor websites in September 2026. "kit" = supplied with the CNC door kit (price of a stand-alone equivalent in brackets). * Only if the robots do not already have grippers. Taxes, shipping and installation are not included.', { run: { size: 17, color: C.muted }, before: 60 }),
  ...figure(path.join(FIGDIR, 'fig01_layout_setup1.png'), 'Setup 1 layout with the sensor placement (top view, not to scale).', 6.7, 4.4),

  h1('Setup 2', { page: true }),
  para(`A part is accepted only if its length, width and height are all *≥ 48.00 mm* (50 mm nominal − 2 mm). Undersized parts go to a separate non-conforming area. The CNC is the bottleneck, so the flow is also rearranged to keep its idle time short.`),
  bullet('*Gauge station at Robot 2.* Three laser displacement sensors ({LS-61}, {LS-62}, {LS-63}: Keyence IL-065, price on quote) measure length, width and height against three fixed datums. {PX-64} (FFI7-0P-1E, $92) confirms the part is in the nest. Squareness and flatness are below 0.1 mm, so one reading per face is enough, and the parts are already clean from the CNC.'),
  bullet('*Non-conforming chute* next to the output pallet, with the drop sensor {PE-65} (QMIHD-0P-0F, $81). Two NOK parts in a row hold the CNC, because they point to tool wear or a wrong offset.'),
  bullet('*Dual gripper on Robot 1* (OnRobot Dual Quick Changer + a second RG2, $5,580). Robot 1 picks the next raw part with gripper A while the CNC is still machining, then waits at the door. When the cycle ends, gripper B unloads, the wrist turns 180° and gripper A loads (Figure 2). Robot 2 measures in parallel, so the inspection never makes the CNC wait.'),
  ...figure(path.join(FIGDIR, 'fig14_dual_gripper_exchange.png'), 'Part exchange with the dual gripper. The CNC only waits during steps 2 to 5.', 6.7, 2.2),
  para(`*Result:* CNC idle time per part drops from ${K.idle1} s to ${K.idle2} s, CNC utilization rises from ${(K.util1 * 100).toFixed(1)} % to ${(K.util2 * 100).toFixed(1)} % and output from ${K.pph1.toFixed(1)} to ${K.pph2.toFixed(1)} parts per hour (Figure 3).`, { keepNext: true }),
  ...figure(path.join(FIGDIR, 'fig10_timing_setup1_vs_setup2.png'), 'Timing of one CNC cycle in Setup 1 and Setup 2.', 6.7, 2.9),
  ...figure(path.join(__dirname, 'out', 'sim_setup2_overview.png'), 'Simulation of Setup 2: gauge station, NOK chute and dual gripper (A empty, B carrying the finished part to the conveyor).', 6.7, 3.8),

  h1('GitHub repository and simulation'),
  new Paragraph({ spacing: { after: 110, line: 270 }, children: [
    new TextRun('In addition to this answer, I created a public GitHub repository, '),
    new TextRun({ text: 'CNC Cell Simulator', bold: true }),
    new TextRun(' ('), link(REPO, REPO), new TextRun('). It contains the full design report, every state diagram and flowchart, and an interactive simulation that runs in the browser ('), link(LIVE, LIVE),
    new TextRun('). The simulation runs both setups step by step, shows the sensors and the camera / proximity check live, and lets you test failures such as a dirty sensor that ends in a line stop or an undersized part in Setup 2.'),
  ] }),
];

const doc = new Document({
  creator: 'Sensors Design Task', title: 'Sensors Design Task: Week 2 answer',
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: C.ink } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 29, bold: true, color: C.head }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 24, bold: true, color: C.head }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, outlineLevel: 1 } },
    ],
  },
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }] },
    { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 300 } } } }] },
  ] },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1150, bottom: 1080, left: 1296, right: 1296, header: 500, footer: 500 } } },
    footers: { default: new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: PW }], children: [new TextRun({ text: 'Sensors Design Task · Week 2', size: 16, color: C.muted }), new TextRun({ text: '\tPage ', size: 16, color: C.muted }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: C.muted })] })] }) },
    children: body,
  }],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log('wrote', OUT, buf.length, 'bytes · figures', figN, '· tables', tabN); });
