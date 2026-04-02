const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Usage: node label.js [options]

Options:
  --input-file <path>         Input CSV file (default: ../../data/processed/depenses.csv)
  --output-file <path>        Output CSV file (default: ../../data/processed/depenses-labeled.csv)
  --categories <json>         Categories definition as inline JSON
  --categories-file <path>    Path to JSON file defining categories (default: ../../config/categories.json)
  --category-patterns-file <path> Path to JSON file with category patterns (default: ../../config/category-patterns.json)
  --category-col <name>       Name of the added column (default: category)
  --default <label>           Default label when no category matches (default: "other")
  -h, --help                 Show this help message

Categories File Format:
  {
    "categories": [
      {
        "name": "fuel",
        "filters": { "description": { "regex": "escence|essence" } }
      },
      {
        "name": "mechanic",
        "filters": { "description": { "contains": "mecanicien" } }
      }
    ]
  }

Category Patterns File Format:
  {
    "forced": [
      {
        "description": "abderrahmen sallem",
        "category": "false-positive/lending"
      }
    ]
  }

Notes:
  - Categories are evaluated in order; first match wins
  - Forced categories are checked BEFORE automatic detection
  - Multiple filters within a category are ANDed together
  - Supports same operators as filter.js

Example:
  node label.js --categories-file config/categories.json --category-patterns-file config/category-patterns.json
`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  showHelp();
}

let inputFile = null;
let outputFile = null;
let categoriesJson = null;
let categoriesFile = null;
let categoryPatternsFile = null;
let categoryColName = 'category';
let defaultLabel = 'other';
let separator = '/';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1]; i++;
  } else if (args[i] === '--output-file' && args[i + 1]) {
    outputFile = args[i + 1]; i++;
  } else if (args[i] === '--categories' && args[i + 1]) {
    categoriesJson = args[i + 1]; i++;
  } else if (args[i] === '--categories-file' && args[i + 1]) {
    categoriesFile = args[i + 1]; i++;
  } else if (args[i] === '--category-patterns-file' && args[i + 1]) {
    categoryPatternsFile = args[i + 1]; i++;
  } else if (args[i] === '--category-col' && args[i + 1]) {
    categoryColName = args[i + 1]; i++;
  } else if (args[i] === '--default' && args[i + 1]) {
    defaultLabel = args[i + 1]; i++;
  } else if (args[i] === '--separator' && args[i + 1]) {
    separator = args[i + 1]; i++;
  }
}

const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) inputFile = path.join(baseDir, 'data', 'processed', 'depenses.csv');
if (!outputFile) outputFile = path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
if (!categoriesFile && !categoriesJson) categoriesFile = path.join(baseDir, 'config', 'categories.json');
if (!categoryPatternsFile) categoryPatternsFile = path.join(baseDir, 'config', 'category-patterns.json');

if (!path.isAbsolute(inputFile)) inputFile = path.join(process.cwd(), inputFile);
if (!path.isAbsolute(outputFile)) outputFile = path.join(process.cwd(), outputFile);
if (!path.isAbsolute(categoryPatternsFile)) categoryPatternsFile = path.join(process.cwd(), categoryPatternsFile);

// Load category patterns
let categoryPatterns = [];
if (categoryPatternsFile && fs.existsSync(categoryPatternsFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(categoryPatternsFile, 'utf-8').replace(/^\uFEFF/, ''));
    categoryPatterns = parsed.forced || [];
  } catch (e) {
    console.warn('Warning: Could not read/parse category-patterns-file:', e.message);
  }
}

// Load categories
let categoryDefs = [];
if (categoriesFile) {
  const fPath = path.isAbsolute(categoriesFile) ? categoriesFile : path.join(process.cwd(), categoriesFile);
  try {
    const parsed = JSON.parse(fs.readFileSync(fPath, 'utf-8').replace(/^\uFEFF/, ''));
    categoryDefs = parsed.categories || [];
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
  showHelp();
}

if (categoryDefs.length === 0) {
  console.error('Error: No categories defined');
  process.exit(1);
}

// Parse a CSV line respecting quoted fields
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// Strip accents and lowercase for accent-insensitive matching
function normalizeStr(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Count how many tokens match value as whole words (word-boundary + accent normalization)
function countTokenMatches(value, tokens) {
  const normValue = normalizeStr(value);
  return tokens.reduce((count, token) => {
    const normToken = normalizeStr(token);
    const escaped = normToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return count + (new RegExp('\\b' + escaped + '\\b', 'i').test(normValue) ? 1 : 0);
  }, 0);
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

// Match a single value against a filter condition
function matchesFilter(value, condition) {
  if (typeof condition !== 'object' || condition === null) {
    return String(value) === String(condition);
  }
  for (const [op, operand] of Object.entries(condition)) {
    const numVal = parseFloat(value);
    const numOp = parseFloat(operand);
    switch (op) {
      case 'eq':   if (String(value) !== String(operand)) return false; break;
      case 'ne':   if (String(value) === String(operand)) return false; break;
      case 'gt':   if (isNaN(numVal) || isNaN(numOp) || numVal <= numOp) return false; break;
      case 'gte':  if (isNaN(numVal) || isNaN(numOp) || numVal < numOp) return false; break;
      case 'lt':   if (isNaN(numVal) || isNaN(numOp) || numVal >= numOp) return false; break;
      case 'lte':  if (isNaN(numVal) || isNaN(numOp) || numVal > numOp) return false; break;
      case 'contains':    if (!String(value).includes(String(operand))) return false; break;
      case 'startsWith':  if (!String(value).startsWith(String(operand))) return false; break;
      case 'endsWith':    if (!String(value).endsWith(String(operand))) return false; break;
      case 'regex':
        try {
          const rx = new RegExp(operand, 'i');
          if (!rx.test(String(value)) && !rx.test(normalizeStr(String(value)))) return false;
        }
        catch (e) { console.error(`Invalid regex "${operand}": ${e.message}`); process.exit(1); }
        break;
      case 'tokens':
        if (!Array.isArray(operand) || countTokenMatches(String(value), operand) === 0) return false;
        break;
      case 'in':   if (!Array.isArray(operand) || !operand.map(String).includes(String(value))) return false; break;
      case 'nin':  if (!Array.isArray(operand) || operand.map(String).includes(String(value))) return false; break;
      default:
        console.error(`Error: Unknown operator "${op}"`); process.exit(1);
    }
  }
  return true;
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
  const content = fs.readFileSync(inputFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 1) {
    console.error('Error: CSV file is empty');
    process.exit(1);
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const columnMap = {};
  headers.forEach((h, i) => { columnMap[h] = i; });

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

  fs.writeFileSync(outputFile, outputLines.join('\n') + '\n', 'utf-8');

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
