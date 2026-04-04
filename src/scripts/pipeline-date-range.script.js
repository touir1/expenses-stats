#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../utils/cli-args.util');
const { runCommand } = require('../utils/process-runner.util');
const { ensureRatesUpdated } = require('../utils/rate-manager.util');
const { logSuccess, logError, logWarning, logInfo } = require('../utils/console-output.util');

function validateDateFormat(dateStr) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('/').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

async function main() {
  // Parse pipeline arguments
  const optionDefs = [
    { flag: '--skip-parsing',  param: false },
    { flag: '--skip-labeling', param: false },
    { flag: '--begin-date',    param: true,  default: null },
    { flag: '--end-date',      param: true,  default: null },
    { flag: '--filter',        param: true,  default: null },
    { flag: '--use-database',  param: false },
    { flag: '--database',      param: true,  default: null }
  ];

  const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);
  const skipParsing  = parsedArgs['skip-parsing'];
  const skipLabeling = parsedArgs['skip-labeling'];
  let beginDate      = parsedArgs['begin-date'];
  let endDate        = parsedArgs['end-date'];
  const applyFilter  = parsedArgs['filter'];
  const useDatabase  = parsedArgs['use-database'];
  const databaseArg  = parsedArgs['database'];

  if (showHelp) {
    console.log(`
Usage: node pipeline-date-range.script.js [options]

Pipeline Stages (CSV mode):
  1. Parse → 2. Label → 3. Filter by date → 4. Additional filter (opt) → 5. Stats

Pipeline Stages (--use-database mode):
  1. Parse → 2. Label → 3. DB Insert → 4. Stats from DB (date + filter in SQL)

Options:
  --skip-parsing           Skip the parsing step (use existing CSV)
  --skip-labeling          Skip the labeling step (use existing labeled CSV)
  --begin-date <date>      Start date for filtering (DD/MM/YYYY format, required)
  --end-date <date>        End date for filtering (DD/MM/YYYY format, required)
  --filter <key>           Apply named filter (car, eur, tnd, high_value, low_value, food, transport)
  --use-database           Load data into DB then generate stats from DB (no filter.script.js step)
  --database <path>        SQLite database file (default: data/database/depenses.db)
  -h, --help              Show this help message

Examples:
  node pipeline-date-range.script.js --begin-date "01/03/2026" --end-date "31/03/2026"
  node pipeline-date-range.script.js --begin-date "01/01/2025" --end-date "31/12/2025" --filter car
  node pipeline-date-range.script.js --begin-date "01/01/2025" --end-date "31/12/2025" --use-database
`);
    process.exit(0);
  }

  // Validate date parameters
  if (!beginDate || !endDate) {
    logError('--begin-date and --end-date are required');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  if (!validateDateFormat(beginDate)) {
    logError(`Invalid begin-date format "${beginDate}". Expected DD/MM/YYYY`);
    process.exit(1);
  }

  if (!validateDateFormat(endDate)) {
    logError(`Invalid end-date format "${endDate}". Expected DD/MM/YYYY`);
    process.exit(1);
  }

  const dateRangeSuffix = `${beginDate.replace(/\//g, '-')}-to-${endDate.replace(/\//g, '-')}`;

  try {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   EXPENSE ANALYSIS PIPELINE (DATE RANGE)   ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`Date Range: ${beginDate} to ${endDate}\n`);

    // Check and update conversion rates if needed
    await ensureRatesUpdated();

    // Step 1: Parse
    if (!skipParsing) {
      await runCommand(
        path.join(__dirname, 'parser.script.js'),
        [],
        { description: 'Step 1: Parsing depenses.txt to CSV' }
      );
    } else {
      console.log('⊘ Skipping parsing step');
    }

    // Step 2: Label
    if (!skipLabeling) {
      await runCommand(
        path.join(__dirname, 'label.script.js'),
        [
          '--input-file', path.join(__dirname, '..', '..', 'data', 'processed', 'depenses.csv'),
          '--output-file', path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv'),
          '--categories-file', path.join(__dirname, '..', '..', 'config', 'categories.config.json'),
          '--forced-categories-file', path.join(__dirname, '..', '..', 'config', 'forced-categories.config.json')
        ],
        { description: 'Step 2: Labeling expenses with categories' }
      );
    } else {
      console.log('⊘ Skipping labeling step');
    }

    const labeledCsv   = path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv');
    const databaseFile = databaseArg || path.join(__dirname, '..', '..', 'data', 'database', 'depenses.db');
    const statsOutputFile = applyFilter
      ? path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-${applyFilter}-stats.json`)
      : path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-stats.json`);

    if (useDatabase) {
      // Step 3: DB Insert
      await runCommand(
        path.join(__dirname, 'db-insert.script.js'),
        ['--input-file', labeledCsv, '--database', databaseFile],
        { description: 'Step 3: Loading labeled data into database' }
      );

      // Step 4: Stats from DB (date range + optional filter handled inside stats.script.js)
      const statsArgs = [
        '--use-database', '--database', databaseFile,
        '--begin-date', beginDate, '--end-date', endDate,
        '--output', 'both', '--output-file', statsOutputFile
      ];
      if (applyFilter) statsArgs.push('--filter', applyFilter);

      await runCommand(
        path.join(__dirname, 'stats.script.js'),
        statsArgs,
        { description: `Step 4: Generating statistics from database (${beginDate} to ${endDate}${applyFilter ? `, filter: ${applyFilter}` : ''})` }
      );
    } else {
      // Step 3: Filter by date range
      let inputForStats = labeledCsv;
      const dateFilteredOutput = path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-filtered.csv`);

      await runCommand(
        path.join(__dirname, 'filter.script.js'),
        ['--input-file', inputForStats, '--output-file', dateFilteredOutput, '--begin-date', beginDate, '--end-date', endDate],
        { description: `Step 3: Filtering by date range (${beginDate} to ${endDate})` }
      );
      inputForStats = dateFilteredOutput;

      // Step 4: Apply additional named filter if specified
      if (applyFilter) {
        const configPath = path.join(__dirname, '..', '..', 'config', 'filters.config.json');
        const filterConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!filterConfig.filters[applyFilter]) {
          throw new Error(`Unknown filter key: "${applyFilter}". Available: ${Object.keys(filterConfig.filters).join(', ')}`);
        }
        const filterDef  = filterConfig.filters[applyFilter];
        const filterFile = path.join(__dirname, '..', '..', 'config', 'filters', `filter-${applyFilter}.json`);
        fs.writeFileSync(filterFile, JSON.stringify(filterDef, null, 2), 'utf-8');

        const additionalFilteredOutput = path.join(__dirname, '..', '..', 'output', `depenses-${dateRangeSuffix}-${applyFilter}-filtered.csv`);
        await runCommand(
          path.join(__dirname, 'filter.script.js'),
          ['--input-file', inputForStats, '--output-file', additionalFilteredOutput, '--filters-file', filterFile],
          { description: `Step 4: Applying additional "${applyFilter}" filter (${filterDef.description})` }
        );
        inputForStats = additionalFilteredOutput;
      }

      // Step 5: Stats from CSV
      await runCommand(
        path.join(__dirname, 'stats.script.js'),
        [
          '--input-file', inputForStats,
          '--output', 'both', '--output-file', statsOutputFile,
          '--conversion-rates', path.join(__dirname, '..', '..', 'data', 'processed', 'conversion-rates.csv')
        ],
        { description: applyFilter ? `Step 5: Generating statistics (date range + ${applyFilter} filter)` : 'Step 5: Generating statistics (date range filter)' }
      );
    }

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║   🎉 PIPELINE COMPLETED SUCCESSFULLY!     ║');
    console.log('╚════════════════════════════════════════════╝\n');

    console.log(`Date Range: ${beginDate} to ${endDate}`);
    if (applyFilter) {
      console.log(`Additional Filter: ${applyFilter}`);
    }
    console.log(`Output: ${statsOutputFile}`);

  } catch (err) {
    console.error(`\n❌ Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
