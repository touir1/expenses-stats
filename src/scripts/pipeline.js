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

async function main() {
  const args = process.argv.slice(2);
  let skipParsing = false;
  let skipLabeling = false;
  let applyFilter = null;
  let filterKey = null;

  // Parse pipeline arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-parsing') skipParsing = true;
    if (args[i] === '--skip-labeling') skipLabeling = true;
    if (args[i] === '--filter' && args[i + 1]) {
      filterKey = args[i + 1];
      i++;
    }
    if (args[i] === '-h' || args[i] === '--help') {
      console.log(`
Usage: node pipeline.js [options]

Pipeline Stages:
  1. Parse: Convert depenses.txt → depenses.csv
  2. Label: Add categories to depenses.csv → depenses-labeled.csv
  3. Filter (optional): Filter labeled data using named filter
  4. Stats: Generate statistics from labeled/filtered data

Options:
  --skip-parsing        Skip the parsing step (use existing CSV)
  --skip-labeling       Skip the labeling step (use existing labeled CSV)
  --filter <key>        Apply named filter from config/filters-config.json
                        Available filters: car, eur, tnd, high_value, low_value, food, transport
                        Output: output/depenses-<key>-filtered.csv
  -h, --help           Show this help message

Examples:
  node pipeline.js
  node pipeline.js --skip-parsing
  node pipeline.js --filter car
  node pipeline.js --skip-labeling --filter eur

Filter Keys:
  car          - Car-related expenses (repairs, maintenance, insurance)
  eur          - EUR currency only
  tnd          - TND currency only
  high_value   - Expenses over 100 EUR / 350 TND
  low_value    - Expenses under 50 EUR / 175 TND
  food         - Food-related expenses
  transport    - Transport-related expenses
`);
      process.exit(0);
    }
  }

  try {
    log('green', '╔════════════════════════════════════════════╗');
    log('green', '║   EXPENSE ANALYSIS PIPELINE                ║');
    log('green', '╚════════════════════════════════════════════╝');

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

    // Step 3: Filter (optional)
    let inputForStats = path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv');
    
    if (filterKey) {
      // Load filter config
      const configPath = path.join(__dirname, '..', '..', 'config', 'filters-config.json');
      const filterConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      if (!filterConfig.filters[filterKey]) {
        throw new Error(`Unknown filter key: "${filterKey}". Available: ${Object.keys(filterConfig.filters).join(', ')}`);
      }

      const filterDef = filterConfig.filters[filterKey];
      const filterFile = path.join(__dirname, '..', '..' , 'config', `filter-${filterKey}.json`);
      
      // Write filter to temp file (include category reference if present)
      fs.writeFileSync(filterFile, JSON.stringify(filterDef, null, 2), 'utf-8');

      await runCommand(
        'filter.js',
        [
          '--input-file', inputForStats,
          '--output-file', path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-filtered.csv`),
          '--filters-file', filterFile
        ],
        `Step 3: Filtering with "${filterKey}" filter (${filterDef.description})`
      );

      // Update input for stats to use filtered output
      inputForStats = path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-filtered.csv`);
    }

    // Step 4: Stats
    const statsOutputFile = filterKey 
      ? path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-stats.json`)
      : path.join(__dirname, '..', '..', 'output', 'depenses-stats.json');

    await runCommand(
      'stats.js',
      [
        '--input-file', inputForStats,
        '--output', 'both',
        '--output-file', statsOutputFile,
        '--conversion-rates', path.join(__dirname, '..', '..', 'config', 'conversion_rates.csv')
      ],
      'Step 4: Generating statistics'
    );

    log('green', '\n╔════════════════════════════════════════════╗');
    log('green', '║   🎉 PIPELINE COMPLETED SUCCESSFULLY!     ║');
    log('green', '╚════════════════════════════════════════════╝\n');

    if (filterKey) {
      log('blue', `Filter Applied: ${filterKey}`);
      log('blue', `Output: ${path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-stats.json`)}`);
    }

  } catch (err) {
    log('red', `\n❌ Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
