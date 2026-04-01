const fs = require('fs');

// Read CSV
const csv = fs.readFileSync('data/processed/depenses-labeled.csv', 'utf-8');
const lines = csv.split('\n').slice(1);

const others = [];

lines.forEach(line => {
  if (line.endsWith(',other')) {
    const parts = line.split(',');
    if (parts.length >= 5) {
      const amount = parts[0];
      const currency = parts[1];
      const desc = parts.slice(4, -1).join(',').trim().replace(/^"|"$/g, '');
      others.push({ desc, amount, currency });
    }
  }
});

// Sort by description
others.sort((a, b) => a.desc.localeCompare(b.desc));

// Display
console.log(`\nTotal items in "other" category: ${others.length}\n`);
console.log('='.repeat(80));

others.forEach((item, i) => {
  console.log(`${String(i+1).padStart(4)}. ${item.desc.padEnd(55)} | ${String(item.amount).padStart(8)}${item.currency}`);
});

console.log('='.repeat(80));
