const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath, ensureDir } = require('../utils/path-resolver.util');
const { logSuccess, logError, logWarning, logInfo } = require('../utils/console-output.util');
const { openDatabase, getUnlabeledExpenses, getAllCategoriesAsMap } = require('../utils/db.util');
const { loadCategories, loadCategoryPatterns, fileExists } = require('../utils/data.util');
const { countTokenMatches, matchTokens, normalizeStr } = require('../utils/text.util');
const { matchesFilter } = require('../utils/filtering.util');
const { parseCSVLine } = require('../utils/csv.util');

// Parse command-line arguments
const optionDefs = [
  { flag: '--database', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--forced-categories-file', param: true, default: null },
  { flag: '--output-file', param: true, default: null },
  { flag: '--all', param: false }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node generate-validation.script.js [options]

Queries the database for unlabeled expenses, runs the auto-categorizer as a
guess, and writes a CSV for the user to review and correct before committing
labels to the database.

If the output file already exists, only new (hash, date) pairs are appended
so that prior edits are preserved.

Options:
  --database <path>              SQLite DB file (default: data/database/depenses.db)
  --categories-file <path>       Categories config (default: config/categories.config.json)
  --forced-categories-file <path> Forced categories config (default: config/forced-categories.config.json)
  --output-file <path>           Validation CSV output (default: data/processed/depenses-validation.csv)
  --all                          Include already-validated rows (category_id IS NOT NULL) too
  -h, --help                     Show this help message

Output columns:
  hash, date, description, amount, currency_code, suggested_category, category
`);
  process.exit(0);
}

const defaults = getDefaultPaths();
const databaseFile = resolvePath(parsedArgs['database'], defaults.databaseFile);
const categoriesFile = resolvePath(parsedArgs['categories-file'], defaults.categoriesFile);
const forcedCategoriesFile = resolvePath(parsedArgs['forced-categories-file'], defaults.forcedCategoriesFile);
const outputFile = resolvePath(parsedArgs['output-file'], defaults.validationFile);
const includeAll = parsedArgs['all'] || false;

// ── Label-guessing logic (mirrors label.script.js) ───────────────────────────

function buildLeafList(categories, parentPath, separator = '/') {
  const leaves = [];
  for (const catDef of categories) {
    const currentPath = parentPath ? `${parentPath}${separator}${catDef.name}` : catDef.name;
    if (catDef.subcategories && catDef.subcategories.length > 0) {
      leaves.push(...buildLeafList(catDef.subcategories, currentPath, separator));
    } else {
      leaves.push({ path: currentPath, filters: catDef.filters || {} });
    }
  }
  return leaves;
}

function scoreLeaf(row, columnMap, filters) {
  if (!filters || Object.keys(filters).length === 0) return { score: 0, coverage: 0 };
  let score = 0;
  let matchedChars = 0;
  let descLength = 0;

  for (const [colName, condition] of Object.entries(filters)) {
    if (!(colName in columnMap)) return { score: 0, coverage: 0 };
    const value = row[columnMap[colName]].trim();
    if (!matchesFilter(value, condition)) return { score: 0, coverage: 0 };

    if (typeof condition === 'object' && condition !== null && Array.isArray(condition.tokens)) {
      if (Array.isArray(condition.exclude) && countTokenMatches(value, condition.exclude) > 0) {
        return { score: 0, coverage: 0 };
      }
      const { count, matchedChars: mc, descLength: dl } = matchTokens(value, condition.tokens);
      score += count;
      matchedChars += mc;
      descLength = Math.max(descLength, dl);
    } else {
      score += 1;
    }
  }

  const coverage = descLength > 0 ? matchedChars / descLength : 0;
  return { score, coverage };
}

function assignCategory(row, columnMap, leaves, minScore = 1) {
  let bestPath = null;
  let bestScore = 0;
  let bestCoverage = 0;

  for (const leaf of leaves) {
    const { score, coverage } = scoreLeaf(row, columnMap, leaf.filters);
    if (score > bestScore || (score > 0 && score === bestScore && coverage > bestCoverage)) {
      bestScore = score;
      bestCoverage = coverage;
      bestPath = leaf.path;
    }
  }

  return bestScore >= minScore ? bestPath : null;
}

function checkForcedCategory(row, columnMap, forcedList) {
  if (!forcedList || forcedList.length === 0) return null;
  if (!('description' in columnMap)) return null;

  const descriptionValue = row[columnMap['description']] ? normalizeStr(row[columnMap['description']].trim()) : '';
  if (!descriptionValue) return null;

  let bestMatch = null;
  let bestScore = -1;

  for (const forced of forcedList) {
    if (!forced.description) continue;
    const pattern = normalizeStr(forced.description);

    if (forced.word) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp('\\b' + escaped + '\\b', 'i').test(descriptionValue)) continue;
    } else {
      if (!descriptionValue.includes(pattern)) continue;
    }

    if (forced.date && ('date' in columnMap) && row[columnMap['date']].trim() !== forced.date) continue;
    if (forced.amount && ('amount' in columnMap) && row[columnMap['amount']].trim() !== String(forced.amount)) continue;
    if (forced.currency_code && ('currency_code' in columnMap) && row[columnMap['currency_code']].trim() !== forced.currency_code) continue;

    const score = pattern.length / descriptionValue.length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = forced.category;
    }
  }
  return bestMatch;
}

// Adapt a DB row object (plain object) to the array + columnMap format expected by label functions.
function dbRowToArrayAndMap(dbRow) {
  const keys = ['amount', 'currency_code', 'currency_symbol', 'date', 'description'];
  const row = keys.map(k => String(dbRow[k] ?? ''));
  const columnMap = {};
  keys.forEach((k, i) => { columnMap[k] = i; });
  return { row, columnMap };
}

function guessLabel(dbRow, leaves, categoryPatterns) {
  const { row, columnMap } = dbRowToArrayAndMap(dbRow);
  const forced = checkForcedCategory(row, columnMap, categoryPatterns);
  return forced || assignCategory(row, columnMap, leaves) || 'other';
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

const VALIDATION_HEADER = 'hash,date,description,amount,currency_code,suggested_category,category';

function csvField(value) {
  const str = String(value ?? '');
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function rowToCsvLine(hash, date, description, amount, currency_code, suggested, category) {
  return [hash, date, description, amount, currency_code, suggested, category]
    .map(csvField)
    .join(',');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let db;
  try {
    db = await openDatabase(databaseFile);
    logSuccess('Connected to database', databaseFile);

    // Load label-guessing config
    if (!fileExists(categoriesFile)) throw new Error(`Categories file not found: ${categoriesFile}`);
    const categoryDefs = loadCategories(categoriesFile);
    const leaves = buildLeafList(categoryDefs, '');

    let categoryPatterns = [];
    if (fileExists(forcedCategoriesFile)) {
      categoryPatterns = loadCategoryPatterns(forcedCategoriesFile);
      logSuccess('Forced category patterns loaded', `${categoryPatterns.length} entries`);
    } else {
      logWarning('Forced categories file not found, skipping');
    }

    // Load existing validation file to find already-handled (hash, date) pairs
    const existingKeys = new Set();
    let existingLines = [];
    if (fileExists(outputFile)) {
      const content = fs.readFileSync(outputFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      // First line is the header
      existingLines = lines;
      for (let i = 1; i < lines.length; i++) {
        const parts = parseCSVLine(lines[i]);
        if (parts.length >= 2) {
          existingKeys.add(`${parts[0]}::${parts[1]}`);
        }
      }
      logSuccess('Existing validation file found', `${existingKeys.size} entries already present`);
    }

    // Fetch unlabeled expenses from DB
    let dbRows;
    if (includeAll) {
      // Query all expenses (for --all mode)
      dbRows = await new Promise((resolve, reject) => {
        db.all(
          `SELECT hash, date, description, amount, currency_code, currency_symbol
           FROM expenses
           GROUP BY hash, date
           ORDER BY substr(date,7,4)||substr(date,4,2)||substr(date,1,2)`,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });
      logInfo(`--all mode: fetched ${dbRows.length} unique (hash, date) pairs from DB`);
    } else {
      dbRows = await getUnlabeledExpenses(db);
      logSuccess('Unlabeled expenses fetched', `${dbRows.length} unique (hash, date) pairs`);
    }

    // Filter out rows already in the validation file
    const newRows = dbRows.filter(r => !existingKeys.has(`${r.hash}::${r.date}`));
    logInfo(`New rows to add: ${newRows.length}`);

    if (newRows.length === 0) {
      logSuccess('Validation file is up to date — nothing to append');
      db.close(() => {});
      return;
    }

    // Guess labels for new rows
    const newLines = newRows.map(r => {
      const suggested = guessLabel(r, leaves, categoryPatterns);
      return rowToCsvLine(r.hash, r.date, r.description, r.amount, r.currency_code, suggested, suggested);
    });

    // Write output file (create or append)
    ensureDir(path.dirname(outputFile));
    if (existingLines.length === 0) {
      // New file — write header + rows
      fs.writeFileSync(outputFile, [VALIDATION_HEADER, ...newLines].join('\n') + '\n', 'utf-8');
    } else {
      // Append new rows (no duplicate header)
      fs.appendFileSync(outputFile, newLines.join('\n') + '\n', 'utf-8');
    }

    logSuccess(`Validation file updated`, outputFile);
    logInfo(`Added ${newLines.length} new rows`);

    // Summary by suggested category
    const tally = {};
    for (const line of newLines) {
      const parts = parseCSVLine(line);
      const cat = parts[5] || 'other';
      tally[cat] = (tally[cat] || 0) + 1;
    }
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    logInfo('\nSuggested category breakdown:');
    for (const [label, count] of sorted) {
      logInfo(`  ${label.padEnd(28)} ${String(count).padStart(4)} rows`);
    }

    logInfo('\nNext step: edit the "category" column in the validation file, then run:');
    logInfo('  npm run db:apply-labels');

    db.close((err) => {
      if (err) logError(`Error closing database: ${err.message}`);
    });
  } catch (err) {
    logError(err.message);
    if (db) db.close(() => {});
    process.exit(1);
  }
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
