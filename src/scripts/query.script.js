const { parseArgs } = require('../utils/cli-args.util');
const { getDefaultPaths, resolvePath } = require('../utils/path-resolver.util');
const { readCSV, fileExists } = require('../utils/data.util');
const { openDatabase, getExpensesFromDb } = require('../utils/db.util');
const { logError, logWarning, logInfo, logSuccess, logDivider, colors } = require('../utils/console-output.util');
const { toComparableString } = require('../utils/date.util');

const optionDefs = [
  { flag: '--csv',           param: false },
  { flag: '--csv-file',      param: true,  default: null },
  { flag: '--database',      param: false },
  { flag: '--database-file', param: true,  default: null },
  { flag: '--date',          param: true,  default: null },
  { flag: '--begin-date',   param: true,  default: null },
  { flag: '--end-date',     param: true,  default: null },
  { flag: '--currency',     param: true,  default: null },
  { flag: '--category',     param: true,  default: null },
  { flag: '--description',  param: true,  default: null },
  { flag: '--amount',       param: true,  default: null },
  { flag: '--min-amount',   param: true,  default: null },
  { flag: '--max-amount',   param: true,  default: null },
];

const { showHelp, args: parsedArgs } = parseArgs(process.argv, optionDefs);

if (showHelp) {
  console.log(`
Usage: node query.script.js [source] [filters]

Source (default: labeled CSV):
  --csv                     Use default labeled CSV (data/processed/depenses-labeled.csv)
  --csv-file <path>         Use a specific CSV file
  --database                Use default SQLite database (data/database/depenses.db)
  --database-file <path>    Use a specific SQLite database file

Date filters:
  --date <DD/MM/YYYY>       Exact date
  --begin-date <DD/MM/YYYY> From date (inclusive)
  --end-date <DD/MM/YYYY>   Until date (inclusive)

Field filters:
  --currency <code>         Currency code, e.g. EUR or TND
  --category <text>         Category contains text (case-insensitive), e.g. food or food/cafe
  --description <text>      Description contains text (case-insensitive)
  --amount <value>          Exact amount
  --min-amount <value>      Amount >= value (inclusive)
  --max-amount <value>      Amount <= value (inclusive)

Examples:
  node query.script.js --begin-date "01/01/2025" --end-date "31/03/2025"
  node query.script.js --currency EUR --min-amount 100
  node query.script.js --category food --begin-date "01/03/2025"
  node query.script.js --description karta --currency TND
  node query.script.js --database --category transport
  node query.script.js --database-file data/database/depenses.db --category transport
  node query.script.js --amount 5.5 --currency TND
`);
  process.exit(0);
}

const defaults = getDefaultPaths();
const csvPath      = resolvePath(parsedArgs['csv-file'], defaults.inputFile);
const databasePath = resolvePath(parsedArgs['database-file'], defaults.databaseFile);
const useDatabase  = !!parsedArgs['database'] || !!parsedArgs['database-file'];

const filterDate       = parsedArgs['date']        || null;
const filterBeginDate  = parsedArgs['begin-date']  || null;
const filterEndDate    = parsedArgs['end-date']     || null;
const filterCurrency   = parsedArgs['currency']     ? parsedArgs['currency'].toUpperCase() : null;
const filterCategory   = parsedArgs['category']     || null;
const filterDesc       = parsedArgs['description']  || null;
const filterAmount     = parsedArgs['amount']       !== null ? parseFloat(parsedArgs['amount'])     : null;
const filterMinAmount  = parsedArgs['min-amount']   !== null ? parseFloat(parsedArgs['min-amount']) : null;
const filterMaxAmount  = parsedArgs['max-amount']   !== null ? parseFloat(parsedArgs['max-amount']) : null;

// ─── Filter application ───────────────────────────────────────────────────────

function applyFilters(rows) {
  return rows.filter(row => {
    const date    = (row.date        || '').trim();
    const amount  = parseFloat(row.amount);
    const cur     = (row.currency_code || '').trim().toUpperCase();
    const cat     = (row.category    || '').trim().toLowerCase();
    const desc    = (row.description || '').trim().toLowerCase();

    if (filterDate && date !== filterDate) return false;

    if (filterBeginDate) {
      const cmp = toComparableString(date);
      const ref = toComparableString(filterBeginDate);
      if (!cmp || !ref || cmp < ref) return false;
    }
    if (filterEndDate) {
      const cmp = toComparableString(date);
      const ref = toComparableString(filterEndDate);
      if (!cmp || !ref || cmp > ref) return false;
    }

    if (filterCurrency && cur !== filterCurrency) return false;
    if (filterCategory && !cat.includes(filterCategory.toLowerCase())) return false;
    if (filterDesc && !desc.includes(filterDesc.toLowerCase())) return false;

    if (filterAmount !== null && !isNaN(filterAmount) && amount !== filterAmount) return false;
    if (filterMinAmount !== null && !isNaN(filterMinAmount) && amount < filterMinAmount) return false;
    if (filterMaxAmount !== null && !isNaN(filterMaxAmount) && amount > filterMaxAmount) return false;

    return true;
  });
}

// ─── Display ──────────────────────────────────────────────────────────────────

function pad(str, len, right = false) {
  const s = String(str ?? '');
  return right ? s.padStart(len) : s.padEnd(len);
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function printTable(rows) {
  if (rows.length === 0) {
    logWarning('No rows match the given filters.');
    return;
  }

  const COL = {
    date:     { label: 'Date',        width: 12 },
    amount:   { label: 'Amount',      width: 10 },
    currency: { label: 'Currency',    width: 8  },
    category: { label: 'Category',    width: 22 },
    desc:     { label: 'Description', width: 48 },
  };

  const sep = `${'─'.repeat(COL.date.width)}─${'─'.repeat(COL.amount.width)}─${'─'.repeat(COL.currency.width)}─${'─'.repeat(COL.category.width)}─${'─'.repeat(COL.desc.width)}`;

  const header =
    `${colors.bright}` +
    `${pad(COL.date.label,     COL.date.width)} ` +
    `${pad(COL.amount.label,   COL.amount.width, true)} ` +
    `${pad(COL.currency.label, COL.currency.width)} ` +
    `${pad(COL.category.label, COL.category.width)} ` +
    `${pad(COL.desc.label,     COL.desc.width)}` +
    `${colors.reset}`;

  console.log('');
  console.log(header);
  console.log(sep);

  for (const row of rows) {
    const amtNum = parseFloat(row.amount);
    const amtStr = isNaN(amtNum) ? row.amount : amtNum.toFixed(3);
    const cur    = (row.currency_code || '').toUpperCase();
    const symbol = cur === 'EUR' ? colors.blue : colors.cyan;

    console.log(
      `${colors.dim}${pad(row.date, COL.date.width)}${colors.reset} ` +
      `${symbol}${pad(amtStr, COL.amount.width, true)}${colors.reset} ` +
      `${pad(cur, COL.currency.width)} ` +
      `${colors.dim}${pad(truncate(row.category || 'other', COL.category.width), COL.category.width)}${colors.reset} ` +
      `${truncate(row.description, COL.desc.width)}`
    );
  }

  console.log(sep);
}

function printSummary(rows) {
  const total = rows.length;
  const byCurrency = {};

  for (const row of rows) {
    const cur = (row.currency_code || 'UNKNOWN').toUpperCase();
    const sym = row.currency_symbol || cur;
    const amt = parseFloat(row.amount) || 0;
    if (!byCurrency[cur]) byCurrency[cur] = { symbol: sym, sum: 0, count: 0 };
    byCurrency[cur].sum += amt;
    byCurrency[cur].count++;
  }

  logInfo(`${total} row${total !== 1 ? 's' : ''} matched`);
  for (const [cur, data] of Object.entries(byCurrency)) {
    logInfo(`  ${cur}  ${data.count} rows  total: ${data.sum.toFixed(3)} ${data.symbol}`);
  }

  const activeFilters = [];
  if (filterDate)      activeFilters.push(`date = ${filterDate}`);
  if (filterBeginDate) activeFilters.push(`from ${filterBeginDate}`);
  if (filterEndDate)   activeFilters.push(`to ${filterEndDate}`);
  if (filterCurrency)  activeFilters.push(`currency = ${filterCurrency}`);
  if (filterCategory)  activeFilters.push(`category ∋ "${filterCategory}"`);
  if (filterDesc)      activeFilters.push(`description ∋ "${filterDesc}"`);
  if (filterAmount !== null)    activeFilters.push(`amount = ${filterAmount}`);
  if (filterMinAmount !== null) activeFilters.push(`amount ≥ ${filterMinAmount}`);
  if (filterMaxAmount !== null) activeFilters.push(`amount ≤ ${filterMaxAmount}`);

  if (activeFilters.length > 0) {
    logInfo(`Filters: ${activeFilters.join('  |  ')}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let rows = [];

  if (useDatabase) {
    if (!fileExists(databasePath)) {
      logError(`Database not found: ${databasePath}`);
      process.exit(1);
    }
    let db;
    try {
      db = await openDatabase(databasePath);
      // Pass date range to DB for initial narrowing; remaining filters applied in-memory
      rows = await getExpensesFromDb(db, {
        beginDate: filterBeginDate || undefined,
        endDate:   filterEndDate   || undefined,
      });
    } finally {
      if (db) db.close();
    }
    logSuccess(`Loaded from database`, databasePath);
  } else {
    if (!fileExists(csvPath)) {
      logError(`CSV file not found: ${csvPath}`);
      process.exit(1);
    }
    const { rows: csvRows } = readCSV(csvPath);
    rows = csvRows;
    logSuccess(`Loaded from CSV`, csvPath);
  }

  const matched = applyFilters(rows);
  printTable(matched);
  printSummary(matched);
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
