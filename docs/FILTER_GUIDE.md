# Filter Configuration Guide

## Overview

`config/filters.config.json` defines named filters used by the pipeline. Instead of passing raw JSON on the command line, reference a filter by its key.

## Defined filters

### `car` — Car-related expenses
```json
{ "description": "Car-related expenses", "category": "car" }
```
**Usage:** `npm run pipeline:car`

### `eur` — EUR currency only
```json
{ "description": "EUR currency only", "filters": { "currency_code": { "eq": "EUR" } } }
```
**Usage:** `npm run pipeline:eur`

### `tnd` — TND currency only
```json
{ "description": "TND currency only", "filters": { "currency_code": { "eq": "TND" } } }
```
**Usage:** `npm run pipeline:tnd`

### `food` — Food-related expenses
```json
{ "description": "All food-related expenses", "category": "food" }
```
**Usage:** `npm run pipeline:food`

### `transport` — Transport-related expenses
```json
{ "description": "All transport-related expenses", "category": "transport" }
```
**Usage:** `npm run pipeline:transport`

### `high_value` — Expenses ≥ 100
```json
{ "description": "Expenses over 100", "filters": { "amount": { "gte": 100 } } }
```
**Usage:** `npm run pipeline -- --filter high_value`

### `low_value` — Expenses < 50
```json
{ "description": "Expenses under 50", "filters": { "amount": { "lt": 50 } } }
```
**Usage:** `npm run pipeline -- --filter low_value`

---

## Filter schema

Two formats are supported in `filters.config.json`:

### Category shorthand
```json
"car": {
  "description": "Car-related expenses",
  "category": "car"
}
```
The pipeline expands `"category": "car"` into a `tokens` filter using all tokens from `car`'s subcategories.

### Explicit filters
```json
"eur": {
  "description": "EUR only",
  "filters": {
    "currency_code": { "eq": "EUR" }
  }
}
```
Standard GraphQL-style condition object. Multiple columns are ANDed together.

---

## Adding a filter

1. Edit `config/filters.config.json` and add an entry to the `filters` object:

```json
"my_filter": {
  "description": "What this filter does",
  "filters": {
    "column_name": { "operator": "value" }
  }
}
```

2. Run it:

```bash
npm run pipeline -- --filter my_filter
```

3. Optionally add an npm shortcut in `package.json`:

```json
"pipeline:my_filter": "node src/scripts/pipeline.script.js --filter my_filter"
```

---

## How the pipeline uses filters

When `--filter <key>` is passed:

1. Pipeline reads `config/filters.config.json` and resolves the key
2. Writes the resolved definition to `config/filters/filter-<key>.json`
3. Passes `--filters-file config/filters/filter-<key>.json` to `filter.script.js`
4. Output files: `output/depenses-<key>-filtered.csv` and `output/depenses-<key>-stats.json`

---

## Filter operator reference

From `src/utils/filtering.util.js → matchesFilter()`:

### Comparison
| Operator | Description | Applies to |
|----------|-------------|------------|
| `eq` | Equals | any |
| `ne` | Not equals | any |
| `gt` | Greater than | number |
| `gte` | Greater or equal | number, date (`DD/MM/YYYY`) |
| `lt` | Less than | number |
| `lte` | Less or equal | number, date (`DD/MM/YYYY`) |

### String
| Operator | Description |
|----------|-------------|
| `contains` | Substring match (case-sensitive) |
| `startsWith` | Prefix match |
| `endsWith` | Suffix match |
| `regex` | Regex, case-insensitive; also tested against accent-normalized string |

### Array / tokens
| Operator | Description |
|----------|-------------|
| `tokens` | Word-boundary, accent-insensitive token match — used by category filters |
| `in` | Value is in the array |
| `nin` | Value is not in the array |

Date fields (`date` column) use `toComparableString()` (→ `YYYYMMDD`) for `gte`/`lte` comparisons.

---

## Ad-hoc row filtering and display

For interactive filtering without running the full pipeline, use `query.script.js`:

```bash
npm run query -- --currency EUR --min-amount 100
npm run query -- --category food --begin-date "01/01/2025"
npm run query -- --database --description "orange" --currency TND
```

See `--help` for full flag reference.

---

## Examples

### Date range (in config)
```json
"q1_2025": {
  "description": "Q1 2025 expenses",
  "filters": {
    "date": { "gte": "01/01/2025", "lte": "31/03/2025" }
  }
}
```

### Multi-condition AND
```json
"expensive_food": {
  "description": "Food expenses above 50",
  "filters": {
    "category": { "regex": "^food" },
    "amount": { "gte": 50 }
  }
}
```

### Exclude by list
```json
"no_transfers": {
  "description": "Exclude false positives",
  "filters": {
    "category": { "nin": ["false-positive/transfers", "false-positive/lending"] }
  }
}
```

---

## Troubleshooting

**Filter key not found** — check spelling against `config/filters.config.json`

**No rows match** — conditions may be too strict; test with `npm run query` first to explore data interactively

**Unexpected results** — multiple conditions in one filter are ANDed; OR logic requires `regex` with `|`
