/**
 * TransitSync — live console supervisor.
 *
 * Started by start-transitsync-console.bat (desktop mode) or by the
 * TransitSync-Web scheduled task via scripts/run-web-service.ps1 (--service).
 *
 * It owns the whole site:
 *
 *   * API         (node server/src/index.js)              -> 127.0.0.1:3100
 *   * Caddy       (caddy run --config Caddyfile)          -> 127.0.0.1:8080 (tunnel origin)
 *   * cloudflared (cloudflared --config <cfg> tunnel run) -> transitsync.me (public edge)
 *
 * START ORDER MATTERS
 *   The API opens :3100 only after it has connected to MariaDB and run its
 *   migrations. If Caddy binds first it reverse-proxies /api/* to a closed port
 *   and logs `dial tcp 127.0.0.1:3100: connectex: ... refused` (HTTP 502). So we
 *   start the API, WAIT until its health endpoint answers, then start Caddy and
 *   finally the tunnel. No fixed sleeps: an event-driven poll.
 *
 * WHY THIS EXISTS INSTEAD OF MULTIPLE `>>` REDIRECTIONS IN THE .bat
 *   Independent `cmd` processes appending (`>>`) to one log file fight over the
 *   handle on Windows. Here a SINGLE process owns the log handle and every child
 *   is piped through it, so all output lands in the console and in the log with
 *   no lock contention.
 *
 * TWO MODES
 *   desktop  (default): a direct child of the console window. Closing the window
 *              tears the whole tree down. A child that dies stops the console.
 *   --service: owned by a SYSTEM scheduled task, independent of any logon. A
 *              child that dies is restarted with backoff, and a stamp file
 *              (logs/transitsync-service.active) tells the desktop launcher to
 *              attach as a viewer instead of fighting for the ports.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const serverDir = path.join(root, 'server');
const logDir = path.join(root, 'logs');
const logPath = path.join(logDir, 'transitsync-console.log');
const stampPath = path.join(logDir, 'transitsync-service.active');

const SERVICE_MODE = process.argv.includes('--service');

// Absolute defaults so the SYSTEM scheduled task needs no .bat to supply env.
const CADDY = process.env.TRANSITSYNC_CADDY || 'C:\\Caddy\\caddy.exe';
const CLOUDFLARED = process.env.TRANSITSYNC_CLOUDFLARED
  || 'C:\\Program Files\\cloudflared\\cloudflared.exe';
const TUNNEL_CONFIG = process.env.TRANSITSYNC_TUNNEL_CONFIG
  || 'C:\\Users\\Administrator\\.cloudflared\\config.yml';
const API_PORT = Number(process.env.TRANSITSYNC_API_PORT || 3100);
const PROXY_PORT = Number(process.env.TRANSITSYNC_PROXY_PORT || 8080);
const API_HEALTH = `http://127.0.0.1:${API_PORT}/api/health`;
const PROXY_HEALTH = `http://127.0.0.1:${PROXY_PORT}/api/health`;
const API_READY_BUDGET_MS = 60_000;
const PROXY_READY_BUDGET_MS = 30_000;

mkdirSync(logDir, { recursive: true });
// Desktop mode truncates for a fresh session; service mode appends so the
// desktop viewer can keep tailing across a service restart.
const log = createWriteStream(logPath, { flags: SERVICE_MODE ? 'a' : 'w' });

const stamp = () => new Date().toISOString();
const banner = (s) => `\n${'='.repeat(64)}\n  ${s}\n${'='.repeat(64)}\n`;

// Fan a child's bytes to BOTH stdout and the log, prefixing each line so the
// source is obvious. A per-stream remainder buffer keeps half-lines intact.
function makePump(label, onLine) {
  let pending = '';
  return (buf) => {
    pending += buf.toString('utf8');
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      const out = `${label} | ${line}\n`;
      process.stdout.write(out);
      log.write(out);
      if (onLine) onLine(line);
    }
  };
}

function say(text) {
  process.stdout.write(text);
  log.write(text);
}

function writeStamp() {
  if (!SERVICE_MODE) return;
  try {
    writeFileSync(stampPath, JSON.stringify({
      pid: process.pid,
      mode: 'web-service',
      startedAt: stamp(),
    }, null, 2));
  } catch { /* best effort */ }
}

function clearStamp() {
  if (!SERVICE_MODE) return;
  try { rmSync(stampPath, { force: true }); } catch { /* best effort */ }
}

const children = [];
const respawnState = new Map();
let shuttingDown = false;

// Service mode: bring a single dead child back instead of taking the whole site
// down. A counter with a 30s healthy window stops a crash loop from spinning.
function handleChildLoss(label, command, args, cwd, onLine, reason) {
  const now = Date.now();
  let state = respawnState.get(label) || { count: 0, last: 0 };
  if (now - state.last > 30_000) state.count = 0;
  state.count += 1;
  state.last = now;
  respawnState.set(label, state);

  if (state.count > 10) {
    stop(1, `${reason} — too many restarts, exiting so the task scheduler can recover`);
    return;
  }
  const delay = Math.min(1000 * state.count, 10_000);
  say(`[${stamp()}] ${reason} — restarting in ${Math.round(delay / 1000)}s (attempt ${state.count}/10)\n`);
  const timer = setTimeout(() => {
    if (shuttingDown) return;
    const idx = children.findIndex((entry) => entry.label === label && !entry.alive);
    if (idx >= 0) children.splice(idx, 1);
    start(label, command, args, cwd, onLine);
  }, delay);
  timer.unref();
}

function start(label, command, args, cwd, onLine) {
  const child = spawn(command, args, { cwd, windowsHide: true, env: process.env });
  const entry = { label, child, alive: true };
  children.push(entry);
  const pump = makePump(label.padEnd(6), onLine);
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  // `error` and `exit` can both fire for a failed spawn; `alive` guards it.
  const gone = (reason) => {
    if (!entry.alive || shuttingDown) return;
    entry.alive = false;
    if (SERVICE_MODE) {
      handleChildLoss(label, command, args, cwd, onLine, reason);
    } else {
      stop(1, `${reason} — stopping the console`);
    }
  };

  child.on('error', (err) => gone(`${label} failed to start: ${err.message}`));
  child.on('exit', (code, signal) => gone(`${label} exited (code ${code}, signal ${signal ?? 'none'})`));
  return child;
}

function stop(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  say(banner(reason));
  clearStamp();
  for (const entry of children) {
    try {
      if (entry.alive && entry.child.exitCode === null && !entry.child.killed) entry.child.kill();
    } catch { /* already gone */ }
  }
  setTimeout(() => {
    log.end();
    process.exit(code);
  }, 600).unref();
}

process.on('SIGINT', () => stop(0, 'Ctrl+C — shutting down.'));
process.on('SIGTERM', () => stop(0, 'Terminated — shutting down.'));
process.on('exit', clearStamp);

// Poll a URL until it answers 2xx, or the budget runs out. Never a fixed sleep:
// returns the instant the endpoint is healthy. Honours an in-flight shutdown.
async function waitForHttp(url, budgetMs, label) {
  const deadline = Date.now() + budgetMs;
  let lastErr = 'not answering yet';
  say(`[${stamp()}] waiting for ${label} at ${url} ...\n`);
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.name === 'TimeoutError' ? 'timed out' : (err?.code || err?.message || 'refused');
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!shuttingDown) say(`[${stamp()}] WARNING: ${label} not ready after ${Math.round(budgetMs / 1000)}s (${lastErr})\n`);
  return false;
}

say(`[${stamp()}] ==== ${SERVICE_MODE ? 'web service' : 'console'} session start ====\n`);
say(`[${stamp()}] caddy = ${CADDY}\n`);
say(`[${stamp()}] cloudflared = ${CLOUDFLARED || '(not found — public tunnel disabled)'}\n`);
writeStamp();

// --- 1) API first, and do not proceed until :3100 answers --------------------
start('api', process.execPath, ['src/index.js'], serverDir);
const apiReady = await waitForHttp(API_HEALTH, API_READY_BUDGET_MS, `API (:${API_PORT})`);
if (!shuttingDown) {
  say(apiReady
    ? `[${stamp()}] API is online — :${API_PORT} is listening, starting Caddy\n`
    : `[${stamp()}] starting Caddy anyway — the panel will load but /api/* may 502 until the API is up\n`);

  // --- 2) Caddy only after the API gate -------------------------------------
  start('caddy', CADDY, ['run', '--config', 'Caddyfile'], root);

  // --- 3) the public tunnel last --------------------------------------------
  const tunnelAvailable = Boolean(CLOUDFLARED) && existsSync(CLOUDFLARED)
    && Boolean(TUNNEL_CONFIG) && existsSync(TUNNEL_CONFIG);
  if (tunnelAvailable) {
    let announced = false;
    start(
      'tunnel',
      CLOUDFLARED,
      ['--no-autoupdate', '--config', TUNNEL_CONFIG, 'tunnel', 'run'],
      root,
      (line) => {
        if (announced) return;
        if (/Registered tunnel connection|Connection .* registered/i.test(line)) {
          announced = true;
          say(banner('public site LIVE — transitsync.me is now served'));
        }
      },
    );
  } else {
    say(`[${stamp()}] WARNING: cloudflared (${CLOUDFLARED || 'unset'}) or its config `
      + `(${TUNNEL_CONFIG || 'unset'}) was not found — public tunnel disabled, local only on 127.0.0.1:${PROXY_PORT}\n`);
  }

  // --- 4) confirm the proxy is serving, then announce -----------------------
  const proxyReady = await waitForHttp(PROXY_HEALTH, PROXY_READY_BUDGET_MS, `proxy (:${PROXY_PORT})`);
  if (!shuttingDown) {
    say(proxyReady
      ? `[${stamp()}] panel is LIVE on 127.0.0.1:${PROXY_PORT} (public: transitsync.me)\n`
      : `[${stamp()}] WARNING: panel did not answer ${PROXY_HEALTH}\n`);
  }
}
