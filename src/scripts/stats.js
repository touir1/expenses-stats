const fs = require('fs');
const path = require('path');

// Parse command-line arguments
const args = process.argv.slice(2);

// Help function
function showHelp() {
  console.log(`
Usage: node stats.js [options]

Options:
  --input-file <path>        Input CSV file with expenses (default: ../../data/processed/depenses-labeled.csv)
  --output <mode>            Output mode: 'console', 'file', or 'both' (default: console)
  --output-file <path>       Output JSON file path (default: ../../output/depenses-stats.json)
  --conversion-rates <path>  Conversion rates CSV file (default: ../../config/conversion_rates.csv)
  --convert-to <currency>    Convert amounts to currency: EUR or TND
  -h, --help                Show this help message

Example:
  node stats.js
  node stats.js --input-file data/processed/depenses-labeled.csv --output file --output-file output/stats.json
  node stats.js --convert-to EUR
  node stats.js -h
`);
  process.exit(0);
}

// Check for help flag
if (args.includes('-h') || args.includes('--help')) {
  showHelp();
}

let inputFile = null;
let outputMode = 'console'; // 'console', 'file', or 'both'
let outputFile = null;
let conversionRatesFile = null;
let convertCurrency = null; // 'EUR' or 'TND'

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1];
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputMode = args[i + 1];
    i++;
  } else if (args[i] === '--output-file' && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  } else if (args[i] === '--conversion-rates' && args[i + 1]) {
    conversionRatesFile = args[i + 1];
    i++;
  } else if (args[i] === '--convert-to' && args[i + 1]) {
    convertCurrency = args[i + 1].toUpperCase();
    i++;
  }
}

// Use defaults if not provided
const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) {
  inputFile = path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
}
if (!outputFile) {
  outputFile = path.join(baseDir, 'output', 'depenses-stats.json');
}
if (!conversionRatesFile) {
  conversionRatesFile = path.join(baseDir, 'config', 'conversion_rates.csv');
}

// Make paths absolute if relative
if (!path.isAbsolute(inputFile)) {
  inputFile = path.join(process.cwd(), inputFile);
}
if (!path.isAbsolute(outputFile)) {
  outputFile = path.join(process.cwd(), outputFile);
}
if (!path.isAbsolute(conversionRatesFile)) {
  conversionRatesFile = path.join(process.cwd(), conversionRatesFile);
}

// Load conversion rates
const conversionRates = {};
if (fs.existsSync(conversionRatesFile)) {
  const ratesContent = fs.readFileSync(conversionRatesFile, 'utf-8');
  const ratesLines = ratesContent.split('\n').filter(l => l.trim());
  
  for (let i = 1; i < ratesLines.length; i++) {
    const [date, rate] = ratesLines[i].split(',');
    if (date && rate) {
      // Store by full date (YYYY-MM-DD)
      conversionRates[date.trim()] = parseFloat(rate);
    }
  }
}

// Read and parse CSV
const content = fs.readFileSync(inputFile, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());

if (lines.length < 2) {
  console.error('Error: CSV file is empty or invalid');
  process.exit(1);
}

// Parse header
const headers = parseCSVLine(lines[0]).map(h => h.trim());
const amountIdx = headers.indexOf('amount');
const currencySymbolIdx = headers.indexOf('currency_symbol');
const currencyCodeIdx = headers.indexOf('currency_code');
const dateIdx = headers.indexOf('date');
const descriptionIdx = headers.indexOf('description');
const categoryIdx = headers.indexOf('category');

if (amountIdx === -1 || currencySymbolIdx === -1 || currencyCodeIdx === -1 || dateIdx === -1) {
  console.error('Error: CSV header is missing required columns');
  process.exit(1);
}

// Parse data rows
const expenses = [];
for (let i = 1; i < lines.length; i++) {
  const parts = parseCSVLine(lines[i]);
  if (parts.length < headers.length) continue;

  const description = descriptionIdx !== -1 ? parts[descriptionIdx].trim() : '';
  const category = categoryIdx !== -1 ? parts[categoryIdx].trim() : null;

  expenses.push({
    amount: parseFloat(parts[amountIdx]),
    currencySymbol: parts[currencySymbolIdx].trim(),
    currencyCode: parts[currencyCodeIdx].trim(),
    date: parts[dateIdx].trim(),
    description,
    category
  });
}

// Helper function to get conversion rate for a date
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

function getConversionRate(dateStr) {
  // dateStr is DD/MM/YYYY
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    const fullDate = `${year}-${month}-${day}`;
    
    // Try exact date first
    if (conversionRates[fullDate]) {
      return conversionRates[fullDate];
    }
    
    // Fall back to first available date before this date
    const rateKeys = Object.keys(conversionRates).sort();
    for (let i = rateKeys.length - 1; i >= 0; i--) {
      if (rateKeys[i] <= fullDate) {
        return conversionRates[rateKeys[i]];
      }
    }
    
    // If no rate before, use the first available rate
    if (rateKeys.length > 0) {
      return conversionRates[rateKeys[0]];
    }
  }
  return 3.5; // Default fallback
}

// Convert amounts if requested
if (convertCurrency && (convertCurrency === 'EUR' || convertCurrency === 'TND')) {
  expenses.forEach(exp => {
    if (exp.currencyCode !== convertCurrency) {
      const rate = getConversionRate(exp.date);
      if (exp.currencyCode === 'TND' && convertCurrency === 'EUR') {
        exp.originalAmount = exp.amount;
        exp.amount = exp.amount / rate;
      } else if (exp.currencyCode === 'EUR' && convertCurrency === 'TND') {
        exp.originalAmount = exp.amount;
        exp.amount = exp.amount * rate;
      }
      exp.currencyCode = convertCurrency;
      exp.currencySymbol = convertCurrency === 'EUR' ? '€' : 'dt';
      exp.converted = true;
    }
  });
}

// Calculate statistics
const hasCategories = categoryIdx !== -1;
const stats = {
  totalEntries: expenses.length,
  conversionApplied: convertCurrency ? true : false,
  targetCurrency: convertCurrency || null,
  totalAmount: convertCurrency ? 0 : { EUR: 0, TND: 0 },
  byCurrency: {},
  byMonth: {},
  ...(hasCategories ? { byCategory: {} } : {}),
  minAmount: Infinity,
  maxAmount: -Infinity,
  averageAmount: 0,
  generatedAt: new Date().toISOString()
};

// Process each expense
expenses.forEach(exp => {
  const amount = exp.amount;
  const code = exp.currencyCode;
  
  // Total amounts
  if (convertCurrency) {
    stats.totalAmount += amount;
  } else {
    if (code === 'EUR') {
      stats.totalAmount.EUR += amount;
    } else if (code === 'TND') {
      stats.totalAmount.TND += amount;
    }
  }
  
  // Min/Max
  stats.minAmount = Math.min(stats.minAmount, amount);
  stats.maxAmount = Math.max(stats.maxAmount, amount);
  
  // By currency
  if (!stats.byCurrency[code]) {
    stats.byCurrency[code] = {
      count: 0,
      total: 0,
      average: 0,
      min: Infinity,
      max: -Infinity
    };
  }
  stats.byCurrency[code].count++;
  stats.byCurrency[code].total += amount;
  stats.byCurrency[code].min = Math.min(stats.byCurrency[code].min, amount);
  stats.byCurrency[code].max = Math.max(stats.byCurrency[code].max, amount);
  
  // By month (from date DD/MM/YYYY)
  const [day, month, year] = exp.date.split('/');
  const monthKey = `${year}-${month}`;
  if (!stats.byMonth[monthKey]) {
    stats.byMonth[monthKey] = {
      count: 0,
      EUR: 0,
      TND: 0
    };
  }
  stats.byMonth[monthKey].count++;
  if (code === 'EUR') {
    stats.byMonth[monthKey].EUR += amount;
  } else {
    stats.byMonth[monthKey].TND += amount;
  }

  // By category
  if (hasCategories && exp.category) {
    const cat = exp.category;
    const [mainCat, subCat] = cat.split('/');
    
    if (!stats.byCategory[mainCat]) {
      stats.byCategory[mainCat] = { 
        count: 0, 
        EUR: 0, 
        TND: 0,
        subcategories: {}
      };
    }
    stats.byCategory[mainCat].count++;
    if (code === 'EUR') {
      stats.byCategory[mainCat].EUR += amount;
    } else {
      stats.byCategory[mainCat].TND += amount;
    }
    
    // By subcategory (if exists)
    if (subCat) {
      if (!stats.byCategory[mainCat].subcategories[subCat]) {
        stats.byCategory[mainCat].subcategories[subCat] = { count: 0, EUR: 0, TND: 0 };
      }
      stats.byCategory[mainCat].subcategories[subCat].count++;
      if (code === 'EUR') {
        stats.byCategory[mainCat].subcategories[subCat].EUR += amount;
      } else {
        stats.byCategory[mainCat].subcategories[subCat].TND += amount;
      }
    }
  }
});

// Calculate monthly totals with conversion to both currencies
Object.keys(stats.byMonth).forEach(monthKey => {
  const monthData = stats.byMonth[monthKey];
  const rate = getConversionRate(`01/${monthKey.split('-')[1]}/${monthKey.split('-')[0]}`);
  const rateInverse = 1 / rate;
  
  // Total shown in EUR: EUR + (TND / rate)
  const totalEUR = monthData.EUR + (monthData.TND / rate);
  // Total shown in TND: TND + (EUR * rate)
  const totalTND = monthData.TND + (monthData.EUR * rate);
  
  monthData.total = {
    EUR: totalEUR,
    TND: totalTND
  };
});

// Add unified total in both currencies (EUR + TND converted)
if (!convertCurrency && stats.totalAmount.EUR !== undefined) {
  let totalInEUR = 0;
  let totalInTND = 0;
  
  // Sum monthly totals in both currencies
  Object.keys(stats.byMonth).forEach(monthKey => {
    const monthData = stats.byMonth[monthKey];
    totalInEUR += monthData.total.EUR;
    totalInTND += monthData.total.TND;
  });
  
  stats.totalAmount.total = {
    EUR: totalInEUR,
    TND: totalInTND
  };
}

// Calculate category converted totals
if (hasCategories) {
  Object.keys(stats.byCategory).forEach(mainCat => {
    const c = stats.byCategory[mainCat];
    // Use overall average rate for category totals (no date context per category)
    const rates = Object.values(conversionRates);
    const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 3.5;
    c.total = {
      EUR: c.EUR + (c.TND / avgRate),
      TND: c.TND + (c.EUR * avgRate)
    };
    c.average = { EUR: c.total.EUR / c.count, TND: c.total.TND / c.count };
    
    // Calculate subcategory totals
    if (c.subcategories) {
      Object.keys(c.subcategories).forEach(subCat => {
        const sub = c.subcategories[subCat];
        sub.total = {
          EUR: sub.EUR + (sub.TND / avgRate),
          TND: sub.TND + (sub.EUR * avgRate)
        };
        sub.average = { EUR: sub.total.EUR / sub.count, TND: sub.total.TND / sub.count };
      });
    }
  });
  // Sort by category name, then subcategory name
  const sortedCats = {};
  Object.entries(stats.byCategory)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([k, v]) => {
      if (v.subcategories) {
        const sortedSubs = {};
        Object.entries(v.subcategories)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([subk, subv]) => { sortedSubs[subk] = subv; });
        v.subcategories = sortedSubs;
      }
      sortedCats[k] = v;
    });
  stats.byCategory = sortedCats;
}

// Calculate averages
if (stats.totalAmount.total && typeof stats.totalAmount.total === 'object') {
  // Average based on EUR total
  stats.averageAmount = stats.totalAmount.total.EUR / stats.totalEntries;
} else {
  stats.averageAmount = stats.totalAmount.total / stats.totalEntries;
}
Object.keys(stats.byCurrency).forEach(code => {
  stats.byCurrency[code].average = stats.byCurrency[code].total / stats.byCurrency[code].count;
});

// Sort months
const sortedMonths = {};
Object.keys(stats.byMonth).sort().forEach(month => {
  sortedMonths[month] = stats.byMonth[month];
});
stats.byMonth = sortedMonths;

// Format output
const formatStats = () => {
  let output = '\n╔════════════════════════════════════════════════╗\n';
  output += '║         EXPENSE STATISTICS SUMMARY              ║\n';
  output += '╚════════════════════════════════════════════════╝\n\n';
  
  output += `📊 Total Entries: ${stats.totalEntries}\n`;
  
  if (convertCurrency) {
    const symbol = convertCurrency === 'EUR' ? '€' : 'dt';
    output += `💰 Total Amount: ${stats.totalAmount.toFixed(2)}${symbol} (converted to ${convertCurrency})\n`;
    output += `📈 Average Amount: ${stats.averageAmount.toFixed(2)}${symbol}\n`;
    output += `📉 Range: ${stats.minAmount.toFixed(2)} - ${stats.maxAmount.toFixed(2)}${symbol}\n\n`;
  } else {
    output += `💰 Total Amount: €${stats.totalAmount.EUR.toFixed(2)} + ${stats.totalAmount.TND.toFixed(2)}dt\n`;
    output += `   Converted Total: €${stats.totalAmount.total.EUR.toFixed(2)} or ${stats.totalAmount.total.TND.toFixed(2)}dt\n`;
    const eurCurrency = stats.byCurrency['EUR'];
    const tndCurrency = stats.byCurrency['TND'];
    if (eurCurrency) {
      output += `📈 (EUR) Average: €${eurCurrency.average.toFixed(2)}, Range: €${eurCurrency.min.toFixed(2)} - €${eurCurrency.max.toFixed(2)}\n`;
    }
    if (tndCurrency) {
      output += `📈 (TND) Average: ${tndCurrency.average.toFixed(2)}dt, Range: ${tndCurrency.min.toFixed(2)} - ${tndCurrency.max.toFixed(2)}dt\n`;
    }
    output += '\n';
  }
  
  output += '💶 BY CURRENCY:\n';
  output += '─────────────────────\n';
  Object.keys(stats.byCurrency).forEach(code => {
    const c = stats.byCurrency[code];
    output += `  ${code}: ${c.count} entries\n`;
    output += `    Total: ${c.total.toFixed(2)}\n`;
    output += `    Average: ${c.average.toFixed(2)}\n`;
    output += `    Range: ${c.min.toFixed(2)} - ${c.max.toFixed(2)}\n\n`;
  });
  
  output += '📅 BY MONTH:\n';
  output += '─────────────────────\n';
  Object.keys(stats.byMonth).forEach(month => {
    const m = stats.byMonth[month];
    if (convertCurrency) {
      const symbol = convertCurrency === 'EUR' ? '€' : 'dt';
      output += `  ${month}: ${m.count} entries | ${m.total.toFixed(2)}${symbol}\n`;
    } else {
      const totalEUR = m.total.EUR !== undefined ? m.total.EUR.toFixed(2) : (m.EUR + m.TND).toFixed(2);
      const totalTND = m.total.TND !== undefined ? m.total.TND.toFixed(2) : (m.EUR + m.TND).toFixed(2);
      output += `  ${month}: ${m.count} entries | €${m.EUR.toFixed(2)} + ${m.TND.toFixed(2)}dt | Total: €${totalEUR} or ${totalTND}dt\n`;
    }
  });

  if (hasCategories && stats.byCategory && Object.keys(stats.byCategory).length > 0) {
    output += '\n🏷️  BY CATEGORY:\n';
    output += '─────────────────────\n';
    Object.keys(stats.byCategory).forEach(cat => {
      const c = stats.byCategory[cat];
      if (convertCurrency) {
        const symbol = convertCurrency === 'EUR' ? '€' : 'dt';
        output += `  ${cat.padEnd(30)} ${String(c.count).padStart(4)} entries | ${c.total.EUR.toFixed(2)}${symbol}\n`;
      } else {
        output += `  ${cat.padEnd(30)} ${String(c.count).padStart(4)} entries | €${c.EUR.toFixed(2)} + ${c.TND.toFixed(2)}dt | Total: €${c.total.EUR.toFixed(2)}\n`;
      }
      
      // Show subcategories
      if (c.subcategories && Object.keys(c.subcategories).length > 0) {
        Object.keys(c.subcategories).forEach(subCat => {
          const sub = c.subcategories[subCat];
          if (convertCurrency) {
            const symbol = convertCurrency === 'EUR' ? '€' : 'dt';
            output += `    → ${subCat.padEnd(26)} ${String(sub.count).padStart(4)} entries | ${sub.total.EUR.toFixed(2)}${symbol}\n`;
          } else {
            output += `    → ${subCat.padEnd(26)} ${String(sub.count).padStart(4)} entries | €${sub.EUR.toFixed(2)} + ${sub.TND.toFixed(2)}dt | Total: €${sub.total.EUR.toFixed(2)}\n`;
          }
        });
      }
    });
  }
  
  output += `\n⏰ Generated: ${new Date(stats.generatedAt).toLocaleString()}\n`;
  if (convertCurrency) {
    output += `📍 Currency Conversion: Using rates from ${path.basename(conversionRatesFile)}\n`;
  }
  return output;
};

const jsonOutput = JSON.stringify(stats, null, 2);
const consoleOutput = formatStats();

// Output based on mode
if (outputMode === 'console' || outputMode === 'both') {
  console.log(consoleOutput);
}

if (outputMode === 'file' || outputMode === 'both') {
  fs.writeFileSync(outputFile, jsonOutput, 'utf-8');
  console.log(`✓ Stats saved to: ${outputFile}`);
}

if (!['console', 'file', 'both'].includes(outputMode)) {
  console.error(`Invalid output mode: ${outputMode}. Use: console, file, or both`);
  process.exit(1);
}
