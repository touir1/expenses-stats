const path = require('path');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');
const { logSuccess, logError, logWarning, logInfo } = require('../utils/console-output.util');
const { openDatabase, getAllCategoriesAsMap, updateExpenseCategoriesBatch } = require('../utils/db.util');
const { readCSV, loadCategories, fileExists } = require('../utils/data.util');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--database', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--dry-run', param: false }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node apply-labels.script.js [options]

Reads the user-edited validation CSV and applies the confirmed category labels
to the database. Matches rows by (hash, date).

Options:
  --input-file <path>      Validation CSV (default: data/processed/depenses-validation.csv)
  --database <path>        SQLite DB file (default: data/database/depenses.db)
  --categories-file <path> Categories config for label→id resolution (default: config/categories.config.json)
  --dry-run                Print what would be updated without writing to the database
  -h, --help               Show this help message

Expected CSV columns: hash, date, description, amount, currency_code, suggested_category, category
`);
  process.exit(0);
}

const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.validationFile);
const databaseFile = resolvePath(parsedArgs['database'], defaults.databaseFile);
const categoriesFile = resolvePath(parsedArgs['categories-file'], defaults.categoriesFile);
const dryRun = parsedArgs['dry-run'] || false;

async function main() {
  let db;
  try {
    if (!fileExists(inputFile)) throw new Error(`Validation file not found: ${inputFile}`);

    const { rows: csvRows } = readCSV(inputFile);
    logSuccess('Read validation file', `${csvRows.length} rows`);

    if (csvRows.length === 0) {
      logInfo('Nothing to apply — validation file is empty');
      return;
    }

    db = await openDatabase(databaseFile);
    logSuccess('Connected to database', databaseFile);

    const categoryMap = await getAllCategoriesAsMap(db);
    logSuccess('Loaded categories', `${Object.keys(categoryMap).length} entries`);

    // Process each validation row
    const updates = [];
    const skipped = [];
    const unknownCategories = new Set();
    const updatedByCategory = {};

    for (const row of csvRows) {
      const hash = row.hash ? row.hash.trim() : '';
      const date = row.date ? row.date.trim() : '';
      const category = row.category ? row.category.trim() : '';

      if (!hash || !date) {
        logWarning('Row missing hash or date — skipping');
        continue;
      }

      if (!category || category === 'other') {
        skipped.push({ hash, date, reason: category === 'other' ? '"other" label' : 'empty category' });
        continue;
      }

      const categoryId = categoryMap[category];
      if (categoryId === undefined) {
        unknownCategories.add(category);
        skipped.push({ hash, date, reason: `unknown category "${category}"` });
        continue;
      }

      updates.push({ hash, date, categoryId });
      updatedByCategory[category] = (updatedByCategory[category] || 0) + 1;
    }

    // Report unknown categories (likely typos)
    if (unknownCategories.size > 0) {
      logWarning(`Unknown categories found (check for typos):`);
      for (const cat of [...unknownCategories].sort()) {
        logWarning(`  ${cat}`);
      }
    }

    logInfo(`\nSummary:`);
    logInfo(`  To update:  ${updates.length} rows`);
    logInfo(`  Skipped:    ${skipped.length} rows (other/empty/unknown)`);

    if (updates.length === 0) {
      logInfo('Nothing to update');
      db.close(() => {});
      return;
    }

    if (dryRun) {
      logInfo('\n[dry-run] Would update the following (hash::date → category):');
      for (const u of updates) {
        const cat = Object.entries(categoryMap).find(([, id]) => id === u.categoryId)?.[0] ?? u.categoryId;
        logInfo(`  ${u.hash}::${u.date}  →  ${cat}`);
      }
      logInfo('\n[dry-run] No changes written to database');
      db.close(() => {});
      return;
    }

    // Apply updates in a single transaction
    const totalChanged = await updateExpenseCategoriesBatch(db, updates);
    logSuccess('Labels applied', `${totalChanged} expense rows updated`);

    // Breakdown by category
    const grouped = {};
    for (const [label, count] of Object.entries(updatedByCategory)) {
      const slash = label.indexOf('/');
      const parent = slash === -1 ? label : label.slice(0, slash);
      const sub    = slash === -1 ? null  : label.slice(slash + 1);
      if (!grouped[parent]) grouped[parent] = { total: 0, subs: {} };
      grouped[parent].total += count;
      if (sub) grouped[parent].subs[sub] = (grouped[parent].subs[sub] || 0) + count;
    }

    logInfo('\nUpdated by category:');
    const sortedParents = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);
    for (const [parent, data] of sortedParents) {
      logInfo(`  ${parent.padEnd(28)} ${String(data.total).padStart(4)} rows`);
      const sortedSubs = Object.entries(data.subs).sort((a, b) => b[1] - a[1]);
      for (const [sub, count] of sortedSubs) {
        logInfo(`    └─ ${sub.padEnd(24)} ${String(count).padStart(4)} rows`);
      }
    }

    db.close((err) => {
      if (err) logError(`Error closing database: ${err.message}`);
      else logSuccess('Database connection closed');
    });
  } catch (err) {
    logError(err.message);
    if (db) db.close(() => {});
    process.exit(1);
  }
}

main();
