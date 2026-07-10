/**
 * Project root for dev vs packaged (asar) layouts.
 * PowerShell and native addons need real filesystem paths outside app.asar.
 */
const path = require('path');

function projectRoot() {
  if (__dirname.includes('app.asar')) {
    return path.join(process.resourcesPath, 'app.asar.unpacked');
  }
  return path.join(__dirname, '..');
}

/** @param {...string} parts */
function fromRoot(...parts) {
  return path.join(projectRoot(), ...parts);
}

module.exports = { projectRoot, fromRoot };
