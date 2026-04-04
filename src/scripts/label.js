const fs = require('fs');
const path = require('path');
const { normalizeStr, countTokenMatches } = require('../utils/text');
const { matchesFilter } = require('../utils/filtering');
const { parseCSVLine } = require('../utils/csv');
const { readCSVLines, writeCSVRaw, loadCategories, loadCategoryPatterns, fileExists } = require('../utils/data');
const { parseArgs } = require('../utils/cli-args');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver');
const { logWarning, logError, logSuccess, logInfo } = require('../utils/console-output');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--output-file', param: true, default: null },
  { flag: '--categories', param: true, default: null },
  { flag: '--categories-file', param: true, default: null },
  { flag: '--category-patterns-file', param: true, default: null },
  { flag: '--category-col', param: true, default: 'category' },
  { flag: '--default', param: true, default: 'other' },
  { flag: '--separator', param: true, default: '/' }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node label.js [options]

Options:
  --input-file <path>         Input CSV file (default: data/processed/depenses.csv)
  --output-file <path>        Output CSV file (default: data/processed/depenses-labeled.csv)
  --categories <json>         Categories definition as inline JSON
  --categories-file <path>    Path to JSON file defining categories (default: config/categories.config.json)
  --category-patterns-file <path> Path to JSON file with category patterns (default: config/category-patterns.config.json)
  --category-col <name>       Name of the added column (default: category)
  --default <label>           Default label when no category matches (default: "other")
  -h, --help                 Show this help message

Examples:
  node label.js --categories-file config/categories.config.json
  node label.js --help
`);
  process.exit(0);
}

// Resolve paths
const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.parsedFile);
const outputFile = resolvePath(parsedArgs['output-file'], defaults.inputFile);
const categoriesFile = parsedArgs['categories-file'] ? resolvePath(parsedArgs['categories-file']) : defaults.categoriesFile;
const categoryPatternsFile = resolvePath(parsedArgs['category-patterns-file'], defaults.categoryPatternsFile);
const categoryColName = parsedArgs['category-col'] || 'category';
const defaultLabel = parsedArgs['default'] || 'other';
const separator = parsedArgs['separator'] || '/';
const categoriesJson = parsedArgs['categories'] || null;

// Load category patterns
let categoryPatterns = [];
if (categoryPatternsFile && fileExists(categoryPatternsFile)) {
  try {
    categoryPatterns = loadCategoryPatterns(categoryPatternsFile);
  } catch (e) {
    logWarning('Could not read/parse category-patterns-file', e.message);
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



// Sum token-match scores across all token filters in a category definition
function getCategoryScore(row, columnMap, filters) {
  if (!filters) return 0;
  let score = 0;
  for (const [colName, condition] of Object.entries(filters)) {
    if (colName in columnMap && typeof condition === 'object' && Array.isArray(condition.tokens)) {
      score += countTokenMatches(row[columnMap[colName]].trim(), condition.tokens);
    }
  }
  return score;
}



// Collect all tokens from subcategories (if category has no explicit filters)
function collectSubcategoryTokens(catDef) {
  if (!catDef.subcategories || catDef.subcategories.length === 0) {
    return null;
  }
  const allTokens = new Set();
  for (const sub of catDef.subcategories) {
    if (sub.filters && sub.filters.description && Array.isArray(sub.filters.description.tokens)) {
      sub.filters.description.tokens.forEach(t => allTokens.add(t));
    }
  }
  return allTokens.size > 0 ? Array.from(allTokens) : null;
}

// Match a row against all filters in a category (AND logic)
// If category has no explicit filters but has subcategories, use auto-generated filters from subcategories
function matchesCategory(row, columnMap, catDef) {
  let filters = catDef.filters || {};
  
  // If no explicit filters but has subcategories, auto-generate filter from subcategory tokens
  if (Object.keys(filters).length === 0 && catDef.subcategories && catDef.subcategories.length > 0) {
    const tokens = collectSubcategoryTokens(catDef);
    if (tokens && tokens.length > 0) {
      filters = { description: { tokens } };
    }
  }
  
  for (const [colName, condition] of Object.entries(filters)) {
    if (!(colName in columnMap)) {
      console.error(`Error: Column "${colName}" not found in CSV header`);
      process.exit(1);
    }
    const value = row[columnMap[colName]].trim();
    if (!matchesFilter(value, condition)) return false;
  }
  return true;
}

// Check if row matches a forced category
function checkForcedCategory(row, columnMap, forcedList) {
  if (!forcedList || forcedList.length === 0) return null;
  if (!('description' in columnMap)) return null;
  
  const descriptionValue = row[columnMap['description']] ? row[columnMap['description']].trim().toLowerCase() : '';
  if (!descriptionValue) return null;

  // Score each matching forced entry by coverage: how much of the description the pattern covers
  // The longest (most specific) matching pattern wins
  let bestMatch = null;
  let bestScore = -1;

  for (const forced of forcedList) {
    if (!forced.description) continue;
    const pattern = forced.description.toLowerCase();
    if (!descriptionValue.includes(pattern)) continue;

    const score = pattern.length / descriptionValue.length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = forced.category;
    }
  }
  return bestMatch;
}

// Recursively assign hierarchical category label
function assignCategory(row, columnMap, categories, parentPath) {
  for (const catDef of categories) {
    if (matchesCategory(row, columnMap, catDef)) {
      const currentPath = parentPath ? `${parentPath}${separator}${catDef.name}` : catDef.name;
      if (catDef.subcategories && catDef.subcategories.length > 0) {
        // If any subcategory uses tokens, score all matching subs and pick the best
        const usesTokens = catDef.subcategories.some(s =>
          s.filters && Object.values(s.filters).some(f => f && typeof f === 'object' && Array.isArray(f.tokens))
        );
        if (usesTokens) {
          let bestPath = null;
          let bestScore = -1;
          for (const sub of catDef.subcategories) {
            if (!matchesCategory(row, columnMap, sub)) continue;
            const score = getCategoryScore(row, columnMap, sub.filters);
            if (score > bestScore) { bestScore = score; bestPath = `${currentPath}${separator}${sub.name}`; }
          }
          return bestPath || currentPath;
        }
        // First-match-wins for non-token subcategories
        const subLabel = assignCategory(row, columnMap, catDef.subcategories, currentPath);
        if (subLabel !== null) return subLabel;
      }
      return currentPath;
    }
  }
  return null;
}

// Read and process CSV
try {
  const { headers, lines, columnMap } = readCSVLines(inputFile);

  if (lines.length < 1) {
    console.error('Error: CSV file is empty');
    process.exit(1);
  }

  // Build output with added category column
  const outputLines = [lines[0] + ',' + categoryColName];
  const tally = {};

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    // Check category patterns first
    const patternLabel = checkForcedCategory(parts, columnMap, categoryPatterns);
    const label = patternLabel || assignCategory(parts, columnMap, categoryDefs, '') || defaultLabel;
    tally[label] = (tally[label] || 0) + 1;
    outputLines.push(lines[i] + ',' + label);
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
