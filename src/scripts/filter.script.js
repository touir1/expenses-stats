const path = require('path');
const { parseCSVLine } = require('../utils/csv.util');
const { matchesFilter } = require('../utils/filtering.util');
const { readCSVLines, writeCSVRaw, readJSON } = require('../utils/data.util');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');
const { logError } = require('../utils/console-output.util');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--output-file', param: true, default: null },
  { flag: '--filters', param: true, default: null },
  { flag: '--filters-file', param: true, default: null },
  { flag: '--begin-date', param: true, default: null },
  { flag: '--end-date', param: true, default: null }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node filter.script.js [options]

Options:
  --input-file <path>    Input CSV file (default: data/processed/depenses-labeled.csv)
  --output-file <path>   Output CSV file (default: output/depenses-filtered.csv)
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
  node filter.script.js --input-file data.csv --output-file filtered.csv \\
    --filters '{"currency_code": "EUR", "amount": {"gte": 100}}'
  node filter.script.js --begin-date "01/01/2024" --end-date "31/12/2024"
`);
  process.exit(0);
}

// Use defaults from path resolver
const defaults = getDefaultPaths();
let inputFile = resolvePath(parsedArgs['input-file'], defaults.inputFile);
let outputFile = resolvePath(parsedArgs['output-file'], path.join(defaults.outputDir, 'depenses-filtered.csv'));
const filterJson = parsedArgs['filters'];
const filtersFile = parsedArgs['filters-file'];
const beginDate = parsedArgs['begin-date'];
const endDate = parsedArgs['end-date'];

// Parse filters
let filtersDef = {};
if (filtersFile) {
  const fPath = path.isAbsolute(filtersFile) ? filtersFile : path.join(process.cwd(), filtersFile);
  try {
    filtersDef = readJSON(fPath);
  } catch (e) {
    logError('Could not read/parse --filters-file', e.message);
    process.exit(1);
  }
} else if (filterJson) {
  try {
    filtersDef = JSON.parse(filterJson);
  } catch (e) {
    logError('Invalid JSON in --filters parameter', e.message);
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
      logError(`Category "${categoryName}" not found in categories.json`);
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
    logError('Error reading categories', e.message);
    process.exit(1);
  }
}

// Resolve category references in filters
let filters = {};
if (filtersDef.category) {
  // Single category reference
  const tokens = collectCategoryTokens(filtersDef.category, resolvePath(null, defaults.categoriesFile));
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
      logError(`Column "${columnName}" not found in CSV header`);
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
  const { headerLine, lines, columnMap } = readCSVLines(inputFile);

  // Parse and filter data rows
  const filteredRows = [];
  let totalRows = 0;

  for (const line of lines) {
    totalRows++;
    const parts = parseCSVLine(line);

    if (matchesAllFilters(parts, columnMap)) {
      filteredRows.push(line);
    }
  }

  // Build output CSV
  let csv = headerLine + '\n';
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
