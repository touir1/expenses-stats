/**
 * Centralized data access module.
 * Handles reading/writing CSV files and reading JSON config files.
 * Database-specific operations remain in db-insert.script.js.
 */

const fs = require('fs');
const path = require('path');
const { parseCSVLine } = require('./csv.util');
const { ensureDir } = require('./path-resolver.util');

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Read a CSV file and return headers + rows as objects.
 * @param {string} filePath
 * @returns {{ headers: string[], rows: Object.<string, string>[], columnMap: Object.<string, number> }}
 */
function readCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 1) {
    throw new Error(`CSV file is empty: ${filePath}`);
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const columnMap = {};
  headers.forEach((h, i) => { columnMap[h] = i; });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (parts[idx] || '').trim(); });
    rows.push(row);
  }

  return { headers, rows, columnMap };
}

/**
 * Read a CSV file and return headers + raw parts arrays (for scripts that use index-based access).
 * @param {string} filePath
 * @returns {{ headers: string[], lines: string[], columnMap: Object.<string, number> }}
 */
function readCSVLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 1) {
    throw new Error(`CSV file is empty: ${filePath}`);
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const columnMap = {};
  headers.forEach((h, i) => { columnMap[h] = i; });

  return { headers, lines, columnMap };
}

/**
 * Write rows (array of objects) to a CSV file.
 * @param {string} filePath
 * @param {string[]} headers
 * @param {Object.<string, string>[]} rows
 */
function writeCSV(filePath, headers, rows) {
  const escape = (val) => {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(h => escape(row[h] ?? '')).join(','))
  ];

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Write raw CSV content string to a file.
 * @param {string} filePath
 * @param {string} content
 */
function writeCSVRaw(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ─── JSON Config ─────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON config file (handles BOM).
 * @param {string} filePath
 * @returns {*}
 */
function readJSON(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

/**
 * Load categories definition from a JSON file.
 * @param {string} filePath
 * @returns {Array} categories array
 */
function loadCategories(filePath) {
  const data = readJSON(filePath);
  return data.categories || [];
}

/**
 * Load category patterns (forced mappings) from a JSON file.
 * @param {string} filePath
 * @returns {Array} forced patterns array
 */
function loadCategoryPatterns(filePath) {
  const data = readJSON(filePath);
  return data.forced || [];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Ensure directory for a file path exists, creating it recursively if needed.
 * @param {string} filePath
 */
/**
 * Check if a file exists.
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

module.exports = {
  readCSV,
  readCSVLines,
  writeCSV,
  writeCSVRaw,
  readJSON,
  loadCategories,
  loadCategoryPatterns,
  fileExists,
};
