// Rate manager utility for checking and updating conversion rates

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getProjectRoot } = require('./path-resolver');
const { logWarning, logSuccess, logInfo, colors } = require('./console-output');

// Simple log wrapper using console-output colors
function log(color, message) {
  const colorMap = {
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    red: colors.red
  };
  console.log(`${colorMap[color] || colors.reset}${message}${colors.reset}`);
}

// Check if conversion rates are current and attempt to update if outdated
async function ensureRatesUpdated(ratesPath = null) {
  try {
    if (!ratesPath) {
      ratesPath = path.join(getProjectRoot(), 'config', 'conversion_rates.csv');
    }

    const content = fs.readFileSync(ratesPath, 'utf-8');
    const lines = content.trim().split('\n');
    
    if (lines.length < 2) {
      logWarning('conversion_rates.csv is empty or invalid');
      return;
    }

    // Get the last date from the CSV (skip header)
    const lastLine = lines[lines.length - 1];
    const lastDate = lastLine.split(',')[0];
    
    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    if (lastDate !== todayStr) {
      logWarning(`Conversion rates are outdated (last: ${lastDate}, today: ${todayStr})`)
      logInfo('Attempting to update conversion rates');
      try {
        const proc = spawn('node', [path.join(getProjectRoot(), 'src', 'scripts', 'update-rates.js'), '--auto'], {
          cwd: getProjectRoot(),
          stdio: 'inherit'
        });

        await new Promise((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) {
              logSuccess('Conversion rates updated');
            } else {
              logWarning(`Rate update failed with exit code ${code}, continuing with existing rates`);
            }
            resolve();
          });
          proc.on('error', () => {
            logWarning('Rate update failed, continuing with existing rates');
            resolve();
          });
        });
      } catch (err) {
        logWarning(`Could not update rates: ${err.message}, continuing with existing rates`);
      }
    } else {
      logSuccess('Conversion rates are current', lastDate);
    }
  } catch (err) {
    logWarning(`Could not check conversion rates: ${err.message}, continuing...`);
  }
}

module.exports = {
  ensureRatesUpdated,
  log
};
