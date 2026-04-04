// Date utilities for DD/MM/YYYY ↔ YYYY-MM-DD conversion and comparison

// Convert DD/MM/YYYY string to YYYY-MM-DD format (ISO)
function toISODate(ddmmyyyyStr) {
  if (!ddmmyyyyStr || typeof ddmmyyyyStr !== 'string') return null;
  const parts = ddmmyyyyStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// Convert YYYY-MM-DD to DD/MM/YYYY format
function toDDMMYYYY(isoDateStr) {
  if (!isoDateStr || typeof isoDateStr !== 'string') return null;
  const parts = isoDateStr.split('-');
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  return `${day}/${month}/${year}`;
}

// Convert DD/MM/YYYY to comparable numeric string YYYYMMDD
function toComparableString(ddmmyyyyStr) {
  if (!ddmmyyyyStr || typeof ddmmyyyyStr !== 'string') return null;
  const parts = ddmmyyyyStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  return `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`;
}

// Parse DD/MM/YYYY and return { year, month, day }
function parseDate(ddmmyyyyStr) {
  if (!ddmmyyyyStr || typeof ddmmyyyyStr !== 'string') return null;
  const parts = ddmmyyyyStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  return { year: parseInt(year), month: parseInt(month), day: parseInt(day) };
}

// Compare two DD/MM/YYYY dates (-1 = first < second, 0 = equal, 1 = first > second)
function compareDates(date1, date2) {
  const str1 = toComparableString(date1);
  const str2 = toComparableString(date2);
  if (str1 < str2) return -1;
  if (str1 > str2) return 1;
  return 0;
}

// Check if date1 comes before date2 (both DD/MM/YYYY format)
function isBefore(date1, date2) {
  return compareDates(date1, date2) < 0;
}

// Check if date1 comes after date2 (both DD/MM/YYYY format)
function isAfter(date1, date2) {
  return compareDates(date1, date2) > 0;
}

// Get current date in DD/MM/YYYY format
function getTodayDDMMYYYY() {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const year = today.getFullYear();
  return `${day}/${month}/${year}`;
}

// Get current date in YYYY-MM-DD format
function getTodayISO() {
  return toISODate(getTodayDDMMYYYY());
}

// Get year and month string from DD/MM/YYYY (format: "2025-11" or "202511")
function getYearMonthKey(ddmmyyyyStr, separator = '-') {
  const parsed = parseDate(ddmmyyyyStr);
  if (!parsed) return null;
  const month = String(parsed.month).padStart(2, '0');
  return `${parsed.year}${separator}${month}`;
}

module.exports = {
  toISODate,
  toDDMMYYYY,
  toComparableString,
  parseDate,
  compareDates,
  isBefore,
  isAfter,
  getTodayDDMMYYYY,
  getTodayISO,
  getYearMonthKey
};
