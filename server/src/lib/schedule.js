/**
 * NPT schedule helpers for route/bus operational windows.
 *
 * This is the server-side twin of the client's `utils/busStatus.js`: a route is
 * only "live" while the current **Nepal Standard Time** (UTC+5:45) sits strictly
 * inside its `departure_time` → `arrival_time` window. Departure is inclusive and
 * arrival is exclusive, so a 06:45–07:50 service reads `live` at 07:49 and
 * `completed` at 07:50 — and, at 13:22, `completed` rather than a bogus "Live".
 */

import { NPT_TIME_ZONE } from './time.js';

/** Parse HH:MM (or HH:MM:SS) to total minutes since midnight. */
export function parseMinutesSinceMidnight(value) {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(value).trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** Get current minutes since midnight in NPT (Asia/Kathmandu). */
export function nowNptMinutesSinceMidnight(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NPT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** Is `now` (NPT minutes) inside [start, end)? */
export function isInScheduleWindow({ start, end, now = nowNptMinutesSinceMidnight() }) {
  const s = parseMinutesSinceMidnight(start);
  const e = parseMinutesSinceMidnight(end);
  if (s == null || e == null || now == null) return false;
  if (e >= s) {
    // Normal window (e.g., 06:45–07:50): live from departure up to arrival.
    return now >= s && now < e;
  }
  // Crosses midnight (rare): live on either leg.
  return now >= s || now < e;
}

/**
 * Operational state of a schedule window at the current NPT instant.
 *
 * - `live`      — now sits inside the departure→arrival window;
 * - `offline`   — the window has not opened yet (or no timetable is stored);
 * - `completed` — the window has closed for today.
 *
 * Mirrors the client classifier `evaluateBusStatus()` (which splits `offline`
 * into `scheduled` / `upcoming`); anything other than `live` must never render
 * as "Live".
 */
export function scheduleState({ start, end, now = nowNptMinutesSinceMidnight() }) {
  const s = parseMinutesSinceMidnight(start);
  const e = parseMinutesSinceMidnight(end);
  if (s == null || e == null || now == null) return 'offline';

  if (e >= s) {
    if (now < s) return 'offline';
    return now >= e ? 'completed' : 'live';
  }

  // Crosses midnight: live on [s, 24:00) ∪ [0, e). The gap (e, s) splits at
  // its midpoint — right after the window reads `completed`, right before it
  // reads `offline`.
  if (now >= s || now < e) return 'live';
  return now - e <= (s - e) / 2 ? 'completed' : 'offline';
}

/** Display label for a `scheduleState()` result. */
export function scheduleLabel(state) {
  return state === 'live' ? 'Live' : state === 'completed' ? 'Completed' : 'Offline';
}
