const { normalizeStr, countTokenMatches } = require('./text');

/**
 * Convert DD/MM/YYYY date string to comparable YYYYMMDD string.
 * @param {string} dateStr
 * @returns {string}
 */
function dateToComparable(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return parts[2] + parts[1] + parts[0];
  }
  return dateStr;
}

/**
 * Match a single value against a filter condition.
 * Supports operators: eq, ne, gt, gte, lt, lte, contains, startsWith, endsWith, regex, tokens, in, nin.
 * Pass columnName to enable date-aware gte/lte comparisons for DD/MM/YYYY dates.
 * @param {string} value
 * @param {*} condition
 * @param {string} [columnName]
 * @returns {boolean}
 */
function matchesFilter(value, condition, columnName) {
  if (typeof condition !== 'object' || condition === null) {
    return String(value) === String(condition);
  }

  for (const [op, operand] of Object.entries(condition)) {
    const numVal = parseFloat(value);
    const numOp  = parseFloat(operand);

    switch (op) {
      case 'eq':  if (String(value) !== String(operand)) return false; break;
      case 'ne':  if (String(value) === String(operand)) return false; break;
      case 'gt':  if (isNaN(numVal) || isNaN(numOp) || numVal <= numOp) return false; break;
      case 'lt':  if (isNaN(numVal) || isNaN(numOp) || numVal >= numOp) return false; break;
      case 'gte':
        if (columnName === 'date' && value.includes('/') && operand.includes('/')) {
          if (dateToComparable(value) < dateToComparable(operand)) return false;
        } else {
          if (isNaN(numVal) || isNaN(numOp) || numVal < numOp) return false;
        }
        break;
      case 'lte':
        if (columnName === 'date' && value.includes('/') && operand.includes('/')) {
          if (dateToComparable(value) > dateToComparable(operand)) return false;
        } else {
          if (isNaN(numVal) || isNaN(numOp) || numVal > numOp) return false;
        }
        break;
      case 'contains':   if (!String(value).includes(String(operand))) return false; break;
      case 'startsWith': if (!String(value).startsWith(String(operand))) return false; break;
      case 'endsWith':   if (!String(value).endsWith(String(operand))) return false; break;
      case 'regex':
        try {
          const rx = new RegExp(operand, 'i');
          if (!rx.test(String(value)) && !rx.test(normalizeStr(String(value)))) return false;
        } catch (e) {
          console.error(`Invalid regex "${operand}": ${e.message}`);
          process.exit(1);
        }
        break;
      case 'tokens':
        if (!Array.isArray(operand) || countTokenMatches(String(value), operand) === 0) return false;
        break;
      case 'in':
        if (!Array.isArray(operand) || !operand.map(String).includes(String(value))) return false;
        break;
      case 'nin':
        if (!Array.isArray(operand) || operand.map(String).includes(String(value))) return false;
        break;
      default:
        console.error(`Unknown operator "${op}"`);
        process.exit(1);
    }
  }
  return true;
}

module.exports = { matchesFilter, dateToComparable };
