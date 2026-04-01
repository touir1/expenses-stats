#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Color output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

function log(color, msg) {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function runCommand(cmd, args, description) {
  return new Promise((resolve, reject) => {
    log('blue', `\n📌 ${description}`);
    const proc = spawn('node', [cmd, ...args], {
      cwd: path.join(__dirname),
      stdio: 'inherit'
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        log('red', `❌ Command failed with exit code ${code}`);
        reject(new Error(`${description} failed`));
      } else {
        log('green', `✓ ${description} completed`);
        resolve();
      }
    });

    proc.on('error', (err) => {
      log('red', `❌ Error: ${err.message}`);
      reject(err);
    });
  });
}

async function ensureRatesUpdated() {
  try {
    const ratesPath = path.join(__dirname, '..', '..', 'config', 'conversion_rates.csv');
    const content = fs.readFileSync(ratesPath, 'utf-8');
    const lines = content.trim().split('\n');
    
    if (lines.length < 2) {
      log('yellow', 'Warning: conversion_rates.csv is empty or invalid');
      return;
    }

    // Get the last date from the CSV (skip header)
    const lastLine = lines[lines.length - 1];
    const lastDate = lastLine.split(',')[0];
    
    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    if (lastDate !== todayStr) {
      log('yellow', `\n⚠️  Conversion rates are outdated (last: ${lastDate}, today: ${todayStr})`);
      log('blue', '📌 Attempting to update conversion rates...');
      try {
        const proc = spawn('node', ['update-rates.js', '--auto'], {
          cwd: path.join(__dirname),
          stdio: 'inherit'
        });

        await new Promise((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) {
              log('green', '✓ Conversion rates updated');
            } else {
              log('yellow', `⚠️  Rate update failed with exit code ${code}, continuing with existing rates`);
            }
            resolve();
          });
          proc.on('error', () => {
            log('yellow', '⚠️  Rate update failed, continuing with existing rates');
            resolve();
          });
        });
      } catch (err) {
        log('yellow', `⚠️  Could not update rates: ${err.message}, continuing with existing rates`);
      }
    } else {
      log('green', `✓ Conversion rates are current (${lastDate})`);
    }
  } catch (err) {
    log('yellow', `⚠️  Could not check conversion rates: ${err.message}, continuing...`);
  }
}

function validateDateFormat(dateStr) {
  const regex = /^\d{2}\/\d{2}\/\d{4}$/;
  return regex.test(dateStr);
}

async function main() {
  const args = process.argv.slice(2);
  let skipParsing = false;
  let skipLabeling = false;
  let beginDate = null;
  let endDate = null;
  let applyFilter = null;

  // Parse pipeline arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-parsing') skipParsing = true;
    if (args[i] === '--skip-labeling') skipLabeling = true;
    if (args[i] === '--begin-date' && args[i + 1]) {
      beginDate = args[i + 1];
      i++;
    }
    if (args[i] === '--end-date' && args[i + 1]) {
      endDate = args[i + 1];
      i++;
    }
    if (args[i] === '--filter' && args[i + 1]) {
      applyFilter = args[i + 1];
      i++;
    }
    if (args[i] === '-h' || args[i] === '--help') {
      console.log(`
Usage: node pipeline-date-range.js [options]

Pipeline Stages:
  1. Parse: Convert depenses.txt → depenses.csv
  2. Label: Add categories to depenses.csv → depenses-labeled.csv
  3. Filter by Date Range: Filter by date range (optional)
  4. Additional Filter (optional): Apply named filter from config
  5. Stats: Generate statistics from filtered data

Options:
  --skip-parsing           Skip the parsing step (use existing CSV)
  --skip-labeling          Skip the labeling step (use existing labeled CSV)
  --begin-date <date>      Start date for filtering (DD/MM/YYYY format, required)
  --end-date <date>        End date for filtering (DD/MM/YYYY format, required)
  --filter <key>           Apply additional named filter from config/filters-config.json
                           Available: car, eur, tnd, high_value, low_value, food, transport
  -h, --help              Show this help message

Examples:
  node pipeline-date-range.js --begin-date "01/03/2026" --end-date "31/03/2026"
  node pipeline-date-range.js --begin-date "01/01/2024" --end-date "31/12/2024" --filter car
  node pipeline-date-range.js --skip-parsing --begin-date "01/03/2026" --end-date "31/03/2026"

Output Files:
  - depenses-<begin>-to-<end>-filtered.csv
  - depenses-<begin>-to-<end>-stats.json
  - Or with filter: depenses-<begin>-to-<end>-<filter>-filtered.csv
`);
      process.exit(0);
    }
  }

  // Validate date parameters
  if (!beginDate || !endDate) {
    log('red', '❌ Error: --begin-date and --end-date are required');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  if (!validateDateFormat(beginDate)) {
    log('red', `❌ Error: Invalid begin-date format "${beginDate}". Expected DD/MM/YYYY`);
    process.exit(1);
  }

  if (!validateDateFormat(endDate)) {
    log('red', `❌ Error: Invalid end-date format "${endDate}". Expected DD/MM/YYYY`);
    process.exit(1);
  }

  const dateRangeSuffix = `${beginDate.replace(/\//g, '-')}-to-${endDate.replace(/\//g, '-')}`;

  try {
    log('green', '╔════════════════════════════════════════════╗');
    log('green', '║   EXPENSE ANALYSIS PIPELINE (DATE RANGE)   ║');
    log('green', '╚════════════════════════════════════════════╝');
    log('blue', `Date Range: ${beginDate} to ${endDate}\n`);

    // Check and update conversion rates if needed
    await ensureRatesUpdated();

    // Step 1: Parse
    if (!skipParsing) {
      await runCommand(
        'parser.js',
        [],
        'Step 1: Parsing depenses.txt to CSV'
      );
    } else {
      log('yellow', '⊘ Skipping parsing step');
    }

    // Step 2: Label
    if (!skipLabeling) {
      await runCommand(
        'label.js',
        [
          '--input-file', path.join(__dirname, '..', '..', 'data', 'processed', 'depenses.csv'),
          '--output-file', path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv'),
          '--categories-file', path.join(__dirname, '..', '..', 'config', 'categories.json'),
          '--forced-categories-file', path.join(__dirname, '..', '..', 'config', 'forced-categories.json')
        ],
        'Step 2: Labeling expenses with categories'
      );
    } else {
      log('yellow', '⊘ Skipping labeling step');
    }

    // Step 3: Filter by date range
    let inputForStats = path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv');
    const dateFilteredOutput = path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-filtered.csv`);

    await runCommand(
      'filter.js',
      [
        '--input-file', inputForStats,
        '--output-file', dateFilteredOutput,
        '--begin-date', beginDate,
        '--end-date', endDate
      ],
      `Step 3: Filtering by date range (${beginDate} to ${endDate})`
    );

    inputForStats = dateFilteredOutput;

    // Step 4: Apply additional filter if specified
    if (applyFilter) {
      const configPath = path.join(__dirname, '..', '..', 'config', 'filters-config.json');
      const filterConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      if (!filterConfig.filters[applyFilter]) {
        throw new Error(`Unknown filter key: "${applyFilter}". Available: ${Object.keys(filterConfig.filters).join(', ')}`);
      }

      const filterDef = filterConfig.filters[applyFilter];
      const filterFile = path.join(__dirname, '..', '..' , 'config', `filter-${applyFilter}.json`);
      
      fs.writeFileSync(filterFile, JSON.stringify(filterDef, null, 2), 'utf-8');

      const additionalFilteredOutput = path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-${applyFilter}-filtered.csv`);

      await runCommand(
        'filter.js',
        [
          '--input-file', inputForStats,
          '--output-file', additionalFilteredOutput,
          '--filters-file', filterFile
        ],
        `Step 4: Applying additional "${applyFilter}" filter (${filterDef.description})`
      );

      inputForStats = additionalFilteredOutput;
    }

    // Step 5: Stats
    const statsOutputFile = applyFilter
      ? path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-${applyFilter}-stats.json`)
      : path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-stats.json`);

    await runCommand(
      'stats.js',
      [
        '--input-file', inputForStats,
        '--output', 'both',
        '--output-file', statsOutputFile,
        '--conversion-rates', path.join(__dirname, '..', '..', 'config', 'conversion_rates.csv')
      ],
      applyFilter ? `Step 5: Generating statistics (date range + ${applyFilter} filter)` : 'Step 5: Generating statistics (date range filter)'
    );

    log('green', '\n╔════════════════════════════════════════════╗');
    log('green', '║   🎉 PIPELINE COMPLETED SUCCESSFULLY!     ║');
    log('green', '╚════════════════════════════════════════════╝\n');

    log('blue', `Date Range: ${beginDate} to ${endDate}`);
    if (applyFilter) {
      log('blue', `Additional Filter: ${applyFilter}`);
    }
    log('blue', `Output: ${statsOutputFile}`);

  } catch (err) {
    log('red', `\n❌ Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
