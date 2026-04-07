# Label Validation Plan

> **Status: implemented** (2026-04-07)

## Motivation

The current DB pipeline inserts expenses **already labeled** by the auto-categorizer. The label is treated as final at insert time, meaning any mis-categorization silently enters the database. This plan introduces a **user validation gate** between label guessing and DB commit: labels are guesses until the user reviews and confirms them.

---

## New data flow (DB mode)

```
depenses.txt
    ↓ parser.script.js
depenses.csv
    ↓ db-insert.script.js  [MODIFIED — inserts without category_id]
depenses.db (expenses.category_id = NULL)
    ↓ generate-validation.script.js  [NEW]
depenses-validation.csv  ←── user edits this file (confirm/correct labels)
    ↓ apply-labels.script.js  [NEW]
depenses.db (expenses.category_id populated for validated rows)
    ↓ stats.script.js
depenses-stats.json
```

The CSV-only pipeline (no `--use-database`) is **not affected** — `label.script.js` and `depenses-labeled.csv` remain as-is.

---

## Validation file format

`data/processed/depenses-validation.csv`

| Column | Description |
|--------|-------------|
| `hash` | SHA hash from `hash.util.js` — stable identifier |
| `date` | `DD/MM/YYYY` |
| `description` | Free text |
| `amount` | Decimal |
| `currency_code` | `EUR` or `TND` |
| `suggested_category` | Auto-guessed label (read-only reference) |
| `category` | **User-editable field** — pre-filled with the guess; user corrects here |

The user edits only the `category` column. Any row left unchanged keeps the suggested value. The `apply-labels.script.js` reads `category`, not `suggested_category`.

Rows already validated in a previous run are excluded from regeneration (unless `--all` is passed).

---

## Changes required

### 1. `src/utils/path-resolver.util.js`

Add one new default path:

```js
validationFile: path.join(root, 'data', 'processed', 'depenses-validation.csv'),
```

### 2. `src/scripts/db-insert.script.js` — modified

- Accept input CSV **with or without** a `category` column.
- When `category` column is absent (or `--skip-labels` flag is set): insert rows with `category_id = NULL`.
- Remove the hard failure on missing `categoryId` — log a warning and insert with `NULL` instead.
- The dedup logic (hash + date) remains unchanged.

New CLI flag: `--skip-labels` (boolean) — forces `category_id = NULL` even if a `category` column is present.

### 3. `src/scripts/generate-validation.script.js` — new

Queries the DB for expenses where `category_id IS NULL`, runs the same label-guessing logic as `label.script.js` (forced categories first, then token scoring), and writes the validation CSV.

```
Usage: node generate-validation.script.js [options]

Options:
  --database <path>              SQLite DB file (default: data/database/depenses.db)
  --categories-file <path>       Categories config (default: config/categories.config.json)
  --forced-categories-file <path>
  --output-file <path>           Validation CSV (default: data/processed/depenses-validation.csv)
  --all                          Include already-validated rows (category_id IS NOT NULL) too
```

Output: writes `depenses-validation.csv` sorted by date ascending. If the file already exists, **appends only new rows** (matched by hash + date) so prior edits are preserved.

### 4. `src/scripts/apply-labels.script.js` — new

Reads the (user-edited) validation CSV and issues `UPDATE expenses SET category_id = ? WHERE hash = ? AND date = ?` for each row.

```
Usage: node apply-labels.script.js [options]

Options:
  --input-file <path>            Validation CSV (default: data/processed/depenses-validation.csv)
  --database <path>              SQLite DB file (default: data/database/depenses.db)
  --categories-file <path>       Needed to resolve category label → category_id
  --dry-run                      Print what would be updated without writing to DB
```

Behaviour:
- Skips rows where `category` column is empty or `other` — warns and leaves `category_id = NULL`.
- Reports per-category counts of updates.
- Reports rows where the label in the CSV does not match any known category (user typo).

### 5. `src/scripts/pipeline.script.js` — modified

**Default DB behaviour (no extra flags needed):** when `--use-database` is active, the pipeline always passes `--skip-labels` to `db-insert.script.js`. Labels are never committed at insert time — validation is mandatory, not opt-in.

Pipeline stages when `--use-database` is set:

```
Step 1: Parse          (parser.script.js)
Step 2: Label          (label.script.js → depenses-labeled.csv, kept for CSV mode)
Step 3: DB Insert      (db-insert.script.js --skip-labels)  ← always skip-labels in DB mode
Step 4: Gen Validation (generate-validation.script.js)
  → pipeline exits here and prints instructions to edit the validation file
```

A second invocation (or a dedicated npm script) completes the flow:

```
Step 1: Apply Labels   (apply-labels.script.js)
Step 2: Stats          (stats.script.js --use-database)
```

Escape hatch: `--force-labels` flag on the pipeline bypasses the default and passes the labeled CSV's categories directly into `db-insert.script.js` (restores old behaviour for scripted/automated use).

### 6. `src/utils/db.util.js` — minor

Add a helper `updateExpenseCategory(db, hash, date, categoryId)` that issues the UPDATE used by `apply-labels.script.js`. Also add `getUnlabeledExpenses(db)` that SELECTs rows where `category_id IS NULL`.

---

## DB schema changes

No structural schema change is required — `expenses.category_id` is already nullable (no `NOT NULL` constraint). Rows inserted without a category simply have `category_id = NULL` until `apply-labels.script.js` populates them.

Stats queries must be reviewed to handle `category_id IS NULL` rows gracefully (exclude them or count them as "unvalidated").

---

## New npm scripts

```jsonc
// package.json additions
"db:insert":          "node src/scripts/db-insert.script.js --skip-labels",
"db:gen-validation":  "node src/scripts/generate-validation.script.js",
"db:apply-labels":    "node src/scripts/apply-labels.script.js",
"db:apply-labels:dry":"node src/scripts/apply-labels.script.js --dry-run",
"db:validate":        "npm run db:gen-validation && echo 'Edit data/processed/depenses-validation.csv, then run npm run db:apply-labels'",
```

### Typical workflow

`--skip-labels` is implicit whenever `--use-database` is active in the pipeline. No extra flag needed.

```bash
# First pass: parse, insert raw, generate validation file
npm run pipeline -- --use-database
#    → pipeline exits after Step 4 with instructions
#    → edit data/processed/depenses-validation.csv (confirm/fix the `category` column)

# Second pass: apply validated labels then generate stats
npm run db:apply-labels
npm run stats -- --use-database
```

To restore old behaviour (skip validation, commit labels immediately):

```bash
npm run pipeline -- --use-database --force-labels
```

---

## Incremental runs

On subsequent runs (new expenses added to depenses.txt):

1. Re-parse and re-insert raw — dedup skips existing rows, only new ones get `category_id = NULL`.
2. `generate-validation.script.js` appends only the new unlabeled rows to the existing validation file.
3. User edits just the newly appended rows.
4. `apply-labels.script.js` updates only those rows (skips already-labeled ones).

---

## Out of scope

- A TUI/interactive editor for the validation file — the plain CSV is intentional; use any spreadsheet tool.
- Changing category of an already-validated expense — out of scope for this flow; needs a separate `relabel` command.
- Applying this validation gate to the CSV-only pipeline.
