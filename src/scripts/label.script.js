const fs = require('fs');
const path = require('path');
const { countTokenMatches, matchTokens, normalizeStr } = require('../utils/text.util');
const { matchesFilter } = require('../utils/filtering.util');
const { parseCSVLine } = require('../utils/csv.util');
const { readCSVLines, writeCSVRaw, loadCategories, loadCategoryPatterns, fileExists } = require('../utils/data.util');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');
const { logWarning, logError, logSuccess, logInfo } = require('../utils/console-output.util');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--output-file', param: true, default: null },
  { flag: '--categories', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--forced-categories-file', param: true, default: null },
  { flag: '--category-col', param: true, default: 'category' },
  { flag: '--default', param: true, default: 'other' },
  { flag: '--separator', param: true, default: '/' },
  { flag: '--min-score', param: true, default: null }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node label.script.js [options]

Options:
  --input-file <path>         Input CSV file (default: data/processed/depenses.csv)
  --output-file <path>        Output CSV file (default: data/processed/depenses-labeled.csv)
  --categories <json>         Categories definition as inline JSON
  --categories-file <path>    Path to JSON file defining categories (default: config/categories.config.json)
  --forced-categories-file <path> Path to JSON file with forced category mappings (default: config/forced-categories.config.json)
  --category-col <name>       Name of the added column (default: category)
  --default <label>           Default label when no category matches (default: "other")
  -h, --help                 Show this help message

Examples:
  node label.script.js --categories-file config/categories.config.json
  node label.script.js --help
`);
  process.exit(0);
}

// Resolve paths
const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.parsedFile);
const outputFile = resolvePath(parsedArgs['output-file'], defaults.inputFile);
const categoriesFile = parsedArgs['categories-file'] ? resolvePath(parsedArgs['categories-file']) : defaults.categoriesFile;
const categoryPatternsFile = resolvePath(parsedArgs['forced-categories-file'], defaults.forcedCategoriesFile);
const categoryColName = parsedArgs['category-col'] || 'category';
const defaultLabel = parsedArgs['default'] || 'other';
const separator = parsedArgs['separator'] || '/';
const categoriesJson = parsedArgs['categories'] || null;
const minScore = parseInt(parsedArgs['min-score'], 10) || 1;

// Load category patterns
let categoryPatterns = [];
if (categoryPatternsFile && fileExists(categoryPatternsFile)) {
  try {
    categoryPatterns = loadCategoryPatterns(categoryPatternsFile);
  } catch (e) {
    logWarning('Could not read/parse forced-categories-file', e.message);
  }
}

// Load categories
let categoryDefs = [];
if (categoriesFile) {
  const fPath = path.isAbsolute(categoriesFile) ? categoriesFile : path.join(process.cwd(), categoriesFile);
  try {
    categoryDefs = loadCategories(fPath);
  } catch (e) {
    console.error('Error: Could not read/parse --categories-file:', e.message);
    process.exit(1);
  }
} else if (categoriesJson) {
  try {
    const parsed = JSON.parse(categoriesJson);
    categoryDefs = parsed.categories || [];
  } catch (e) {
    console.error('Error: Invalid JSON in --categories:', e.message);
    process.exit(1);
  }
} else {
  console.error('Error: --categories or --categories-file is required');
  process.exit(1);
}

if (categoryDefs.length === 0) {
  console.error('Error: No categories defined');
  process.exit(1);
}



// Build a flat list of all leaf nodes from the category tree (computed once at startup)
function buildLeafList(categories, parentPath) {
  const leaves = [];
  for (const catDef of categories) {
    const currentPath = parentPath ? `${parentPath}${separator}${catDef.name}` : catDef.name;
    if (catDef.subcategories && catDef.subcategories.length > 0) {
      leaves.push(...buildLeafList(catDef.subcategories, currentPath));
    } else {
      leaves.push({ path: currentPath, filters: catDef.filters || {} });
    }
  }
  return leaves;
}

// Score a row against a single leaf's filters (AND logic across filters, sum of token matches).
// Returns { score, coverage } where coverage = matched token chars / description length.
// Returns { score: 0, coverage: 0 } if any filter fails or an exclude token matches.
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
      // Exclusion check: any matching exclude token disqualifies this leaf
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

// Assign category by scoring all leaves globally and picking the highest score.
// Ties broken by coverage ratio (matched token chars / description length).
// Returns null if bestScore < minScore.
function assignCategory(row, columnMap, leaves, minScore) {
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

// Check if row matches a forced category
function checkForcedCategory(row, columnMap, forcedList) {
  if (!forcedList || forcedList.length === 0) return null;
  if (!('description' in columnMap)) return null;
  
  const descriptionValue = row[columnMap['description']] ? normalizeStr(row[columnMap['description']].trim()) : '';
  if (!descriptionValue) return null;

  // Score each matching forced entry by coverage: how much of the description the pattern covers
  // The longest (most specific) matching pattern wins
  let bestMatch = null;
  let bestScore = -1;

  for (const forced of forcedList) {
    if (!forced.description) continue;
    const pattern = normalizeStr(forced.description);
    if (!descriptionValue.includes(pattern)) continue;

    // Optional exact constraints for disambiguation
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

// Precompute flat leaf list once
const leaves = buildLeafList(categoryDefs, '');

// Read and process CSV
try {
  const { headerLine, lines, columnMap } = readCSVLines(inputFile);

  // Build output with added category column
  const outputLines = [headerLine + ',' + categoryColName];
  const tally = {};

  for (const line of lines) {
    const parts = parseCSVLine(line);
    // Check category patterns first
    const patternLabel = checkForcedCategory(parts, columnMap, categoryPatterns);
    const label = patternLabel || assignCategory(parts, columnMap, leaves, minScore) || defaultLabel;
    tally[label] = (tally[label] || 0) + 1;
    outputLines.push(line + ',' + label);
  }

  writeCSVRaw(outputFile, outputLines.join('\n') + '\n');

  const totalRows = lines.length - 1;
  console.log(`✓ Labeled CSV created: ${outputFile}`);
  console.log(`✓ Total rows: ${totalRows}`);
  console.log(`✓ Category breakdown:`);
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sorted) {
    const pct = ((count / totalRows) * 100).toFixed(1);
    console.log(`    ${label.padEnd(20)} ${String(count).padStart(4)} rows  (${pct}%)`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
