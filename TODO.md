# TODO

## Bugs

- [x] **`csv.util.js` — unclosed quotes silently misparse**: inner while exits on `i >= line.length` without finding closing quote, absorbing commas into the field and producing wrong column counts — now throws `Malformed CSV: unclosed quoted field`
- [x] **`update-rates.script.js` — HTTP status never checked**: API 4xx/5xx responses were parsed as JSON and crashed cryptically — now rejects with HTTP status before parsing
- [x] **`pipeline-date-range.script.js` — date validation is format-only**: `32/13/2026` passed `validateDateFormat()` — now uses `new Date()` round-trip to catch impossible calendar dates
- [x] **Inconsistent date padding across codebase**: `toISODate` and `toComparableString` in `date.util.js`, `getExpensesFromDb` params in `db.util.js`, and `monthKey` in `stats.script.js` were missing `.padStart(2,'0')` — all fixed

## Inconsistencies

- [x] **Conversion rate fallback differs between modes**: CSV mode falls back to earliest available rate; DB mode returns nothing — `getConversionRateFromDb` now uses a UNION query to try nearest-prior then earliest available, matching `getRateForDate()` semantics
- [x] **`readCSV()` vs `readCSVLines()` return different shapes**: `readCSVLines` now returns `{ headers, headerLine, lines, columnMap }` where `lines` is data-only (no header row); callers updated to use `headerLine` for re-serialization and iterate `lines` directly
- [ ] **`filter.script.js` uses bare `console.log` for output summary**: lines 182–190 use `console.log` directly instead of `logSuccess`/`logWarning` from `console-output.util.js`, inconsistent with every other script

## Dead Code

- [x] **`update-rates.script.js:77` — `getMonthDates()`**: defined, never called; comment says "kept for compatibility"
- [x] **`db.util.js` — `insertExpense()` (singular)**: exported but only `insertExpensesBatch()` is ever used

## Missing Error Handling

- [x] **`parser.script.js` — `fs.readFileSync` uncaught**: crashes with raw Node error instead of user-friendly message
- [x] **`data.util.js` — `JSON.parse` uncaught in `readJSON()`**: malformed config files produce cryptic errors
- [x] **`db-insert.script.js` — `db.close()` errors silently ignored**
- [x] **`main()` missing `.catch()` in most entry-point scripts**: `category-details.script.js`, `generate-validation.script.js`, `apply-labels.script.js`, `db-insert.script.js`, `pipeline-date-range.script.js`, and `pipeline.script.js` all call `main()` bare — on Node ≥ 15 an unhandled rejection terminates silently without printing the error (compare: `query.script.js` and `stats.script.js` already use `main().catch(...)`)

## Performance

- [x] **`db-insert.script.js` — full table pre-load**: entire `expenses` and `categories` tables loaded into memory before processing; will OOM on large datasets
- [x] **`db.util.js:517` — N+1 queries in `loadCategoryPatternsIntoDb()`**: one `SELECT id FROM categories` per pattern; should pre-load the map once
- [x] **Missing DB index on `expenses.date`**: date-range queries do full table scans; add composite `(date, category_id)` index

## Features

- [ ] **Incremental parsing**: parser re-reads entire `depenses.txt` every run; track last-processed line and only parse new entries
- [ ] **Duplicate detection script**: hashes exist in DB but no `show-duplicates.js` to surface what would be skipped on next insert
- [ ] **Rate usage audit**: no report of which dates had missing conversion rates or which fallback was applied
- [ ] **Empty description validation**: parser accepts blank descriptions, producing uncategorizable rows
- [ ] **`stats.script.js` drops categories beyond 2 levels**: `exp.category.split('/')` only takes `[mainCat, subCat]` (line 259) — a 3rd level is silently ignored in all output
- [ ] **Category totals use a single average rate**: `byCategory` computes one average across all rates (line 302–308) while `byMonth` uses per-date rates — same data, different rate logic, diverging totals
- [x] **Forced categories flag silently ignored**: `pipeline.script.js` passes `--forced-categories-file` to `label.script.js` but `label.script.js` didn't declare that flag — now declared and wired to `forced-categories.config.json`; `category-patterns.config.json` removed and its entries merged into `forced-categories.config.json`

## Architecture

- [x] **`stats.script.js` duplicates calculation logic**: CSV and DB modes diverge completely but compute the same output structure; a data-source abstraction would let both share one calculation pass
- [x] **`pipeline.script.js` hardcodes paths instead of using `getDefaultPaths()`**: lines 84–87 build paths manually (`path.join(__dirname, '..', '..', 'data', ...)`) instead of reading from `path-resolver.util.js`; breaks if paths change
- [x] **`FORCED_CATEGORIES.md` is internally contradictory**: rewrote to match actual implementation — description-substring matching, `category_patterns` table, no hash/date-based lookup
- [ ] **`pipeline-date-range.script.js` hardcodes paths instead of using `getDefaultPaths()`**: lines 111–114, 122, 152, 163, 169, 172, 187 all use `path.join(__dirname, '..', '..', ...)` directly — the same fix already applied to `pipeline.script.js` was never applied here

## Missing Scripts

- [x] **`check-forced.js` referenced in docs but does not exist**: removed from docs — the old hash-based system it belonged to no longer exists; forced categories are managed via `config/forced-categories.config.json` directly
