# TODO

## Bugs

- [ ] **`csv.js` — infinite loop on unclosed quotes**: `parseCSVLine` while loop never breaks on malformed input like `"unclosed,value`
- [ ] **`update-rates.js` — HTTP status never checked**: API 4xx/5xx responses are parsed as JSON and crash cryptically
- [ ] **`pipeline-date-range.js` — date validation is format-only**: `32/13/2026` passes `validateDateFormat()` and causes silent downstream failures
- [ ] **Inconsistent date padding across codebase**: `date-utils.js`, `db.js`, and `stats.js` each implement DD/MM/YYYY→ISO conversion differently; some missing `.padStart(2,'0')` causing mismatched rate lookups

## Inconsistencies

- [ ] **Conversion rate fallback differs between modes**: CSV mode falls back to earliest available rate; DB mode returns nothing — same date range produces different totals
- [ ] **`readCSV()` vs `readCSVLines()` return different shapes**: scripts pick whichever was convenient, making maintenance fragile

## Dead Code

- [ ] **`update-rates.js:77` — `getMonthDates()`**: defined, never called; comment says "kept for compatibility"
- [ ] **`db.js` — `insertExpense()` (singular)**: exported but only `insertExpensesBatch()` is ever used

## Missing Error Handling

- [ ] **`parser.js` — `fs.readFileSync` uncaught**: crashes with raw Node error instead of user-friendly message
- [ ] **`data.js` — `JSON.parse` uncaught in `readJSON()`**: malformed config files produce cryptic errors
- [ ] **`db-insert.js` — `db.close()` errors silently ignored**

## Performance

- [ ] **`db-insert.js` — full table pre-load**: entire `expenses` and `categories` tables loaded into memory before processing; will OOM on large datasets
- [ ] **`db.js:517` — N+1 queries in `loadCategoryPatternsIntoDb()`**: one `SELECT id FROM categories` per pattern; should pre-load the map once
- [ ] **Missing DB index on `expenses.date`**: date-range queries do full table scans; add composite `(date, category_id)` index

## Features

- [ ] **Incremental parsing**: parser re-reads entire `depenses.txt` every run; track last-processed line and only parse new entries
- [ ] **Duplicate detection script**: hashes exist in DB but no `show-duplicates.js` to surface what would be skipped on next insert
- [ ] **Rate usage audit**: no report of which dates had missing conversion rates or which fallback was applied
- [ ] **Empty description validation**: parser accepts blank descriptions, producing uncategorizable rows
- [ ] **Forced categories not applied in DB mode**: `forced-categories.config.json` only used by `label.js` (CSV path), ignored entirely with `--use-database`

## Architecture

- [ ] **`stats.js` duplicates calculation logic**: CSV and DB modes diverge completely but compute the same output structure; a data-source abstraction would let both share one calculation pass
