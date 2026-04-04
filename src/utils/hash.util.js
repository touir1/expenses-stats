const crypto = require('crypto');

// Generate a hash for transaction identification (description + currency + amount)
// Used for deduplication and as part of forced categorization key (with date)
function hashExpense(description, currencyCode, amount) {
  const str = `${description}|${currencyCode}|${amount}`;
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

module.exports = { hashExpense };
