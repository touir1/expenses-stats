#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function normalizeStr(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function loadConversionRates(csvPath) {
  try {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const rates = {};
    for (let i = 1; i < lines.length; i++) {
      const [date, rate] = lines[i].split(',');
      if (date && rate) {
        // Store by full date (YYYY-MM-DD) for daily rates
        rates[date.trim()] = parseFloat(rate);
      }
    }
    return rates;
  } catch (e) {
    console.error('Warning: Could not read conversion rates:', e.message);
    return {};
  }
}

function getRateForDate(dateStr, rates) {
  // dateStr is DD/MM/YYYY
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    const fullDate = `${year}-${month}-${day}`;
    
    // Try exact date first
    if (rates[fullDate]) {
      return rates[fullDate];
    }
    
    // Fall back to first available date before this date
    const rateKeys = Object.keys(rates).sort();
    for (let i = rateKeys.length - 1; i >= 0; i--) {
      if (rateKeys[i] <= fullDate) {
        return rates[rateKeys[i]];
      }
    }
    
    // If no rate before, use the first available rate
    if (rateKeys.length > 0) {
      return rates[rateKeys[0]];
    }
  }
  return 3.5; // Default fallback
}

function convertToEUR(amount, currency, dateStr, rates) {
  if (currency === 'EUR') return amount;
  const rate = getRateForDate(dateStr, rates);
  return amount / rate;
}

async function main() {
  const args = process.argv.slice(2);
  let category = null;
  let subcategory = null;
  let inputFile = null;
  let showHelp = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      category = args[i + 1];
      i++;
    } else if (args[i] === '--subcategory' && args[i + 1]) {
      subcategory = args[i + 1];
      i++;
    } else if (args[i] === '--input-file' && args[i + 1]) {
      inputFile = args[i + 1];
      i++;
    } else if (args[i] === '-h' || args[i] === '--help') {
      showHelp = true;
    }
  }

  if (showHelp || !category) {
    console.log(`
Usage: node category-details.js --category <name> [--subcategory <name>] [options]

Show detailed expense entries for a specific category or subcategory.

Options:
  --category <name>        Category name (required)
                           Examples: car, food, housing, transport, etc.
  --subcategory <name>     Subcategory name (optional)
                           Examples: mechanic, cafe, rent, train_bus, etc.
  --input-file <path>      Input CSV file (default: depenses-labeled.csv)
  -h, --help              Show this help message

Examples:
  node category-details.js --category car
  node category-details.js --category car --subcategory mechanic
  node category-details.js --category food --subcategory cafe
  node category-details.js --category housing --subcategory rent

Output:
  - Detailed table of matching entries
  - Summary statistics (count, total, average, min, max)
  - Breakdown by currency
`);
    process.exit(0);
  }

  // Resolve file paths
  const baseDir = path.join(__dirname, '..', '..');
  inputFile = inputFile || path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
  const conversionFile = path.join(baseDir, 'config', 'conversion_rates.csv');

  try {
    // Read CSV
    if (!fs.existsSync(inputFile)) {
      console.error(`Error: File not found: ${inputFile}`);
      process.exit(1);
    }

    const content = fs.readFileSync(inputFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    if (lines.length < 2) {
      console.error('Error: CSV file is empty or has no data rows');
      process.exit(1);
    }

    // Parse header
    const header = lines[0].split(',');
    const columnMap = {};
    header.forEach((col, idx) => {
      columnMap[col] = idx;
    });

    // Get conversion rates
    const rates = loadConversionRates(conversionFile);

    // Filter rows by category/subcategory
    const matchingRows = [];
    const categoryCol = columnMap['category'];

    if (categoryCol === undefined) {
      console.error('Error: "category" column not found in CSV');
      process.exit(1);
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const catValue = cols[categoryCol]?.trim() || '';

      // Parse category/subcategory from value
      const [catName, subName] = catValue.split('/');
      const normalizedCat = normalizeStr(catName);
      const normalizedSub = subName ? normalizeStr(subName) : '';
      const normalizedInputCat = normalizeStr(category);
      const normalizedInputSub = subcategory ? normalizeStr(subcategory) : '';

      // Match category (required)
      if (normalizedCat !== normalizedInputCat) continue;

      // Match subcategory if specified
      if (subcategory && normalizedSub !== normalizedInputSub) continue;

      matchingRows.push(cols);
    }

    if (matchingRows.length === 0) {
      const searchStr = subcategory ? `${category}/${subcategory}` : category;
      console.log(`\n⚠️  No entries found for: ${searchStr}`);
      process.exit(0);
    }

    // Display results
    const displayCategory = subcategory ? `${category}/${subcategory}` : category;
    console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  EXPENSE DETAILS: ${displayCategory.toUpperCase().padEnd(42)} ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

    // Create table data
    const tableRows = matchingRows.map((cols, idx) => {
      const amount = parseFloat(cols[columnMap['amount']] || 0);
      const currency = cols[columnMap['currency_code']]?.trim() || '';
      const date = cols[columnMap['date']]?.trim() || '';
      const description = cols[columnMap['description']]?.trim() || '';
      const categoryValue = cols[columnMap['category']]?.trim() || '';
      const [, subName] = categoryValue.split('/');
      
      const row = {
        '#': idx + 1,
        'Date': date,
        'Description': description,
        'Amount': amount.toFixed(2),
        'Currency': currency,
        'EUR Value': convertToEUR(amount, currency, date, rates).toFixed(2)
      };

      // Add subcategory column if no subcategory filter is applied
      if (!subcategory) {
        row['Subcategory'] = subName || 'other';
      }

      return row;
    });

    // Display table
    console.log('📋 ENTRIES:');
    console.log('');
    
    // Simple table formatting
    let cols = ['#', 'Date'];
    if (!subcategory) {
      cols.push('Subcategory');
    }
    cols.push('Description', 'Amount', 'Currency', 'EUR Value');
    
    const widths = {
      '#': 3,
      'Date': 12,
      'Subcategory': 14,
      'Description': 30,
      'Amount': 10,
      'Currency': 8,
      'EUR Value': 10
    };

    // Adjust description width if subcategory is shown
    if (!subcategory) {
      widths['Description'] = 26;
    }

    // Header
    console.log(cols.map(col => col.padEnd(widths[col])).join(' '));
    console.log('-'.repeat(cols.reduce((sum, col) => sum + widths[col] + 1, 0)));

    // Rows
    for (const row of tableRows) {
      const line = cols.map(col => {
        let val = String(row[col]);
        if (col === 'Description') {
          val = val.length > widths[col] ? val.substring(0, widths[col] - 3) + '...' : val;
        }
        return val.padEnd(widths[col]);
      }).join(' ');
      console.log(line);
    }

    // Calculate statistics
    console.log('');
    console.log('📊 SUMMARY STATISTICS:');
    console.log('');

    const totalEntries = matchingRows.length;
    
    // Group by currency AND subcategory
    const byCurrency = {};
    const bySubcategory = {};
    let totalEUR = 0;
    let totalTND = 0;
    let minAmount = Infinity;
    let maxAmount = -Infinity;
    let minEUR = Infinity;
    let maxEUR = -Infinity;
    let minTND = Infinity;
    let maxTND = -Infinity;

    for (let i = 0; i < matchingRows.length; i++) {
      const cols = matchingRows[i];
      const amount = parseFloat(cols[columnMap['amount']] || 0);
      const currency = cols[columnMap['currency_code']]?.trim() || '';
      const categoryValue = cols[columnMap['category']]?.trim() || '';
      const [, subName] = categoryValue.split('/');
      const subcat = subName || 'other';
      const date2 = cols[columnMap['date']]?.trim() || '';
      const eurValue = convertToEUR(amount, currency, date2, rates);

      // By currency
      if (!byCurrency[currency]) {
        byCurrency[currency] = { count: 0, total: 0, entries: [] };
      }
      byCurrency[currency].count++;
      byCurrency[currency].total += amount;
      byCurrency[currency].entries.push(amount);

      // By subcategory (if no subcategory filter)
      if (!subcategory) {
        if (!bySubcategory[subcat]) {
          bySubcategory[subcat] = { byCurrency: {} };
        }
        if (!bySubcategory[subcat].byCurrency[currency]) {
          bySubcategory[subcat].byCurrency[currency] = { count: 0, total: 0, entries: [] };
        }
        bySubcategory[subcat].byCurrency[currency].count++;
        bySubcategory[subcat].byCurrency[currency].total += amount;
        bySubcategory[subcat].byCurrency[currency].entries.push(amount);
      }

      // Track both EUR and TND totals/mins/maxes
      if (currency === 'EUR') {
        totalEUR += amount;
        minEUR = Math.min(minEUR, amount);
        maxEUR = Math.max(maxEUR, amount);
      } else if (currency === 'TND') {
        totalTND += amount;
        minTND = Math.min(minTND, amount);
        maxTND = Math.max(maxTND, amount);
      }

      minAmount = Math.min(minAmount, amount);
      maxAmount = Math.max(maxAmount, amount);
    }

    console.log(`  Total Entries: ${totalEntries}`);
    if (totalEUR > 0) {
      console.log(`  EUR Total: €${totalEUR.toFixed(2)}`);
      console.log(`  (EUR) Average: €${(totalEUR / byCurrency['EUR'].count).toFixed(2)}`);
      console.log(`  (EUR) Range: €${minEUR.toFixed(2)} - €${maxEUR.toFixed(2)}`);
    }
    if (totalTND > 0) {
      console.log(`  TND Total: ${totalTND.toFixed(2)}dt`);
      console.log(`  (TND) Average: ${(totalTND / byCurrency['TND'].count).toFixed(2)}dt`);
      console.log(`  (TND) Range: ${minTND.toFixed(2)} - ${maxTND.toFixed(2)}dt`);
    }
    console.log('');

    // Show subcategory stats if category-level view
    if (!subcategory && Object.keys(bySubcategory).length > 0) {
      console.log('📂 BY SUBCATEGORY:');
      const sortedSubs = Object.entries(bySubcategory).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [subcat, data] of sortedSubs) {
        console.log(`  ${subcat}:`);
        
        // Count total entries in this subcategory
        let totalEntriesSub = 0;
        for (const curr of Object.keys(data.byCurrency)) {
          totalEntriesSub += data.byCurrency[curr].count;
        }
        console.log(`    Entries: ${totalEntriesSub}`);

        // Display EUR stats if present
        if (data.byCurrency['EUR']) {
          const eurData = data.byCurrency['EUR'];
          const avg = eurData.total / eurData.count;
          const min = Math.min(...eurData.entries);
          const max = Math.max(...eurData.entries);
          console.log(`    (EUR) Total: €${eurData.total.toFixed(2)}, Average: €${avg.toFixed(2)}, Range: €${min.toFixed(2)} - €${max.toFixed(2)}`);
        }

        // Display TND stats if present
        if (data.byCurrency['TND']) {
          const tndData = data.byCurrency['TND'];
          const avg = tndData.total / tndData.count;
          const min = Math.min(...tndData.entries);
          const max = Math.max(...tndData.entries);
          console.log(`    (TND) Total: ${tndData.total.toFixed(2)}dt, Average: ${avg.toFixed(2)}dt, Range: ${min.toFixed(2)} - ${max.toFixed(2)}dt`);
        }
      }
      console.log('');
    }

    console.log('💶 BY CURRENCY:');
    for (const [curr, data] of Object.entries(byCurrency)) {
      const avg = data.total / data.count;
      const min = Math.min(...data.entries);
      const max = Math.max(...data.entries);
      console.log(`  ${curr}:`);
      console.log(`    Entries: ${data.count}`);
      console.log(`    Total: ${data.total.toFixed(2)}`);
      console.log(`    Average: ${avg.toFixed(2)}`);
      console.log(`    Range: ${min.toFixed(2)} - ${max.toFixed(2)}`);
    }

    console.log('');

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
