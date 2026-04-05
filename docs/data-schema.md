# Data Schema Reference

## CSV columns

### `depenses.csv` / `depenses-labeled.csv`

| Column | Type | Format | Example |
|--------|------|--------|---------|
| `amount` | number | decimal | `804.5` |
| `currency_symbol` | string | `€` or `dt` | `€` |
| `currency_code` | string | `EUR` or `TND` | `EUR` |
| `date` | string | `DD/MM/YYYY` | `15/03/2026` |
| `description` | string | free text | `loyer courbevoie` |
| `hash` | string | hex | `a3f2...` |
| `category` | string | `parent/sub` or `other` | `car/mechanic` |

### `conversion-rates.csv`

| Column | Description |
|--------|-------------|
| `date` | `YYYY-MM-DD` |
| `base` | Base currency code |
| `quote` | Quote currency code |
| `rate` | Conversion rate |

---

## Config file formats

### `categories.config.json`

```json
{
  "categories": [
    {
      "name": "car",
      "subcategories": [
        {
          "name": "mechanic",
          "filters": {
            "description": { "tokens": ["mecanicien", "tasli7"] }
          }
        }
      ]
    }
  ]
}
```

Category-level tokens are auto-generated at runtime from all subcategory token lists.

### `forced-categories.config.json`

```json
{
  "forced": [
    { "description": "maman", "category": "gifts/misc" },
    { "description": "huile d'olive", "category": "food/groceries" }
  ]
}
```

Description-substring matching, longest match wins. Used for names, multi-word phrases, and tokens that are too ambiguous for the global scoring system.

### `filters.config.json`

```json
{
  "filters": {
    "car": {
      "description": "Car-related expenses",
      "category": "car"
    },
    "eur": {
      "description": "EUR only",
      "filters": { "currency_code": { "eq": "EUR" } }
    }
  }
}
```

---

## Filter operators (`src/utils/filtering.util.js`)

| Operator | Type | Description |
|----------|------|-------------|
| `eq` | any | Equals |
| `ne` | any | Not equals |
| `gt` | number | Greater than |
| `gte` | number / date | Greater than or equal |
| `lt` | number | Less than |
| `lte` | number / date | Less than or equal |
| `contains` | string | Substring match |
| `startsWith` | string | Prefix match |
| `endsWith` | string | Suffix match |
| `regex` | string | Regex (case-insensitive, also tested against normalized string) |
| `tokens` | array | Word-boundary token match (accent-insensitive) |
| `in` | array | Value in list |
| `nin` | array | Value not in list |

Date fields (`date` column) use `DD/MM/YYYY` string comparison via `toComparableString()` for `gte`/`lte`.

---

## SQLite schema (`data/database/depenses.db`)

Tables: `expenses`, `categories`, `category_filters`, `category_filter_tokens`, `category_patterns`, `conversion_rates`

Key index: `idx_conversion_rates_lookup ON conversion_rates (base, quote, date)` — used for nearest-prior-date rate lookup.
