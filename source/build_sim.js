// Bundle the simulator into one self-contained HTML page.
//   out/sim/index.html      stand-alone file (opens from disk)
//   out/sim/artifact.html   same page without the document skeleton (for publishing)
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const D = require('./src/cell-diagrams.js');

const fonts = 'https://fonts.googleapis.com/css2?family=Barlow:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Barlow+Semi+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
const head = `<title>CNC Cell Simulator</title>
<meta name="description" content="Live state-machine simulation of a CNC machine-tending cell with camera and proximity sensor cross-checking.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>
${R('sim-src/app.css')}
/* shared diagram styles */
${D.CSS}
</style>`;
const scripts = `<script>
${R('src/cell-model.js')}
</script>
<script>
${R('src/cell-diagrams.js')}
</script>
<script>
${R('sim-src/app.js')}
</script>`;
const body = R('sim-src/body.html');

const outDir = path.join(__dirname, 'out', 'sim');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'artifact.html'), `${head}\n${body}\n${scripts}\n`);
fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${body}
${scripts}
</body>
</html>
`);
console.log('built', fs.statSync(path.join(outDir, 'index.html')).size, 'bytes');
