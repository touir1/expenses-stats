#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../utils/cli-args.util');
const { runCommand } = require('../utils/process-runner.util');
const { ensureRatesUpdated } = require('../utils/rate-manager.util');
const { getDefaultPaths } = require('../utils/path-resolver.util');
const { logError } = require('../utils/console-output.util');

async function main() {
  // Parse pipeline arguments
  const optionDefs = [
    { flag: '--skip-parsing',  param: false },
    { flag: '--skip-labeling', param: false },
    { flag: '--filter',        param: true,  default: null },
    { flag: '--use-database',           param: false },
    { flag: '--database',               param: true,  default: null },
    { flag: '--reset-database',         param: false },
    { flag: '--reset-database-labels',  param: false },
    { flag: '--force-labels',           param: false }
  ];

  const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);
  const skipParsing          = parsedArgs['skip-parsing'];
  const skipLabeling         = parsedArgs['skip-labeling'];
  const filterKey            = parsedArgs['filter'];
  const useDatabase          = parsedArgs['use-database'];
  const databaseArg          = parsedArgs['database'];
  const resetDatabase        = parsedArgs['reset-database'];
  const resetDatabaseLabels  = parsedArgs['reset-database-labels'];
  const forceLabels          = parsedArgs['force-labels'];

  if (showHelp) {
    console.log(`
Usage: node pipeline.script.js [options]

Pipeline Stages (CSV mode):
  1. Parse: Convert depenses.txt → depenses.csv
  2. Label: Add categories → depenses-labeled.csv
  3. Filter (optional): Filter labeled data using named filter
  4. Stats: Generate statistics from labeled/filtered data

Pipeline Stages (--use-database mode, default):
  1. Parse: Convert depenses.txt → depenses.csv
  2. Label: Add categories → depenses-labeled.csv (kept for CSV mode)
  3. DB Insert: Load data into SQLite WITHOUT labels (category_id = NULL)
  4. Gen Validation: Write depenses-validation.csv with guessed labels for user review
  → Pipeline exits here. Edit the validation file, then run:
      npm run db:apply-labels
      npm run stats -- --use-database

Pipeline Stages (--use-database --force-labels mode):
  1. Parse / 2. Label / 3. DB Insert WITH labels / 4. Stats (old behaviour)

Options:
  --skip-parsing        Skip the parsing step (use existing CSV)
  --skip-labeling       Skip the labeling step (use existing labeled CSV)
  --filter <key>        Apply named filter from config/filters.config.json
                        Available: car, eur, tnd, high_value, low_value, food, transport
  --use-database        Load data into DB (validation gate active by default)
  --database <path>     SQLite database file (default: data/database/depenses.db)
  --reset-database        Drop and recreate DB tables before inserting (implies --use-database)
  --reset-database-labels Drop and recreate DB tables only when labeling ran (noop with --skip-labeling)
  --force-labels          Skip validation gate: commit labels immediately (restores old behaviour)
  -h, --help           Show this help message

Examples:
  node pipeline.script.js
  node pipeline.script.js --filter car
  node pipeline.script.js --use-database
  node pipeline.script.js --use-database --force-labels
`);
    process.exit(0);
  }

  const defaults = getDefaultPaths();

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
          '--input-file',              defaults.parsedFile,
          '--output-file',             defaults.inputFile,
          '--categories-file',         defaults.categoriesFile,
          '--forced-categories-file',  defaults.forcedCategoriesFile
        ],
        { description: 'Step 2: Labeling expenses with categories' }
      );
    } else {
      console.log('⊘ Skipping labeling step');
    }

    const labeledCsv      = defaults.inputFile;
    const databaseFile    = databaseArg || defaults.databaseFile;
    const statsOutputFile = filterKey
      ? path.join(defaults.outputDir, `depenses-${filterKey}-stats.json`)
      : path.join(defaults.outputDir, 'depenses-stats.json');

    if (useDatabase) {
      const shouldReset = resetDatabase || (!skipLabeling && resetDatabaseLabels);

      if (forceLabels) {
        // ── Force-labels mode: old behaviour, commits labels immediately ──────
        const dbInsertArgs = ['--input-file', labeledCsv, '--database', databaseFile];
        if (shouldReset) dbInsertArgs.push('--reset-database');
        await runCommand(
          path.join(__dirname, 'db-insert.script.js'),
          dbInsertArgs,
          { description: `Step 3: Loading labeled data into database${shouldReset ? ' (reset)' : ''} (--force-labels)` }
        );

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
        // ── Default DB mode: insert without labels, then generate validation ──
        const dbInsertArgs = ['--input-file', labeledCsv, '--database', databaseFile, '--skip-labels'];
        if (shouldReset) dbInsertArgs.push('--reset-database');
        await runCommand(
          path.join(__dirname, 'db-insert.script.js'),
          dbInsertArgs,
          { description: `Step 3: Inserting expenses into database without labels${shouldReset ? ' (reset)' : ''}` }
        );

        await runCommand(
          path.join(__dirname, 'generate-validation.script.js'),
          ['--database', databaseFile],
          { description: 'Step 4: Generating validation file with label suggestions' }
        );

        console.log('\n╔════════════════════════════════════════════╗');
        console.log('║   PIPELINE PAUSED — USER ACTION NEEDED    ║');
        console.log('╚════════════════════════════════════════════╝');
        console.log('\nReview and correct labels in:');
        console.log('  data/processed/depenses-validation.csv\n');
        console.log('Edit the "category" column, then run:');
        console.log('  npm run db:apply-labels');
        console.log('  npm run stats -- --use-database\n');
        return;
      }
    } else {
      // Step 3: Filter (optional)
      let inputForStats = labeledCsv;

      if (filterKey) {
        const filterConfigPath = path.join(defaults.configDir, 'filters.config.json');
        const filterConfig = JSON.parse(fs.readFileSync(filterConfigPath, 'utf-8'));
        if (!filterConfig.filters[filterKey]) {
          throw new Error(`Unknown filter key: "${filterKey}". Available: ${Object.keys(filterConfig.filters).join(', ')}`);
        }
        const filterDef  = filterConfig.filters[filterKey];
        const filterFile = path.join(defaults.configDir, 'filters', `filter-${filterKey}.json`);
        fs.writeFileSync(filterFile, JSON.stringify(filterDef, null, 2), 'utf-8');

        const filteredCsv = path.join(defaults.outputDir, `depenses-${filterKey}-filtered.csv`);
        await runCommand(
          path.join(__dirname, 'filter.script.js'),
          [
            '--input-file',   inputForStats,
            '--output-file',  filteredCsv,
            '--filters-file', filterFile
          ],
          { description: `Step 3: Filtering with "${filterKey}" filter (${filterDef.description})` }
        );
        inputForStats = filteredCsv;
      }

      // Step 4: Stats from CSV
      await runCommand(
        path.join(__dirname, 'stats.script.js'),
        [
          '--input-file',       inputForStats,
          '--output',           'both',
          '--output-file',      statsOutputFile,
          '--conversion-rates', defaults.conversionRatesFile
        ],
        { description: 'Step 4: Generating statistics' }
      );
    }

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║   🎉 PIPELINE COMPLETED SUCCESSFULLY!     ║');
    console.log('╚════════════════════════════════════════════╝\n');

    if (filterKey) {
      console.log(`Filter Applied: ${filterKey}`);
      console.log(`Output: ${path.join(defaults.outputDir, `depenses-${filterKey}-stats.json`)}`);
    }

  } catch (err) {
    console.error(`\n❌ Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
