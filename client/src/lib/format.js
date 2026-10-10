/**
 * Formatting helpers.
 *
 * The API returns SQLite timestamps as `YYYY-MM-DD HH:MM:SS` in **UTC** with no
 * zone marker. Passing those straight to `new Date()` makes browsers treat them
 * as local time, which silently shifts every scan by the viewer's offset — on
 * this project it rendered times up to 5h45m off in Kathmandu. `parseSqlDate`
 * pins them to UTC explicitly; plain ISO strings (`2026-10-02T10:32:41Z`) are
 * already zoned and pass through untouched.
 */

const SQL_DATE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/** Parse an API timestamp as UTC. Returns null for empty/invalid input. */
export function parseSqlDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const match = SQL_DATE.exec(value);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }

  // Date-only values (`2024-11-30`) are calendar dates, not instants: anchoring
  // them to local midnight avoids the previous day appearing after rounding.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, mo, d] = value.split('-').map(Number);
    return new Date(y, mo - 1, d);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  // The console is operated out of Kathmandu, so every instant is rendered in
  // Nepal Time (UTC+5:45) regardless of the viewer's device timezone.
  timeZone: 'Asia/Kathmandu',
});

const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Kathmandu',
});

const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kathmandu',
});

export const NPT_TIME_ZONE = 'Asia/Kathmandu';

/** `HH:MM` in Nepal Time, with an explicit `NPT` suffix for dense feeds. */
export const formatNptTime = (value) => {
  const date = parseSqlDate(value);
  return date ? `${TIME_FMT.format(date)} NPT` : '—';
};

/** `DD Mon HH:MM` in Nepal Time, suffixed with `NPT`. */
export const formatNptDateTime = (value) => {
  const date = parseSqlDate(value);
  return date ? `${DATETIME_FMT.format(date)} NPT` : '—';
};

/** `YYYY-MM-DD` Nepal calendar day (independent of the viewer's zone). */
export const formatNptDate = (value) => {
  const date = parseSqlDate(value);
  if (!date) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts;
};

export const formatTime = (value) => {
  const date = parseSqlDate(value);
  return date ? TIME_FMT.format(date) : '—';
};

export const formatDateTime = (value) => {
  const date = parseSqlDate(value);
  return date ? DATETIME_FMT.format(date) : '—';
};

export const formatFull = (value) => {
  const date = parseSqlDate(value);
  return date ? FULL_FMT.format(date) : '—';
};

export function formatRelative(value) {
  const date = parseSqlDate(value);
  if (!date) return '—';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const fmt = (n, unit) => {
    const rounded = Math.round(n);
    const label = `${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
    return future ? `in ${label}` : `${label} ago`;
  };

  if (abs < 45) return future ? 'in a moment' : 'just now';
  if (abs < 3600) return fmt(abs / 60, 'min');
  if (abs < 86400) return fmt(abs / 3600, 'hour');
  if (abs < 2592000) return fmt(abs / 86400, 'day');
  return formatDateTime(value);
}

/** `2026-10-03` for <input type="date"> bounds and API query params. */
export function toDateInput(value) {
  const date = parseSqlDate(value);
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const todayInput = () => toDateInput(new Date());

export function daysAgoInput(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toDateInput(date);
}

export const formatNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat().format(value)
    : '—';

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const formatPercent = (value, digits = 0) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(digits)}%`
    : '—';

/** Initials for avatars; tolerates null/undefined names. */
export function initials(name) {
  if (!name) return '??';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function titleCase(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Truncate long free-text fields (alert messages, audit details). */
export function truncate(value, max = 80) {
  if (!value) return '';
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}