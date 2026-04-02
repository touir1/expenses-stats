const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../utils/cli-args');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver');
const { logSuccess, logError } = require('../utils/console-output');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file', param: true, default: null },
  { flag: '--output-file', param: true, default: null }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node parser.js [options]

Options:
  --input-file <path>   Input text file containing expenses (default: data/raw/depenses.txt)
  --output-file <path>  Output CSV file path (default: data/processed/depenses.csv)
  -h, --help           Show this help message

Example:
  node parser.js --input-file expenses.txt --output-file expenses.csv
  node parser.js -h
`);
  process.exit(0);
}

// Use defaults from path resolver
const defaults = getDefaultPaths();
const inputFile = resolvePath(parsedArgs['input-file'], defaults.rawFile);
const outputFile = resolvePath(parsedArgs['output-file'], defaults.inputFile);

const content = fs.readFileSync(inputFile, 'utf-8');
const lines = content.split('\n');

// Parse the expenses
const expenses = [];
let currentDate = null;

for (const line of lines) {
  const trimmed = line.trim();
  
  // Skip empty lines and headers
  if (!trimmed || trimmed.startsWith('Dépenses') || trimmed.startsWith('Total mois')) {
    continue;
  }
  
  // Check if this is a date line (format: DD/MM/YYYY:)
  const dateMatch = trimmed.match(/^(\d{1,2}\/\d{1,2}\/\d{4}):?$/);
  if (dateMatch) {
    currentDate = dateMatch[1];
    continue;
  }
  
  // Parse expense line
  if (currentDate) {
    // Try to match: amount + currency + description
    // Formats: "5dt coffee", "804.5 € loyer courbevoie"
    
    // Format 1: amount followed by "dt" or "€" or " €"
    const expenseMatch = trimmed.match(/^([\d.]+)\s*(dt|€)\s+(.*)$/);
    
    if (expenseMatch) {
      const amount = expenseMatch[1];
      const currency = expenseMatch[2] === '€' ? '€' : 'dt';
      const description = expenseMatch[3].trim();
      
      expenses.push({
        amount,
        currency,
        date: currentDate,
        description
      });
    }
  }
}

// Create CSV header
let csv = 'amount,currency_symbol,currency_code,date,description\n';

// Currency code mapping
const currencyCodeMap = {
  '€': 'EUR',
  'dt': 'TND'
};

// Add expense rows
for (const expense of expenses) {
  // Escape description if it contains commas or quotes
  const description = expense.description.includes(',') || expense.description.includes('"')
    ? `"${expense.description.replace(/"/g, '""')}"`
    : expense.description;
  
  const currencyCode = currencyCodeMap[expense.currency] || 'UNK';
  csv += `${expense.amount},${expense.currency},${currencyCode},${expense.date},${description}\n`;
}

// Write the CSV file
fs.writeFileSync(outputFile, csv, 'utf-8');
logSuccess('CSV file created', outputFile);
logSuccess('Total expenses', `${expenses.length} rows`);
