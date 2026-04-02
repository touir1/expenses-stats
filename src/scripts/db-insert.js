const path = require('path');
const { readCSV, loadCategories, fileExists, ensureDir } = require('../utils/data');
const { openDatabase, initializeDatabase, loadCategoriesIntoDb, getCategoryIdByLabel, getExpenseCount, insertExpense, getRowCount } = require('../utils/db');

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Usage: node db-insert.js [options]

Options:
  --input-file <path>      Input labeled CSV file (default: ../../data/processed/depenses-labeled.csv)
  --categories-file <path> Categories definition file (default: ../../config/categories.json)
  --database <path>        SQLite database file (default: ../../data/database/depenses.db)
  --delete-all             Delete all data and recreate the tables
  -h, --help              Show this help message

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
let databaseFile = null;
let deleteAll = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1]; i++;
  } else if (args[i] === '--categories-file' && args[i + 1]) {
    categoriesFile = args[i + 1]; i++;
  } else if (args[i] === '--database' && args[i + 1]) {
    databaseFile = args[i + 1]; i++;
  } else if (args[i] === '--delete-all') {
    deleteAll = true;
  }
}

const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) inputFile = path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
if (!categoriesFile) categoriesFile = path.join(baseDir, 'config', 'categories.json');
if (!databaseFile) databaseFile = path.join(baseDir, 'data', 'database', 'depenses.db');

if (!path.isAbsolute(inputFile)) inputFile = path.join(process.cwd(), inputFile);
if (!path.isAbsolute(categoriesFile)) categoriesFile = path.join(process.cwd(), categoriesFile);
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
    const rowGroups = {};
    for (const row of csvRows) {
      const key = `${row.date}|${row.category}|${row.amount}`;
      if (!rowGroups[key]) rowGroups[key] = [];
      rowGroups[key].push(row);
    }

    let insertCount = 0;
    let skipCount = 0;
    let warningCount = 0;
    const insertedByCategory = {};

    console.log(`\nProcessing ${Object.keys(rowGroups).length} unique (date, category, amount) combinations...\n`);

    // Process each group
    for (const [key, groupRows] of Object.entries(rowGroups)) {
      const [date, categoryLabel, amount] = key.split('|');
      const csvCount = groupRows.length;

      const categoryId = await getCategoryIdByLabel(db, categoryLabel);
      if (!categoryId) {
        console.warn(`  ⚠ Category not found: ${categoryLabel}`);
        warningCount++;
        continue;
      }

      const dbCount = await getExpenseCount(db, date, categoryId, amount);

      if (dbCount === csvCount) {
        skipCount += csvCount;
      } else if (csvCount > dbCount) {
        const rowsToInsert = csvCount - dbCount;
        for (let i = 0; i < rowsToInsert; i++) {
          try {
            await insertExpense(db, groupRows[i], categoryId);
            insertCount++;
            insertedByCategory[categoryLabel] = (insertedByCategory[categoryLabel] || 0) + 1;
          } catch (err) {
            console.error(`  ✗ Error inserting row: ${err.message}`);
          }
        }
      } else {
        console.warn(`  ⚠ WARNING: Database has ${dbCount} rows vs CSV has ${csvCount} for ${date}, ${categoryLabel}, ${amount}`);
        warningCount++;
      }
    }

    console.log(`\n✓ Insert complete:`);
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
