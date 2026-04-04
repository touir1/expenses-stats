// Process execution utility for running Node scripts with consistent logging and error handling

const { spawn } = require('child_process');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

// Log with color
function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Run a Node script as a child process
function runCommand(scriptPath, args = [], options = {}) {
  const {
    description = `Running ${path.basename(scriptPath)}`,
    verbose = false,
    timeout = null,
    showOutput = true
  } = options;

  return new Promise((resolve, reject) => {
    log('blue', `\n📌 ${description}`);

    const proc = spawn('node', [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: showOutput ? 'inherit' : 'pipe'
    });

    let timeoutHandle = null;
    if (timeout) {
      timeoutHandle = setTimeout(() => {
        proc.kill();
        reject(new Error(`Process timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      log('red', `✗ Error running ${path.basename(scriptPath)}: ${err.message}`);
      reject(err);
    });

    proc.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (code === 0) {
        log('green', `✓ ${description} completed successfully`);
        resolve({ code, output: '' });
      } else {
        const err = new Error(`${path.basename(scriptPath)} exited with code ${code}`);
        log('red', `✗ ${err.message}`);
        reject(err);
      }
    });
  });
}

// Run multiple commands sequentially
async function runSequential(commands) {
  const results = [];
  for (const cmd of commands) {
    const result = await runCommand(cmd.scriptPath, cmd.args, cmd.options);
    results.push(result);
  }
  return results;
}

module.exports = {
  log,
  colors,
  runCommand,
  runSequential
};
