/**
 * MySQL hands back bare `YYYY-MM-DD HH:MM:SS` strings (`dateStrings: true` on
 * the pool), and because the session timezone is `+05:45` they are **Nepal
 * Time wall clocks** — the very shape `NOW()` stamps rows with.
 *
 * Passing that straight to `new Date()` is a trap: without an offset, V8 treats
 * it as *local* time, so on a UTC host the instant lands 5:45 in the wrong
 * direction — a freshly issued 8-hour session could compare as already expired
 * (or as never expiring at all). Every comparison against a stored timestamp
 * must therefore go through here so the value is read as the NPT it actually
 * is.
 *
 * Values that carry an explicit zone (`Z`, `+05:45`, any ISO offset) are taken
 * at face value, and date-only strings stay calendar dates (no shift).
 */
export function parseNptStamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);

  const text = String(value).trim();
  const isBareNpt = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text);

  const parsed = new Date(isBareNpt ? `${text.replace(' ', 'T')}+05:45` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when `value` is a timestamp strictly in the past. `null` counts as expired. */
export function isExpired(value, at = new Date()) {
  const date = parseNptStamp(value);
  if (!date) return true;
  return date.getTime() < at.getTime();
}

/** The wall-clock stamp shape every stored timestamp uses (`NOW()` output). */
export function nowNptStamp(at = new Date()) {
  return new Date(at.getTime() + NPT_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Nepal Time. The whole console is operated out of Kathmandu, so staff-facing
 * timestamps are rendered in NPT (UTC+5:45) rather than the server's zone.
 *
 * Storage is NPT wall time end-to-end — `NOW()` stamps rows in `+05:45` — so
 * these helpers only ever *present* an instant or derive a calendar day from
 * one, they never rewrite a zone.
 */
export const NPT_TIME_ZONE = 'Asia/Kathmandu';
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

/** Format an instant as Nepali Time, e.g. `2026-10-09 19:14:03`. */
export function formatNpt(value = new Date(), { seconds = true } = {}) {
  const date = parseNptStamp(value) ?? new Date(value);
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
  const date = parseNptStamp(value) ?? new Date(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + NPT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Normalise a device-supplied timestamp to the NPT wall-clock string the
 * tables store.
 *
 * Accepts ISO-8601 with an offset, epoch milliseconds (13 digits) or seconds
 * (10 digits), or an already-bare `YYYY-MM-DD HH:MM:SS` stamp (read as NPT,
 * so re-stamping it is a no-op). Returns `null` when the value is absent or
 * unparseable, letting callers fall back to `NOW()`.
 */
export function toNptStamp(value) {
  if (value === null || value === undefined || value === '') return null;

  let date;
  if (typeof value === 'number') {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = parseNptStamp(value);
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return nowNptStamp(date);
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
  parseNptStamp,
  isExpired,
  nowNptStamp,
  parseDurationMs,
  formatNpt,
  nptDay,
  toNptStamp,
  NPT_TIME_ZONE,
};