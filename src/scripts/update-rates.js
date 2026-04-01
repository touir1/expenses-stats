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

function fetchRates(startDate, endDate) {
  return new Promise((resolve, reject) => {
    // Format: YYYY-MM-DD
    // Returns rates for date range
    const url = `${API_BASE}?base=EUR&quotes=TND&from=${startDate}&to=${endDate}`;

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
    } else if (args[i] === '--auto') {
      autoMode = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      showHelp = true;
    }
  }

  if (showHelp) {
    console.log(`
Usage: node update-rates.js [options]

Fetch EUR to TND conversion rates and update config/conversion_rates.csv
Uses frankfurter.dev API (FREE, no limits, no authentication required)
Batch requests: fetches all daily rates for the entire date range in one API call

Options:
  --start <YYYY-MM-DD>   Start date (default: 2022-08-01 or last date in CSV with --auto)
  --end <YYYY-MM-DD>     End date (default: today)
  --auto                 Auto incremental update: fetch from last date in CSV to today
  -h, --help            Show this help message

API: https://frankfurter.dev (open source, no rate limits)
GitHub: https://github.com/hakanensari/frankfurter

Examples:
  node update-rates.js
  node update-rates.js --start 2024-01-01 --end 2024-12-31
  node update-rates.js --auto
  npm run update-rates

Note:
  - Fetches all daily rates for the requested date range in a single batch request
  - Free API with unlimited requests
  - Historical rates available from 1999 onwards
  - CSV contains daily rates (one rate per day)
  - --auto mode fetches new rates from the last date in the CSV onwards
`);
    process.exit(0);
  }

  // Default dates
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  
  const csvPath = path.join(__dirname, '..', '..', 'config', 'conversion_rates.csv');
  
  // Auto mode: fetch from last date in CSV to today
  if (autoMode) {
    try {
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.trim().split('\n');
      
      if (lines.length < 2) {
        // Empty CSV, start from default
        startDate = '2022-08-01';
        endDate = todayStr;
      } else {
        // Get last date from CSV and start from next day
        const lastLine = lines[lines.length - 1];
        const lastDate = lastLine.split(',')[0];
        
        // Parse last date and add 1 day
        const lastDateObj = new Date(lastDate + 'T00:00:00Z');
        lastDateObj.setUTCDate(lastDateObj.getUTCDate() + 1);
        startDate = lastDateObj.toISOString().split('T')[0];
        endDate = todayStr;
        
        // If last date is today or later, nothing to fetch
        if (startDate > todayStr) {
          console.log('✓ Rates are already up to date');
          process.exit(0);
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

  console.log('📊 Fetching EUR to TND conversion rates (daily)...\n');
  console.log(`Start date: ${startDate}`);
  console.log(`End date: ${endDate}`);
  console.log(`API: frankfurter.dev (FREE, batch mode, no limits)`);
  console.log('');

  // Read existing rates
  let existingRates = {};
  if (fs.existsSync(csvPath)) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('date'));
    for (const line of lines) {
      const [date, rate] = line.split(',');
      if (date && rate) {
        // Store by full date (YYYY-MM-DD)
        existingRates[date.trim()] = parseFloat(rate);
      }
    }
    console.log(`Found ${Object.keys(existingRates).length} existing rates in CSV\n`);
  }

  const dates = getMonthDates(startDate, endDate);
  console.log(`Date range: ${startDate} to ${endDate}\n`);

  const rates = [];
  let successCount = 0;
  let failCount = 0;

  // Add existing rates first
  for (const [dateKey, rate] of Object.entries(existingRates)) {
    // Store existing daily rates
    rates.push({ date: dateKey, rate: rate.toFixed(4) });
  }

  // Fetch all rates (batch request via frankfurter.dev)
  console.log('⏳ Fetching all daily rates from API...\n');
  
  try {
    const allRates = await fetchRates(startDate, endDate);
    
    // Process the batch response
    // Format (array): [{"date":"2025-04-01", "rate": 3.35}, ...]
    
    if (Array.isArray(allRates)) {
      // Array format - API returns daily rates
      for (const item of allRates) {
        if (item.date && item.rate) {
          const dateKey = item.date; // YYYY-MM-DD format
          
          // Update or add rate
          const existing = rates.find(r => r.date === dateKey);
          if (existing) {
            existing.rate = parseFloat(item.rate).toFixed(4);
          } else {
            rates.push({ date: dateKey, rate: parseFloat(item.rate).toFixed(4) });
          }
          successCount++;
        }
      }
    } else {
      // Object format - shouldn't happen with current API, but handle it
      for (const [dateStr, tndRate] of Object.entries(allRates)) {
        const date = dateStr; // YYYY-MM-DD format
        const dateKey = date;
        
        if (tndRate) {
          // Update or add rate
          const existing = rates.find(r => r.date === dateKey);
          if (existing) {
            existing.rate = parseFloat(tndRate).toFixed(4);
          } else {
            rates.push({ date: date, rate: parseFloat(tndRate).toFixed(4) });
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

  // Sort by date
  rates.sort((a, b) => a.date.localeCompare(b.date));

  // Write CSV
  const csv = 'date,rate\n' + rates.map(r => `${r.date},${r.rate}`).join('\n');
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
