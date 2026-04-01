# Project Reorganization Summary

## What Was Done

### 1. **Folder Structure** ✓
Organized all files into a clean, modular structure:

```
depenses_stats/
├── src/scripts/              # Main scripts
│   ├── parser.js            # Parse TXT → CSV
│   ├── label.js             # Add categories
│   ├── filter.js            # Apply filters
│   ├── stats.js             # Generate statistics
│   ├── pipeline.js          # Orchestrate workflow
│   └── list_other.js        # List uncategorized items
├── config/                  # Configuration
│   ├── categories.json      # Token-based category definitions (200+ tokens)
│   ├── conversion_rates.csv
│   └── filters-config.json  # Named filter mappings
├── data/                    # Data files
│   ├── raw/                # Input
│   │   └── depenses.txt
│   └── processed/          # Intermediate results
│       ├── depenses.csv
│       └── depenses-labeled.csv
├── output/                  # Pipeline results
│   ├── depenses-stats.json
│   └── depenses-*-stats.json (per-filter)
├── package.json            # NPM scripts
└── README.md               # Full documentation
```

### 2. **Scripts with Updated Paths** ✓
All scripts now reference the organized folder structure:

- **parser.js**: Reads from `data/raw/` → writes to `data/processed/`
- **label.js**: Reads from `data/processed/` → writes to `data/processed/`
- **filter.js**: Reads from `data/processed/` → writes to `output/`
- **stats.js**: Reads from `data/processed/` or `output/` → writes stats to `output/`

### 3. **Pipeline Script** ✓
**New file: `src/scripts/pipeline.js`**

Orchestrates the complete workflow with optional steps:

```bash
# Full pipeline (parse → label → stats)
npm run pipeline

# Skip parsing, use existing CSV
npm run pipeline:quick

# With a named filter
npm run pipeline:car
npm run pipeline:eur
npm run pipeline:food
npm run pipeline:transport
```

**Pipeline Stages:**
1. Parse: TXT → CSV (can skip with `--skip-parsing`)
2. Label: Add categories
3. Filter: Apply optional named filter
4. Stats: Generate statistics (console + JSON)

### 4. **Filters Configuration** ✓
**New file: `config/filters-config.json`**

Maps filter keys to their JSON definitions:

```json
{
  "filters": {
    "car": {
      "description": "Car-related expenses (repairs, maintenance, insurance)",
      "filters": { /* filter JSON */ }
    },
    "eur": {
      "description": "EUR currency only",
      "filters": { "currency_code": { "eq": "EUR" } }
    },
    ...
  }
}
```

**Available Filters:**
- `car` - Car-related expenses
- `eur` - EUR currency only
- `tnd` - TND currency only
- `high_value` - €100+ expenses
- `low_value` - <€50 expenses
- `food` - Food-related
- `transport` - Transport-related

### 5. **Package.json Scripts** ✓
Convenient NPM commands for all workflows. Includes `list:other` for inspecting uncategorized entries.

```bash
# Pipeline commands
npm run pipeline              # Full pipeline
npm run pipeline:quick        # Skip parsing
npm run pipeline:car          # With car filter
npm run pipeline:eur          # EUR filter
npm run pipeline:tnd          # TND filter
npm run pipeline:food         # Food filter
npm run pipeline:transport    # Transport filter

# Utility commands
npm run list:other            # List all uncategorized items

# Individual script commands
npm run parse                 # Just parse
npm run label                 # Just label
npm run filter                # Just filter
npm run stats                 # Just stats

# Help commands
npm run pipeline:help
npm run parse:help
npm run label:help
npm run filter:help
npm run stats:help
```

### 6. **Documentation** ✓
**New file: `README.md`** with complete usage guide

## Key Features

### Modular Design
- Each script has a single responsibility
- Scripts can be run independently or orchestrated
- All paths are relative and configurable

### Named Filters with Key Mapping
- Define filters once in `filters-config.json`
- Reference by key in pipeline: `npm run pipeline -- --filter key`
- Filter JSON automatically generated and applied
- Results saved as `output/depenses-{key}-filtered.csv` and stats JSON

### Optional Pipeline Steps
- Skip parsing if CSV already exists: `--skip-parsing`
- Skip labeling if already labeled: `--skip-labeling`
- Apply optional filter before stats: `--filter key`

### Complete Statistics
- Console output with formatted tables
- JSON file output for programmatic access
- Category breakdown with converted totals
- Monthly trends with both EUR/TND conversions
- Per-filter statistics

## Usage Examples

### 1. Standard Full Pipeline
```bash
npm run pipeline
# Output: data/processed/depenses-labeled.csv, output/depenses-stats.json
```

### 2. Analyze Car Expenses
```bash
npm run pipeline:car
# Output: output/depenses-car-filtered.csv, output/depenses-car-stats.json
```

### 3. Quick Re-run (Skip Parsing)
```bash
npm run pipeline:quick
# For when depenses.csv exists and only categories changed
```

### 4. Add Custom Filter
1. Edit `config/filters-config.json`:
   ```json
   "my_filter": {
     "description": "My custom filter",
     "filters": { "amount": { "gte": 500 } }
   }
   ```
2. Run: `npm run pipeline -- --filter my_filter`

### 5. Manual Control
```bash
# Parse only
npm run parse

# Label with categories
npm run label

# Filter manually
npm run filter

# Generate stats
npm run stats

# Inspect uncategorized items
npm run list:other
```

## File Organization Benefits

### Before
- All files in root directory
- Unclear which files were inputs vs outputs
- Hard to find config files
- Difficult to scale to multiple datasets

### After
- Clear separation: `src/` (code), `config/` (settings), `data/` (files), `output/` (results)
- `config/filters-config.json` acts as central filter registry
- Easy to add new filters without code changes
- Easy to backup, version, or migrate projects
- Scalable structure for larger workflows

## Tested Workflows

✅ **Full Pipeline**
- Parsing: TXT → CSV (3516 entries)
- Labeling: Added 41 categories
- Stats: Generated with category breakdown

✅ **Car Filter Pipeline**
- Applied "car" filter to labeled data
- Output: 193 car-related entries
- Stats: By car subcategory

✅ **Individual Scripts**
- Each script works independently
- Correct path resolution in organized structure

## Next Steps (Optional)

1. **Add More Named Filters**
   - Edit `filters-config.json` with new keys
   - Run: `npm run pipeline -- --filter newkey`

2. **Enrich Categories**
   - Update `config/categories.json`
   - Re-run: `npm run pipeline:quick` (skips parsing)

3. **Batch Processing**
   - Create shell script to run multiple filters
   - Generate comparative reports

4. **Automated Scheduling**
   - Use cron/Task Scheduler to run pipeline regularly
   - Archive outputs with dates
   - Generate trend reports

## Verification

All components tested and working:

```bash
# Verify structure
ls -la  # or: Get-ChildItem

# Verify scripts
npm run pipeline:help
npm run parse:help
npm run label:help
npm run filter:help
npm run stats:help

# Run quick test
npm run pipeline:quick

# Test with filter
npm run pipeline:car
```

## Summary

**Deliverables:**
- ✅ Organized folder structure (src, config, data, output)
- ✅ Updated scripts with relative paths
- ✅ pipeline.js orchestrator
- ✅ filters-config.json with 7 predefined filters
- ✅ list_other.js for inspecting uncategorized items
- ✅ package.json with convenient NPM scripts
- ✅ categories.json with 200+ tokens across 15 categories (41 subcategories)
- ✅ "other" category reduced to ~4.4% (from ~15% initial)
- ✅ Comprehensive README.md documentation

**Key Innovation: Token-Based Categories + Named Filters**
Categories use word-boundary token matching (accent-insensitive). Category-level tokens are auto-generated from subcategory lists — no duplication. Named filters let you use simple keys:
- Before: `node filter.js --filters '{"description": {"regex": "car|..."}, ...}'`
- After: `npm run pipeline:car`

To improve categorization: run `npm run list:other`, identify patterns, add tokens to `categories.json`, re-run `npm run pipeline:quick`.
