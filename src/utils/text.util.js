/**
 * Strip accents and lowercase for accent-insensitive matching.
 * @param {string} s
 * @returns {string}
 */
function normalizeStr(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Count how many tokens match value as whole words (word-boundary + accent normalization).
 * @param {string} value
 * @param {string[]} tokens
 * @returns {number}
 */
function countTokenMatches(value, tokens) {
  const normValue = normalizeStr(value);
  return tokens.reduce((count, token) => {
    const normToken = normalizeStr(token);
    const escaped = normToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return count + (new RegExp('\\b' + escaped + '\\b', 'i').test(normValue) ? 1 : 0);
  }, 0);
}

module.exports = { normalizeStr, countTokenMatches };
