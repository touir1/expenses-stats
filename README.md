# depenses_stats

Expense analysis pipeline: parse → label → filter → stats. Supports EUR and TND.

## Quick start

```bash
npm run pipeline                   # Full run
npm run pipeline:quick             # Skip parsing (reuse existing CSV)
npm run pipeline:car               # With named filter (car / eur / tnd / food / transport)
npm run pipeline:date-range -- --begin-date "01/03/2026" --end-date "31/03/2026"
npm run list:other                 # Inspect uncategorized expenses
npm run update-rates               # Refresh conversion rates
```

## Named filters

Defined in `config/filters.config.json`. Pass via `--filter <key>` or use the `pipeline:<key>` shortcuts.

## Adding categories

Edit `config/categories.config.json` — add tokens to a subcategory, then `npm run pipeline:quick`.

## Forced categorization

Edit `config/forced-categories.config.json` — map an expense hash to a category explicitly.  
Use `npm run list:other` to find hashes, see `docs/FORCED_CATEGORIES.md` for details.

## Docs

- `docs/data-schema.md` — CSV columns, config formats, filter operators, DB schema
- `docs/FILTER_GUIDE.md` — filter system deep-dive
- `docs/FORCED_CATEGORIES.md` — forced categorization guide

## Requirements

Node.js ≥ 14, `sqlite3` package.
