// Exhaustive camera study with the recovery changes of ../camera_policy.md §3 applied in memory.
//   cd source && FAULTS=mismatch,camwrong,timeout node --max-old-space-size=8000 ../verification/camera_study/study_fixed.js [outDir]
const path = require('path');
const SRC = path.join(__dirname, '..', '..', 'source');
require('./patch_model.js')(require(path.join(SRC, 'src', 'cell-model.js')));
process.argv[2] = process.argv[2] || path.join(SRC, 'out', 'study_fixed');
require(path.join(SRC, 'camera_study.js'));
