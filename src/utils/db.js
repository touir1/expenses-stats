const sqlite3 = require('sqlite3').verbose();

// Open a SQLite database connection
function openDatabase(databaseFile) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databaseFile, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

// Initialize database schema (create tables, optionally drop first)
function initializeDatabase(db, { dropAll = false } = {}) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      if (dropAll) {
        db.run('DROP TABLE IF EXISTS expenses', () => {});
        db.run('DROP TABLE IF EXISTS filters', () => {});
        db.run('DROP TABLE IF EXISTS categories', () => {});
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          parent_id INTEGER,
          label TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (parent_id) REFERENCES categories(id)
        )
      `, (err) => { if (err) reject(err); });

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
      `, (err) => { if (err) reject(err); });

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
      `, (err) => { if (err) reject(err); });

      // Composite index for the deduplication COUNT query (date + category_id + amount)
      db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_dedup ON expenses (date, category_id, amount)`
        , (err) => { if (err) reject(err); });

      // Index for category-based grouping and reporting
      db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category_id)`
        , (err) => { if (err) reject(err); });

      // Index for FK lookups: filters by category (SQLite does not auto-index FK columns)
      db.run(`CREATE INDEX IF NOT EXISTS idx_filters_category ON filters (category_id)`
        , (err) => { if (err) reject(err); else resolve(); });
    });
  });
}

// Recursively insert a category and its filters/subcategories
function _processCategory(db, catDef, parentId, parentLabel, callback) {
  const label = parentLabel ? `${parentLabel}/${catDef.name}` : catDef.name;

  db.run(
    'INSERT OR REPLACE INTO categories (name, parent_id, label) VALUES (?, ?, ?)',
    [catDef.name, parentId, label],
    function(err) {
      if (err) { callback(err); return; }

      const categoryId = this.lastID;
      const filters = catDef.filters || {};
      const filterEntries = Object.entries(filters);

      const processSubcategories = () => {
        const subs = catDef.subcategories || [];
        if (subs.length === 0) { callback(null); return; }
        let done = 0;
        subs.forEach((subCat) => {
          _processCategory(db, subCat, categoryId, label, (err) => {
            if (err) { callback(err); return; }
            if (++done === subs.length) callback(null);
          });
        });
      };

      if (filterEntries.length === 0) {
        processSubcategories();
        return;
      }

      const totalFilterOps = filterEntries.reduce((acc, [, cond]) => acc + Object.keys(cond).length, 0);
      let filtersProcessed = 0;

      filterEntries.forEach(([colName, condition]) => {
        Object.entries(condition).forEach(([operator, value]) => {
          const filterValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          db.run(
            'INSERT INTO filters (category_id, column_name, operator, filter_value) VALUES (?, ?, ?, ?)',
            [categoryId, colName, operator, filterValue],
            (err) => {
              if (err) console.error(`Error inserting filter for ${catDef.name}:`, err.message);
              if (++filtersProcessed === totalFilterOps) processSubcategories();
            }
          );
        });
      });
    }
  );
}

// Insert categories and their filters into the database
function loadCategoriesIntoDb(db, categories) {
  return new Promise((resolve, reject) => {
    let processed = 0;
    if (categories.length === 0) { resolve(); return; }
    categories.forEach((cat) => {
      _processCategory(db, cat, null, null, (err) => {
        if (err) { reject(err); return; }
        if (++processed === categories.length) resolve();
      });
    });
  });
}

// Get category ID by its full label (e.g. "food/cafe")
function getCategoryIdByLabel(db, label) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM categories WHERE label = ?', [label], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.id : null);
    });
  });
}

// Count expenses matching date + category + amount
function getExpenseCount(db, date, categoryId, amount) {
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

// Insert a single expense row
function insertExpense(db, row, categoryId) {
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

// Count rows in a table
function getRowCount(db, table) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as count FROM ${table}`, (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.count : 0);
    });
  });
}

module.exports = {
  openDatabase,
  initializeDatabase,
  loadCategoriesIntoDb,
  getCategoryIdByLabel,
  getExpenseCount,
  insertExpense,
  getRowCount,
};
