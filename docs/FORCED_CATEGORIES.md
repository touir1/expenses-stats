# Forced Categorization System

Forced categories override the automatic token-scoring system for descriptions that are ambiguous, context-dependent, or simply not coverable by tokens alone (person names, multi-word phrases, etc.).

## How it works

Before token scoring runs, `label.script.js` checks each row's description against the forced-category list. If any pattern is a case-insensitive substring of the description, the longest matching pattern wins and its category is applied directly — token scoring is skipped entirely for that row.

**Priority order in `label.script.js`:**
1. Forced category pattern match (longest substring wins)
2. Token scoring across all leaf categories (highest score wins)
3. Default label `other`

## Configuration file

`config/forced-categories.config.json`:

```json
{
  "description": "...",
  "forced": [
    { "description": "huile d'olive",   "category": "food/groceries" },
    { "description": "huile",           "category": "food/groceries" },
    { "description": "maman",           "category": "gifts/misc" }
  ]
}
```

**Fields:**
- `description` — substring to match (case-insensitive, longest wins)
- `category` — full label path; must exist in `categories.config.json`

**Matching rules:**
- Case-insensitive (`"huile d'Olive"` matches `"huile d'olive"`)
- Substring — pattern just needs to appear anywhere in the description
- When multiple patterns match, the longest one takes priority (more specific wins)
- No date, amount, or currency matching — description substring only

## When to add a forced entry

Use forced categories when:
- The description contains a person's name that token scoring would misclassify
- A multi-word phrase is too ambiguous as individual tokens (e.g. `"huile"` alone might match car oil, but `"huile d'olive"` is unambiguous)
- A single token appears in many categories and the correct one can only be determined from the full phrase

## Adding an entry

1. Edit `config/forced-categories.config.json` and add to the `forced` array:

```json
{ "description": "karta orange", "category": "tech/telecom" }
```

2. Re-run labeling:

```bash
npm run label
# or as part of the full pipeline
npm run pipeline:quick
```

## Database integration

When loading the database, forced-category patterns are stored in the `category_patterns` table (not a separate `forced_categorizations` table):

```bash
npm run db:insert -- --reset-database
```

The `category_patterns` table schema:

```sql
CREATE TABLE category_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description_pattern TEXT NOT NULL,
  date TEXT,
  amount REAL,
  currency TEXT,
  category_id INTEGER NOT NULL,
  UNIQUE(description_pattern, date, amount, currency)
);
```

The `date`, `amount`, and `currency` columns exist in the schema but are not currently used by `label.script.js` — matching is description-substring only. They are reserved for potential future use.

DB functions in `db.util.js`:
- `loadCategoryPatternsIntoDb(db, patterns)` — bulk-loads patterns on `db:insert`
- `getCategoryPatternsFromDb(db)` — returns all patterns ordered longest-first

## Tips

- **Order doesn't matter** — the longest-match rule handles priority automatically
- **More specific is always safer** — `"huile d'olive"` beats `"huile"` if both match
- **Run `npm run list:other` after adding** — to verify previously uncategorized rows are now caught
