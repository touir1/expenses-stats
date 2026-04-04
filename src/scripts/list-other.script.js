const { readCSV } = require('../utils/data.util');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');

const optionDefs = [
  { flag: '--input-file', param: true, default: null }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node list-other.script.js [options]

Options:
  --input-file <path>  Input labeled CSV file (default: data/processed/depenses-labeled.csv)
  -h, --help          Show this help message
`);
  process.exit(0);
}

const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.inputFile);

// Read CSV
const { rows: csvRows } = readCSV(inputFile);

const others = csvRows
  .filter(row => (row['category'] || '').trim() === 'other')
  .map(row => ({
    desc:     (row['description'] || '').trim(),
    amount:   (row['amount'] || '').trim(),
    currency: (row['currency_symbol'] || '').trim()
  }));

// Sort by description
others.sort((a, b) => a.desc.localeCompare(b.desc));

// Display
console.log(`\nTotal items in "other" category: ${others.length}\n`);
console.log('='.repeat(80));

others.forEach((item, i) => {
  console.log(`${String(i+1).padStart(4)}. ${item.desc.padEnd(55)} | ${String(item.amount).padStart(8)}${item.currency}`);
});

console.log('='.repeat(80));
