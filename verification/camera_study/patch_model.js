// The recovery changes proposed in step A2.1, applied in memory to the shared model:
// a FAULT repeats the state, so jobs that move a part run only when the gripper still holds it,
// and the conveyor start-up checks are repeated until they read clear.
module.exports = function patch(M) {
  const S = (k) => Object.values(M.MACHINES).find((m) => m.states && m.states[k]);
  const b7 = S('B7').states.B7.do;
  b7[2] = Object.assign({}, b7[2], { when: 'GR-21B' });
  b7[3] = Object.assign({}, b7[3], { when: 'GR-21B' });
  const r2 = S('E2');
  r2.states.E2.do[0] = Object.assign({}, r2.states.E2.do[0], { when: '!GR-51' });
  r2.states.E3.do[0] = Object.assign({}, r2.states.E3.do[0], { when: 'GR-51' });
  const conv = S('C1');
  conv.initial = Object.assign({}, conv.initial, { do: conv.initial.do.map((st) => Object.assign({}, st, { until: '!' + st.check })) });
  return M;
};
