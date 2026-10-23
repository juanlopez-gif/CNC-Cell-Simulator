// Path of the Chrome executable used by puppeteer-core: the CHROME environment variable, else the
// usual install location on this platform.
const fs = require('fs');

const DEFAULTS = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
};
const CHROME = process.env.CHROME || DEFAULTS[process.platform] || DEFAULTS.linux;
if (!fs.existsSync(CHROME)) console.error(`Chrome not found at ${CHROME}: set CHROME=<path to the Chrome executable>`);

module.exports = { CHROME };
