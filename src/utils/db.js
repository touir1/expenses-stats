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
        db.run('DROP TABLE IF EXISTS filter_tokens', () => {});
        db.run('DROP TABLE IF EXISTS filters', () => {});
        db.run('DROP TABLE IF EXISTS category_patterns', () => {});
        db.run('DROP TABLE IF EXISTS categories', () => {});
        db.run('DROP TABLE IF EXISTS conversion_rates', () => {});
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
          filter_value TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )
      `, (err) => { if (err) reject(err); });

      db.run(`
        CREATE TABLE IF NOT EXISTS filter_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filter_id INTEGER NOT NULL,
          token TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (filter_id) REFERENCES filters(id) ON DELETE CASCADE,
          UNIQUE(filter_id, token)
        )
      `, (err) => { if (err) reject(err); });

      db.run(`CREATE INDEX IF NOT EXISTS idx_filter_tokens_filter ON filter_tokens (filter_id)`
        , (err) => { if (err) reject(err); });

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
        , (err) => { if (err) reject(err); });

      db.run(`
        CREATE TABLE IF NOT EXISTS conversion_rates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          base TEXT NOT NULL,
          quote TEXT NOT NULL,
          rate REAL NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(date, base, quote)
        )
      `, (err) => { if (err) reject(err); });

      db.run(`
        CREATE TABLE IF NOT EXISTS category_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          description_pattern TEXT NOT NULL UNIQUE,
          category_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )
      `, (err) => { if (err) reject(err); });

      // Index for nearest-prior-date lookup on conversion_rates
      db.run(`CREATE INDEX IF NOT EXISTS idx_conversion_rates_lookup ON conversion_rates (base, quote, date)`
        , (err) => { if (err) reject(err); });

      // Index for FK lookups: category_patterns by category
      db.run(`CREATE INDEX IF NOT EXISTS idx_category_patterns_category ON category_patterns (category_id)`
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
          const isTokens = operator === 'tokens' && Array.isArray(value);
          const filterValue = isTokens ? null : (typeof value === 'object' ? JSON.stringify(value) : String(value));
          db.run(
            'INSERT INTO filters (category_id, column_name, operator, filter_value) VALUES (?, ?, ?, ?)',
            [categoryId, colName, operator, filterValue],
            function(err) {
              if (err) {
                console.error(`Error inserting filter for ${catDef.name}:`, err.message);
                if (++filtersProcessed === totalFilterOps) processSubcategories();
                return;
              }
              if (!isTokens || value.length === 0) {
                if (++filtersProcessed === totalFilterOps) processSubcategories();
                return;
              }
              // Insert each token into filter_tokens
              const filterId = this.lastID;
              let tokensDone = 0;
              value.forEach((token) => {
                db.run(
                  'INSERT INTO filter_tokens (filter_id, token) VALUES (?, ?)',
                  [filterId, String(token)],
                  (tokenErr) => {
                    if (tokenErr) console.error(`Error inserting token "${token}" for ${catDef.name}:`, tokenErr.message);
                    if (++tokensDone === value.length) {
                      if (++filtersProcessed === totalFilterOps) processSubcategories();
                    }
                  }
                );
              });
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

// Get all tokens for a filter row
function getFilterTokens(db, filterId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, token FROM filter_tokens WHERE filter_id = ? ORDER BY token', [filterId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Add a token to an existing filter
function addFilterToken(db, filterId, token) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO filter_tokens (filter_id, token) VALUES (?, ?)', [filterId, token], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

// Remove a token from a filter by token text
function removeFilterToken(db, filterId, token) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM filter_tokens WHERE filter_id = ? AND token = ?', [filterId, token], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

const DEFAULT_RATE = 3.5;

// Bulk-load conversion rates into DB using a transaction.
// rows: array of { date (YYYY-MM-DD), base, quote, rate }
function loadConversionRatesIntoDb(db, rows) {
  return new Promise((resolve, reject) => {
    if (rows.length === 0) { resolve(); return; }
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO conversion_rates (date, base, quote, rate) VALUES (?, ?, ?, ?)'
      );
      for (const r of rows) {
        stmt.run([r.date, String(r.base).toUpperCase(), String(r.quote).toUpperCase(), parseFloat(r.rate)]);
      }
      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Get conversion rate for a DD/MM/YYYY date using nearest-prior-date logic.
// Falls back to DEFAULT_RATE if no rate is found.
function getConversionRateFromDb(db, dateStr, base = 'EUR', quote = 'TND') {
  return new Promise((resolve, reject) => {
    const parts = dateStr.split('/');
    if (parts.length !== 3) { resolve(DEFAULT_RATE); return; }
    const isoDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    db.get(
      'SELECT rate FROM conversion_rates WHERE base = ? AND quote = ? AND date <= ? ORDER BY date DESC LIMIT 1',
      [base.toUpperCase(), quote.toUpperCase(), isoDate],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.rate : DEFAULT_RATE);
      }
    );
  });
}

// Load category patterns into DB.
// patterns: array of { description, category } where category is a label like "food/cafe".
// Categories must already be loaded before calling this.
function loadCategoryPatternsIntoDb(db, patterns) {
  return new Promise((resolve, reject) => {
    if (patterns.length === 0) { resolve(); return; }
    let processed = 0;
    patterns.forEach((p) => {
      db.get('SELECT id FROM categories WHERE label = ?', [p.category], (err, row) => {
        if (err) { reject(err); return; }
        if (!row) {
          console.warn(`  ⚠ Category not found for pattern "${p.description}": ${p.category}`);
          if (++processed === patterns.length) resolve();
          return;
        }
        db.run(
          'INSERT OR REPLACE INTO category_patterns (description_pattern, category_id) VALUES (?, ?)',
          [p.description, row.id],
          (err2) => {
            if (err2) console.error(`Error inserting pattern "${p.description}":`, err2.message);
            if (++processed === patterns.length) resolve();
          }
        );
      });
    });
  });
}

// Get all category patterns, joined with their category label.
// Ordered longest-pattern-first (same priority as label.js matching logic).
function getCategoryPatternsFromDb(db) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT cp.id, cp.description_pattern, c.label AS category_label
       FROM category_patterns cp
       JOIN categories c ON c.id = cp.category_id
       ORDER BY length(cp.description_pattern) DESC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// Get all filters (with their tokens) for a category
function getFiltersForCategory(db, categoryId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT f.id, f.column_name, f.operator, f.filter_value,
              group_concat(ft.token, '|') AS tokens
       FROM filters f
       LEFT JOIN filter_tokens ft ON ft.filter_id = f.id
       WHERE f.category_id = ?
       GROUP BY f.id
       ORDER BY f.column_name, f.operator`,
      [categoryId],
      (err, rows) => {
        if (err) { reject(err); return; }
        resolve((rows || []).map(r => ({
          id: r.id,
          column_name: r.column_name,
          operator: r.operator,
          filter_value: r.filter_value,
          tokens: r.tokens ? r.tokens.split('|') : [],
        })));
      }
    );
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
  getFilterTokens,
  addFilterToken,
  removeFilterToken,
  getFiltersForCategory,
  loadConversionRatesIntoDb,
  getConversionRateFromDb,
  loadCategoryPatternsIntoDb,
  getCategoryPatternsFromDb,
};
