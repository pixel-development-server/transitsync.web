/**
 * SQLite has no native date type. `datetime('now')` always yields **UTC** in the
 * form `YYYY-MM-DD HH:MM:SS`, with no zone suffix.
 *
 * Passing that straight to `new Date()` is a trap: without an offset, V8 treats
 * it as *local* time. On any host whose clock is behind UTC the parsed instant
 * lands in the past, so a freshly issued 8-hour session compares as already
 * expired. Every comparison against a stored timestamp must therefore go
 * through here so the value is interpreted as the UTC it actually is.
 */
export function parseSqliteDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);

  const text = String(value).trim();
  const isSqliteUtc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text);

  const parsed = new Date(isSqliteUtc ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when `value` is a timestamp strictly in the past. `null` counts as expired. */
export function isExpired(value, at = new Date()) {
  const date = parseSqliteDate(value);
  if (!date) return true;
  return date.getTime() < at.getTime();
}

/** SQLite's `datetime('now')` string, for comparisons done inside SQL-free JS. */
export function sqliteNowUtc(at = new Date()) {
  return at.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Nepal Time. The whole console is operated out of Kathmandu, so staff-facing
 * timestamps are rendered in NPT (UTC+5:45) rather than the server's zone.
 *
 * Storage stays UTC — every `scan_events.scan_time` is `datetime('now')` — so
 * these helpers only ever *present* an instant, they never rewrite one.
 */
export const NPT_TIME_ZONE = 'Asia/Kathmandu';
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

/** Format an instant as Nepali Time, e.g. `2026-10-09 19:14:03`. */
export function formatNpt(value = new Date(), { seconds = true } = {}) {
  const date = parseSqliteDate(value) ?? new Date(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: NPT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  })
    .format(date)
    .replace(',', '');
}

/** Nepali calendar day (`YYYY-MM-DD`) for an instant. */
export function nptDay(value = new Date()) {
  const date = parseSqliteDate(value) ?? new Date(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + NPT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Normalise a device-supplied timestamp to a UTC SQLite string.
 *
 * Accepts ISO-8601 with an offset, epoch milliseconds (13 digits) or seconds
 * (10 digits), or an already-`SQLite`-shaped UTC string. Returns `null` when the
 * value is absent or unparseable, letting callers fall back to `datetime('now')`.
 */
export function toUtcSqlite(value) {
  if (value === null || value === undefined || value === '') return null;

  let date;
  if (typeof value === 'number') {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = parseSqliteDate(value);
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return sqliteNowUtc(date);
}

const DURATION_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Parse a `jsonwebtoken`-style duration string into milliseconds.
 *
 * `JWT_EXPIRES_IN` is '8h' / '30d' / '900'. `Number.parseInt('8h', 10)` returns
 * `8`, which is truthy — so a naive `parseInt(...) || fallback` silently yields
 * an **8 millisecond** session instead of 8 hours. Always go through here.
 *
 * @param {string|number} value
 * @param {number} fallbackMs used when the value is missing or unparseable
 */
export function parseDurationMs(value, fallbackMs = 8 * 3_600_000) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Bare numbers follow the jsonwebtoken convention of seconds.
    return value > 0 ? value * 1000 : fallbackMs;
  }
  if (typeof value !== 'string') return fallbackMs;

  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(value);
  if (!match) return fallbackMs;

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = unit === 'ms' ? 1 : DURATION_UNITS[unit];

  if (!Number.isFinite(amount) || !multiplier || amount <= 0) return fallbackMs;
  return amount * multiplier;
}

export default {
  parseSqliteDate,
  isExpired,
  sqliteNowUtc,
  parseDurationMs,
  formatNpt,
  nptDay,
  toUtcSqlite,
  NPT_TIME_ZONE,
};