#!/usr/bin/env node
/**
 * TransitSync startup supervisor — a txAdmin-style pre-flight gate.
 *
 * Before the API is allowed to listen, this scans the watched folders, syntax
 * checks every JavaScript file and parses every JSON file, and refuses to start
 * anything if a single problem is found. The idea is that a typo that would
 * otherwise crash the server *after* it has half-initialised (and possibly left
 * a half-migrated database) instead stops it before the first line of app code
 * runs.
 *
 * Flow:
 *
 *   scan  ─►  validate  ─►  zero errors?  ─┬─ no  ─► report count, exit(1)
 *                                          └─ yes ─► spawn the API
 *
 * In `--dev` mode the same gate runs on every change: a clean change restarts
 * the API, a broken one is reported and the last good process is left running.
 * The startup gate itself is absolute — a broken tree never starts.
 *
 * Logging is delegated to `logger.js` so the supervisor and the API speak the
 * same Nepal-Time, colour-coded language.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as logger from './logger.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SERVER_DIR, '..');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const JSON_EXTENSIONS = new Set(['.json']);
// JSX/TSX cannot be parsed by `node --check` (it has no JSX grammar), so they
// are reported and skipped rather than treated as failures.
const UNSUPPORTED_EXTENSIONS = new Set(['.jsx', '.tsx', '.ts']);

/** Directories never worth descending into. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.cache',
  'logs',
  'data',
  'backups',
  'certs',
]);

/**
 * The folders watched, named the way the operator thinks about them.
 *
 * `routes` and `database` are listed explicitly for clarity even though both
 * live *inside* `server/src`; `pruneNested()` drops them so nothing is scanned
 * twice while the intent stays legible.
 */
const WATCH_DIRS = [
  { label: 'server', dir: 'server' },
  { label: 'routes', dir: 'server/src/routes' },
  { label: 'database', dir: 'server/src/db' },
  { label: 'public', dir: 'client/public' },
  { label: 'scripts', dir: 'scripts' },
];

/** Standalone config files that sit outside every watch folder. */
const WATCH_FILES = ['ecosystem.config.js', 'package.json'];

const CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = new Set(process.argv.slice(2));
const OPTIONS = {
  dev: argv.has('--dev') || argv.has('--watch') || process.env.SUPERVISOR_WATCH === '1',
  check: argv.has('--check') || argv.has('--dry-run'),
  help: argv.has('--help') || argv.has('-h'),
};

function printHelp() {
  const lines = [
    'TransitSync supervisor',
    '',
    'Usage: node supervisor.js [options]',
    '',
    'Options',
    '  --dev, --watch   re-check and restart the API on file changes',
    '  --check          run the pre-flight gate only, then exit (no server)',
    '  --help, -h       show this help',
    '',
    'Exit codes',
    '  0  every check passed (and, unless --check, the server ran to completion)',
    '  1  a syntax or integrity error was found — the server was NOT started',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/');

/** Drop any entry that is already contained by another entry. */
function pruneNested(entries) {
  const resolved = entries.map((entry) => ({ ...entry, abs: path.resolve(ROOT, entry.dir) }));
  return resolved.filter(
    (entry) =>
      !resolved.some(
        (other) =>
          other.abs !== entry.abs && (entry.abs + path.sep).startsWith(other.abs + path.sep),
      ),
  );
}

async function walk(dir, files) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

async function collectFiles(dirs) {
  const files = [];
  const missing = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir.abs)) {
      missing.push(dir.label);
      continue;
    }
    await walk(dir.abs, files);
  }
  for (const extra of WATCH_FILES) {
    const full = path.resolve(ROOT, extra);
    if (fs.existsSync(full)) files.push(full);
  }
  return { files: files.sort(), missing };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
let tempCounter = 0;

function runNodeCheck(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ ok: false, message: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, message: stderr.trim() }));
  });
}

/**
 * Syntax check a JS file.
 *
 * `node --check` decides module-vs-script from the file's extension and the
 * nearest package.json `type`. A `.js` file whose package.json cannot be seen
 * (or that simply uses the other convention) can therefore report a bogus
 * "Cannot use import statement outside a module" failure. Before declaring an
 * error we re-check the source as an ES module in a temp file, so only code
 * that is invalid *both* ways is ever reported.
 */
async function checkSyntax(file) {
  const primary = await runNodeCheck(file);
  if (primary.ok) return { ok: true };

  let source;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, message: primary.message || error.message };
  }
  if (!/\b(import|export)\b/.test(source)) return { ok: false, message: primary.message };

  const probe = path.join(os.tmpdir(), `ts-supervisor-${process.pid}-${tempCounter++}.mjs`);
  try {
    await fs.promises.writeFile(probe, source, 'utf8');
    const asModule = await runNodeCheck(probe);
    if (asModule.ok) return { ok: true };
    return { ok: false, message: primary.message || asModule.message };
  } catch (error) {
    return { ok: false, message: primary.message || error.message };
  } finally {
    await fs.promises.rm(probe, { force: true }).catch(() => {});
  }
}

async function checkJson(file) {
  try {
    JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function checkFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) return checkSyntax(file);
  if (JSON_EXTENSIONS.has(ext)) return checkJson(file);
  return { ok: true, skipped: true };
}

/**
 * Condense a validator's output into one reportable line.
 *
 * `node --check` emits `<file>:<line>` followed by the offending source line and
 * a `SyntaxError: …`; the caller already prints the path, so the location header
 * is dropped to avoid showing it twice, and the human-readable error is placed
 * last where it is easiest to scan.
 */
function summarize(message) {
  const lines = String(message ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines.filter((line) => !/^.+:\d+(:\d+)?$/.test(line));
  const detail = body.find((line) => !/error/i.test(line));
  const problem = body.find((line) => /error/i.test(line));
  return [detail, problem].filter(Boolean).join(' — ').slice(0, 220) || lines[0]?.slice(0, 220) || 'invalid syntax';
}

async function validate(files) {
  const errors = [];
  const queue = [...files];
  let unsupported = 0;

  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      if (UNSUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        unsupported += 1;
        continue;
      }
      const result = await checkFile(file);
      if (!result.ok) errors.push({ file, message: summarize(result.message) });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  return { errors, unsupported };
}

// ---------------------------------------------------------------------------
// Database pre-flight (MySQL connectivity + schema integrity)
// ---------------------------------------------------------------------------
/**
 * Validate that MySQL is reachable and the TransitSync schema is present before
 * the API is allowed to boot. This is the proposal's "startup supervisor" gate:
 * on any failure the boot halts (`process.exit(1)`) instead of letting the
 * server come up against a missing or half-migrated database.
 */
async function checkDatabase() {
  const target = `mysql://${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}/${
    process.env.DB_NAME || 'transitsync'
  }`;
  let dbModule = null;
  try {
    dbModule = await import(pathToFileURL(path.join(SERVER_DIR, 'db.js')).href);
    const row = await dbModule.ping();
    const [[meta]] = await dbModule.adminPool.query(
      'SELECT COUNT(*) AS tables_present FROM information_schema.tables WHERE table_schema = ?',
      [process.env.DB_NAME || 'transitsync'],
    );
    logger.fields('INFO', [
      ['database', target],
      ['server tz', `${row.time_zone} (NPT wall-clock)`],
      ['tables', String(meta.tables_present)],
    ]);
    if (!meta.tables_present) {
      logger.error(
        `Database "${process.env.DB_NAME || 'transitsync'}" has no tables. Run \`npm run migrate\` first.`,
      );
      return false;
    }
    logger.success('MySQL reachable and schema present.');
    return true;
  } catch (error) {
    logger.error(`MySQL pre-flight failed for ${target}: ${error.message}`);
    logger.error('Set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME in server/.env and ensure MySQL is running.');
    return false;
  } finally {
    // The supervisor only pings; its pools must not hold the event loop open
    // in --check mode (the API child owns its own pools in a separate process).
    if (dbModule) await dbModule.closeDb();
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
async function preflight({ announce = true } = {}) {
  const startedAt = Date.now();
  const dirs = pruneNested(WATCH_DIRS);
  const { files, missing } = await collectFiles(dirs);

  if (announce) {
    logger.heading('TransitSync pre-flight');
    logger.fields('INFO', [
      ['folders', dirs.map((dir) => dir.label).join(', ')],
      ['files', `${files.length} to check`],
    ]);
  }

  for (const label of missing) {
    logger.warn(`Watch folder "${label}" was not found — skipped.`);
  }

  logger.info('Validating MySQL connectivity …');
  const dbOk = await checkDatabase();

  const { errors, unsupported } = await validate(files);
  const elapsed = Date.now() - startedAt;

  if (unsupported) {
    logger.warn(`${unsupported} file(s) skipped (JSX/TypeScript cannot be parsed by node --check).`);
  }

  if (!dbOk) {
    logger.error('MySQL pre-flight failed — the API was not started.');
    return { ok: false, errors: [{ file: 'mysql', message: 'connectivity/schema check failed' }], files: files.length, elapsed };
  }

  if (errors.length) {
    for (const { file, message } of errors) {
      logger.error(`${rel(file)}: ${message}`);
    }
    logger.error(`${errors.length} error(s) in ${files.length} file(s) after ${elapsed}ms.`);
    return { ok: false, errors, files: files.length, elapsed };
  }

  logger.success(`All ${files.length} file(s) passed syntax and integrity checks in ${elapsed}ms.`);
  return { ok: true, errors: [], files: files.length, elapsed };
}

// ---------------------------------------------------------------------------
// Running the API
// ---------------------------------------------------------------------------
let child = null;
let stopping = false;
let restarting = false;

function childEnv() {
  const env = { ...process.env };
  // The API is piped through this supervisor, so its stdout is not a TTY and
  // any TTY-aware colour would be dropped. Force it when the *operator's*
  // terminal can show colour.
  if (process.stdout.isTTY && env.FORCE_COLOR === undefined) env.FORCE_COLOR = '1';
  return env;
}

function launch() {
  logger.success('Pre-flight clean — starting the TransitSync API.');
  logger.info(`Command: node src/index.js   (cwd ${rel(SERVER_DIR)})`);

  child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Stream the API's output live, byte-for-byte, so its own colour-coded rows
  // reach the terminal exactly as written.
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  child.on('error', (error) => {
    logger.error(`Failed to start the API: ${error.message}`);
    logger.flushActivityLog();
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    child = null;
    // A deliberate restart swallows its own exit; the watcher relaunches.
    if (stopping || restarting) return;
    if (code === 0) {
      logger.info('API exited cleanly.');
      logger.stopActivityLog();
      process.exit(0);
    }
    logger.error(`API exited unexpectedly${signal ? ` (${signal})` : ` with code ${code}`}.`);
    logger.flushActivityLog();
    process.exit(code ?? 1);
  });
}

function restart() {
  const previous = child;
  restarting = true;
  if (!previous) {
    restarting = false;
    launch();
    return;
  }
  previous.once('exit', () => {
    restarting = false;
    launch();
  });
  previous.kill();
}

const WATCHABLE = /\.(js|mjs|cjs|json)$/i;
const IGNORED_SEGMENTS = [...EXCLUDED_DIRS].map((dir) => `${path.sep}${dir}${path.sep}`);

function shouldReact(filename) {
  if (!filename) return true;
  if (!WATCHABLE.test(filename)) return false;
  const marker = `${path.sep}${filename}`;
  return !IGNORED_SEGMENTS.some((segment) => marker.includes(segment));
}

/** Validate a small, specific set of files (watch mode). */
async function validateFiles(files) {
  const errors = [];
  for (const file of files) {
    if (UNSUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const result = await checkFile(file);
    if (!result.ok) errors.push({ file, message: summarize(result.message) });
  }
  return errors;
}

function startWatcher(dirs) {
  logger.info('Watch mode on — re-checking changed files and restarting.');
  const dirty = new Set();
  let debounce = null;

  const onChange = (_event, filename) => {
    if (!shouldReact(filename)) return;

    // `filename` is relative to whichever watched root produced the event, and
    // fs.watch does not say which one, so resolve against all of them and keep
    // the ones that are real files (a delete simply matches nothing).
    for (const dir of dirs) {
      const candidate = path.resolve(dir.abs, filename ?? '');
      try {
        if (fs.statSync(candidate).isFile()) dirty.add(candidate);
      } catch {
        /* vanished between the event and the stat — nothing to check */
      }
    }

    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (dirty.size === 0) return;
      const batch = [...dirty];
      dirty.clear();
      const what = batch.length === 1 ? rel(batch[0]) : `${batch.length} files`;
      logger.info(`Change detected: ${what} — re-checking.`);

      // Only the changed files are re-validated. A full sweep spawns one Node
      // process per file (~5s across this tree), far too slow to run on every
      // save; the tree was already verified end-to-end at startup.
      const errors = await validateFiles(batch);
      if (errors.length) {
        for (const { file, message } of errors) logger.error(`${rel(file)}: ${message}`);
        logger.warn('Change has errors — keeping the last good API running.');
        return;
      }
      logger.success('Change clean — restarting the API.');
      restart();
    }, 250);
  };

  for (const dir of dirs) {
    if (!fs.existsSync(dir.abs)) continue;
    try {
      fs.watch(dir.abs, { recursive: true }, onChange);
    } catch (error) {
      logger.warn(`Cannot watch ${dir.label}: ${error.message}`);
    }
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received — stopping the API and flushing logs.`);
  logger.flushActivityLog();

  if (!child) {
    logger.stopActivityLog();
    process.exit(0);
  }

  child.once('exit', () => {
    logger.stopActivityLog();
    process.exit(0);
  });
  child.kill();
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (OPTIONS.help) {
    printHelp();
    return;
  }

  logger.startActivityLog();

  logger.fields('INFO', [
    ['root', ROOT],
    ['mode', OPTIONS.check ? 'check-only' : OPTIONS.dev ? 'development (watch)' : 'serve'],
    ['time', `${logger.timestamp()} NPT`],
  ]);

  const result = await preflight();

  if (!result.ok) {
    logger.error(`Boot aborted — ${result.errors.length} error(s). The API was not started.`);
    logger.stopActivityLog();
    process.exit(1);
  }

  if (OPTIONS.check) {
    logger.success('--check complete: the tree is clean. Not starting the API.');
    logger.stopActivityLog();
    return;
  }

  launch();
  if (OPTIONS.dev) startWatcher(pruneNested(WATCH_DIRS));
}

main().catch((error) => {
  logger.error(`Supervisor crashed: ${error?.stack ?? error}`);
  logger.flushActivityLog();
  process.exit(1);
});
