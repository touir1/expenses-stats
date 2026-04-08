const path = require('path');
const { readCSV, loadCategories, loadCategoryPatterns, fileExists } = require('../utils/data.util');
const { openDatabase, initializeDatabase, loadCategoriesIntoDb, loadCategoryPatternsIntoDb,
        loadConversionRatesIntoDb, insertExpensesBatch, getRowCount,
        getAllCategoriesAsMap, getExpenseCountsForHashes } = require('../utils/db.util');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath, ensureDir } = require('../utils/path-resolver.util');
const { logSuccess, logError, logWarning, logInfo } = require('../utils/console-output.util');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--forced-categories-file', param: true, default: null },
  { flag: '--conversion-rates-file', param: true, default: null },
  { flag: '--database', param: true, default: null },
  { flag: '--reset-database', param: false },
  { flag: '--skip-labels', param: false }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node db-insert.script.js [options]

Options:
  --input-file <path>              Input labeled CSV file (default: data/processed/depenses-labeled.csv)
  --categories-file <path>         Categories definition file (default: config/categories.config.json)
  --forced-categories-file <path>  Forced categories file (default: config/forced-categories.config.json)
  --conversion-rates-file <path>   Conversion rates CSV file (default: data/processed/conversion-rates.csv)
  --database <path>                SQLite database file (default: data/database/depenses.db)
  --reset-database                 Delete all data and recreate the tables
  --skip-labels                    Insert expenses with category_id = NULL (ignore category column)
  -h, --help                      Show this help message

Examples:
  node db-insert.script.js --input-file data/processed/depenses-labeled.csv --database data/depenses.db
  node db-insert.script.js --reset-database --database data/depenses.db
`);
  process.exit(0);
}

// Resolve paths using defaults
const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.inputFile);
const categoriesFile = resolvePath(parsedArgs['categories-file'], defaults.categoriesFile);
const forcedCategoriesFile = resolvePath(parsedArgs['forced-categories-file'], defaults.forcedCategoriesFile);
const conversionRatesFile = resolvePath(parsedArgs['conversion-rates-file'], defaults.conversionRatesFile);
const databaseFile = resolvePath(parsedArgs['database'], defaults.databaseFile);
const deleteAll = parsedArgs['reset-database'] || false;
const skipLabels = parsedArgs['skip-labels'] || false;

// Ensure database directory exists
ensureDir(path.dirname(databaseFile));

// Main process
async function main() {
  let db;
  try {
    db = await openDatabase(databaseFile);
    logSuccess('Connected to database', databaseFile);

    await initializeDatabase(db, { dropAll: deleteAll });
    if (deleteAll) logSuccess('Dropped and recreated tables');
    logSuccess('Tables initialized');

    // Load categories — only if table is empty or --delete-all was used
    if (!fileExists(categoriesFile)) {
      throw new Error(`Categories file not found: ${categoriesFile}`);
    }
    const catCount = await getRowCount(db, 'categories');
    if (deleteAll || catCount === 0) {
      const categories = loadCategories(categoriesFile);
      await loadCategoriesIntoDb(db, categories);
      logSuccess('Categories and filters loaded');
    } else {
      logSuccess('Categories already loaded', `${catCount} entries, skipping`);
    }

    // Load forced category patterns — only if table is empty or --reset-database
    const patternCount = await getRowCount(db, 'category_patterns');
    if (deleteAll || patternCount === 0) {
      if (fileExists(forcedCategoriesFile)) {
        const patterns = loadCategoryPatterns(forcedCategoriesFile);
        await loadCategoryPatternsIntoDb(db, patterns);
        logSuccess('Forced category patterns loaded', `${patterns.length} entries`);
      } else {
        logWarning('Forced categories file not found, skipping');
      }
    } else {
      logSuccess('Forced category patterns already loaded', `${patternCount} entries, skipping`);
    }

    // Load conversion rates — only if table is empty or --delete-all
    const rateCount = await getRowCount(db, 'conversion_rates');
    if (deleteAll || rateCount === 0) {
      if (fileExists(conversionRatesFile)) {
        const { rows: rateRows } = readCSV(conversionRatesFile);
        await loadConversionRatesIntoDb(db, rateRows);
        logSuccess('Conversion rates loaded', `${rateRows.length} entries`);
      } else {
        logWarning('Conversion rates file not found, skipping');
      }
    } else {
      logSuccess('Conversion rates already loaded', `${rateCount} entries, skipping`);
    }

    // Read CSV
    if (!fileExists(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const { rows: csvRows } = readCSV(inputFile);
    logSuccess('Read CSV file', `${csvRows.length} rows`);

    // Group rows by (hash, date) — hash alone excludes date, so the same description/amount/currency
    // on two different dates shares a hash but represents distinct expenses.
    const rowGroups = {};
    for (const row of csvRows) {
      const hash = row.hash;
      if (!hash) {
        logWarning(`Row missing hash field`, `${row.date} • ${row.description}`);
        continue;
      }
      const key = `${hash}::${row.date}`;
      if (!rowGroups[key]) rowGroups[key] = [];
      rowGroups[key].push(row);
    }

    let insertCount = 0;
    let skipCount = 0;
    let warningCount = 0;
    const insertedByCategory = {};

    logInfo(`Processing ${Object.keys(rowGroups).length} unique (hash, date) pairs`);

    if (skipLabels) logInfo('--skip-labels active: inserting expenses without category');

    // Pre-load all categories into memory (1 query instead of per-group lookups)
    // Skipped when --skip-labels is set since no category resolution is needed.
    const categoryMap = skipLabels ? {} : await getAllCategoriesAsMap(db);
    if (!skipLabels) logSuccess('Loaded categories into memory', `${Object.keys(categoryMap).length} categories`);

    // Fetch dedup counts for unique hashes in this batch (avoids full table scan).
    // expenseMap key is "hash::date" — date is not in the hash, so same-hash rows on different
    // dates are tracked separately.
    const uniqueHashes = [...new Set(Object.keys(rowGroups).map(k => k.split('::')[0]))];
    const expenseMap = await getExpenseCountsForHashes(db, uniqueHashes);
    logSuccess('Fetched dedup counts for batch', `${Object.keys(expenseMap).length} existing (hash, date) keys`);

    // Collect all rows to insert (batch them)
    const rowsToInsert = [];
    let processedGroups = 0;

    // Process each (hash, date) group to determine what needs inserting
    for (const [key, groupRows] of Object.entries(rowGroups)) {
      const csvCount = groupRows.length;
      const firstRow = groupRows[0];

      let categoryId = null;
      if (!skipLabels) {
        categoryId = categoryMap[firstRow.category];
        if (categoryId === undefined) {
          logWarning(`Category not found: ${firstRow.category}`);
          warningCount++;
          continue;
        }
      }

      // Check how many rows with this (hash, date) already exist in the database
      const dbCount = expenseMap[key] || 0;

      if (dbCount >= csvCount) {
        skipCount += csvCount;
      } else if (csvCount > dbCount) {
        const rowsNeeded = csvCount - dbCount;
        for (let i = 0; i < rowsNeeded; i++) {
          rowsToInsert.push({
            amount: firstRow.amount,
            currency_symbol: firstRow.currency_symbol,
            currency_code: firstRow.currency_code,
            date: firstRow.date,
            description: firstRow.description,
            category_id: categoryId
          });
          if (!skipLabels && firstRow.category) {
            insertedByCategory[firstRow.category] = (insertedByCategory[firstRow.category] || 0) + 1;
          }
        }
      } else {
        logWarning(`Database has ${dbCount} rows vs CSV has ${csvCount}`, `${key} • ${firstRow.category}`);
        warningCount++;
      }
      processedGroups++;
      if (processedGroups % 500 === 0) {
        logInfo(`Progress: ${processedGroups}/${Object.keys(rowGroups).length} groups processed`);
      }
    }

    // Batch insert all collected rows in a single transaction
    if (rowsToInsert.length > 0) {
      logInfo(`Batch-inserting ${rowsToInsert.length} rows in a single transaction`);
      insertCount = await insertExpensesBatch(db, rowsToInsert);
      logSuccess('Batch insert complete', `${insertCount} rows inserted`);
    }

    logSuccess('Processing complete');
    logInfo(`Inserted: ${insertCount} rows`);
    logInfo(`Skipped (already exists): ${skipCount} rows`);
    logInfo(`Warnings (db > csv): ${warningCount} combinations`);

    if (insertCount > 0) {
      logInfo(`\nInserted by category:`);

      const grouped = {};
      for (const [label, count] of Object.entries(insertedByCategory)) {
        const slash = label.indexOf('/');
        const parent = slash === -1 ? label : label.slice(0, slash);
        const sub    = slash === -1 ? null  : label.slice(slash + 1);
        if (!grouped[parent]) grouped[parent] = { total: 0, subs: {} };
        grouped[parent].total += count;
        if (sub) grouped[parent].subs[sub] = (grouped[parent].subs[sub] || 0) + count;
      }

      const sortedParents = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);
      for (const [parent, data] of sortedParents) {
        logInfo(`  ${parent.padEnd(28)} ${String(data.total).padStart(4)} rows`);
        const sortedSubs = Object.entries(data.subs).sort((a, b) => b[1] - a[1]);
        for (const [sub, count] of sortedSubs) {
          logInfo(`    └─ ${sub.padEnd(24)} ${String(count).padStart(4)} rows`);
        }
      }
    }

    db.close((err) => {
      if (err) logError(`Error closing database: ${err.message}`);
      else logSuccess('Database connection closed');
    });
  } catch (err) {
    logError(err.message);
    if (db) db.close((closeErr) => {
      if (closeErr) logError(`Error closing database: ${closeErr.message}`);
    });
    process.exit(1);
  }
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
