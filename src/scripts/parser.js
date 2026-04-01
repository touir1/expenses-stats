const fs = require('fs');
const path = require('path');

// Parse command-line arguments
const args = process.argv.slice(2);

// Help function
function showHelp() {
  console.log(`
Usage: node parser.js [options]

Options:
  --input-file <path>   Input text file containing expenses (default: ../../data/raw/depenses.txt)
  --output-file <path>  Output CSV file path (default: ../../data/processed/depenses.csv)
  -h, --help           Show this help message

Example:
  node parser.js --input-file expenses.txt --output-file expenses.csv
  node parser.js -h
`);
  process.exit(0);
}

// Check for help flag
if (args.includes('-h') || args.includes('--help')) {
  showHelp();
}

let inputFile = null;
let outputFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1];
    i++;
  } else if (args[i] === '--output-file' && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  }
}

// Use defaults if not provided
const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) {
  inputFile = path.join(baseDir, 'data', 'raw', 'depenses.txt');
}
if (!outputFile) {
  outputFile = path.join(baseDir, 'data', 'processed', 'depenses.csv');
}

// Make paths absolute if relative
if (!path.isAbsolute(inputFile)) {
  inputFile = path.join(process.cwd(), inputFile);
}
if (!path.isAbsolute(outputFile)) {
  outputFile = path.join(process.cwd(), outputFile);
}

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
console.log(`✓ CSV file created: ${outputFile}`);
console.log(`✓ Total expenses: ${expenses.length}`);
