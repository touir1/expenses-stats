const fs = require('fs');
const path = require('path');
const { DEFAULT_RATE, loadConversionRates, getRateForDate } = require('../utils/conversion-rates.util');
const { readCSV, readJSON, fileExists } = require('../utils/data.util');
const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');
const { logSuccess, logError, logInfo } = require('../utils/console-output.util');
const { matchesFilter } = require('../utils/filtering.util');
const { toComparableString } = require('../utils/date.util');

// Parse command-line arguments
const optionDefs = [
  { flag: '--input-file',       param: true,  default: null },
  { flag: '--output',           param: true,  default: 'console' },
  { flag: '--output-file',      param: true,  default: null },
  { flag: '--conversion-rates', param: true,  default: null },
  { flag: '--convert-to',       param: true,  default: null },
  { flag: '--use-database',     param: false },
  { flag: '--database',         param: true,  default: null },
  { flag: '--begin-date',       param: true,  default: null },
  { flag: '--end-date',         param: true,  default: null },
  { flag: '--filter',           param: true,  default: null }
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node stats.script.js [options]

Options:
  --input-file <path>        Input CSV file (default: data/processed/depenses-labeled.csv)
  --output <mode>            Output mode: 'console', 'file', or 'both' (default: console)
  --output-file <path>       Output JSON file path (default: output/depenses-stats.json)
  --conversion-rates <path>  Conversion rates CSV file (default: data/processed/conversion-rates.csv)
  --convert-to <currency>    Convert amounts to currency: EUR or TND
  --use-database             Read expenses and rates from the SQLite database
  --database <path>          SQLite database file (default: data/database/depenses.db)
  --begin-date <DD/MM/YYYY>  Filter expenses from this date (inclusive)
  --end-date <DD/MM/YYYY>    Filter expenses until this date (inclusive)
  --filter <key>             Apply named filter from config/filters.config.json
  -h, --help                Show this help message

Examples:
  node stats.script.js
  node stats.script.js --convert-to EUR
  node stats.script.js --use-database
  node stats.script.js --use-database --begin-date 01/01/2025 --end-date 31/12/2025
  node stats.script.js --use-database --filter car
`);
  process.exit(0);
}

// ─── Data Loaders ─────────────────────────────────────────────────────────────

/**
 * Load expenses and conversion rates from SQLite database.
 * @returns {{ expenses: Object[], conversionRates: Object, conversionSource: string }}
 */
async function loadFromDatabase({ databaseFile, beginDate, endDate }) {
  const { openDatabase, getExpensesFromDb, getConversionRatesMapFromDb } = require('../utils/db.util');
  const db = await openDatabase(databaseFile);
  try {
    const rows = await getExpensesFromDb(db, { beginDate, endDate });
    const conversionRates = await getConversionRatesMapFromDb(db);
    const expenses = rows.map(r => ({
      amount:         r.amount,
      currencySymbol: r.currency_symbol,
      currencyCode:   r.currency_code,
      date:           r.date,
      description:    r.description || '',
      category:       r.category || null
    }));
    return { expenses, conversionRates, conversionSource: 'database' };
  } finally {
    db.close();
  }
}

/**
 * Load expenses and conversion rates from labeled CSV file.
 * @returns {{ expenses: Object[], conversionRates: Object, conversionSource: string }}
 */
function loadFromCSV({ inputFile, conversionRatesFile, beginDate, endDate }) {
  const conversionRates = fileExists(conversionRatesFile) ? loadConversionRates(conversionRatesFile) : {};
  const conversionSource = path.basename(conversionRatesFile);

  const { headers, rows: csvRows } = readCSV(inputFile);
  if (csvRows.length === 0) {
    logError('CSV file is empty or invalid');
    process.exit(1);
  }

  const amountIdx         = headers.indexOf('amount');
  const currencySymbolIdx = headers.indexOf('currency_symbol');
  const currencyCodeIdx   = headers.indexOf('currency_code');
  const dateIdx           = headers.indexOf('date');

  if (amountIdx === -1 || currencySymbolIdx === -1 || currencyCodeIdx === -1 || dateIdx === -1) {
    logError('CSV header is missing required columns');
    process.exit(1);
  }

  let expenses = csvRows.map(row => ({
    amount:         parseFloat(row['amount']),
    currencySymbol: row['currency_symbol'],
    currencyCode:   row['currency_code'],
    date:           row['date'],
    description:    row['description'] || '',
    category:       row['category'] || null
  }));

  if (beginDate || endDate) {
    expenses = expenses.filter(exp => {
      const cmp = toComparableString(exp.date);
      if (beginDate && cmp < toComparableString(beginDate)) return false;
      if (endDate   && cmp > toComparableString(endDate))   return false;
      return true;
    });
  }

  return { expenses, conversionRates, conversionSource };
}

// ─── Named Filter ─────────────────────────────────────────────────────────────

// Apply a named filter definition to an expenses array.
// filterDef shapes: { category: "car" } or { filters: { currency_code: "EUR" } } or raw filters object.
function applyNamedFilter(expenses, filterDef) {
  if (filterDef.category) {
    const cat = filterDef.category;
    return expenses.filter(exp => exp.category === cat || (exp.category || '').startsWith(cat + '/'));
  }
  const filters = filterDef.filters || filterDef;
  return expenses.filter(exp => {
    const row = {
      amount:          String(exp.amount),
      currency_code:   exp.currencyCode,
      currency_symbol: exp.currencySymbol,
      date:            exp.date,
      description:     exp.description,
      category:        exp.category || ''
    };
    for (const [col, condition] of Object.entries(filters)) {
      if (!matchesFilter(row[col] != null ? row[col] : '', condition, col)) return false;
    }
    return true;
  });
}

async function main() {
  const defaults = getDefaultPaths();
  const outputMode     = parsedArgs['output'] || 'console';
  const convertCurrency = parsedArgs['convert-to'] ? parsedArgs['convert-to'].toUpperCase() : null;
  const useDatabase    = parsedArgs['use-database'];
  const beginDate      = parsedArgs['begin-date'];
  const endDate        = parsedArgs['end-date'];
  const filterKey      = parsedArgs['filter'];

  if (!['console', 'file', 'both'].includes(outputMode)) {
    logError(`Invalid output mode: ${outputMode}. Use: console, file, or both`);
    process.exit(1);
  }

  const defaultStatsFile = filterKey
    ? path.join(defaults.outputDir, `depenses-${filterKey}-stats.json`)
    : path.join(defaults.outputDir, 'depenses-stats.json');
  const outputFile = resolvePath(parsedArgs['output-file'], defaultStatsFile);

  let expenses, conversionRates, conversionSource;

  if (useDatabase) {
    const databaseFile = resolvePath(parsedArgs['database'], defaults.databaseFile);
    ({ expenses, conversionRates, conversionSource } = await loadFromDatabase({ databaseFile, beginDate, endDate }));
  } else {
    const inputFile           = resolvePath(parsedArgs['input-file'],       defaults.inputFile);
    const conversionRatesFile = resolvePath(parsedArgs['conversion-rates'], defaults.conversionRatesFile);
    ({ expenses, conversionRates, conversionSource } = loadFromCSV({ inputFile, conversionRatesFile, beginDate, endDate }));
  }

  // Apply named filter (both modes)
  if (filterKey) {
    const filterConfigPath = path.join(defaults.configDir, 'filters.config.json');
    const filterConfig = readJSON(filterConfigPath);
    if (!filterConfig.filters || !filterConfig.filters[filterKey]) {
      logError(`Unknown filter key: "${filterKey}". Available: ${Object.keys(filterConfig.filters || {}).join(', ')}`);
      process.exit(1);
    }
    const filterDef = filterConfig.filters[filterKey];
    expenses = applyNamedFilter(expenses, filterDef);
    logInfo(`Filter applied: ${filterKey}${filterDef.description ? ` (${filterDef.description})` : ''}`);
  }

  if (expenses.length === 0) {
    logError('No expenses found (file is empty or all rows were filtered out)');
    process.exit(1);
  }

  const hasCategories = expenses.some(e => e.category !== null);

  function getConversionRate(dateStr) { return getRateForDate(dateStr, conversionRates); }

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
      if (code === 'EUR') stats.totalAmount.EUR += amount;
      else if (code === 'TND') stats.totalAmount.TND += amount;
    }

    // Min/Max
    stats.minAmount = Math.min(stats.minAmount, amount);
    stats.maxAmount = Math.max(stats.maxAmount, amount);

    // By currency
    if (!stats.byCurrency[code]) {
      stats.byCurrency[code] = { count: 0, total: 0, average: 0, min: Infinity, max: -Infinity };
    }
    stats.byCurrency[code].count++;
    stats.byCurrency[code].total += amount;
    stats.byCurrency[code].min = Math.min(stats.byCurrency[code].min, amount);
    stats.byCurrency[code].max = Math.max(stats.byCurrency[code].max, amount);

    // By month (from date DD/MM/YYYY)
    const [, month, year] = exp.date.split('/');
    const monthKey = `${year}-${month.padStart(2, '0')}`;
    if (!stats.byMonth[monthKey]) {
      stats.byMonth[monthKey] = { count: 0, EUR: 0, TND: 0 };
    }
    stats.byMonth[monthKey].count++;
    if (code === 'EUR') stats.byMonth[monthKey].EUR += amount;
    else stats.byMonth[monthKey].TND += amount;

    // By category
    if (hasCategories && exp.category) {
      const [mainCat, subCat] = exp.category.split('/');
      if (!stats.byCategory[mainCat]) {
        stats.byCategory[mainCat] = { count: 0, EUR: 0, TND: 0, subcategories: {} };
      }
      stats.byCategory[mainCat].count++;
      if (code === 'EUR') stats.byCategory[mainCat].EUR += amount;
      else stats.byCategory[mainCat].TND += amount;

      if (subCat) {
        if (!stats.byCategory[mainCat].subcategories[subCat]) {
          stats.byCategory[mainCat].subcategories[subCat] = { count: 0, EUR: 0, TND: 0 };
        }
        stats.byCategory[mainCat].subcategories[subCat].count++;
        if (code === 'EUR') stats.byCategory[mainCat].subcategories[subCat].EUR += amount;
        else stats.byCategory[mainCat].subcategories[subCat].TND += amount;
      }
    }
  });

  // Calculate monthly totals with conversion to both currencies
  Object.keys(stats.byMonth).forEach(monthKey => {
    const monthData = stats.byMonth[monthKey];
    const [yr, mo] = monthKey.split('-');
    const rate = getConversionRate(`01/${mo}/${yr}`);
    monthData.total = {
      EUR: monthData.EUR + (monthData.TND / rate),
      TND: monthData.TND + (monthData.EUR * rate)
    };
  });

  // Add unified total in both currencies
  if (!convertCurrency && stats.totalAmount.EUR !== undefined) {
    let totalInEUR = 0;
    let totalInTND = 0;
    Object.values(stats.byMonth).forEach(m => {
      totalInEUR += m.total.EUR;
      totalInTND += m.total.TND;
    });
    stats.totalAmount.total = { EUR: totalInEUR, TND: totalInTND };
  }

  // Calculate category converted totals
  if (hasCategories) {
    const rateValues = Object.values(conversionRates);
    const avgRate = rateValues.length > 0 ? rateValues.reduce((a, b) => a + b, 0) / rateValues.length : DEFAULT_RATE;

    Object.keys(stats.byCategory).forEach(mainCat => {
      const c = stats.byCategory[mainCat];
      c.total   = { EUR: c.EUR + (c.TND / avgRate), TND: c.TND + (c.EUR * avgRate) };
      c.average = { EUR: c.total.EUR / c.count, TND: c.total.TND / c.count };
      if (c.subcategories) {
        Object.keys(c.subcategories).forEach(subCat => {
          const sub = c.subcategories[subCat];
          sub.total   = { EUR: sub.EUR + (sub.TND / avgRate), TND: sub.TND + (sub.EUR * avgRate) };
          sub.average = { EUR: sub.total.EUR / sub.count, TND: sub.total.TND / sub.count };
        });
      }
    });
    // Sort categories and subcategories alphabetically
    const sortedCats = {};
    Object.entries(stats.byCategory)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([k, v]) => {
        if (v.subcategories) {
          const sortedSubs = {};
          Object.entries(v.subcategories)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .forEach(([sk, sv]) => { sortedSubs[sk] = sv; });
          v.subcategories = sortedSubs;
        }
        sortedCats[k] = v;
      });
    stats.byCategory = sortedCats;
  }

  // Calculate averages
  if (stats.totalAmount.total && typeof stats.totalAmount.total === 'object') {
    stats.averageAmount = stats.totalAmount.total.EUR / stats.totalEntries;
  } else {
    stats.averageAmount = stats.totalAmount / stats.totalEntries;
  }
  Object.keys(stats.byCurrency).forEach(code => {
    stats.byCurrency[code].average = stats.byCurrency[code].total / stats.byCurrency[code].count;
  });

  // Sort months
  const sortedMonths = {};
  Object.keys(stats.byMonth).sort().forEach(month => { sortedMonths[month] = stats.byMonth[month]; });
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
      output += `📍 Currency Conversion: Using rates from ${conversionSource}\n`;
    }
    return output;
  };

  const jsonOutput = JSON.stringify(stats, null, 2);
  const consoleOutput = formatStats();

  if (outputMode === 'console' || outputMode === 'both') {
    console.log(consoleOutput);
  }
  if (outputMode === 'file' || outputMode === 'both') {
    fs.writeFileSync(outputFile, jsonOutput, 'utf-8');
    logSuccess('Stats saved to file', outputFile);
  }
}

main().catch(err => {
  logError('Stats failed', err.message);
  process.exit(1);
});
