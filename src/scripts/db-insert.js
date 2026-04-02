const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Usage: node db-insert.js [options]

Options:
  --input-file <path>      Input labeled CSV file (default: ../../data/processed/depenses-labeled.csv)
  --categories-file <path> Categories definition file (default: ../../config/categories.json)
  --database <path>        SQLite database file (default: ../../data/database/depenses.db)
  --delete-all             Delete all data and recreate the tables
  -h, --help              Show this help message

Examples:
  node db-insert.js --input-file data/processed/depenses-labeled.csv --database data/depenses.db
  node db-insert.js --delete-all --database data/depenses.db
`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  showHelp();
}

let inputFile = null;
let categoriesFile = null;
let databaseFile = null;
let deleteAll = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-file' && args[i + 1]) {
    inputFile = args[i + 1]; i++;
  } else if (args[i] === '--categories-file' && args[i + 1]) {
    categoriesFile = args[i + 1]; i++;
  } else if (args[i] === '--database' && args[i + 1]) {
    databaseFile = args[i + 1]; i++;
  } else if (args[i] === '--delete-all') {
    deleteAll = true;
  }
}

const baseDir = path.join(__dirname, '..', '..');
if (!inputFile) inputFile = path.join(baseDir, 'data', 'processed', 'depenses-labeled.csv');
if (!categoriesFile) categoriesFile = path.join(baseDir, 'config', 'categories.json');
if (!databaseFile) databaseFile = path.join(baseDir, 'data', 'database', 'depenses.db');

if (!path.isAbsolute(inputFile)) inputFile = path.join(process.cwd(), inputFile);
if (!path.isAbsolute(categoriesFile)) categoriesFile = path.join(process.cwd(), categoriesFile);
if (!path.isAbsolute(databaseFile)) databaseFile = path.join(process.cwd(), databaseFile);

// Ensure database directory exists
const dbDir = path.dirname(databaseFile);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`✓ Created directory: ${dbDir}`);
}

// Open database
const db = new sqlite3.Database(databaseFile, (err) => {
  if (err) {
    console.error(`Error opening database: ${err.message}`);
    process.exit(1);
  }
  console.log(`✓ Connected to database: ${databaseFile}`);
});

// Initialize database
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      if (deleteAll) {
        db.run('DROP TABLE IF EXISTS expenses', () => {});
        db.run('DROP TABLE IF EXISTS filters', () => {});
        db.run('DROP TABLE IF EXISTS categories', () => {});
        console.log('✓ Dropped existing tables');
      }

      // Create categories table
      db.run(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          parent_id INTEGER,
          label TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (parent_id) REFERENCES categories(id)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating categories table:', err.message);
          reject(err);
        }
      });

      // Create filters table
      db.run(`
        CREATE TABLE IF NOT EXISTS filters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER NOT NULL,
          column_name TEXT NOT NULL,
          operator TEXT NOT NULL,
          filter_value TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          console.error('Error creating filters table:', err.message);
          reject(err);
        }
      });

      // Create expenses table
      db.run(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          amount REAL NOT NULL,
          currency_symbol TEXT,
          currency_code TEXT,
          date TEXT NOT NULL,
          description TEXT NOT NULL,
          category_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating expenses table:', err.message);
          reject(err);
        } else {
          console.log('✓ Tables initialized');
          resolve();
        }
      });
    });
  });
}

// Read categories file and populate categories and filters tables
function loadCategories(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      const categories = data.categories || [];

      console.log(`\nLoading ${categories.length} parent categories...`);

      let processed = 0;
      const categoryMap = {}; // name -> id mapping

      const processCategory = (catDef, parentId = null, parentLabel = null, callback) => {
        const label = parentLabel ? `${parentLabel}/${catDef.name}` : catDef.name;

        db.run(
          'INSERT OR REPLACE INTO categories (name, parent_id, label) VALUES (?, ?, ?)',
          [catDef.name, parentId, label],
          function(err) {
            if (err) {
              console.error(`Error inserting category ${catDef.name}:`, err.message);
              callback(err);
              return;
            }

            const categoryId = this.lastID;
            categoryMap[catDef.name] = categoryId;

            // Insert filters for this category
            let filtersProcessed = 0;
            const filters = catDef.filters || {};

            if (Object.keys(filters).length === 0) {
              // No filters, process subcategories
              if (catDef.subcategories && catDef.subcategories.length > 0) {
                let subProcessed = 0;
                catDef.subcategories.forEach((subCat) => {
                  processCategory(subCat, categoryId, label, (err) => {
                    if (err) {
                      callback(err);
                      return;
                    }
                    subProcessed++;
                    if (subProcessed === catDef.subcategories.length) {
                      callback(null);
                    }
                  });
                });
              } else {
                callback(null);
              }
            } else {
              // Pre-compute total number of filter inserts
              const totalFilterOps = Object.entries(filters).reduce((acc, [, cond]) => acc + Object.keys(cond).length, 0);

              // Insert filters
              Object.entries(filters).forEach(([colName, condition]) => {
                Object.entries(condition).forEach(([operator, value]) => {
                  const filterValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                  db.run(
                    'INSERT INTO filters (category_id, column_name, operator, filter_value) VALUES (?, ?, ?, ?)',
                    [categoryId, colName, operator, filterValue],
                    (err) => {
                      filtersProcessed++;
                      if (err) {
                        console.error(`Error inserting filter for ${catDef.name}:`, err.message);
                      }
                      // Process subcategories after all filters are inserted
                      if (filtersProcessed === totalFilterOps) {
                        if (catDef.subcategories && catDef.subcategories.length > 0) {
                          let subProcessed = 0;
                          catDef.subcategories.forEach((subCat) => {
                            processCategory(subCat, categoryId, label, (err) => {
                              if (err) {
                                callback(err);
                                return;
                              }
                              subProcessed++;
                              if (subProcessed === catDef.subcategories.length) {
                                callback(null);
                              }
                            });
                          });
                        } else {
                          callback(null);
                        }
                      }
                    }
                  );
                });
              });
            }
          }
        );
      };

      // Process all parent categories
      let catProcessed = 0;
      categories.forEach((cat) => {
        processCategory(cat, null, null, (err) => {
          if (err) {
            reject(err);
            return;
          }
          catProcessed++;
          if (catProcessed === categories.length) {
            resolve();
          }
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Parse a CSV line respecting quoted fields
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// Read CSV file
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length < 1) {
        reject(new Error('CSV file is empty'));
        return;
      }

      const headers = parseCSVLine(lines[0]).map(h => h.trim());
      const rows = [];

      for (let i = 1; i < lines.length; i++) {
        const parts = parseCSVLine(lines[i]).map(p => p.trim());
        const row = {};
        headers.forEach((h, idx) => {
          row[h] = parts[idx] || '';
        });
        rows.push(row);
      }

      console.log(`✓ Read ${rows.length} rows from CSV`);
      resolve(rows);
    } catch (err) {
      reject(err);
    }
  });
}

// Get category ID by label (parent/child format)
function getCategoryIdByLabel(label) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM categories WHERE label = ?',
      [label],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.id : null);
      }
    );
  });
}

// Get count of matching rows in database
function getDbRowCount(date, categoryId, amount) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT COUNT(*) as count FROM expenses WHERE date = ? AND category_id = ? AND amount = ?',
      [date, categoryId, parseFloat(amount)],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.count : 0);
      }
    );
  });
}

// Count matching rows in CSV data
function getCsvRowCount(rows, date, categoryId, amount) {
  return rows.filter(r => r.date === date && parseFloat(r.amount) === parseFloat(amount)).length;
}

// Insert a single row
function insertRow(row, categoryId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO expenses (amount, currency_symbol, currency_code, date, description, category_id) VALUES (?, ?, ?, ?, ?, ?)',
      [parseFloat(row.amount), row.currency_symbol, row.currency_code, row.date, row.description, categoryId],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// Main process
async function main() {
  try {
    // Initialize database
    await initializeDatabase();

    // Load categories from JSON — only if table is empty or --delete-all was used
    if (!fs.existsSync(categoriesFile)) {
      throw new Error(`Categories file not found: ${categoriesFile}`);
    }
    const catCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM categories', (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.count : 0);
      });
    });
    if (deleteAll || catCount === 0) {
      await loadCategories(categoriesFile);
      console.log('✓ Categories and filters loaded');
    } else {
      console.log(`✓ Categories already loaded (${catCount} entries), skipping`);
    }

    if (deleteAll && !inputFile) {
      console.log('✓ Database reset complete');
      db.close();
      return;
    }

    // Read CSV
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const csvRows = await readCsvFile(inputFile);

    // Group rows by (date, category, amount) to check for duplicates
    const rowGroups = {};
    for (const row of csvRows) {
      const key = `${row.date}|${row.category}|${row.amount}`;
      if (!rowGroups[key]) {
        rowGroups[key] = [];
      }
      rowGroups[key].push(row);
    }

    let insertCount = 0;
    let skipCount = 0;
    let warningCount = 0;
    const insertedByCategory = {};

    console.log(`\nProcessing ${Object.keys(rowGroups).length} unique (date, category, amount) combinations...\n`);

    // Process each group
    for (const [key, groupRows] of Object.entries(rowGroups)) {
      const [date, categoryLabel, amount] = key.split('|');
      const csvCount = groupRows.length;

      // Get category ID from label
      const categoryId = await getCategoryIdByLabel(categoryLabel);
      if (!categoryId) {
        console.warn(`  ⚠ Category not found: ${categoryLabel}`);
        warningCount++;
        continue;
      }

      const dbCount = await getDbRowCount(date, categoryId, amount);

      if (dbCount === csvCount) {
        skipCount += csvCount;
      } else if (csvCount > dbCount) {
        const rowsToInsert = csvCount - dbCount;
        for (let i = 0; i < rowsToInsert; i++) {
          try {
            await insertRow(groupRows[i], categoryId);
            insertCount++;
            insertedByCategory[categoryLabel] = (insertedByCategory[categoryLabel] || 0) + 1;
          } catch (err) {
            console.error(`  ✗ Error inserting row: ${err.message}`);
          }
        }
      } else {
        console.warn(`  ⚠ WARNING: Database has ${dbCount} rows vs CSV has ${csvCount} for ${date}, ${categoryLabel}, ${amount}`);
        warningCount++;
      }
    }

    console.log(`\n✓ Insert complete:`);
    console.log(`  - Inserted: ${insertCount} rows`);
    console.log(`  - Skipped (already exists): ${skipCount} rows`);
    console.log(`  - Warnings (db > csv): ${warningCount} combinations`);

    if (insertCount > 0) {
      console.log(`\n  Inserted by category:`);

      // Group by parent / subcategory
      const grouped = {};
      for (const [label, count] of Object.entries(insertedByCategory)) {
        const slash = label.indexOf('/');
        const parent = slash === -1 ? label : label.slice(0, slash);
        const sub    = slash === -1 ? null  : label.slice(slash + 1);
        if (!grouped[parent]) grouped[parent] = { total: 0, subs: {} };
        grouped[parent].total += count;
        if (sub) grouped[parent].subs[sub] = (grouped[parent].subs[sub] || 0) + count;
      }

      const sortedParents = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);
      for (const [parent, data] of sortedParents) {
        console.log(`    ${parent.padEnd(28)} ${String(data.total).padStart(4)} rows`);
        const sortedSubs = Object.entries(data.subs).sort((a, b) => b[1] - a[1]);
        for (const [sub, count] of sortedSubs) {
          console.log(`      ${('└─ ' + sub).padEnd(26)} ${String(count).padStart(4)} rows`);
        }
      }
    }

    db.close(() => {
      console.log(`✓ Database connection closed`);
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    db.close();
    process.exit(1);
  }
}

main();
