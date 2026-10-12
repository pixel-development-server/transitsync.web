export function toCsv(columns, rows) {
  const headers = columns.map((c) => c.label ?? c.key ?? c).join(',');
  const lines = rows.map((row) => {
    return columns
      .map((col) => {
        const key = col.key ?? col;
        const val = row[key];
        const s = val === null || val === undefined ? '' : String(val).replace(/"/g, '""');
        return `"${s}"`;
      })
      .join(',');
  });
  return [headers, ...lines].join('\n');
}

export function timestampedFilename(name, ext) {
  return `${name}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
