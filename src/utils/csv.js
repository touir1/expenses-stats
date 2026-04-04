/**
 * Parse a single CSV line, respecting quoted fields.
 * Handles: quoted fields, commas inside quotes, escaped double-quotes ("").
 * @param {string} line
 * @returns {string[]}
 */
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let field = '';
      let closed = false;
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; closed = true; break; }
        else { field += line[i++]; }
      }
      if (!closed) throw new Error(`Malformed CSV: unclosed quoted field near: ${line.slice(0, 40)}`);
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

module.exports = { parseCSVLine };
