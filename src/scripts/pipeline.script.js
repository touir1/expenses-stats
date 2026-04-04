#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../utils/cli-args.util');
const { runCommand } = require('../utils/process-runner.util');
const { ensureRatesUpdated } = require('../utils/rate-manager.util');

async function main() {
  // Parse pipeline arguments
  const optionDefs = [
    { flag: '--skip-parsing',  param: false },
    { flag: '--skip-labeling', param: false },
    { flag: '--filter',        param: true,  default: null },
    { flag: '--use-database',  param: false },
    { flag: '--database',      param: true,  default: null }
  ];

  const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);
  const skipParsing  = parsedArgs['skip-parsing'];
  const skipLabeling = parsedArgs['skip-labeling'];
  const filterKey    = parsedArgs['filter'];
  const useDatabase  = parsedArgs['use-database'];
  const databaseArg  = parsedArgs['database'];

  if (showHelp) {
    console.log(`
Usage: node pipeline.script.js [options]

Pipeline Stages (CSV mode):
  1. Parse: Convert depenses.txt → depenses.csv
  2. Label: Add categories → depenses-labeled.csv
  3. Filter (optional): Filter labeled data using named filter
  4. Stats: Generate statistics from labeled/filtered data

Pipeline Stages (--use-database mode):
  1. Parse: Convert depenses.txt → depenses.csv
  2. Label: Add categories → depenses-labeled.csv
  3. DB Insert: Load labeled data into SQLite database
  4. Stats: Generate statistics directly from database

Options:
  --skip-parsing        Skip the parsing step (use existing CSV)
  --skip-labeling       Skip the labeling step (use existing labeled CSV)
  --filter <key>        Apply named filter from config/filters.config.json
                        Available: car, eur, tnd, high_value, low_value, food, transport
  --use-database        Load data into DB then generate stats from DB (no filter.script.js step)
  --database <path>     SQLite database file (default: data/database/depenses.db)
  -h, --help           Show this help message

Examples:
  node pipeline.script.js
  node pipeline.script.js --filter car
  node pipeline.script.js --use-database
  node pipeline.script.js --use-database --filter car
`);
    process.exit(0);
  }

  try {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   EXPENSE ANALYSIS PIPELINE                ║');
    console.log('╚════════════════════════════════════════════╝');

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

    const labeledCsv  = path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv');
    const databaseFile = databaseArg || path.join(__dirname, '..', '..', 'data', 'database', 'depenses.db');
    const statsOutputFile = filterKey
      ? path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-stats.json`)
      : path.join(__dirname, '..', '..', 'output', 'depenses-stats.json');

    if (useDatabase) {
      // Step 3: DB Insert
      await runCommand(
        path.join(__dirname, 'db-insert.script.js'),
        ['--input-file', labeledCsv, '--database', databaseFile],
        { description: 'Step 3: Loading labeled data into database' }
      );

      // Step 4: Stats from DB (filter applied inside stats.script.js via SQL)
      const statsArgs = [
        '--use-database', '--database', databaseFile,
        '--output', 'both', '--output-file', statsOutputFile
      ];
      if (filterKey) statsArgs.push('--filter', filterKey);

      await runCommand(
        path.join(__dirname, 'stats.script.js'),
        statsArgs,
        { description: `Step 4: Generating statistics from database${filterKey ? ` (filter: ${filterKey})` : ''}` }
      );
    } else {
      // Step 3: Filter (optional)
      let inputForStats = labeledCsv;

      if (filterKey) {
        const configPath = path.join(__dirname, '..', '..', 'config', 'filters.config.json');
        const filterConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!filterConfig.filters[filterKey]) {
          throw new Error(`Unknown filter key: "${filterKey}". Available: ${Object.keys(filterConfig.filters).join(', ')}`);
        }
        const filterDef  = filterConfig.filters[filterKey];
        const filterFile = path.join(__dirname, '..', '..', 'config', 'filters', `filter-${filterKey}.json`);
        fs.writeFileSync(filterFile, JSON.stringify(filterDef, null, 2), 'utf-8');

        await runCommand(
          path.join(__dirname, 'filter.script.js'),
          [
            '--input-file',  inputForStats,
            '--output-file', path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-filtered.csv`),
            '--filters-file', filterFile
          ],
          { description: `Step 3: Filtering with "${filterKey}" filter (${filterDef.description})` }
        );
        inputForStats = path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-filtered.csv`);
      }

      // Step 4: Stats from CSV
      await runCommand(
        path.join(__dirname, 'stats.script.js'),
        [
          '--input-file', inputForStats,
          '--output', 'both',
          '--output-file', statsOutputFile,
          '--conversion-rates', path.join(__dirname, '..', '..', 'data', 'processed', 'conversion-rates.csv')
        ],
        { description: 'Step 4: Generating statistics' }
      );
    }

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║   🎉 PIPELINE COMPLETED SUCCESSFULLY!     ║');
    console.log('╚════════════════════════════════════════════╝\n');

    if (filterKey) {
      console.log(`Filter Applied: ${filterKey}`);
      console.log(`Output: ${path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-stats.json`)}`);
    }

  } catch (err) {
    console.error(`\n❌ Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
