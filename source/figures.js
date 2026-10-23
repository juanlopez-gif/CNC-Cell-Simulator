// The figures of the repository (diagrams/): file name and the generator call of src/cell-diagrams.js.
// Used by render.js (SVG + PNG), build_all.js (check) and regress.js (fingerprint).
const D = require('./src/cell-diagrams.js');

module.exports = [
  ['fig02_control_architecture', () => D.archDiagram({})],
  ['fig03_crosscheck_flow', () => D.flowCrossCheck({})],
  ['fig04_supervisor_states', () => D.smSupervisor({})],
  ['fig07_states_conveyor', () => D.smConveyor({})],
  ['fig09_layout_setup2', () => D.layoutSvg({ snapshot: true })],
  ['fig10_timing_setup1_vs_setup2', () => D.timingChart({})],
  ['fig11_flow_setup2', () => D.flowSetup2({})],
  ['fig12_states_robot1_setup2', () => D.smRobot1S2({})],
  ['fig13_states_robot2_setup2', () => D.smRobot2S2({})],
  ['fig14_dual_gripper_exchange', () => D.exchangeStrip({})],
];
