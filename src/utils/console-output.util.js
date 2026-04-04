// Standardized console output for consistent messaging across all scripts

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m'
};

// Success message with checkmark
function logSuccess(message, details = null) {
  const line = `${colors.green}✓${colors.reset} ${message}`;
  console.log(line);
  if (details) {
    console.log(`  ${colors.dim}${details}${colors.reset}`);
  }
}

// Error message with X and red color
function logError(message, details = null) {
  const line = `${colors.red}✗${colors.reset} ${colors.red}${message}${colors.reset}`;
  console.error(line);
  if (details) {
    console.error(`  ${colors.dim}${details}${colors.reset}`);
  }
}

// Warning message with warning icon
function logWarning(message, details = null) {
  const line = `${colors.yellow}⚠${colors.reset} ${colors.yellow}${message}${colors.reset}`;
  console.log(line);
  if (details) {
    console.log(`  ${colors.dim}${details}${colors.reset}`);
  }
}

// Info message with info icon
function logInfo(message, details = null) {
  const line = `${colors.cyan}ℹ${colors.reset} ${message}`;
  console.log(line);
  if (details) {
    console.log(`  ${colors.dim}${details}${colors.reset}`);
  }
}

// Highlight/section header
function logSection(title) {
  console.log(`\n${colors.bright}${colors.blue}${title}${colors.reset}`);
}

// Statistics output with formatting
function logStats(label, value, unit = '') {
  const formattedValue = typeof value === 'number' ? value.toLocaleString() : value;
  console.log(`  ${label}: ${colors.bright}${formattedValue}${colors.reset}${unit}`);
}

// Progress indicator
function logProgress(current, total, label = '') {
  const percent = Math.round((current / total) * 100);
  const bar = `${'▓'.repeat(Math.floor(percent / 5))}${'░'.repeat(20 - Math.floor(percent / 5))}`;
  const line = `  [${bar}] ${percent}% (${current}/${total})${label ? ' - ' + label : ''}`;
  process.stdout.write(`\r${line}`);
  if (current === total) console.log('');
}

// Print a key-value pair
function logKeyValue(key, value, indentLevel = 0) {
  const indent = '  '.repeat(indentLevel);
  const formattedValue = typeof value === 'number' ? value.toLocaleString() : value;
  console.log(`${indent}${key}: ${colors.bright}${formattedValue}${colors.reset}`);
}

// Print divider line
function logDivider() {
  console.log('─'.repeat(60));
}

module.exports = {
  colors,
  logSuccess,
  logError,
  logWarning,
  logInfo,
  logSection,
  logStats,
  logProgress,
  logKeyValue,
  logDivider
};
