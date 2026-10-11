import fs from 'node:fs';
import os from 'node:os';
import config from './config/env.js';
import { getDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { ensureSuperAdmin } from './db/seed.js';
import { ROLE_KEYS } from './db/permissions.js';
import { createApp } from './app.js';
import { hub } from './services/realtime.js';

/**
 * Boot sequence: verify the schema is current, then start listening. Migrations
 * run inline so a fresh clone works with a single `npm start`.
 *
 * A fresh deployment is deliberately left with NO System Administrator so the
 * first-run wizard at /system-setup can collect the credentials. The server used
 * to provision one here with a compiled-in default password, which made the
 * wizard unreachable and shipped the same well-known credential to every install.
 * `npm run seed` still creates an administrator for headless/automated installs,
 * but it is now an explicit operator action rather than a side effect of booting.
 */
function bootstrap() {
  const dbFile = process.env.DB_FILE || config.paths.dbFile;

  if (dbFile !== ':memory:') {
    // Fresh install: create the file so SQLite can open it.
    if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '');
  }

  const db = getDb();

  const results = runMigrations(db, {
    log: (message) => process.stdout.write(`${message}\n`),
  });
  const applied = results.filter((entry) => entry.applied).length;
  if (applied) process.stdout.write(`  ${applied} migration(s) applied.\n`);

  // Level 200 platform owner. The operator now creates this account through the
  // first-run wizard (so they choose their own email/name/password) or from the
  // Super Admin console. An environment-seeded owner is only materialised when
  // `SUPER_ADMIN_BOOTSTRAP=true` is set explicitly, for headless installs.
  if (config.superAdmin.bootstrap) {
    const superAdmin = ensureSuperAdmin(db);
    if (superAdmin?.created) {
      process.stdout.write(
        `  Platform Super Administrator created: ${superAdmin.email} (forced change on first sign-in).\n`,
      );
    }
  }

  const admin = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key IN (?, ?)`,
    )
    .get(ROLE_KEYS.SYSTEM_ADMIN, ROLE_KEYS.SUPER_ADMIN);
  const needsSetup = admin.n === 0;

  return { db, needsSetup };
}

const { needsSetup } = bootstrap();

/**
 * Every non-internal IPv4 address this host answers on — the LAN address, and
 * the Tailscale 100.x address when the tailnet is up. Printed in the startup
 * banner so the operator can hand phones/tablets a URL instead of guessing.
 */
function networkUrls(port) {
  const urls = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.add(`http://${address.address}:${port}`);
      }
    }
  }
  return [...urls];
}

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  const lan = networkUrls(config.port);
  const banner = [
    '',
    '  \x1b[1m\x1b[36mTransitSync\x1b[0m — RFID campus shuttle operations console',
    `  \x1b[2m────────────────────────────────────────────────────────────\x1b[0m`,
    `  console   http://localhost:${config.port}`,
    ...lan.map((url) => `  network   ${url}`),
    `  api       http://localhost:${config.port}/api/health`,
    `  stream    http://localhost:${config.port}/api/stream  (SSE, JWT required)`,
    `  database  ${process.env.DB_FILE || config.paths.dbFile}`,
    `  mode      ${config.nodeEnv}`,
    '',
  ];
  if (needsSetup) {
    banner.push(
      '  \x1b[33m\x1b[1mNo System Administrator exists yet.\x1b[0m',
      `  \x1b[33mCreate the master account now:\x1b[0m  http://localhost:${config.port}/system-setup`,
      '',
    );
  }
  process.stdout.write(`${banner.join('\n')}\n`);
});

server.headersTimeout = 0;
server.requestTimeout = 0;

// --- graceful shutdown -----------------------------------------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n  ${signal} received — shutting down.\n`);

  hub.closeAll();
  server.close(() => {
    closeDb();
    process.stdout.write('  Bye.\n');
    process.exit(0);
  });

  // Don't hang forever on lingering SSE sockets.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`\n  Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}\n`);
});
process.on('uncaughtException', (error) => {
  process.stderr.write(`\n  Uncaught exception: ${error.stack}\n`);
  shutdown('uncaughtException');
});

export { app, server };
