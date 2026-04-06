const sqlite3 = require('sqlite3').verbose();
const { hashExpense } = require('./hash.util');
const { DEFAULT_RATE } = require('./conversion-rates.util');

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
        db.run('DROP TABLE IF EXISTS category_filter_tokens', () => {});
        db.run('DROP TABLE IF EXISTS category_filters', () => {});
        db.run('DROP TABLE IF EXISTS category_patterns', () => {});
        db.run('DROP TABLE IF EXISTS forced_categorizations', () => {}); // legacy, kept for safe drop
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
        CREATE TABLE IF NOT EXISTS category_filters (
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
        CREATE TABLE IF NOT EXISTS category_filter_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filter_id INTEGER NOT NULL,
          token TEXT NOT NULL,
          word INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (filter_id) REFERENCES category_filters(id) ON DELETE CASCADE,
          UNIQUE(filter_id, token)
        )
      `, (err) => { if (err) reject(err); });

      db.run(`CREATE INDEX IF NOT EXISTS idx_category_filter_tokens_filter ON category_filter_tokens (filter_id)`
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
          hash TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id)
        )
      `, (err) => { if (err) reject(err); });

      // Index on hash for fast dedup lookups
      db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_hash ON expenses (hash)`
        , (err) => { if (err) reject(err); });



      // Index for category-based grouping and reporting
      db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category_id)`
        , (err) => { if (err) reject(err); });

      // Composite index for date-range queries (covers date filter + category join)
      db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_date_category ON expenses (date, category_id)`
        , (err) => { if (err) reject(err); });

      // Index for FK lookups: category_filters by category (SQLite does not auto-index FK columns)
      db.run(`CREATE INDEX IF NOT EXISTS idx_category_filters_category ON category_filters (category_id)`
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
          description_pattern TEXT NOT NULL,
          date TEXT,
          amount REAL,
          currency TEXT,
          word INTEGER NOT NULL DEFAULT 0,
          category_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
          UNIQUE(description_pattern, date, amount, currency)
        )
      `, (err) => { if (err) reject(err); });

      // Index for nearest-prior-date lookup on conversion_rates
      db.run(`CREATE INDEX IF NOT EXISTS idx_conversion_rates_lookup ON conversion_rates (base, quote, date)`
        , (err) => { if (err) reject(err); });

      // Index for FK lookups: category_patterns by category
      db.run(`CREATE INDEX IF NOT EXISTS idx_category_patterns_category ON category_patterns (category_id)`
        , (err) => { if (err) reject(err); });

      db.run(`CREATE INDEX IF NOT EXISTS idx_category_patterns_description ON category_patterns (description_pattern)`
        , (err) => { if (err) reject(err); else resolve(); });
    });
  });
}

// Flatten category hierarchy into a list for batch insertion
function flattenCategories(categories, parentLabel = null) {
  const flat = [];
  for (const cat of categories) {
    const label = parentLabel ? `${parentLabel}/${cat.name}` : cat.name;
    flat.push({
      name: cat.name,
      label,
      parentLabel,
      filters: cat.filters || {}
    });
    if (cat.subcategories && cat.subcategories.length > 0) {
      flat.push(...flattenCategories(cat.subcategories, label));
    }
  }
  return flat;
}

// Insert categories and their filters into the database using batch transactions
function loadCategoriesIntoDb(db, categories) {
  return new Promise((resolve, reject) => {
    if (categories.length === 0) { resolve(); return; }

    // Flatten the hierarchical structure
    const flatCategories = flattenCategories(categories);

    // Phase 1: Insert all categories in a single transaction
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // flattenCategories returns parents before children. Within serialize(),
      // each db.run() executes sequentially, so each parent row exists in the DB
      // before its child's INSERT runs. The subquery resolves parent_id at insert time.
      const labelToId = {};
      let catError = null;

      for (const cat of flatCategories) {
        db.run(
          'INSERT OR REPLACE INTO categories (name, parent_id, label) VALUES (?, (SELECT id FROM categories WHERE label = ?), ?)',
          [cat.name, cat.parentLabel || null, cat.label],
          function(err) {
            if (err) {
              console.error(`Error inserting category ${cat.label}:`, err.message);
              catError = err;
            }
          }
        );
      }

      // After all inserts, fetch the id map in one query
      db.all('SELECT id, label FROM categories', (err, rows) => {
        if (err || catError) {
          db.run('ROLLBACK');
          reject(err || catError);
          return;
        }
        (rows || []).forEach(r => { labelToId[r.label] = r.id; });

        // Phase 2: Insert all filters and tokens in a single transaction
        const filterStmt = db.prepare(
          'INSERT INTO category_filters (category_id, column_name, operator, filter_value) VALUES (?, ?, ?, ?)'
        );

        const tokenStmt = db.prepare(
          'INSERT INTO category_filter_tokens (filter_id, token, word) VALUES (?, ?, ?)'
        );

        let filterInsertCount = 0;
        let tokenInsertCount = 0;

        for (const cat of flatCategories) {
          const categoryId = labelToId[cat.label];
          if (!categoryId) continue;

          const filterEntries = Object.entries(cat.filters);
          for (const [colName, condition] of filterEntries) {
            for (const [operator, value] of Object.entries(condition)) {
              const isTokens = operator === 'tokens' && Array.isArray(value);
              const filterValue = isTokens ? null : (typeof value === 'object' ? JSON.stringify(value) : String(value));

              filterStmt.run([categoryId, colName, operator, filterValue], function(err) {
                if (err) {
                  console.error(`Error inserting filter for ${cat.label}:`, err.message);
                  return;
                }

                filterInsertCount++;

                // Insert tokens if applicable
                if (isTokens && value.length > 0) {
                  const filterId = this.lastID;
                  for (const tokenDef of value) {
                    const token = typeof tokenDef === 'string' ? tokenDef : tokenDef.token;
                    const word  = typeof tokenDef === 'string' ? 1 : (tokenDef.word !== false ? 1 : 0);
                    tokenStmt.run([filterId, token, word], (err) => {
                      if (err) console.error(`Error inserting token "${token}":`, err.message);
                      else tokenInsertCount++;
                    });
                  }
                }
              });
            }
          }
        }

        filterStmt.finalize((err) => {
          if (err) {
            db.run('ROLLBACK');
            reject(err);
            return;
          }

          tokenStmt.finalize((err) => {
            if (err) {
              db.run('ROLLBACK');
              reject(err);
              return;
            }

            db.run('COMMIT', (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        });
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

// Bulk insert expenses in a single transaction using a prepared statement.
// Much faster than sequential individual inserts.
// rows: array of { amount, currency_symbol, currency_code, date, description, category_id }
function insertExpensesBatch(db, rows) {
  return new Promise((resolve, reject) => {
    if (rows.length === 0) { resolve(0); return; }
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(
        'INSERT INTO expenses (amount, currency_symbol, currency_code, date, description, category_id, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const r of rows) {
        const hash = hashExpense(r.description, r.currency_code, parseFloat(r.amount));
        stmt.run([parseFloat(r.amount), r.currency_symbol, r.currency_code, r.date, r.description, r.category_id, hash]);
      }
      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve(rows.length);
      });
    });
  });
}

// Load all categories (label → id mapping) for faster lookups.
function getAllCategoriesAsMap(db) {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, label FROM categories', (err, rows) => {
      if (err) { reject(err); return; }
      const map = {};
      (rows || []).forEach(r => { map[r.label] = r.id; });
      resolve(map);
    });
  });
}

// Pre-fetch all existing expense hashes for deduplication.
// Returns map: hash -> count
function getAllExpensesAsMap(db) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT hash, COUNT(*) as count FROM expenses WHERE hash IS NOT NULL GROUP BY hash',
      (err, rows) => {
        if (err) { reject(err); return; }
        const map = {};
        (rows || []).forEach(r => {
          map[r.hash] = r.count;
        });
        resolve(map);
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
    db.all('SELECT id, token, word FROM category_filter_tokens WHERE filter_id = ? ORDER BY token', [filterId], (err, rows) => {
      if (err) reject(err);
      else resolve((rows || []).map(r => ({ id: r.id, token: r.token, word: !!r.word })));
    });
  });
}

// Add a token to an existing filter
function addFilterToken(db, filterId, token, word = true) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO category_filter_tokens (filter_id, token, word) VALUES (?, ?, ?)', [filterId, token, word ? 1 : 0], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

// Remove a token from a filter by token text
function removeFilterToken(db, filterId, token) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM category_filter_tokens WHERE filter_id = ? AND token = ?', [filterId, token], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}



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
// Falls back to earliest available rate, then DEFAULT_RATE — matching getRateForDate() semantics.
function getConversionRateFromDb(db, dateStr, base = 'EUR', quote = 'TND') {
  return new Promise((resolve, reject) => {
    const parts = dateStr.split('/');
    if (parts.length !== 3) { resolve(DEFAULT_RATE); return; }
    const isoDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    db.get(
      `SELECT rate FROM (
         SELECT rate, date FROM conversion_rates WHERE base = ? AND quote = ? AND date <= ? ORDER BY date DESC LIMIT 1
         UNION ALL
         SELECT rate, date FROM conversion_rates WHERE base = ? AND quote = ? ORDER BY date ASC LIMIT 1
       ) LIMIT 1`,
      [b, q, isoDate, b, q],
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
async function loadCategoryPatternsIntoDb(db, patterns) {
  if (patterns.length === 0) return;

  // Pre-load all categories in one query instead of one SELECT per pattern
  const categoryMap = await getAllCategoriesAsMap(db);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO category_patterns (description_pattern, date, amount, currency, word, category_id) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const p of patterns) {
        const categoryId = categoryMap[p.category];
        if (!categoryId) {
          console.warn(`  ⚠ Category not found for pattern "${p.description}": ${p.category}`);
          continue;
        }
        stmt.run([
          p.description,
          p.date || null,
          p.amount != null ? parseFloat(p.amount) : null,
          p.currency ? p.currency.toUpperCase() : null,
          p.word ? 1 : 0,
          categoryId
        ]);
      }
      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Get all category patterns, joined with their category label.
// Ordered longest-pattern-first (same priority as label.script.js matching logic).
function getCategoryPatternsFromDb(db) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT cp.id, cp.description_pattern, cp.date, cp.amount, cp.currency, cp.word, c.label AS category_label
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
              group_concat(ft.token || ':' || ft.word, '|') AS tokens
       FROM category_filters f
       LEFT JOIN category_filter_tokens ft ON ft.filter_id = f.id
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
          tokens: r.tokens
            ? r.tokens.split('|').map(t => { const [tok, w] = t.split(':'); return { token: tok, word: w === '1' }; })
            : [],
        })));
      }
    );
  });
}

// Fetch all expenses with their category label, optionally filtered by date range.
// beginDate / endDate in DD/MM/YYYY format.
// Returns array of { amount, currency_code, currency_symbol, date, description, category }.
function getExpensesFromDb(db, { beginDate, endDate } = {}) {
  return new Promise((resolve, reject) => {
    const conditions = [];
    const params = [];

    if (beginDate) {
      const [bd, bm, by] = beginDate.split('/');
      conditions.push("(substr(e.date,7,4)||substr(e.date,4,2)||substr(e.date,1,2)) >= ?");
      params.push(`${by}${bm.padStart(2, '0')}${bd.padStart(2, '0')}`);
    }
    if (endDate) {
      const [ed, em, ey] = endDate.split('/');
      conditions.push("(substr(e.date,7,4)||substr(e.date,4,2)||substr(e.date,1,2)) <= ?");
      params.push(`${ey}${em.padStart(2, '0')}${ed.padStart(2, '0')}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT e.amount, e.currency_code, e.currency_symbol, e.date, e.description,
             c.label AS category
      FROM expenses e
      LEFT JOIN categories c ON c.id = e.category_id
      ${where}
      ORDER BY substr(e.date,7,4)||substr(e.date,4,2)||substr(e.date,1,2)
    `;

    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Load all conversion rates for a given pair into a { 'YYYY-MM-DD': rate } map.
// Same format returned by loadConversionRates() from conversion-rates.util.js,
// so getRateForDate() works with it directly.
function getConversionRatesMapFromDb(db, base = 'EUR', quote = 'TND') {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT date, rate FROM conversion_rates WHERE base = ? AND quote = ? ORDER BY date',
      [base.toUpperCase(), quote.toUpperCase()],
      (err, rows) => {
        if (err) reject(err);
        else {
          const map = {};
          (rows || []).forEach(r => { map[r.date] = r.rate; });
          resolve(map);
        }
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
  insertExpensesBatch,
  getRowCount,
  getFilterTokens,
  addFilterToken,
  removeFilterToken,
  getFiltersForCategory,
  loadConversionRatesIntoDb,
  getConversionRateFromDb,
  getConversionRatesMapFromDb,
  loadCategoryPatternsIntoDb,
  getCategoryPatternsFromDb,
  getAllCategoriesAsMap,
  getAllExpensesAsMap,
  getExpensesFromDb,
  hashExpense
};
