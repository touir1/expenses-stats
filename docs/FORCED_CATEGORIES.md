# Forced Categorization System

The forced categorization system allows you to override automatic category detection for specific transaction rows. Rows are identified by a unique hash (computed from description, currency, and amount) combined with the transaction date.

This is useful for:
- Overriding the category for a specific transaction
- Handling duplicate descriptions with different contexts
- Correcting mislabeled transactions without changing the automatic rules
- Managing edge cases that only occur once or a few times

## How It Works

The system uses a `forced_categorizations` table in SQLite that stores hash+date combinations mapped to specific categories. When processing expenses, each row's hash and date are checked to see if it has a forced category override before applying automatic pattern matching.

### Hash Generation

The hash is computed from:
- **Description** - Transaction description (case-sensitive)
- **Currency Code** - Currency code (uppercased)
- **Amount** - Transaction amount (numeric value)

Formula: `SHA256(description | currency_code | amount).slice(0, 16)`

The hash is then combined with the date to uniquely identify a transaction for forced categorization.

### Database Table Structure

```sql
CREATE TABLE forced_categorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  date TEXT NOT NULL,
  category_label TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(hash, date)
);
```

**Columns:**
- `hash` - 16-character hex hash computed from description, currency, amount
- `date` - Transaction date (YYYY-MM-DD format)
- `category_label` - The full category path (e.g., "food/groceries")

**Matching Logic:**
- Hash must match exactly (computed from transaction details)
- Date must match exactly
- Once both match, the forced category is applied

## Configuration

Forced categorizations are configured in `config/forced-categories.json`:

```json
{
  "description": "Forced category mappings for specific transaction rows",
  "forced": [
    {
      "date": "2025-11-15",
      "description": "ABDERRAHMEN SELLAM",
      "currency": "TND",
      "amount": 100.00,
      "category": "false-positive/lending"
    },
    {
      "date": "2026-01-10",
      "description": "EURO TRANSFER",
      "currency": "EUR",
      "amount": 50.00,
      "category": "false-positive/transfers"
    }
  ]
}
```

**Guidelines:**
- `date` - Must be in YYYY-MM-DD format
- `description` - Transaction description (case-sensitive for hash computation)
- `currency` - Currency code (case-insensitive; stored as uppercase)
- `amount` - Transaction amount (numeric value)
- `category` - Full category path (must exist in categories.json)

## CSV Integration

Hash values are included in the CSV files for transparency and traceability:

**depenses.csv** (parser output):
```
amount,currency_symbol,currency_code,date,description,hash
5,dt,TND,31/03/2026,coffee,e1866e759a13e164
```

**depenses-labeled.csv** (label output):
```
amount,currency_symbol,currency_code,date,description,hash,category
5,dt,TND,31/03/2026,coffee,e1866e759a13e164,food/cafe
```

The hash allows you to:
- Trace transactions through the pipeline
- Verify which rows have forced categorizations
- Cross-reference with database entries

## Usage

### 1. Initialize Database (Load Configuration)

```bash
npm run db:insert -- --delete-all
```

This loads all forced categorizations from `config/forced-categories.json` into the database.

```
✓ Forced categorizations loaded: 3 entries
```

### 2. Query Forced Categorizations

Use the provided script to check if a row has a forced category:

```bash
# List all forced categorizations
node src/scripts/check-forced.js --list

# Check by hash and date
node src/scripts/check-forced.js "5c63937e8c2f6fcd" "2025-11-15"

# Compute hash and check from transaction details
node src/scripts/check-forced.js "ABDERRAHMEN SELLAM" "TND" 100.00 "2025-11-15"
```

### 3. Database API

In your code, use the db module functions:

```javascript
const { openDatabase, getForcedCategoryFromDb, getAllForcedCategorizationsFromDb, hashExpense } = require('../utils/db');

const db = await openDatabase('data/database/depenses.db');

// Compute hash
const hash = hashExpense('ABDERRAHMEN SELLAM', 'TND', 100.00);

// Check if a row has a forced category
const category = await getForcedCategoryFromDb(db, hash, '2025-11-15');
// Returns: 'false-positive/lending'

// Get all forced categorizations
const all = await getAllForcedCategorizationsFromDb(db);
// Returns: [{ hash: '...', date: '...', category: '...' }, ...]
```

## Integration with Label.js

The current `label.script.js` implementation does not yet use database-backed forced categorizations. It loads from `category-patterns.json` instead.

To integrate forced categorizations into label.script.js:

1. Compute the hash for each CSV row (description, currency_code, amount)
2. Call `getForcedCategoryFromDb()` before applying automatic categorization
3. If a forced category is found, use it; otherwise apply the normal flow

Example enhancement:
```javascript
// In label.script.js processing loop
const hash = hashExpense(row.description, row.currency_code, row.amount);
const forced = await getForcedCategoryFromDb(db, hash, row.date);
const label = forced || assignCategory(row, columnMap, categoryDefs, '');
```

## Adding Forced Categorizations

### Method 1: Configuration File (Current)

Edit `config/forced-categories.json` and add entries:

```json
{
  "forced": [
    {
      "date": "2025-12-15",
      "description": "SOME TRANSACTION",
      "currency": "TND",
      "amount": 25.50,
      "category": "food/groceries"
    }
  ]
}
```

Then reload the database:
```bash
npm run db:insert -- --delete-all
```

### Method 2: Database Direct (Manual SQL)

Compute the hash and insert directly:

```sql
-- First compute the hash (description|currency|amount)
-- SHA256("SOME TRANSACTION|TND|25.50").slice(0, 16) = computed_hash
INSERT INTO forced_categorizations (hash, date, category_label)
VALUES ('computed_hash', '2025-12-15', 'food/groceries');
```

## Hash Examples

### Computing Hashes

```
Description: "ABDERRAHMEN SELLAM"
Currency: "TND"
Amount: 100.00
String: "ABDERRAHMEN SELLAM|TND|100.00"
Hash: 5c63937e8c2f6fcd (first 16 chars of SHA256)
```

### Matching Rows

```
Transaction:
  Date: 2025-11-15
  Description: ABDERRAHMEN SELLAM
  Currency: TND
  Amount: 100.00
  Hash: 5c63937e8c2f6fcd

Stored Forced Categorization:
  Hash: 5c63937e8c2f6fcd
  Date: 2025-11-15
  Category: false-positive/lending

Result: ✓ MATCH
Forced category will be applied: false-positive/lending
```

### Different Descriptions (Different Hash)

```
Transaction 1:
  Hash: 5c63937e8c2f6fcd (ABDERRAHMEN SELLAM|TND|100.00)

Transaction 2:
  Hash: a1b2c3d4e5f6g7h8 (DIFFERENT DESCRIPTION|TND|100.00)

Result: ✗ NO MATCH
Different description = different hash, even if amount/currency/date are same
```

### Different Amounts (Different Hash)

```
Transaction 1:
  Hash: 5c63937e8c2f6fcd (ABDERRAHMEN SELLAM|TND|100.00)

Transaction 2:
  Hash: x9y8z7w6v5u4t3s2 (ABDERRAHMEN SELLAM|TND|50.00)

Result: ✗ NO MATCH
Different amount = different hash
```

## Troubleshooting

**Issue:** Forced categorization not matching

1. Verify the row is in the forced categorizations list:
   ```bash
   node src/scripts/check-forced.js --list
   ```

2. Compute the hash and check:
   ```bash
   node src/scripts/check-forced.js "DESCRIPTION" "CURRENCY" AMOUNT DATE
   ```

3. Verify all components match exactly:
   - **hash**: Computed from description, currency, amount
   - **date**: Must match exactly (YYYY-MM-DD format)

4. Verify category exists in `config/categories.json`

5. Reload database:
   ```bash
   npm run db:insert -- --delete-all
   ```

**Issue:** Wrong category applied**

1. Verify the hash computation:
   ```bash
   node src/scripts/check-forced.js "DESCRIPTION" "CURRENCY" AMOUNT "DATE"
   ```

2. Verify the category in forced-categories.json is correct

3. Check for conflicting patterns in category-patterns.json

**Issue:** Transaction not in forced categorizations**

Make sure:
- Description matches exactly (case-sensitive)
- Currency code is correct (will be normalized to uppercase)
- Amount is correct (floating point precision handled)
- Date is in YYYY-MM-DD format

## Best Practices

1. **Use Exact Descriptions**: Copy the description exactly as it appears in the CSV
2. **Verify Before Adding**: Check that the category is correct before adding to forced list
3. **Clean Up Old Entries**: Remove forced categorizations once you've fixed the underlying rules
4. **Document Reasons**: Add comments in the JSON file explaining why certain rows are forced
5. **Test After Changes**: Run label pipeline after adding forced categorizations to verify behavior
6. **Hash Verification**: Use the hash to verify transactions across systems and pipelines

## Configuration

Forced categorizations are configured in `config/forced-categories.json`:

```json
{
  "description": "Forced category mappings for specific rows",
  "forced": [
    {
      "date": "2025-11-15",
      "description": "ABDERRAHMEN SELLAM",
      "currency": "TND",
      "amount": 100.00,
      "category": "false-positive/lending"
    },
    {
      "date": "2026-01-10",
      "description": "EURO TRANSFER",
      "currency": "EUR",
      "amount": 50.00,
      "category": "false-positive/transfers"
    }
  ]
}
```

**Guidelines:**
- `date` - Must be in YYYY-MM-DD format
- `description` - Transaction description (case-sensitive for matching)
- `currency` - Currency code (case-insensitive; stored as uppercase)
- `amount` - Transaction amount (numeric value)
- `category` - Full category path (must exist in categories.json)

## Usage

### 1. Initialize Database (Load Configuration)

```bash
npm run db:insert -- --delete-all
```

This loads all forced categorizations from `config/forced-categories.json` into the database.

```
✓ Forced categorizations loaded: 3 entries
```

### 2. Query Forced Categorizations

Use the provided script to check if a row has a forced category:

```bash
# Check a specific row
node src/scripts/check-forced.js "2025-11-15" "ABDERRAHMEN SELLAM" "TND" 100.00
# ✓ Forced category found: false-positive/lending

# List all forced categorizations
node src/scripts/check-forced.js --list
```

### 3. Database API

In your code, use the db module functions:

```javascript
const { openDatabase, getForcedCategoryFromDb, getAllForcedCategorizationsFromDb } = require('../utils/db');

const db = await openDatabase('data/database/depenses.db');

// Check if a row has a forced category
const category = await getForcedCategoryFromDb(db, '2025-11-15', 'ABDERRAHMEN SELLAM', 'TND', 100.00);
// Returns: 'false-positive/lending'

// Get all forced categorizations
const all = await getAllForcedCategorizationsFromDb(db);
// Returns: [{ date: '...', description: '...', currency: '...', amount: ..., category: '...' }, ...]
```

## Integration with Label.js

The current `label.script.js` implementation does not yet use database-backed forced categorizations. It loads from `category-patterns.json` instead. 

To integrate forced categorizations into label.script.js:

1. Read the CSV row data (date, description, currency, amount)
2. Call `getForcedCategoryFromDb()` before applying automatic categorization
3. If a forced category is found, use it; otherwise apply the normal flow

Example enhancement:
```javascript
// In label.script.js processing loop
const forced = await getForcedCategoryFromDb(db, row.date, row.description, row.currency, row.amount);
const label = forced || assignCategory(row, columnMap, categoryDefs, '');
```

## Adding Forced Categorizations

### Method 1: Configuration File (Current)

Edit `config/forced-categories.json` and add entries:

```json
{
  "forced": [
    {
      "date": "2025-12-15",
      "description": "SOME TRANSACTION",
      "currency": "TND",
      "amount": 25.50,
      "category": "food/groceries"
    }
  ]
}
```

Then reload the database:
```bash
npm run db:insert -- --delete-all
```

### Method 2: Database Direct (Manual SQL)

Connect to the database and insert directly:

```sql
INSERT INTO forced_categorizations (date, description, currency_code, amount, category_label)
VALUES ('2025-12-15', 'SOME TRANSACTION', 'TND', 25.50, 'food/groceries');
```

## Matching Examples

### Exact Match (All Fields)
```
Stored:        2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Query:         2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Result:        ✓ MATCH
```

### Amount Within Tolerance
```
Stored:        2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Query:         2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.01
Difference:    0.01 (within ±0.02 tolerance)
Result:        ✓ MATCH
```

### Amount Outside Tolerance
```
Stored:        2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Query:         2025-11-15 | ABDERRAHMEN SELLAM | TND | 98.00
Difference:    2.00 (exceeds ±0.02 tolerance)
Result:        ✗ NO MATCH
```

### Different Date (No Match)
```
Stored:        2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Query:         2025-11-16 | ABDERRAHMEN SELLAM | TND | 100.00
Result:        ✗ NO MATCH (date must be exact)
```

### Different Description (Case-Sensitive)
```
Stored:        2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Query:         2025-11-15 | abderrahmen sellam | TND | 100.00
Result:        ✗ NO MATCH (description is case-sensitive)
```

### Currency Case-Insensitive
```
Stored:        2025-11-15 | ABDERRAHMEN SELLAM | TND | 100.00
Query:         2025-11-15 | ABDERRAHMEN SELLAM | tnd | 100.00
Result:        ✓ MATCH (currency codes are normalized to uppercase)
```

## Troubleshooting

**Issue:** Forced categorization not matching

1. Verify the row exists in the database:
   ```bash
   node src/scripts/check-forced.js --list
   ```

2. Check all components match exactly:
   - **date**: YYYY-MM-DD format, exact match required
   - **description**: Case-sensitive, exact match required
   - **currency**: Normalized to uppercase, but case-insensitive in queries
   - **amount**: Must be within ±0.02 of stored value

3. Verify category exists in `config/categories.json`

4. Reload database:
   ```bash
   npm run db:insert -- --delete-all
   ```

**Issue:** Multiple rows with same description but different amounts

Use the amount field to distinguish them. Each combination of (date, description, currency, amount) is unique.

**Issue:** Amount doesn't match (within tolerance)**

The tolerance is ±0.02. If amounts differ by more than that:
- Update the stored amount to match the actual value
- Or adjust the query amount to be within range

Example: If stored amount is 100.00 and query is 100.05, they won't match (0.05 > 0.02).

## Best Practices

1. **Use Exact Descriptions**: Copy the description exactly as it appears in the CSV
2. **Verify Before Adding**: Check that the category is correct before adding to forced list
3. **Clean Up Old Entries**: Remove forced categorizations once you've fixed the underlying rules
4. **Document Reasons**: Add comments in the JSON file explaining why certain rows are forced
5. **Test After Changes**: Run label pipeline after adding forced categorizations to verify behavior

