# Depenses Stats - Expense Analysis Pipeline

A comprehensive Node.js-based expense analysis tool that parses, categorizes, filters, and generates statistics from expense data.

## Project Structure

```
depenses_stats/
├── src/scripts/              # Scripts directory
│   ├── parser.js            # Parse text → CSV
│   ├── label.js             # Add category labels to CSV
│   ├── filter.js            # Filter CSV with GraphQL-style filters
│   ├── stats.js             # Generate statistics
│   ├── pipeline.js          # Main orchestration script
│   └── list-other.js        # List uncategorized items
├── config/                  # Configuration files
│   ├── categories.config.json       # Hierarchical category definitions (token-based)
│   ├── filters.config.json          # Named filter definitions
│   └── filters/                     # Individual filter definitions
├── data/                    # Data directories
│   ├── raw/                # Input raw data
│   │   └── depenses.txt
│   └── processed/          # Processed data
│       ├── depenses.csv
│       ├── depenses-labeled.csv
│       └── conversion-rates.csv     # EUR/TND conversion rates
├── output/                  # Pipeline output
│   ├── depenses-stats.json
│   └── depenses-*-filtered.csv (optional, per filter)
├── docs/                   # Documentation
├── package.json            # NPM configuration
└── README.md               # This file
```

## Quick Start

### 1. Full Pipeline (Parse → Label → Stats)
```bash
npm run pipeline
```

### 2. Quick Pipeline (Skip Parsing)
```bash
npm run pipeline:quick
```

### 3. Pipeline with Filter
```bash
npm run pipeline:car          # Car-related expenses
npm run pipeline:eur          # EUR only expenses
npm run pipeline:tnd          # TND only expenses
npm run pipeline:food         # Food-related expenses
npm run pipeline:transport    # Transport-related expenses
```

### 4. List Uncategorized Items
```bash
npm run list:other
```

### 5. Individual Commands

**Parse expenses**
```bash
npm run parse
```

**Add category labels**
```bash
npm run label
```

**Filter data**
```bash
npm run filter
```

**Generate statistics**
```bash
npm run stats
```

## Named Filters

Filters are defined in `config/filters.config.json` and can be referenced by key:

| Key | Description |
|-----|-------------|
| `car` | Car-related expenses (repairs, maintenance, insurance) |
| `eur` | EUR currency only |
| `tnd` | TND currency only |
| `high_value` | Expenses ≥ 100 EUR / 350 TND |
| `low_value` | Expenses < 50 EUR / 175 TND |
| `food` | Food-related expenses |
| `transport` | Transport-related expenses |

### Adding Custom Filters

Edit `config/filters.config.json`:

```json
{
  "filters": {
    "my_filter": {
      "description": "My custom filter description",
      "filters": {
        "column_name": { "operator": "value" }
      }
    }
  }
}
```

Then run:
```bash
npm run pipeline -- --filter my_filter
```

## Filter Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equals | `"eq": "EUR"` |
| `ne` | Not equals | `"ne": "EUR"` |
| `gt` | Greater than | `"gt": 100` |
| `gte` | Greater than or equal | `"gte": 100` |
| `lt` | Less than | `"lt": 50` |
| `lte` | Less than or equal | `"lte": 500` |
| `contains` | String contains | `"contains": "coffee"` |
| `startsWith` | String starts with | `"startsWith": "dep"` |
| `endsWith` | String ends with | `"endsWith": "eur"` |
| `regex` | Regex pattern | `"regex": "coffee\|tea"` |
| `in` | Value in array | `"in": ["EUR", "TND"]` |
| `nin` | Value not in array | `"nin": ["EUR"]` |

## Category Hierarchy

Categories are hierarchical (e.g., `car/electrical`, `food/cafe`). Each subcategory uses a **token list** — an expense matches if any token appears (word-boundary match, accent-insensitive) in its description:

```json
{
  "categories": [
    {
      "name": "car",
      "subcategories": [
        {
          "name": "electrical",
          "filters": { "description": { "tokens": ["electricien", "batterie", "fusible"] } }
        },
        {
          "name": "mechanic",
          "filters": { "description": { "tokens": ["mecanicien", "tasli7"] } }
        }
      ]
    }
  ]
}
```

Category-level tokens are auto-generated at runtime from all subcategory token lists — no duplication needed.

## Statistics Output

Each stats command generates:
1. **Console output**: Formatted summary with totals, averages, category breakdowns
2. **JSON file**: Complete statistics data for further processing

### Sample Output Structure

```json
{
  "totalEntries": 3516,
  "totalAmount": {
    "EUR": 52266.02,
    "TND": 64509.45,
    "total": {
      "EUR": 70697.29,
      "TND": 247440.52
    }
  },
  "byCurrency": { /* EUR/TND breakdown */ },
  "byMonth": { /* Monthly totals */ },
  "byCategory": { /* Category statistics with converted totals */ }
}
```

## Pipeline Arguments

```bash
node src/scripts/pipeline.js [options]

Options:
  --skip-parsing      Skip parsing step (use existing CSV)
  --skip-labeling     Skip labeling step (use existing labeled CSV)
  --filter <key>      Apply named filter before stats
  -h, --help          Show help
```

## Currency Conversion

- Monthly conversion rates from `config/conversion-rates.csv`
- Format: `YYYY-MM,rate`
- Default fallback rate: 3.5 TND/EUR
- Both EUR and TND totals calculated for each category/month

## File Descriptions

### Core Scripts
- **parser.js**: Parses text format to standardized CSV
- **label.js**: Adds hierarchical category column to CSV
- **filter.js**: Filters rows based on GraphQL-style conditions
- **stats.js**: Calculates and outputs statistics
- **pipeline.js**: Orchestrates the entire workflow

### Configuration
- **categories.config.json**: Full expense category hierarchy with token-based matching
- **conversion-rates.csv**: Monthly EUR/TND conversion rates
- **filters.config.json**: Named filter definitions with descriptions

### Data
- **data/raw/**: Input text files
- **data/processed/**: CSV files (parsed, labeled)
- **output/**: Final statistics and filtered CSVs

## Examples

### Generate full expense statistics
```bash
npm run pipeline
```
Output: `output/depenses-stats.json`

### Analyze car expenses
```bash
npm run pipeline:car
```
Output: `output/depenses-car-filtered.csv` (filtered data) + `output/depenses-car-stats.json` (statistics)

### Quick re-analysis with existing CSV
```bash
npm run pipeline:quick
```
Skips parsing, goes straight to labeling and stats

### Custom filter
1. Add filter to `config/filters.config.json`
2. Run: `npm run pipeline -- --filter filter_key`

## Requirements

- Node.js >= 14.0.0
- No external dependencies

## Notes

- Run `npm run list:other` to inspect uncategorized items and find new tokens to add
- Token matching uses word boundaries and is accent-insensitive and case-insensitive
- Multi-level categories enable detailed budget analysis (e.g., `car/electrical` vs `car/mechanic`)
- Adding tokens to `categories.json` and re-running `npm run pipeline:quick` updates all stats instantly
- All paths are relative and work from any directory
