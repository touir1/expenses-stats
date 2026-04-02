const fs = require('fs');

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

// Read CSV
const csv = fs.readFileSync('data/processed/depenses-labeled.csv', 'utf-8');
const lines = csv.split('\n').slice(1);

const others = [];

lines.forEach(line => {
  if (!line.trim()) return;
  const parts = parseCSVLine(line);
  if (parts.length >= 6 && parts[parts.length - 1].trim() === 'other') {
    const amount = parts[0].trim();
    const currency = parts[1].trim();
    const desc = parts[4].trim();
    others.push({ desc, amount, currency });
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
