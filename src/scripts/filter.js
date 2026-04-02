const fs = require('fs');
const path = require('path');
const { parseCSVLine } = require('../utils/csv');
const { normalizeStr, countTokenMatches } = require('../utils/text');
const { matchesFilter, dateToComparable } = require('../utils/filtering');
const { readCSVLines, writeCSVRaw, readJSON, fileExists } = require('../utils/data');

// Parse command-line arguments
const args = process.argv.slice(2);

// Help function
function showHelp() {
  console.log(`
Usage: node filter.js [options]

Options:
  --input-file <path>    Input CSV file (default: ../../data/processed/depenses-labeled.csv)
  --output-file <path>   Output CSV file (default: ../../output/depenses-filtered.csv)
  --filters <json>       Filters in JSON format (GraphQL-like style)
  --filters-file <path>  Path to a JSON file containing filters
  --begin-date <date>    Filter expenses from this date (DD/MM/YYYY format)
  --end-date <date>      Filter expenses until this date (DD/MM/YYYY format)
  -h, --help            Show this help message

Filter Examples:
  --filters '{"amount": {"gt": 50}}'
  --filters '{"amount": {"gte": 100, "lte": 500}}'
  --filters '{"currency_code": "EUR"}'
  --filters '{"description": {"contains": "coffee"}}'
  --begin-date "01/01/2024" --end-date "31/12/2024"

Operator Support:
  Comparison: gt (>), gte (>=), lt (<), lte (<=), eq (=), ne (!=)
  String: contains, startsWith, endsWith, regex
  Array: in, nin (not in)
  Date format: DD/MM/YYYY

Example:
  node filter.js --input-file data.csv --output-file filtered.csv \\
    --filters '{"currency_code": "EUR", "amount": {"gte": 100}}'
  node filter.js --begin-date "01/01/2024" --end-date "31/12/2024"
`);
  process.exit(0);
}

// Check for help flag
if (args.includes('-h') || args.includes('--help')) {
  showHelp();
}

let inputFile = null;
let outputFile = null;
let filterJson = null;
let filtersFile = null;
let beginDate = null;
let endDate = null;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1];
    i++;
  } else if (args[i] === '--output-file' && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  } else if (args[i] === '--filters-file' && args[i + 1]) {
    filtersFile = args[i + 1];
    i++;
  } else if (args[i] === '--filters' && args[i + 1]) {
    filterJson = args[i + 1];
    i++;
  } else if (args[i] === '--begin-date' && args[i + 1]) {
    beginDate = args[i + 1];
    i++;
  } else if (args[i] === '--end-date' && args[i + 1]) {
    endDate = args[i + 1];
    i++;
  }
}

// Use defaults if not provided
const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) {
  inputFile = path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
}
if (!outputFile) {
  outputFile = path.join(baseDir, 'output', 'depenses-filtered.csv');
}

// Make paths absolute if relative
if (!path.isAbsolute(inputFile)) {
  inputFile = path.join(process.cwd(), inputFile);
}
if (!path.isAbsolute(outputFile)) {
  outputFile = path.join(process.cwd(), outputFile);
}

// Parse filters
let filtersDef = {};
if (filtersFile) {
  const fPath = path.isAbsolute(filtersFile) ? filtersFile : path.join(process.cwd(), filtersFile);
  try {
    filtersDef = readJSON(fPath);
  } catch (e) {
    console.error('Error: Could not read/parse --filters-file:', e.message);
    process.exit(1);
  }
} else if (filterJson) {
  try {
    filtersDef = JSON.parse(filterJson);
  } catch (e) {
    console.error('Error: Invalid JSON in --filters parameter:', e.message);
    process.exit(1);
  }
}

// Collect all tokens from a category's subcategories
function collectCategoryTokens(categoryName, categoriesPath) {
  try {
    const cPath = path.isAbsolute(categoriesPath) ? categoriesPath : path.join(process.cwd(), categoriesPath);
    const categoriesData = readJSON(cPath);
    
    const category = categoriesData.categories.find(c => c.name === categoryName);
    if (!category) {
      console.error(`Error: Category "${categoryName}" not found in categories.json`);
      process.exit(1);
    }
    
    if (!category.subcategories || category.subcategories.length === 0) {
      return [];
    }
    
    const allTokens = new Set();
    for (const sub of category.subcategories) {
      if (sub.filters && sub.filters.description && Array.isArray(sub.filters.description.tokens)) {
        sub.filters.description.tokens.forEach(t => allTokens.add(t));
      }
    }
    return Array.from(allTokens);
  } catch (e) {
    console.error(`Error reading categories: ${e.message}`);
    process.exit(1);
  }
}

// Resolve category references in filters
let filters = {};
if (filtersDef.category) {
  // Single category reference
  const tokens = collectCategoryTokens(filtersDef.category, path.join(baseDir, 'config', 'categories.json'));
  filters = { description: { tokens } };
} else if (filtersDef.filters) {
  // Regular filters
  filters = filtersDef.filters;
} else {
  filters = filtersDef;
}

// Add date range filters if provided
if (beginDate || endDate) {
  if (!filters.date) {
    filters.date = {};
  }
  if (beginDate) {
    filters.date.gte = beginDate;
  }
  if (endDate) {
    filters.date.lte = endDate;
  }
}

// Function to check if a row matches all filters
function matchesAllFilters(row, columnMap) {
  for (const [columnName, condition] of Object.entries(filters)) {
    if (!(columnName in columnMap)) {
      console.error(`Error: Column "${columnName}" not found in CSV header`);
      process.exit(1);
    }
    const columnIndex = columnMap[columnName];
    const value = row[columnIndex].trim();
    
    if (!matchesFilter(value, condition, columnName)) {
      return false;
    }
  }
  return true;
}

// Read the CSV file
try {
  const { headers, lines, columnMap } = readCSVLines(inputFile);

  if (lines.length < 1) {
    console.error('Error: CSV file is empty');
    process.exit(1);
  }

  // Parse and filter data rows
  const filteredRows = [];
  let totalRows = 0;

  for (let i = 1; i < lines.length; i++) {
    totalRows++;
    const parts = parseCSVLine(lines[i]);
    
    if (matchesAllFilters(parts, columnMap)) {
      filteredRows.push(lines[i]);
    }
  }

  // Build output CSV
  let csv = lines[0] + '\n';
  csv += filteredRows.join('\n');
  if (filteredRows.length > 0) {
    csv += '\n';
  }

  // Write the output file
  writeCSVRaw(outputFile, csv);

  console.log(`✓ Filtered CSV created: ${outputFile}`);
  console.log(`✓ Total rows: ${totalRows}`);
  console.log(`✓ Matching rows: ${filteredRows.length}`);
  console.log(`✓ Filtered out: ${totalRows - filteredRows.length}`);
  
  if (Object.keys(filters).length > 0) {
    console.log(`✓ Filters applied: ${JSON.stringify(filters)}`);
  } else {
    console.log(`⚠ No filters applied (all rows included)`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
