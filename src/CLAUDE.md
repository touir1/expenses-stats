# src/ — Source Context

See root `CLAUDE.md` for full project map. This file covers internal conventions for `scripts/` and `utils/`.

## Data flow

```
depenses.txt → parser.script.js → depenses.csv
                                      ↓
                           label.script.js (uses categories.config.json + forced-categories.config.json)
                                      ↓
                                 depenses-labeled.csv
                                      ↓
                  filter.script.js (optional) → depenses-{key}-filtered.csv
                                      ↓
                           stats.script.js → depenses-stats.json
```

DB mode bypasses filter.script.js — date/filter logic moves into SQL via `db.util.js`.

## Adding a path default

All default paths live in `utils/path-resolver.util.js → getDefaultPaths()`. Add there first; scripts read from it via `getDefaultPaths()` or accept CLI override via `resolvePath()`.

## Adding a filter operator

Add a `case` in `utils/filtering.util.js → matchesFilter()`. Both `filter.script.js` (CSV) and `stats.script.js` (DB-mode post-processing) use this function.

## Adding a category

Edit `config/categories.config.json`. Token matching is word-boundary + accent-insensitive (via `utils/text.util.js → normalizeStr`). No code change needed — re-run `npm run pipeline:quick`.

## Adding a named filter

Edit `config/filters.config.json`. Pipelines write the resolved definition to `config/filters/filter-{key}.json` at runtime before passing it to `filter.script.js`.

## Script→util dependency map

```
pipeline.script.js          → process-runner, rate-manager, cli-args
pipeline-date-range.script  → process-runner, rate-manager, cli-args, console-output
parser.script.js            → cli-args, path-resolver, console-output, hash
label.script.js             → cli-args, path-resolver, data, text, console-output
filter.script.js            → cli-args, path-resolver, data, csv, filtering, text
stats.script.js             → cli-args, path-resolver, data, db, conversion-rates, filtering, console-output
db-insert.script.js         → cli-args, path-resolver, data, db, console-output
update-rates.script.js      → cli-args, path-resolver, db, console-output
category-details.script.js  → cli-args, path-resolver, data, console-output
list-other.script.js        → cli-args, path-resolver, data
```
