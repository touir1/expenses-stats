# TODO

## Bugs

- [x] **`csv.util.js` — unclosed quotes silently misparse**: inner while exits on `i >= line.length` without finding closing quote, absorbing commas into the field and producing wrong column counts — now throws `Malformed CSV: unclosed quoted field`
- [x] **`update-rates.script.js` — HTTP status never checked**: API 4xx/5xx responses were parsed as JSON and crashed cryptically — now rejects with HTTP status before parsing
- [x] **`pipeline-date-range.script.js` — date validation is format-only**: `32/13/2026` passed `validateDateFormat()` — now uses `new Date()` round-trip to catch impossible calendar dates
- [x] **Inconsistent date padding across codebase**: `toISODate` and `toComparableString` in `date.util.js`, `getExpensesFromDb` params in `db.util.js`, and `monthKey` in `stats.script.js` were missing `.padStart(2,'0')` — all fixed

## Inconsistencies

- [ ] **Conversion rate fallback differs between modes**: CSV mode falls back to earliest available rate; DB mode returns nothing — same date range produces different totals
- [ ] **`readCSV()` vs `readCSVLines()` return different shapes**: scripts pick whichever was convenient, making maintenance fragile

## Dead Code

- [ ] **`update-rates.script.js:77` — `getMonthDates()`**: defined, never called; comment says "kept for compatibility"
- [ ] **`db.util.js` — `insertExpense()` (singular)**: exported but only `insertExpensesBatch()` is ever used

## Missing Error Handling

- [ ] **`parser.script.js` — `fs.readFileSync` uncaught**: crashes with raw Node error instead of user-friendly message
- [ ] **`data.util.js` — `JSON.parse` uncaught in `readJSON()`**: malformed config files produce cryptic errors
- [ ] **`db-insert.script.js` — `db.close()` errors silently ignored**

## Performance

- [ ] **`db-insert.script.js` — full table pre-load**: entire `expenses` and `categories` tables loaded into memory before processing; will OOM on large datasets
- [ ] **`db.util.js:517` — N+1 queries in `loadCategoryPatternsIntoDb()`**: one `SELECT id FROM categories` per pattern; should pre-load the map once
- [ ] **Missing DB index on `expenses.date`**: date-range queries do full table scans; add composite `(date, category_id)` index

## Features

- [ ] **Incremental parsing**: parser re-reads entire `depenses.txt` every run; track last-processed line and only parse new entries
- [ ] **Duplicate detection script**: hashes exist in DB but no `show-duplicates.js` to surface what would be skipped on next insert
- [ ] **Rate usage audit**: no report of which dates had missing conversion rates or which fallback was applied
- [ ] **Empty description validation**: parser accepts blank descriptions, producing uncategorizable rows
- [ ] **`stats.script.js` drops categories beyond 2 levels**: `exp.category.split('/')` only takes `[mainCat, subCat]` (line 259) — a 3rd level is silently ignored in all output
- [ ] **Category totals use a single average rate**: `byCategory` computes one average across all rates (line 302–308) while `byMonth` uses per-date rates — same data, different rate logic, diverging totals
- [ ] **Forced categories (hash-based) never applied**: `pipeline.script.js` passes `--forced-categories-file` to `label.script.js` but `label.script.js` doesn't declare that flag — `parseArgs` silently drops it. `label.script.js` only runs description-substring matching from `category-patterns.config.json`; the hash+date system in `forced_categorizations` DB table is never consulted during labeling

## Architecture

- [ ] **`stats.script.js` duplicates calculation logic**: CSV and DB modes diverge completely but compute the same output structure; a data-source abstraction would let both share one calculation pass
- [ ] **`pipeline.script.js` hardcodes paths instead of using `getDefaultPaths()`**: lines 84–87 build paths manually (`path.join(__dirname, '..', '..', 'data', ...)`) instead of reading from `path-resolver.util.js`; breaks if paths change
- [ ] **`FORCED_CATEGORIES.md` is internally contradictory**: two conflicting system descriptions — one hash-based (`getForcedCategoryFromDb(db, hash, date)`), one description-based (`getForcedCategoryFromDb(db, date, description, currency, amount)`) — result of unresolved docs drift; needs a single authoritative description matching the actual implementation

## Missing Scripts

- [ ] **`check-forced.js` referenced in docs but does not exist**: `FORCED_CATEGORIES.md` documents `node src/scripts/check-forced.js --list` and `check-forced.js "HASH" "DATE"` — script is missing entirely
