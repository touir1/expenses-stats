/**
 * Strip accents and lowercase for accent-insensitive matching.
 * @param {string} s
 * @returns {string}
 */
function normalizeStr(s) {
  return String(s)
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035`]/g, "'") // curly/typographic apostrophes → straight
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // curly quotes → straight
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')  // typographic dashes → hyphen
    .replace(/[œŒ]/g, 'oe')                                   // ligatures: œ → oe
    .replace(/[æÆ]/g, 'ae')                                   // ligatures: æ → ae
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Match tokens against a value, returning both count and total matched character length.
 * Used for scoring and coverage calculation.
 * @param {string} value
 * @param {string[]} tokens
 * @returns {{ count: number, matchedChars: number, descLength: number }}
 */
function matchTokens(value, tokens) {
  const normValue = normalizeStr(value);
  let count = 0;
  let matchedChars = 0;
  for (const token of tokens) {
    const normToken = normalizeStr(token);
    const escaped = normToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b' + escaped + '\\b', 'i').test(normValue)) {
      count++;
      matchedChars += normToken.length;
    }
  }
  return { count, matchedChars, descLength: normValue.length };
}

/**
 * Count how many tokens match value as whole words (word-boundary + accent normalization).
 * @param {string} value
 * @param {string[]} tokens
 * @returns {number}
 */
function countTokenMatches(value, tokens) {
  return matchTokens(value, tokens).count;
}

module.exports = { normalizeStr, countTokenMatches, matchTokens };
