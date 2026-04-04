#!/usr/bin/env node

const path = require('path');
const { parseCSVLine } = require('../utils/csv.util');
const { normalizeStr } = require('../utils/text.util');
const { loadConversionRates, convertToEUR } = require('../utils/conversion-rates.util');
const { readCSVLines, fileExists } = require('../utils/data.util');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');
const { logError, logInfo } = require('../utils/console-output.util');

async function main() {
  const optionDefs = [
    { flag: '--category',     param: true,  default: null },
    { flag: '--subcategory',  param: true,  default: null },
    { flag: '--input-file',   param: true,  default: null },
    { flag: '--use-database', param: false },
    { flag: '--database',     param: true,  default: null }
  ];

  const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);
  const category    = parsedArgs['category'];
  const subcategory = parsedArgs['subcategory'];
  const useDatabase = parsedArgs['use-database'];

  if (showHelp || !category) {
    console.log(`
Usage: node category-details.script.js --category <name> [--subcategory <name>] [options]

Show detailed expense entries for a specific category or subcategory.

Options:
  --category <name>        Category name (required)
                           Examples: car, food, housing, transport, etc.
  --subcategory <name>     Subcategory name (optional)
                           Examples: mechanic, cafe, rent, train_bus, etc.
  --input-file <path>      Input CSV file (default: depenses-labeled.csv)
  --use-database           Read from SQLite database instead of CSV
  --database <path>        SQLite database file (default: data/database/depenses.db)
  -h, --help              Show this help message

Examples:
  node category-details.script.js --category car
  node category-details.script.js --category car --subcategory mechanic
  node category-details.script.js --category food --use-database
`);
    process.exit(0);
  }

  const defaults = getDefaultPaths();

  try {
    // Build matching rows array from either CSV or DB
    let matchingRows = []; // each item: { date, description, amount, currency, eurValue, subcat }

    if (useDatabase) {
      // --- DATABASE MODE ---
      const { openDatabase, getExpensesFromDb, getConversionRatesMapFromDb } = require('../utils/db.util');
      const { getRateForDate } = require('../utils/conversion-rates.util');
      const databaseFile = resolvePath(parsedArgs['database'], defaults.databaseFile);

      const db = await openDatabase(databaseFile);
      let rows, rates;
      try {
        rows  = await getExpensesFromDb(db);
        rates = await getConversionRatesMapFromDb(db);
      } finally {
        db.close();
      }

      const normalizedCat = normalizeStr(category);
      const normalizedSub = subcategory ? normalizeStr(subcategory) : '';

      for (const r of rows) {
        const catLabel = r.category || '';
        const [catName, subName] = catLabel.split('/');
        if (normalizeStr(catName) !== normalizedCat) continue;
        if (subcategory && normalizeStr(subName || '') !== normalizedSub) continue;

        const rate = getRateForDate(r.date, rates);
        const eurValue = r.currency_code === 'EUR' ? r.amount : r.amount / rate;
        matchingRows.push({
          date:        r.date,
          description: r.description,
          amount:      r.amount,
          currency:    r.currency_code,
          eurValue,
          subcat:      subName || 'other'
        });
      }
    } else {
      // --- CSV MODE ---
      const inputFile = resolvePath(parsedArgs['input-file'], defaults.inputFile);
      if (!fileExists(inputFile)) {
        logError(`File not found: ${inputFile}`);
        process.exit(1);
      }

      const { lines, columnMap } = readCSVLines(inputFile);
      if (lines.length < 2) {
        logError('CSV file is empty or has no data rows');
        process.exit(1);
      }

      const rates = loadConversionRates(defaults.conversionRatesFile);
      const categoryCol = columnMap['category'];
      if (categoryCol === undefined) {
        logError('"category" column not found in CSV');
        process.exit(1);
      }

      const normalizedCat = normalizeStr(category);
      const normalizedSub = subcategory ? normalizeStr(subcategory) : '';

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const catValue = cols[categoryCol]?.trim() || '';
        const [catName, subName] = catValue.split('/');
        if (normalizeStr(catName) !== normalizedCat) continue;
        if (subcategory && normalizeStr(subName || '') !== normalizedSub) continue;

        const amount   = parseFloat(cols[columnMap['amount']] || 0);
        const currency = cols[columnMap['currency_code']]?.trim() || '';
        const date     = cols[columnMap['date']]?.trim() || '';
        const eurValue = convertToEUR(amount, currency, date, rates);
        matchingRows.push({
          date,
          description: cols[columnMap['description']]?.trim() || '',
          amount,
          currency,
          eurValue,
          subcat: subName || 'other'
        });
      }
    }

    if (matchingRows.length === 0) {
      const searchStr = subcategory ? `${category}/${subcategory}` : category;
      console.log(`No entries found for: ${searchStr}`);
      process.exit(0);
    }

    // --- Display ---
    const displayCategory = subcategory ? `${category}/${subcategory}` : category;
    console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  EXPENSE DETAILS: ${displayCategory.toUpperCase().padEnd(42)} ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

    // Table columns
    const cols = ['#', 'Date'];
    if (!subcategory) cols.push('Subcategory');
    cols.push('Description', 'Amount', 'Currency', 'EUR Value');

    const widths = {
      '#':           3,
      'Date':        12,
      'Subcategory': 14,
      'Description': subcategory ? 30 : 26,
      'Amount':      10,
      'Currency':    8,
      'EUR Value':   10
    };

    console.log(cols.map(c => c.padEnd(widths[c])).join(' '));
    console.log('-'.repeat(cols.reduce((sum, c) => sum + widths[c] + 1, 0)));

    matchingRows.forEach((row, idx) => {
      const line = cols.map(c => {
        let val;
        switch (c) {
          case '#':           val = String(idx + 1); break;
          case 'Date':        val = row.date; break;
          case 'Subcategory': val = row.subcat; break;
          case 'Description': {
            val = row.description;
            if (val.length > widths[c]) val = val.substring(0, widths[c] - 3) + '...';
            break;
          }
          case 'Amount':      val = row.amount.toFixed(2); break;
          case 'Currency':    val = row.currency; break;
          case 'EUR Value':   val = row.eurValue.toFixed(2); break;
          default:            val = '';
        }
        return val.padEnd(widths[c]);
      }).join(' ');
      console.log(line);
    });

    // --- Statistics ---
    console.log('');
    logInfo('SUMMARY STATISTICS');

    const byCurrency   = {};
    const bySubcategory = {};
    let totalEUR = 0, totalTND = 0;
    let minEUR = Infinity, maxEUR = -Infinity;
    let minTND = Infinity, maxTND = -Infinity;

    for (const row of matchingRows) {
      const { amount, currency, subcat } = row;

      if (!byCurrency[currency]) byCurrency[currency] = { count: 0, total: 0, entries: [] };
      byCurrency[currency].count++;
      byCurrency[currency].total += amount;
      byCurrency[currency].entries.push(amount);

      if (!subcategory) {
        if (!bySubcategory[subcat]) bySubcategory[subcat] = { byCurrency: {} };
        if (!bySubcategory[subcat].byCurrency[currency]) {
          bySubcategory[subcat].byCurrency[currency] = { count: 0, total: 0, entries: [] };
        }
        bySubcategory[subcat].byCurrency[currency].count++;
        bySubcategory[subcat].byCurrency[currency].total += amount;
        bySubcategory[subcat].byCurrency[currency].entries.push(amount);
      }

      if (currency === 'EUR') {
        totalEUR += amount;
        minEUR = Math.min(minEUR, amount);
        maxEUR = Math.max(maxEUR, amount);
      } else if (currency === 'TND') {
        totalTND += amount;
        minTND = Math.min(minTND, amount);
        maxTND = Math.max(maxTND, amount);
      }
    }

    console.log(`  Total Entries: ${matchingRows.length}`);
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

    if (!subcategory && Object.keys(bySubcategory).length > 0) {
      console.log('📂 BY SUBCATEGORY:');
      Object.entries(bySubcategory).sort((a, b) => a[0].localeCompare(b[0])).forEach(([sub, data]) => {
        const totalEntries = Object.values(data.byCurrency).reduce((s, d) => s + d.count, 0);
        console.log(`  ${sub}: ${totalEntries} entries`);
        if (data.byCurrency['EUR']) {
          const d = data.byCurrency['EUR'];
          const avg = d.total / d.count;
          console.log(`    (EUR) Total: €${d.total.toFixed(2)}, Average: €${avg.toFixed(2)}, Range: €${Math.min(...d.entries).toFixed(2)} - €${Math.max(...d.entries).toFixed(2)}`);
        }
        if (data.byCurrency['TND']) {
          const d = data.byCurrency['TND'];
          const avg = d.total / d.count;
          console.log(`    (TND) Total: ${d.total.toFixed(2)}dt, Average: ${avg.toFixed(2)}dt, Range: ${Math.min(...d.entries).toFixed(2)} - ${Math.max(...d.entries).toFixed(2)}dt`);
        }
      });
      console.log('');
    }

    console.log('💶 BY CURRENCY:');
    for (const [curr, data] of Object.entries(byCurrency)) {
      const avg = data.total / data.count;
      const min = Math.min(...data.entries);
      const max = Math.max(...data.entries);
      console.log(`  ${curr}: ${data.count} entries | Total: ${data.total.toFixed(2)} | Average: ${avg.toFixed(2)} | Range: ${min.toFixed(2)} - ${max.toFixed(2)}`);
    }
    console.log('');

  } catch (err) {
    logError('Error', err.message);
    process.exit(1);
  }
}

main();
