const { readCSV } = require('../utils/data');

// Read CSV
const { rows: csvRows, columnMap } = readCSV('data/processed/depenses-labeled.csv');

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
