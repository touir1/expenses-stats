# Filter Configuration Guide

## Overview

The `config/filters-config.json` file defines named filters that can be used in the pipeline. Instead of passing complex JSON on the command line, you simply reference a filter by its key.

## Current Filters

### 1. `car` - Car-Related Expenses
```json
{
  "description": "Car-related expenses (repairs, maintenance, insurance)",
  "filters": {
    "description": {
      "regex": "opel|mecanicien|electricien|atelier|tolier|voiture|automobile|huile|essence|parking|assurance|garage|moteur|filtre|plaquette|freins|batterie|radiateur|suspension|pneu|courroie|clim|climatisation|révision"
    }
  }
}
```
**Usage:** `npm run pipeline:car`
**Output:** 193 car-related entries analyzed separately

### 2. `eur` - EUR Currency Only
```json
{
  "description": "EUR currency only",
  "filters": {
    "currency_code": { "eq": "EUR" }
  }
}
```
**Usage:** `npm run pipeline:eur`
**Output:** 2,086 EUR entries

### 3. `tnd` - TND Currency Only
```json
{
  "description": "TND currency only",
  "filters": {
    "currency_code": { "eq": "TND" }
  }
}
```
**Usage:** `npm run pipeline:tnd`
**Output:** 1,430 TND entries

### 4. `high_value` - High-Value Expenses
```json
{
  "description": "Expenses over 100 EUR / 350 TND",
  "filters": {
    "amount": { "gte": 100 }
  }
}
```
**Usage:** `npm run pipeline -- --filter high_value`
**Output:** Large expenses (rent, flights, major purchases)

### 5. `low_value` - Low-Value Expenses
```json
{
  "description": "Expenses under 50 EUR / 175 TND",
  "filters": {
    "amount": { "lt": 50 }
  }
}
```
**Usage:** `npm run pipeline -- --filter low_value`
**Output:** Small daily expenses (coffee, snacks, etc.)

### 6. `food` - Food-Related Expenses
```json
{
  "description": "All food-related expenses",
  "filters": {
    "description": {
      "regex": "cafe|restaurant|lunch|coffee|bread|pastry|grocery|boulangerie|pâtisserie|épicerie|marché|viande|fruits|légumes|milk|cheese|pizza|kebab|sandwich|restaurant|café|bistro"
    }
  }
}
```
**Usage:** `npm run pipeline:food`
**Output:** All food-related entries

### 7. `transport` - Transport-Related Expenses
```json
{
  "description": "All transport-related expenses",
  "filters": {
    "description": {
      "regex": "flight|avion|train|bus|taxi|uber|transport|ticket|voyage|vol|aéroport"
    }
  }
}
```
**Usage:** `npm run pipeline:transport`
**Output:** All transport entries

## Adding a New Filter

1. **Edit `config/filters-config.json`**

2. **Add your filter to the `filters` object:**

```json
"my_new_filter": {
  "description": "Clear description of what this filter does",
  "filters": {
    "column_name": { "operator": "value" }
  }
}
```

3. **Use it in the pipeline:**

```bash
npm run pipeline -- --filter my_new_filter
```

## Filter Operator Reference

### Comparison Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equals | `"eq": "EUR"` |
| `ne` | Not equals | `"ne": "TND"` |
| `gt` | Greater than | `"gt": 100` |
| `gte` | Greater or equal | `"gte": 100` |
| `lt` | Less than | `"lt": 50` |
| `lte` | Less or equal | `"lte": 500` |

### String Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `contains` | Contains substring | `"contains": "coffee"` |
| `startsWith` | Starts with | `"startsWith": "dep"` |
| `endsWith` | Ends with | `"endsWith": "eur"` |
| `regex` | Regex pattern | `"regex": "coffee\|tea"` |

### Array Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `in` | Value in array | `"in": ["EUR", "TND"]` |
| `nin` | Value not in array | `"nin": ["USD"]` |

## Examples: Creating Custom Filters

### Example 1: Specific Date Range
```json
"2024_expenses": {
  "description": "Expenses from 2024 only",
  "filters": {
    "date": { "regex": "2024" }
  }
}
```

### Example 2: Multi-Condition Filter (AND logic)
```json
"expensive_food": {
  "description": "Food expenses over 50 EUR",
  "filters": {
    "description": { "regex": "cafe|restaurant|pizza" },
    "amount": { "gte": 50 }
  }
}
```

### Example 3: High TND Expenses
```json
"high_tnd": {
  "description": "TND expenses above 500",
  "filters": {
    "currency_code": { "eq": "TND" },
    "amount": { "gte": 500 }
  }
}
```

### Example 4: Exclude Certain Categories
```json
"no_groceries": {
  "description": "All non-grocery food expenses",
  "filters": {
    "description": { "nin": ["grocery", "épicerie", "marché"] }
  }
}
```

### Example 5: Specific Keywords
```json
"subscriptions": {
  "description": "Subscription-related expenses",
  "filters": {
    "description": { "regex": "subscription|netflix|spotify|adobe|microsoft" }
  }
}
```

## Pipeline Script Integration

When you use `npm run pipeline -- --filter mykey`:

1. Pipeline reads `config/filters-config.json`
2. Finds the `mykey` filter definition
3. Creates temporary `config/filter-mykey.json` with the filter
4. Runs labeling (categorizes all 3,516 entries)
5. Applies the filter: `output/depenses-mykey-filtered.csv`
6. Generates stats: `output/depenses-mykey-stats.json`

## Output Naming

For each filter key, you get:
- **Filtered CSV**: `output/depenses-{key}-filtered.csv`
- **Stats JSON**: `output/depenses-{key}-stats.json`

Example for `car` filter:
- `output/depenses-car-filtered.csv` (193 rows)
- `output/depenses-car-stats.json` (statistics)

## Tips

### 1. Combine Filters in Pipeline
Create a filter for complex queries:

```json
"rental_car_insurance": {
  "description": "Car insurance expenses above 50 EUR",
  "filters": {
    "description": { "regex": "assurance.*voiture|insurance.*car|auto.*insurance" },
    "amount": { "gte": 50 }
  }
}
```

### 2. Regex Case-Insensitive
All regex patterns are case-insensitive (uses `i` flag):

```json
// Matches: "Coffee", "COFFEE", "coffee"
"description": { "regex": "coffee" }
```

### 3. OR Logic in Regex
```json
"meals": {
  "description": "Meals (restaurant or cafe)",
  "filters": {
    "description": { "regex": "restaurant|cafe|bistro" }
  }
}
```

### 4. Escaped Special Characters
For regex special characters, escape with backslash:

```json
// Match literally: "C++"
"description": { "regex": "C\\+\\+" }
```

### 5. Quick Filter Testing
Add to package.json for convenience:

```json
"scripts": {
  "filter:my_test": "npm run pipeline -- --filter my_test"
}
```

Then: `npm run filter:my_test`

## Full Filter Schema

```json
{
  "filters": {
    "filter_key": {
      "description": "Human-readable description",
      "filters": {
        "column_name_1": {
          "operator_1": "value_1",
          "operator_2": "value_2"
        },
        "column_name_2": {
          "operator": "value"
        }
      }
    }
  }
}
```

## Troubleshooting

### Filter not found error
- Check spelling: `npm run pipeline -- --filter carex` (typo!)
- Verify in `config/filters-config.json` it exists

### No results matching filter
- Filter conditions too restrictive
- Check data in `data/processed/depenses.csv`
- Review filter operators and values

### Unexpected results
- AND logic between multiple conditions in one category (all must match)
- OR logic within regex patterns (use `|`)
- Case-insensitive matching (use as needed)

## Default Script Commands

Add these to `package.json` for quick access:

```json
"scripts": {
  "pipeline:my_filter": "npm run pipeline -- --filter my_filter"
}
```

Then use: `npm run pipeline:my_filter`

All seven pre-configured filters include NPM scripts (see package.json).
