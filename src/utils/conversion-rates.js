const fs = require('fs');

const DEFAULT_RATE = 3.5;

/**
 * Load conversion rates from a CSV file.
 * Supports both old format (date,rate) and new format (date,base,quote,rate).
 * @param {string} csvPath
 * @param {string} base   Base currency (default: 'EUR')
 * @param {string} quote  Quote currency (default: 'TND')
 * @returns {Object.<string, number>} Map of YYYY-MM-DD -> rate
 */
function loadConversionRates(csvPath, base = 'EUR', quote = 'TND') {
  try {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const rates = {};
    if (lines.length < 2) return rates;

    const header = lines[0].split(',').map(h => h.trim());
    const isNewFormat = header.length >= 4 && header[1] === 'base';

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (isNewFormat) {
        const [d, rowBase, rowQuote, rate] = cols;
        if (d && rate && rowBase.trim() === base && rowQuote.trim() === quote) {
          rates[d.trim()] = parseFloat(rate);
        }
      } else {
        // Old format: date,rate — all rows are implicitly EUR/TND
        const [d, rate] = cols;
        if (d && rate) {
          rates[d.trim()] = parseFloat(rate);
        }
      }
    }
    return rates;
  } catch (e) {
    console.error('Warning: Could not read conversion rates:', e.message);
    return {};
  }
}

/**
 * Get the conversion rate for a given DD/MM/YYYY date.
 * Falls back to the most recent rate before the date, then the earliest available, then DEFAULT_RATE.
 * @param {string} dateStr  DD/MM/YYYY
 * @param {Object.<string, number>} rates
 * @returns {number}
 */
function getRateForDate(dateStr, rates) {
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const fullDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    if (rates[fullDate]) return rates[fullDate];
    const rateKeys = Object.keys(rates).sort();
    for (let i = rateKeys.length - 1; i >= 0; i--) {
      if (rateKeys[i] <= fullDate) return rates[rateKeys[i]];
    }
    if (rateKeys.length > 0) return rates[rateKeys[0]];
  }
  return DEFAULT_RATE;
}

/**
 * Convert an amount to EUR using the rate for a given date.
 * @param {number} amount
 * @param {string} currency  e.g. 'TND', 'EUR'
 * @param {string} dateStr   DD/MM/YYYY
 * @param {Object.<string, number>} rates
 * @returns {number}
 */
function convertToEUR(amount, currency, dateStr, rates) {
  if (currency === 'EUR') return amount;
  const rate = getRateForDate(dateStr, rates);
  return amount / rate;
}

module.exports = { DEFAULT_RATE, loadConversionRates, getRateForDate, convertToEUR };
