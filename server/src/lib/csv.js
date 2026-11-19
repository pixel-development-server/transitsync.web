/** RFC 4180 compliant CSV serialisation. */

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Guard against CSV/formula injection when the file is opened in Excel.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * @param {Array<{key:string,label:string,format?:(value:any,row:any)=>any}>} columns
 * @param {Array<object>} rows
 */
export function toCsv(columns, rows) {
  const header = columns.map((column) => escapeCell(column.label)).join(',');
  const body = rows.map((row) =>
    columns
      .map((column) => escapeCell(column.format ? column.format(row[column.key], row) : row[column.key]))
      .join(','),
  );
  // BOM keeps Excel happy with UTF-8 student names.
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

/**
 * Parse raw CSV text into a matrix of cell strings (RFC 4180).
 *
 * Hand-rolled rather than pulled from a dependency, for the same reason `toCsv`
 * is: the grammar is tiny, and the only genuinely fiddly parts are quoted
 * fields. This handles exactly what our own exports emit and what users paste
 * back in:
 *
 *   - an optional leading UTF-8 BOM (Excel and `toCsv` both write one),
 *   - CRLF or bare LF record separators (and a lone CR),
 *   - quoted fields, including a doubled quote ("") as a literal `"`,
 *   - commas and newlines *inside* quotes,
 *   - a trailing newline, which must not produce a spurious empty record.
 *
 * Returns `string[][]` — one inner array per record, cells in file order.
 */
export function parseCsvRows(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Set when the current field began with a quote, so a final `""` (an empty but
  // deliberately quoted cell) is still emitted even though `field` is ''.
  let quotedField = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          // "" inside a quoted field is an escaped quote, not the terminator.
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        // Commas and newlines are literal data while inside quotes.
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      quotedField = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      quotedField = false;
    } else if (char === '\r' || char === '\n') {
      // Consume CRLF as a single record separator.
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      quotedField = false;
    } else {
      field += char;
    }
  }

  // Flush the final record unless the document ended exactly on a separator (in
  // which case there is nothing left to emit — a trailing newline is normal).
  if (field !== '' || row.length > 0 || quotedField) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parse CSV text into an array of objects keyed by the (trimmed) header row.
 *
 * A header-only document yields `[]`. Fully blank lines are skipped so a stray
 * newline at the end of the file never becomes a phantom record. Cells for a
 * column the header omits are simply absent from the object — callers can use
 * `key in row` to distinguish "empty cell" from "no such column", which is what
 * lets the student import leave untouched fields alone on an update.
 */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => cell.trim());
  const records = [];

  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    // Skip a fully-empty line (a single blank cell): it carries no record.
    if (cells.length === 1 && cells[0].trim() === '') continue;

    const record = {};
    header.forEach((key, column) => {
      // Unnamed trailing columns (a stray comma in the header) are ignored.
      if (!key) return;
      record[key] = cells[column] ?? '';
    });
    records.push(record);
  }

  return records;
}

export function timestampedFilename(base, extension) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}-${stamp}.${extension}`;
}

export default { toCsv, parseCsv, parseCsvRows, timestampedFilename };
