const path = require('path');
const { readCSV, loadCategories, loadCategoryPatterns, fileExists } = require('../utils/data');
const { openDatabase, initializeDatabase, loadCategoriesIntoDb, loadCategoryPatternsIntoDb,
        loadConversionRatesIntoDb, getCategoryIdByLabel, getExpenseCount, insertExpense, insertExpensesBatch,
        getRowCount, getAllCategoriesAsMap, getAllExpensesAsMap, hashExpense } = require('../utils/db');
const { parseArgs } = require('../utils/cli-args');
const { getDefaultPaths, resolvePath, ensureDir } = require('../utils/path-resolver');
const { logSuccess, logError, logWarning, logInfo } = require('../utils/console-output');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--category-patterns-file', param: true, default: null },
  { flag: '--conversion-rates-file', param: true, default: null },
  { flag: '--database', param: true, default: null },
  { flag: '--delete-all', param: false }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node db-insert.js [options]

Options:
  --input-file <path>            Input labeled CSV file (default: data/processed/depenses-labeled.csv)
  --categories-file <path>       Categories definition file (default: config/categories.json)
  --category-patterns-file <path> Category patterns file (default: config/category-patterns.json)
  --conversion-rates-file <path> Conversion rates CSV file (default: config/conversion_rates.csv)
  --database <path>              SQLite database file (default: data/database/depenses.db)
  --delete-all                   Delete all data and recreate the tables
  -h, --help                    Show this help message

Examples:
  node db-insert.js --input-file data/processed/depenses-labeled.csv --database data/depenses.db
  node db-insert.js --delete-all --database data/depenses.db
`);
  process.exit(0);
}

// Resolve paths using defaults
const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.inputFile);
const categoriesFile = resolvePath(parsedArgs['categories-file'], defaults.categoriesFile);
const categoryPatternsFile = resolvePath(parsedArgs['category-patterns-file'], defaults.categoryPatternsFile);
const conversionRatesFile = resolvePath(parsedArgs['conversion-rates-file'], defaults.conversionRatesFile);
const databaseFile = resolvePath(parsedArgs['database'], defaults.databaseFile);
const deleteAll = parsedArgs['delete-all'] || false;

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

    // Load category patterns — only if table is empty or --delete-all
    const patternCount = await getRowCount(db, 'category_patterns');
    if (deleteAll || patternCount === 0) {
      if (fileExists(categoryPatternsFile)) {
        const patterns = loadCategoryPatterns(categoryPatternsFile);
        await loadCategoryPatternsIntoDb(db, patterns);
        logSuccess('Category patterns loaded', `${patterns.length} entries`);
      } else {
        logWarning('Category patterns file not found, skipping');
      }
    } else {
      logSuccess('Category patterns already loaded', `${patternCount} entries, skipping`);
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

    if (deleteAll && !parsedArgs['input-file']) {
      logSuccess('Database reset complete');
      db.close();
      return;
    }

    // Read CSV
    if (!fileExists(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const { rows: csvRows } = readCSV(inputFile);
    logSuccess('Read CSV file', `${csvRows.length} rows`);

    // Group rows by (date, category, amount) to check for duplicates
    // Normalize amount to number for consistent key matching with database
    const rowGroups = {};
    for (const row of csvRows) {
      const normalizedAmount = parseFloat(row.amount);
      const key = `${row.date}|${row.category}|${normalizedAmount}`;
      if (!rowGroups[key]) rowGroups[key] = [];
      rowGroups[key].push(row);
    }

    let insertCount = 0;
    let skipCount = 0;
    let warningCount = 0;
    const insertedByCategory = {};

    logInfo(`Processing ${Object.keys(rowGroups).length} unique (date, category, amount) combinations`);
    logInfo('Pre-loading categories and existing expenses for optimization');

    // Pre-load all categories into memory (1 query instead of per-group lookups)
    const categoryMap = await getAllCategoriesAsMap(db);
    logSuccess('Loaded categories into memory', `${Object.keys(categoryMap).length} categories`);

    // Pre-fetch all existing expenses for deduplication (1 query instead of per-group queries)
    const expenseMap = await getAllExpensesAsMap(db);
    logSuccess('Pre-fetched dedup keys from database', `${Object.keys(expenseMap).length} existing keys`);

    // Collect all rows to insert (batch them)
    const rowsToInsert = [];
    let processedGroups = 0;

    // Process each group to determine what needs inserting
    for (const [key, groupRows] of Object.entries(rowGroups)) {
      const [date, categoryLabel, amount] = key.split('|');
      const csvCount = groupRows.length;
      const categoryId = categoryMap[categoryLabel];

      if (!categoryId) {
        logWarning(`Category not found: ${categoryLabel}`);
        warningCount++;
        continue;
      }

      // Use hash for dedup lookup
      const hash = hashExpense(date, categoryId, parseFloat(amount));
      const dbCount = expenseMap[hash] || 0;

      if (dbCount === csvCount) {
        skipCount += csvCount;
      } else if (csvCount > dbCount) {
        const rowsNeeded = csvCount - dbCount;
        for (let i = 0; i < rowsNeeded; i++) {
          rowsToInsert.push({
            amount: groupRows[i].amount,
            currency_symbol: groupRows[i].currency_symbol,
            currency_code: groupRows[i].currency_code,
            date: groupRows[i].date,
            description: groupRows[i].description,
            category_id: categoryId
          });
          insertedByCategory[categoryLabel] = (insertedByCategory[categoryLabel] || 0) + 1;
        }
      } else {
        logWarning(`Database has ${dbCount} rows vs CSV has ${csvCount}`, `${date} • ${categoryLabel} • ${amount}`);
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

    db.close(() => {
      logSuccess('Database connection closed');
    });
  } catch (err) {
    logError(err.message);
    if (db) db.close();
    process.exit(1);
  }
}

main();
