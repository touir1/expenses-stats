#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * Fetch EUR to TND conversion rates from frankfurter.dev API
 * - FREE, no API key required, no rate limits
 * - Supports historical rates from 1999
 * - Batch requests: can fetch multiple dates in one call
 * - Open source (https://github.com/hakanensari/frankfurter)
 */

const API_BASE = 'https://api.frankfurter.dev/v2/rates';

function fetchRates(startDate, endDate, base, quote) {
  return new Promise((resolve, reject) => {
    // Format: YYYY-MM-DD
    // Returns rates for date range
    const url = `${API_BASE}?base=${base}&quotes=${quote}&from=${startDate}&to=${endDate}`;

    const request = https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          
          // Check if response is an array (new format) or object
          if (Array.isArray(json)) {
            // Response is array: [{"date":"...", "quote":"TND", "rate":...}, ...]
            const rates = {};
            for (const item of json) {
              if (item.date && item.rate) {
                rates[item.date] = item.rate;
              }
            }
            if (Object.keys(rates).length === 0) {
              reject(new Error('No rates found in response'));
              return;
            }
            resolve(rates);
          } else if (json.rates) {
            // Response is object: {"rates": {"2025-04-01": {"TND": 3.45}, ...}}
            resolve(json.rates);
          } else if (json.error) {
            reject(new Error(`API error: ${json.message || json.error}`));
            return;
          } else {
            reject(new Error('No rates found in response'));
          }
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function getMonthDates(startDate, endDate) {
  // This function is kept for compatibility but not used for batch fetching
  // The API returns daily rates which we store directly
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  // Get first day of each month for reference only
  while (current <= end) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    dates.push(`${year}-${month}-01`);
    current.setMonth(current.getMonth() + 1);
  }

  return dates;
}

async function main() {
  const args = process.argv.slice(2);
  let startDate = null;
  let endDate = null;
  let baseCurrency = 'EUR';
  let quoteCurrency = 'TND';
  let showHelp = false;
  let autoMode = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      startDate = args[i + 1];
      i++;
    } else if (args[i] === '--end' && args[i + 1]) {
      endDate = args[i + 1];
      i++;
    } else if (args[i] === '--base' && args[i + 1]) {
      baseCurrency = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--quote' && args[i + 1]) {
      quoteCurrency = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--auto') {
      autoMode = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      showHelp = true;
    }
  }

  if (showHelp) {
    console.log(`
Usage: node update-rates.js [options]

Fetch currency conversion rates and update config/conversion_rates.csv
Uses frankfurter.dev API (FREE, no limits, no authentication required)
Batch requests: fetches all daily rates for the entire date range in one API call

Options:
  --start <YYYY-MM-DD>   Start date (default: 2022-08-01 or last date in CSV with --auto)
  --end <YYYY-MM-DD>     End date (default: today)
  --base <CODE>          Base currency (default: EUR)
  --quote <CODE>         Quote currency (default: TND)
  --auto                 Auto incremental update: fetch from last date in CSV to today
  -h, --help            Show this help message

API: https://frankfurter.dev (open source, no rate limits)
GitHub: https://github.com/hakanensari/frankfurter

Examples:
  node update-rates.js
  node update-rates.js --start 2024-01-01 --end 2024-12-31
  node update-rates.js --base EUR --quote USD --auto
  node update-rates.js --auto
  npm run update-rates

Note:
  - CSV format: date,base,quote,rate
  - Fetches all daily rates for the requested date range in a single batch request
  - Free API with unlimited requests
  - Historical rates available from 1999 onwards
  - --auto mode fetches new rates from the last date in the CSV for the given pair
`);
    process.exit(0);
  }

  // Default dates
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  
  const csvPath = path.join(__dirname, '..', '..', 'config', 'conversion_rates.csv');
  
  // Auto mode: fetch from last date in CSV to today (for the specific pair)
  if (autoMode) {
    try {
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());

      if (lines.length < 2) {
        startDate = '2022-08-01';
        endDate = todayStr;
      } else {
        const header = lines[0].split(',').map(h => h.trim());
        const isNewFormat = header.length >= 4 && header[1] === 'base';

        // Find last date for this specific pair
        let lastDate = null;
        for (let i = lines.length - 1; i >= 1; i--) {
          const cols = lines[i].split(',');
          if (isNewFormat) {
            if (cols[1]?.trim() === baseCurrency && cols[2]?.trim() === quoteCurrency) {
              lastDate = cols[0].trim();
              break;
            }
          } else {
            // Old format: all rows are EUR/TND
            if (baseCurrency === 'EUR' && quoteCurrency === 'TND') {
              lastDate = cols[0].trim();
              break;
            }
          }
        }

        if (!lastDate) {
          startDate = '2022-08-01';
          endDate = todayStr;
        } else {
          const lastDateObj = new Date(lastDate + 'T00:00:00Z');
          lastDateObj.setUTCDate(lastDateObj.getUTCDate() + 1);
          startDate = lastDateObj.toISOString().split('T')[0];
          endDate = todayStr;

          if (startDate > todayStr) {
            console.log(`✓ Rates are already up to date for ${baseCurrency}/${quoteCurrency}`);
            process.exit(0);
          }
        }
      }
    } catch (err) {
      console.error(`Error reading CSV for auto mode: ${err.message}`);
      startDate = '2022-08-01';
      endDate = todayStr;
    }
  }
  
  // Default dates if not set
  startDate = startDate || '2022-08-01';
  endDate = endDate || todayStr;

  console.log(`📊 Fetching ${baseCurrency}/${quoteCurrency} conversion rates (daily)...\n`);
  console.log(`Start date:  ${startDate}`);
  console.log(`End date:    ${endDate}`);
  console.log(`Pair:        ${baseCurrency}/${quoteCurrency}`);
  console.log(`API:         frankfurter.dev (FREE, batch mode, no limits)`);
  console.log('');

  // Read existing rates (supports both old date,rate and new date,base,quote,rate format)
  const rates = []; // { date, base, quote, rate }
  if (fs.existsSync(csvPath)) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length >= 2) {
      const header = lines[0].split(',').map(h => h.trim());
      const isNewFormat = header.length >= 4 && header[1] === 'base';
      for (const line of lines.slice(1)) {
        const cols = line.split(',');
        if (isNewFormat) {
          const [d, b, q, r] = cols;
          if (d && r) rates.push({ date: d.trim(), base: b.trim(), quote: q.trim(), rate: parseFloat(r).toFixed(4) });
        } else {
          // Old format: migrate to EUR/TND
          const [d, r] = cols;
          if (d && r) rates.push({ date: d.trim(), base: 'EUR', quote: 'TND', rate: parseFloat(r).toFixed(4) });
        }
      }
    }
    console.log(`Found ${rates.length} existing rates in CSV\n`);
  }

  console.log(`Date range: ${startDate} to ${endDate}\n`);

  let successCount = 0;
  let failCount = 0;

  // Fetch all rates (batch request via frankfurter.dev)
  console.log('⏳ Fetching all daily rates from API...\n');
  
  try {
    const allRates = await fetchRates(startDate, endDate, baseCurrency, quoteCurrency);
    
    // Process the batch response
    // Format (array): [{"date":"2025-04-01", "rate": 3.35}, ...]
    
    if (Array.isArray(allRates)) {
      for (const item of allRates) {
        if (item.date && item.rate) {
          const existing = rates.find(r => r.date === item.date && r.base === baseCurrency && r.quote === quoteCurrency);
          if (existing) {
            existing.rate = parseFloat(item.rate).toFixed(4);
          } else {
            rates.push({ date: item.date, base: baseCurrency, quote: quoteCurrency, rate: parseFloat(item.rate).toFixed(4) });
          }
          successCount++;
        }
      }
    } else {
      for (const [dateStr, val] of Object.entries(allRates)) {
        const rateVal = typeof val === 'object' ? val[quoteCurrency] : val;
        if (rateVal) {
          const existing = rates.find(r => r.date === dateStr && r.base === baseCurrency && r.quote === quoteCurrency);
          if (existing) {
            existing.rate = parseFloat(rateVal).toFixed(4);
          } else {
            rates.push({ date: dateStr, base: baseCurrency, quote: quoteCurrency, rate: parseFloat(rateVal).toFixed(4) });
          }
          successCount++;
        }
      }
    }
    
    console.log(`✓ Successfully fetched ${successCount} daily rates from API`);
  } catch (err) {
    console.log(`✗ Failed to fetch rates: ${err.message}`);
    failCount++;
  }

  console.log('');

  if (rates.length === 0) {
    console.error('\n❌ No rates available.');
    console.error('   Failed to fetch rates from frankfurter.dev API.');
    process.exit(1);
  }

  // Sort by base, quote, then date
  rates.sort((a, b) => a.base.localeCompare(b.base) || a.quote.localeCompare(b.quote) || a.date.localeCompare(b.date));

  // Write CSV with new format: date,base,quote,rate
  const csv = 'date,base,quote,rate\n' + rates.map(r => `${r.date},${r.base},${r.quote},${r.rate}`).join('\n');
  fs.writeFileSync(csvPath, csv, 'utf-8');

  console.log('\n' + '='.repeat(60));
  console.log(`✓ Updated ${csvPath}`);
  console.log(`  Total rates in file: ${rates.length}`);
  if (successCount > 0) {
    console.log(`  Successfully fetched: ${successCount} rates`);
  }
  if (failCount > 0) {
    console.log(`  Failed: ${failCount} rates`);
  }
  console.log('='.repeat(60));
}

// Run main and handle errors
(async () => {
  try {
    await main();
    process.exitCode = 0;
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exitCode = 1;
  }
})();
