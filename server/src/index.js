import fs from 'node:fs';
import os from 'node:os';
import config from './config/env.js';
import { getDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { ensureSuperAdmin } from './db/seed.js';
import { ROLE_KEYS } from './db/permissions.js';
import { createApp } from './app.js';
import { hub } from './services/realtime.js';
import * as logger from '../logger.js';

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
async function bootstrap() {
  const db = getDb();

  const results = await runMigrations({
    log: (message) => logger.info(message),
  });
  const applied = results.filter((entry) => entry.applied).length;
  if (applied) logger.success(`${applied} migration(s) applied.`);

  // Level 200 platform owner. The operator now creates this account through the
  // first-run wizard (so they choose their own email/name/password) or from the
  // Super Admin console. An environment-seeded owner is only materialised when
  // `SUPER_ADMIN_BOOTSTRAP=true` is set explicitly, for headless installs.
  if (config.superAdmin.bootstrap) {
    const superAdmin = await ensureSuperAdmin(db);
    if (superAdmin?.created) {
      logger.success(
        `Platform Super Administrator created: ${superAdmin.email} (forced change on first sign-in).`,
      );
    }
  }

  const admin = await db
    .get(
      `SELECT COUNT(*) AS n FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.\`key\` IN (?, ?)`,
      ROLE_KEYS.SYSTEM_ADMIN, ROLE_KEYS.SUPER_ADMIN,
    );
  const needsSetup = admin.n === 0;

  return { db, needsSetup };
}

const { needsSetup } = await bootstrap();

// Begin persisting activity to logs/server_activity.log on the once-a-minute
// cadence; the buffer also flushes on exit, so nothing in flight is lost.
logger.startActivityLog();

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

  logger.heading('TransitSync — RFID campus shuttle operations console');
  logger.fields('INFO', [
    ['console', `http://localhost:${config.port}`],
    ...lan.map((url) => ['network', url]),
    ['api', `http://localhost:${config.port}/api/health`],
    ['stream', `http://localhost:${config.port}/api/stream  (SSE, JWT required)`],
    ['database', `${config.db.host}:${config.db.port}/${config.db.database}`],
    ['mode', config.nodeEnv],
  ]);
  logger.success(`Listening on ${config.host}:${config.port}.`);

  if (needsSetup) {
    logger.warn('No System Administrator exists yet.');
    logger.warn(`Create the master account now: http://localhost:${config.port}/system-setup`);
  }

  // Get the startup report on disk immediately rather than waiting a full minute.
  logger.flushActivityLog();
});

server.headersTimeout = 0;
server.requestTimeout = 0;

// --- graceful shutdown -----------------------------------------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down.`);

  hub.closeAll();
  server.close(() => {
    closeDb();
    logger.info('Bye.');
    logger.stopActivityLog();
    process.exit(0);
  });

  // Don't hang forever on lingering SSE sockets.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.stack}`);
  shutdown('uncaughtException');
});

export { app, server };
