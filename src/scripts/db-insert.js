const path = require('path');
const { readCSV, loadCategories, loadCategoryPatterns, fileExists } = require('../utils/data');
const { openDatabase, initializeDatabase, loadCategoriesIntoDb, loadCategoryPatternsIntoDb,
        loadForcedCategorizationsIntoDb, loadConversionRatesIntoDb, getCategoryIdByLabel, getExpenseCount, 
        insertExpense, insertExpensesBatch, getRowCount, getAllCategoriesAsMap, getAllExpensesAsMap, 
        hashExpense } = require('../utils/db');
const { parseArgs } = require('../utils/cli-args');
const { getDefaultPaths, resolvePath, ensureDir } = require('../utils/path-resolver');
const { logSuccess, logError, logWarning, logInfo } = require('../utils/console-output');

// Helper function to load forced categories from JSON file
function loadForcedCategories(filePath) {
  const fs = require('fs');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return (data.forced && Array.isArray(data.forced)) ? data.forced : [];
  } catch (err) {
    console.warn(`Warning: Could not load forced categories from ${filePath}:`, err.message);
    return [];
  }
}

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--category-patterns-file', param: true, default: null },
  { flag: '--forced-categories-file', param: true, default: null },
  { flag: '--conversion-rates-file', param: true, default: null },
  { flag: '--database', param: true, default: null },
  { flag: '--delete-all', param: false }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node db-insert.js [options]

Options:
  --input-file <path>              Input labeled CSV file (default: data/processed/depenses-labeled.csv)
  --categories-file <path>         Categories definition file (default: config/categories.json)
  --category-patterns-file <path>  Category patterns file (default: config/category-patterns.json)
  --forced-categories-file <path>  Forced categories file (default: config/forced-categories.json)
  --conversion-rates-file <path>   Conversion rates CSV file (default: config/conversion_rates.csv)
  --database <path>                SQLite database file (default: data/database/depenses.db)
  --delete-all                     Delete all data and recreate the tables
  -h, --help                      Show this help message

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
const forcedCategoriesFile = resolvePath(parsedArgs['forced-categories-file'], defaults.forcedCategoriesFile);
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

    // Load forced categorizations — only if table is empty or --delete-all
    const forcedCount = await getRowCount(db, 'forced_categorizations');
    if (deleteAll || forcedCount === 0) {
      if (fileExists(forcedCategoriesFile)) {
        const forcedList = loadForcedCategories(forcedCategoriesFile);
        await loadForcedCategorizationsIntoDb(db, forcedList);
        logSuccess('Forced categorizations loaded', `${forcedList.length} entries`);
      } else {
        logWarning('Forced categorizations file not found, skipping');
      }
    } else {
      logSuccess('Forced categorizations already loaded', `${forcedCount} entries, skipping`);
    }

    // Read CSV
    if (!fileExists(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const { rows: csvRows } = readCSV(inputFile);
    logSuccess('Read CSV file', `${csvRows.length} rows`);

    // Group rows by HASH to check for duplicates
    // Hash is unique identifier for each distinct transaction (description + currency + amount)
    const rowGroups = {};
    for (const row of csvRows) {
      const hash = row.hash;
      if (!hash) {
        logWarning(`Row missing hash field`, `${row.date} • ${row.description}`);
        continue;
      }
      if (!rowGroups[hash]) rowGroups[hash] = [];
      rowGroups[hash].push(row);
    }

    let insertCount = 0;
    let skipCount = 0;
    let warningCount = 0;
    const insertedByCategory = {};

    logInfo(`Processing ${Object.keys(rowGroups).length} unique hashes (distinct transactions)`);
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

    // Process each hash group to determine what needs inserting
    for (const [hash, groupRows] of Object.entries(rowGroups)) {
      const csvCount = groupRows.length;
      const firstRow = groupRows[0];
      const categoryId = categoryMap[firstRow.category];

      if (!categoryId) {
        logWarning(`Category not found: ${firstRow.category}`);
        warningCount++;
        continue;
      }

      // Check if this hash already exists in the database
      const dbCount = expenseMap[hash] || 0;

      if (dbCount >= csvCount) {
        // All rows with this hash are already in database
        skipCount += csvCount;
      } else if (csvCount > dbCount) {
        // Need to insert the missing rows (those with the same hash)
        // Since they have the same hash, they're identical, so just insert the difference
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
          insertedByCategory[firstRow.category] = (insertedByCategory[firstRow.category] || 0) + 1;
        }
      } else {
        logWarning(`Database has ${dbCount} rows vs CSV has ${csvCount}`, `${hash.substring(0, 8)}... • ${firstRow.category}`);
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
