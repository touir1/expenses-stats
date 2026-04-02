#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../utils/cli-args');
const { runCommand } = require('../utils/process-runner');
const { ensureRatesUpdated } = require('../utils/rate-manager');

async function main() {
  // Parse pipeline arguments
  const optionDefs = [
    { flag: '--skip-parsing', param: false },
    { flag: '--skip-labeling', param: false },
    { flag: '--filter', param: true, default: null }
  ];

  const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);
  const skipParsing = parsedArgs['skip-parsing'];
  const skipLabeling = parsedArgs['skip-labeling'];
  const filterKey = parsedArgs['filter'];

  if (showHelp) {
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

  try {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   EXPENSE ANALYSIS PIPELINE                ║');
    console.log('╚════════════════════════════════════════════╝');

    // Check and update conversion rates if needed
    await ensureRatesUpdated();

    // Step 1: Parse
    if (!skipParsing) {
      await runCommand(
        path.join(__dirname, 'parser.js'),
        [],
        { description: 'Step 1: Parsing depenses.txt to CSV' }
      );
    } else {
      console.log('⊘ Skipping parsing step');
    }

    // Step 2: Label
    if (!skipLabeling) {
      await runCommand(
        path.join(__dirname, 'label.js'),
        [
          '--input-file', path.join(__dirname, '..', '..', 'data', 'processed', 'depenses.csv'),
          '--output-file', path.join(__dirname, '..', '..', 'data', 'processed', 'depenses-labeled.csv'),
          '--categories-file', path.join(__dirname, '..', '..', 'config', 'categories.json'),
          '--forced-categories-file', path.join(__dirname, '..', '..', 'config', 'forced-categories.json')
        ],
        { description: 'Step 2: Labeling expenses with categories' }
      );
    } else {
      console.log('⊘ Skipping labeling step');
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
        path.join(__dirname, 'filter.js'),
        [
          '--input-file', inputForStats,
          '--output-file', path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-filtered.csv`),
          '--filters-file', filterFile
        ],
        { description: `Step 3: Filtering with "${filterKey}" filter (${filterDef.description})` }
      );

      // Update input for stats to use filtered output
      inputForStats = path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-filtered.csv`);
    }

    // Step 4: Stats
    const statsOutputFile = filterKey 
      ? path.join(__dirname, '..', '..', 'output', `depenses-${filterKey}-stats.json`)
      : path.join(__dirname, '..', '..', 'output', 'depenses-stats.json');

    await runCommand(
      path.join(__dirname, 'stats.js'),
      [
        '--input-file', inputForStats,
        '--output', 'both',
        '--output-file', statsOutputFile,
        '--conversion-rates', path.join(__dirname, '..', '..', 'config', 'conversion_rates.csv')
      ],
      { description: 'Step 4: Generating statistics' }
    );

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
