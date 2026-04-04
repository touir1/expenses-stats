# src/ — Source Context

See root `CLAUDE.md` for full project map. This file covers internal conventions for `scripts/` and `utils/`.

## Data flow

```
depenses.txt → parser.js → depenses.csv
                              ↓
                           label.js (uses categories.config.json + forced-categories.config.json)
                              ↓
                         depenses-labeled.csv
                              ↓
                  filter.js (optional) → depenses-{key}-filtered.csv
                              ↓
                           stats.js → depenses-stats.json
```

DB mode bypasses filter.js — date/filter logic moves into SQL via `db.js`.

## Adding a path default

All default paths live in `utils/path-resolver.js → getDefaultPaths()`. Add there first; scripts read from it via `getDefaultPaths()` or accept CLI override via `resolvePath()`.

## Adding a filter operator

Add a `case` in `utils/filtering.js → matchesFilter()`. Both `filter.js` (CSV) and `stats.js` (DB-mode post-processing) use this function.

## Adding a category

Edit `config/categories.config.json`. Token matching is word-boundary + accent-insensitive (via `utils/text.js → normalizeStr`). No code change needed — re-run `npm run pipeline:quick`.

## Adding a named filter

Edit `config/filters.config.json`. Pipelines write the resolved definition to `config/filters/filter-{key}.json` at runtime before passing it to `filter.js`.

## Script→util dependency map

```
pipeline.js          → process-runner, rate-manager, cli-args
pipeline-date-range  → process-runner, rate-manager, cli-args, console-output
parser.js            → cli-args, path-resolver, console-output, hash
label.js             → cli-args, path-resolver, data, text, console-output
filter.js            → cli-args, path-resolver, data, csv, filtering, text
stats.js             → cli-args, path-resolver, data, db, conversion-rates, filtering, console-output
db-insert.js         → cli-args, path-resolver, data, db, console-output
update-rates.js      → cli-args, path-resolver, db, console-output
category-details.js  → cli-args, path-resolver, data, console-output
list-other.js        → cli-args, path-resolver, data
```
