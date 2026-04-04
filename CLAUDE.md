# CLAUDE.md — depenses_stats

Node.js expense analysis tool: parse text → CSV → label categories → filter → stats. Currencies: EUR (€) and TND (dt).

## Directory layout

```
config/
  categories.config.json       # Hierarchical category definitions (token-based matching)
  category-patterns.config.json# Regex/pattern overrides for labeling
  forced-categories.config.json# Explicit hash→category overrides
  filters.config.json          # Named filter registry (keys used by --filter)
  filters/                     # Individual filter definition files (generated at runtime)
data/
  raw/depenses.txt             # Source input (hand-written expense log)
  processed/depenses.csv       # Parsed output
  processed/depenses-labeled.csv # After label.script.js
  processed/conversion-rates.csv # EUR↔TND rates by date
  database/depenses.db         # SQLite (optional DB mode)
docs/                          # Extended docs (FILTER_GUIDE, FORCED_CATEGORIES, data-schema, SETUP_SUMMARY)
output/                        # Stats JSON + filtered CSVs (gitignored)
src/
  scripts/                     # Runnable entry points (see below)
  utils/                       # Shared modules (see below)
```

## Scripts (`src/scripts/`)

| File | Purpose |
|------|---------|
| `pipeline.script.js` | Full run: parse → label → [filter] → stats |
| `pipeline-date-range.script.js` | Same but with `--begin-date`/`--end-date` |
| `parser.script.js` | `depenses.txt` → `depenses.csv` (adds hash column) |
| `label.script.js` | Adds `category` column via token matching |
| `filter.script.js` | Filters CSV rows (GraphQL-style operators or date range) |
| `stats.script.js` | Generates JSON + console stats; supports DB mode |
| `db-insert.script.js` | Loads labeled CSV into SQLite |
| `update-rates.script.js` | Fetches EUR↔TND rates from frankfurter.dev API |
| `category-details.script.js` | Drill-down stats for a specific category |
| `list-other.script.js` | Lists rows with `category = "other"` (for finding new tokens) |

## Utils (`src/utils/`)

| File | Exports / Role |
|------|---------------|
| `path-resolver.util.js` | **Single source of truth for all default paths.** `getDefaultPaths()` returns all standard file paths. Always update here when paths change. |
| `cli-args.util.js` | `parseArgs(argv, optionDefs)` — lightweight arg parser |
| `console-output.util.js` | `logSuccess/logError/logWarning/logInfo`, `colors` |
| `csv.util.js` | `parseCSVLine()` — handles quoted fields |
| `data.util.js` | `readCSV`, `readCSVLines`, `writeCSVRaw`, `readJSON`, `fileExists` |
| `date.util.js` | `toComparableString(dd/mm/yyyy)` for date comparisons |
| `db.util.js` | All SQLite operations — schema init, insert, query |
| `filtering.util.js` | `matchesFilter(value, condition, columnName)` — all filter operators |
| `hash.util.js` | `hashExpense(description, currencyCode, amount)` — dedup key |
| `process-runner.util.js` | `runCommand(scriptPath, args, opts)` — spawns child node processes |
| `rate-manager.util.js` | `ensureRatesUpdated()` — checks CSV freshness, auto-updates |
| `conversion-rates.util.js` | Rate lookup logic, `DEFAULT_RATE` fallback |
| `text.util.js` | `normalizeStr()` (accent-insensitive), `countTokenMatches()` |

## npm scripts

```bash
npm run pipeline                    # Full pipeline
npm run pipeline:quick              # Skip parsing
npm run pipeline:car|eur|tnd|food|transport  # With named filter
npm run pipeline:date-range -- --begin-date "01/03/2026" --end-date "31/03/2026"
npm run stats                       # Stats only
npm run list:other                  # Inspect uncategorized rows
npm run update-rates                # Refresh conversion-rates.csv
npm run db:insert                   # Load into SQLite
```

## Key conventions

- **Naming**: kebab-case for all files and directories; config files use `.config.json` suffix
- **Paths**: never hardcode paths in scripts — use `getDefaultPaths()` from `path-resolver.util.js` or pass via CLI args
- **Filter flow**: `filters.config.json` → pipeline reads definition → writes temp file to `config/filters/filter-{key}.json` → passes to `filter.script.js`
- **Category matching**: token-based, word-boundary, accent-insensitive, case-insensitive (`text.util.js`)
- **Hashing**: each expense gets a SHA-based hash from (description, currency, amount) for dedup in DB mode
- **DB mode**: enabled with `--use-database`; filters and date ranges applied in SQL instead of CSV pipeline

## CSV column schema

`amount, currency_symbol, currency_code, date, description, hash[, category]`
- `date` format: `DD/MM/YYYY`
- `currency_symbol`: `€` or `dt`
- `currency_code`: `EUR` or `TND`

See `docs/data-schema.md` for config file formats and filter operator reference.
