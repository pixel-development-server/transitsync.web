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

export function timestampedFilename(base, extension) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}-${stamp}.${extension}`;
}

export default { toCsv, timestampedFilename };
