const path = require('path');
const { readCSV, loadCategories, loadCategoryPatterns, fileExists, ensureDir } = require('../utils/data');
const { openDatabase, initializeDatabase, loadCategoriesIntoDb, loadCategoryPatternsIntoDb,
        loadConversionRatesIntoDb, getCategoryIdByLabel, getExpenseCount, insertExpense, insertExpensesBatch,
        getRowCount, getAllCategoriesAsMap, getAllExpensesAsMap, hashExpense } = require('../utils/db');

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Usage: node db-insert.js [options]

Options:
  --input-file <path>            Input labeled CSV file (default: ../../data/processed/depenses-labeled.csv)
  --categories-file <path>       Categories definition file (default: ../../config/categories.json)
  --category-patterns-file <path> Category patterns file (default: ../../config/category-patterns.json)
  --conversion-rates-file <path> Conversion rates CSV file (default: ../../config/conversion_rates.csv)
  --database <path>              SQLite database file (default: ../../data/database/depenses.db)
  --delete-all                   Delete all data and recreate the tables
  -h, --help                    Show this help message

Examples:
  node db-insert.js --input-file data/processed/depenses-labeled.csv --database data/depenses.db
  node db-insert.js --delete-all --database data/depenses.db
`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  showHelp();
}

let inputFile = null;
let categoriesFile = null;
let categoryPatternsFile = null;
let conversionRatesFile = null;
let databaseFile = null;
let deleteAll = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1]; i++;
  } else if (args[i] === '--categories-file' && args[i + 1]) {
    categoriesFile = args[i + 1]; i++;
  } else if (args[i] === '--category-patterns-file' && args[i + 1]) {
    categoryPatternsFile = args[i + 1]; i++;
  } else if (args[i] === '--conversion-rates-file' && args[i + 1]) {
    conversionRatesFile = args[i + 1]; i++;
  } else if (args[i] === '--database' && args[i + 1]) {
    databaseFile = args[i + 1]; i++;
  } else if (args[i] === '--delete-all') {
    deleteAll = true;
  }
}

const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) inputFile = path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
if (!categoriesFile) categoriesFile = path.join(baseDir, 'config', 'categories.json');
if (!categoryPatternsFile) categoryPatternsFile = path.join(baseDir, 'config', 'category-patterns.json');
if (!conversionRatesFile) conversionRatesFile = path.join(baseDir, 'config', 'conversion_rates.csv');
if (!databaseFile) databaseFile = path.join(baseDir, 'data', 'database', 'depenses.db');

if (!path.isAbsolute(inputFile)) inputFile = path.join(process.cwd(), inputFile);
if (!path.isAbsolute(categoriesFile)) categoriesFile = path.join(process.cwd(), categoriesFile);
if (!path.isAbsolute(categoryPatternsFile)) categoryPatternsFile = path.join(process.cwd(), categoryPatternsFile);
if (!path.isAbsolute(conversionRatesFile)) conversionRatesFile = path.join(process.cwd(), conversionRatesFile);
if (!path.isAbsolute(databaseFile)) databaseFile = path.join(process.cwd(), databaseFile);

// Ensure database directory exists
ensureDir(path.dirname(databaseFile));

// Main process
async function main() {
  let db;
  try {
    db = await openDatabase(databaseFile);
    console.log(`✓ Connected to database: ${databaseFile}`);

    await initializeDatabase(db, { dropAll: deleteAll });
    if (deleteAll) console.log('✓ Dropped and recreated tables');
    console.log('✓ Tables initialized');

    // Load categories — only if table is empty or --delete-all was used
    if (!fileExists(categoriesFile)) {
      throw new Error(`Categories file not found: ${categoriesFile}`);
    }
    const catCount = await getRowCount(db, 'categories');
    if (deleteAll || catCount === 0) {
      const categories = loadCategories(categoriesFile);
      await loadCategoriesIntoDb(db, categories);
      console.log('✓ Categories and filters loaded');
    } else {
      console.log(`✓ Categories already loaded (${catCount} entries), skipping`);
    }

    // Load category patterns — only if table is empty or --delete-all
    const patternCount = await getRowCount(db, 'category_patterns');
    if (deleteAll || patternCount === 0) {
      if (fileExists(categoryPatternsFile)) {
        const patterns = loadCategoryPatterns(categoryPatternsFile);
        await loadCategoryPatternsIntoDb(db, patterns);
        console.log(`✓ Category patterns loaded (${patterns.length} entries)`);
      } else {
        console.log('  ⚠ Category patterns file not found, skipping');
      }
    } else {
      console.log(`✓ Category patterns already loaded (${patternCount} entries), skipping`);
    }

    // Load conversion rates — only if table is empty or --delete-all
    const rateCount = await getRowCount(db, 'conversion_rates');
    if (deleteAll || rateCount === 0) {
      if (fileExists(conversionRatesFile)) {
        const { rows: rateRows } = readCSV(conversionRatesFile);
        await loadConversionRatesIntoDb(db, rateRows);
        console.log(`✓ Conversion rates loaded (${rateRows.length} entries)`);
      } else {
        console.log('  ⚠ Conversion rates file not found, skipping');
      }
    } else {
      console.log(`✓ Conversion rates already loaded (${rateCount} entries), skipping`);
    }

    if (deleteAll && !inputFile) {
      console.log('✓ Database reset complete');
      db.close();
      return;
    }

    // Read CSV
    if (!fileExists(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const { rows: csvRows } = readCSV(inputFile);
    console.log(`✓ Read ${csvRows.length} rows from CSV`);

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

    console.log(`\nProcessing ${Object.keys(rowGroups).length} unique (date, category, amount) combinations...`);
    console.log('Pre-loading categories and existing expenses for optimization...\n');

    // Pre-load all categories into memory (1 query instead of per-group lookups)
    const categoryMap = await getAllCategoriesAsMap(db);
    console.log(`✓ Loaded ${Object.keys(categoryMap).length} categories into memory`);

    // Pre-fetch all existing expenses for deduplication (1 query instead of per-group queries)
    const expenseMap = await getAllExpensesAsMap(db);
    console.log(`✓ Pre-fetched ${Object.keys(expenseMap).length} existing dedup keys from database\n`);

    // Collect all rows to insert (batch them)
    const rowsToInsert = [];
    let processedGroups = 0;

    // Process each group to determine what needs inserting
    for (const [key, groupRows] of Object.entries(rowGroups)) {
      const [date, categoryLabel, amount] = key.split('|');
      const csvCount = groupRows.length;
      const categoryId = categoryMap[categoryLabel];

      if (!categoryId) {
        console.warn(`  ⚠ Category not found: ${categoryLabel}`);
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
        console.warn(`  ⚠ WARNING: Database has ${dbCount} rows vs CSV has ${csvCount} for ${date}, ${categoryLabel}, ${amount}`);
        warningCount++;
      }
      processedGroups++;
      if (processedGroups % 500 === 0) {
        console.log(`  ... processed ${processedGroups}/${Object.keys(rowGroups).length} groups`);
      }
    }

    // Batch insert all collected rows in a single transaction
    if (rowsToInsert.length > 0) {
      console.log(`\nBatch-inserting ${rowsToInsert.length} rows in a single transaction...`);
      insertCount = await insertExpensesBatch(db, rowsToInsert);
      console.log(`✓ Batch insert complete: ${insertCount} rows inserted`);
    }

    console.log(`\n✓ Processing complete:`);
    console.log(`  - Inserted: ${insertCount} rows`);
    console.log(`  - Skipped (already exists): ${skipCount} rows`);
    console.log(`  - Warnings (db > csv): ${warningCount} combinations`);

    if (insertCount > 0) {
      console.log(`\n  Inserted by category:`);

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
        console.log(`    ${parent.padEnd(28)} ${String(data.total).padStart(4)} rows`);
        const sortedSubs = Object.entries(data.subs).sort((a, b) => b[1] - a[1]);
        for (const [sub, count] of sortedSubs) {
          console.log(`      ${('└─ ' + sub).padEnd(26)} ${String(count).padStart(4)} rows`);
        }
      }
    }

    db.close(() => {
      console.log(`✓ Database connection closed`);
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (db) db.close();
    process.exit(1);
  }
}

main();
