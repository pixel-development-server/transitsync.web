/**
 * TransitSync structured logger.
 *
 * One module owns how the server talks to a human: **Nepal Time** timestamps
 * (the console is operated from Kathmandu, so every operator-facing instant is
 * rendered in NPT — UTC+5:45 — even when the host clock runs in UTC), colour
 * coded levels, and fixed-width columns so a stream of requests stays skimmable
 * instead of collapsing into a wall of text.
 *
 * It has two sinks:
 *
 *   * the terminal — colour, column-aligned, one row per thing that happened;
 *   * a log file   — the same rows with the colour stripped, buffered in memory
 *                    and flushed every minute to `logs/server_activity.log`.
 *
 * The file is buffered on purpose. Writing to disk is the slow part of logging
 * an HTTP request that has *already* finished, so rows are collected and
 * flushed in one `appendFileSync` per minute. That keeps the request path free
 * of per-request syscalls while still bounding what is lost to a hard crash,
 * and `flushActivityLog()` is exported so callers can force a write at any
 * shutdown point ("every minute, or upon request").
 *
 * Deliberately standalone: this file imports only Node builtins and the pure
 * NPT formatter. It must load *before* the server's environment validation so
 * the startup supervisor can print its pre-flight report even when the app's
 * own config would refuse to boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NPT_TIME_ZONE } from './src/lib/time.js';

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------
const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

/**
 * Respect the conventions every other tool follows: `NO_COLOR` wins, then an
 * explicit `FORCE_COLOR`, otherwise colour only when stdout is a real terminal.
 * `FORCE_COLOR` matters here because the supervisor pipes the server's output —
 * without it every colour would vanish the moment we wrap the process.
 */
function colorsEnabled() {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

/** Wrap `text` in an SGR code, or pass it through when colour is off. */
function paint(text, code) {
  return colorsEnabled() && code ? `${code}${text}${SGR.reset}` : String(text);
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Remove colour so the on-disk copy stays plain text. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, '');
}

/**
 * Characters used purely for terminal decoration, folded to ASCII for the file
 * sink. The log is opened with tools that may assume the system code page
 * (PowerShell 5.1's `Get-Content` does), where a box-drawing rule or an em dash
 * arrives as mojibake. Only decoration is folded — genuine non-ASCII *content*
 * such as a Nepali name is passed through untouched so nothing is lost.
 */
const ASCII_FOLD = new Map([
  ['\u2013', '-'], // – en dash
  ['\u2014', '-'], // — em dash
  ['\u2500', '-'], // ─ box-drawing horizontal
  ['\u2502', '|'], // │ box-drawing vertical
  ['\u2022', '*'], // • bullet
  ['\u2026', '...'], // … ellipsis
  ['\u2018', "'"], // ‘
  ['\u2019', "'"], // ’
  ['\u201c', '"'], // “
  ['\u201d', '"'], // ”
  ['\u2192', '->'], // →
]);

/** Plain, grep-friendly text for the on-disk log. */
export function toFileText(text) {
  return stripAnsi(text).replace(/[\u2013\u2014\u2500\u2502\u2022\u2026\u2018\u2019\u201c\u201d\u2192]/g, (char) =>
    ASCII_FOLD.get(char),
  );
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------
/**
 * `SUCCESS` is a first-class level rather than an alias for INFO: a completed
 * migration and an informational heartbeat read very differently on a console
 * and the operator should be able to tell them apart at a glance.
 */
const LEVEL_STYLE = {
  DEBUG: { weight: 10, colour: SGR.gray, tag: 'DEBUG' },
  INFO: { weight: 20, colour: SGR.cyan, tag: 'INFO' },
  SUCCESS: { weight: 30, colour: SGR.green, tag: 'SUCCESS' },
  WARN: { weight: 40, colour: SGR.yellow, tag: 'WARN' },
  ERROR: { weight: 50, colour: SGR.red, tag: 'ERROR' },
};

const METHOD_COLOUR = {
  GET: SGR.cyan,
  POST: SGR.green,
  PUT: SGR.yellow,
  PATCH: SGR.magenta,
  DELETE: SGR.red,
  OPTIONS: SGR.gray,
  HEAD: SGR.gray,
};

function normalizeLevel(level) {
  const key = String(level ?? 'INFO').toUpperCase();
  return LEVEL_STYLE[key] ? key : 'INFO';
}

/** Map an HTTP status onto a level: 5xx is an error, 4xx a warning. */
export function levelForStatus(status) {
  const code = Number(status) || 0;
  if (code >= 500) return 'ERROR';
  if (code >= 400) return 'WARN';
  return 'INFO';
}

let minLevel = LEVEL_STYLE[normalizeLevel(process.env.LOG_LEVEL || 'INFO')].weight;

/** Raise or lower the console floor (the file sink always records everything). */
export function setLevel(level) {
  minLevel = LEVEL_STYLE[normalizeLevel(level)].weight;
  return minLevel;
}

function shouldPrint(level) {
  return LEVEL_STYLE[level].weight >= minLevel;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------
/**
 * Fixed widths keep rows aligned across a whole session.
 *  * time   — `YYYY-MM-DD HH:MM:SS` is exactly 19 characters;
 *  * level  — the longest tag (`SUCCESS`) is 7;
 *  * method — the longest verb (`OPTIONS`) is 7;
 *  * status — three digits;
 *  * ip     — a full IPv4 quad is 15; a longer IPv6 address simply overflows.
 */
const WIDTH = { time: 19, level: 7, method: 7, status: 3, ip: 15 };

/**
 * Pad a *plain* string to `width`. Colour must be applied **after** padding —
 * measuring a string that already contains escape codes would count them as
 * visible characters and every coloured column would drift out of alignment.
 */
function pad(value, width, align = 'left') {
  const text = String(value ?? '');
  if (text.length >= width) return text;
  return align === 'right' ? text.padStart(width, ' ') : text.padEnd(width, ' ');
}

/**
 * Nepal-Time stamp in a **sortable** form: `2026-10-15 20:14:03`.
 *
 * This deliberately does not reuse `lib/time.js`'s `formatNpt()`. That is the
 * display formatter and renders `en-GB` day-first (`15/10/2026`), which is
 * ambiguous in a log and sorts lexically by day-of-month rather than by instant.
 * A log wants the opposite, so the parts are assembled explicitly here, reusing
 * `NPT_TIME_ZONE` so the zone offset still lives in exactly one place.
 * `hourCycle: 'h23'` is pinned because some locales render midnight as `24:00`.
 */
const NPT_STAMP = new Intl.DateTimeFormat('en-GB', {
  timeZone: NPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = Object.fromEntries(NPT_STAMP.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// ---------------------------------------------------------------------------
// File sink — buffered, one append per flush
// ---------------------------------------------------------------------------
const buffer = [];
let flushTimer = null;
let cachedFile = null;

function logsDisabled() {
  return process.env.TS_TEST === '1' || process.env.NODE_ENV === 'test';
}

/** Absolute path of the activity log, overridable via `ACTIVITY_LOG_FILE`. */
export function activityLogPath() {
  if (cachedFile) return cachedFile;
  const override = process.env.ACTIVITY_LOG_FILE || process.env.TS_ACTIVITY_LOG;
  cachedFile = override
    ? path.resolve(SERVER_ROOT, override)
    : path.join(REPO_ROOT, 'logs', 'server_activity.log');
  return cachedFile;
}

function enqueue(line) {
  if (logsDisabled()) return;
  buffer.push(line);
  // Safety valve: if the process somehow never reaches a flush, don't let the
  // buffer grow without bound.
  if (buffer.length >= 5000) flushActivityLog();
}

/** Append everything buffered so far to disk. Never throws. */
export function flushActivityLog() {
  if (logsDisabled() || buffer.length === 0) return;
  const chunk = `${buffer.join('\n')}\n`;
  buffer.length = 0;
  try {
    const file = activityLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, chunk);
  } catch (error) {
    // A failed log write must never take the server down.
    process.stderr.write(`[logger] could not write activity log: ${error.message}\n`);
  }
}

/** Begin the once-a-minute flush. Idempotent; the timer is unref'd. */
export function startActivityLog({ intervalMs = 60_000 } = {}) {
  if (logsDisabled() || flushTimer) return;
  flushTimer = setInterval(flushActivityLog, intervalMs);
  flushTimer.unref?.();
  process.once('exit', flushActivityLog);
}

export function stopActivityLog() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushActivityLog();
}

// ---------------------------------------------------------------------------
// Core emitters
// ---------------------------------------------------------------------------
function writeFor(level, text) {
  const stream = LEVEL_STYLE[level].weight >= LEVEL_STYLE.WARN.weight ? process.stderr : process.stdout;
  stream.write(`${text}\n`);
}

/** `2026-10-15 20:14:03 INFO    message` */
function eventLine(level, message) {
  const style = LEVEL_STYLE[level];
  const time = timestamp();
  const head = `${paint(pad(time, WIDTH.time), SGR.gray)} ${paint(pad(style.tag, WIDTH.level), style.colour)} `;
  return { console: `${head}${message}`, file: `${pad(time, WIDTH.time)} ${pad(style.tag, WIDTH.level)} ${toFileText(message)}` };
}

/**
 * Emit one structured event. `message` may contain colour; the file copy strips
 * it so the on-disk log stays greppable.
 */
export function log(level, message) {
  const key = normalizeLevel(level);
  if (shouldPrint(key)) writeFor(key, eventLine(key, message).console);
  enqueue(eventLine(key, message).file);
}

export const debug = (message) => log('DEBUG', message);
export const info = (message) => log('INFO', message);
export const success = (message) => log('SUCCESS', message);
export const warn = (message) => log('WARN', message);
export const error = (message) => log('ERROR', message);

/**
 * A tidy block of `label  value` rows sharing one label column — the readable
 * way to print the startup banner without a wall of text.
 */
export function fields(level, pairs) {
  const labelWidth = pairs.reduce((max, [label]) => Math.max(max, String(label).length), 0);
  for (const [label, value] of pairs) {
    log(level, `${paint(pad(String(label), labelWidth), SGR.gray)}  ${paint(String(value), SGR.white)}`);
  }
}

/** A single emphasised heading, underlined to the width of its text. */
export function heading(text, { accent = SGR.cyan } = {}) {
  log('INFO', paint(text, `${SGR.bold}${accent}`));
  log('INFO', paint('─'.repeat(stripAnsi(text).length), SGR.dim));
}

// ---------------------------------------------------------------------------
// HTTP middleware
// ---------------------------------------------------------------------------
function clientAddress(req) {
  // `trust proxy` is on, so req.ip already honours X-Forwarded-For; the IPv6
  // prefix is stripped so an IPv4 client reads as `127.0.0.1`, not `::ffff:...`.
  const raw = req.ip || req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '') || '-';
}

function columnsOf(entry) {
  return {
    time: pad(entry.time, WIDTH.time),
    level: pad(entry.level, WIDTH.level),
    method: pad(entry.method, WIDTH.method),
    status: pad(String(entry.status), WIDTH.status, 'right'),
    ip: pad(entry.ip, WIDTH.ip),
    path: entry.path,
  };
}

function consoleHttp(entry) {
  const c = columnsOf(entry);
  const statusColour =
    entry.status >= 500 ? SGR.red : entry.status >= 400 ? SGR.yellow : entry.status >= 300 ? SGR.cyan : SGR.green;
  return [
    paint(c.time, SGR.gray),
    paint(c.level, LEVEL_STYLE[entry.level].colour),
    paint(c.method, METHOD_COLOUR[entry.method] ?? SGR.white),
    paint(c.status, statusColour),
    paint(c.ip, SGR.gray),
    paint(c.path, SGR.white),
    paint(`${Math.round(entry.durationMs)}ms`, SGR.dim),
  ].join(' ');
}

/** Same six columns, no colour, with the User-Agent appended for the record. */
function fileHttp(entry) {
  const c = columnsOf(entry);
  const parts = [c.time, c.level, c.method, c.status, c.ip, toFileText(c.path), `${Math.round(entry.durationMs)}ms`];
  if (entry.userAgent) parts.push(toFileText(entry.userAgent));
  return parts.join(' ');
}

function emitHttp(entry) {
  if (shouldPrint(entry.level)) writeFor(entry.level, consoleHttp(entry));
  enqueue(fileHttp(entry));
}

/**
 * Express middleware: one aligned row per request, the moment it completes.
 *
 * `res.on('finish')` covers normal responses; `res.on('close')` catches clients
 * that hang up mid-request (and long-lived SSE streams, which only ever close).
 * A guard makes sure a single request can never be logged twice, and the whole
 * body is wrapped so a logging failure can never break a response.
 */
export function requestLogger({ healthLevel = 'DEBUG', quiet = ['/api/health'] } = {}) {
  const quietPrefixes = quiet;
  return function activityLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    let logged = false;

    const record = () => {
      if (logged) return;
      logged = true;
      try {
        const path = req.originalUrl || req.url || '-';
        const isQuiet = quietPrefixes.some((prefix) => path.startsWith(prefix));
        emitHttp({
          time: timestamp(),
          level: isQuiet ? healthLevel : levelForStatus(res.statusCode),
          method: req.method,
          status: res.statusCode,
          ip: clientAddress(req),
          path,
          userAgent: req.headers['user-agent'] || '',
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        });
      } catch {
        /* logging must never affect the response */
      }
    };

    res.on('finish', record);
    res.on('close', record);
    next();
  };
}

export default {
  log,
  debug,
  info,
  success,
  warn,
  error,
  fields,
  heading,
  setLevel,
  requestLogger,
  levelForStatus,
  flushActivityLog,
  startActivityLog,
  stopActivityLog,
  activityLogPath,
  timestamp,
  stripAnsi,
};
