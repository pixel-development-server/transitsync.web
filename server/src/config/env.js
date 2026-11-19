import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');

const ENV_FILE = path.join(SERVER_ROOT, '.env');

/**
 * On first boot we materialise server/.env from the repo-level .env.example so the
 * app always boots with a strong, unique JWT secret instead of a checked-in default.
 */
function provisionEnvFile() {
  if (fs.existsSync(ENV_FILE)) return;
  const template = path.join(SERVER_ROOT, '..', '.env.example');
  const secret = crypto.randomBytes(48).toString('base64url');
  const bootstrapPassword = `Ts!${crypto.randomBytes(9).toString('base64url')}9a`;

  let contents = fs.existsSync(template)
    ? fs.readFileSync(template, 'utf8')
    : 'NODE_ENV=development\nPORT=8080\n';

  contents = contents
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`)
    .replace(/^BOOTSTRAP_ADMIN_PASSWORD=.*$/m, `BOOTSTRAP_ADMIN_PASSWORD=${bootstrapPassword}`);

  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, contents, { mode: 0o600 });

  const adminEmail = (contents.match(/^BOOTSTRAP_ADMIN_EMAIL=(.*)$/m)?.[1] || '').trim();
  process.stdout.write(
    `\n  \u001b[33m\u001b1mTransitSync\u001b[0m initialised a new environment file.\n` +
      `    file    : ${ENV_FILE}\n` +
      `    admin   : ${adminEmail}\n` +
      `    password: ${bootstrapPassword}\n` +
      `    \u2190 Write this down, it is only shown once. You will be forced to change it on first login.\n\n`,
  );
}

provisionEnvFile();
dotenv.config({ path: ENV_FILE, override: false });

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isTest = process.env.TS_TEST === '1' || nodeEnv === 'test';

const dataDir = path.resolve(SERVER_ROOT, process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * MySQL connection settings.
 *
 * The service talks to the local XAMPP MariaDB server (see
 * `server/sql/schema.sql` for the DDL). Every value can be overridden from `server/.env`; the defaults
 * match the homelab box that runs production. The `DB_*` variables below are
 * also what the test harness points at the isolated `transitsync_test` schema.
 */
const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = toInt(process.env.DB_PORT, 3306);
const dbUser = process.env.DB_USER || 'transitsync';
const dbPassword = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_NAME || 'transitsync';

const jwtSecret = process.env.JWT_SECRET || '';

if (!jwtSecret) {
  throw new Error('JWT_SECRET is not configured. Set it in server/.env and restart.');
}
if (isProduction && (jwtSecret.length < 32 || jwtSecret.startsWith('change-me'))) {
  throw new Error('JWT_SECRET must be at least 32 characters and not the example value in production.');
}

const port = toInt(process.env.PORT, 8080);

export const config = {
  nodeEnv,
  isProduction,
  isTest,
  port,
  host: process.env.HOST || '0.0.0.0',

  paths: {
    serverRoot: SERVER_ROOT,
    dataDir,
    backupDir: path.join(dataDir, 'backups'),
    clientDist: path.resolve(SERVER_ROOT, '..', 'client', 'dist'),
  },

  /**
   * Database. These values feed the MariaDB/MySQL pool in `server/db.js`.
   */
  db: {
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    secret: jwtSecret,
    issuer: process.env.JWT_ISSUER || 'transitsync',
    audience: process.env.JWT_AUDIENCE || 'transitsync-console',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    cookieName: process.env.JWT_COOKIE_NAME || 'transitsync_token',
  },

  /**
   * Google Identity Services. The client id is public by design (it is handed
   * to the browser by `/api/auth/google/config`); every ID token is verified
   * server-side against Google's published signing keys and audience before a
   * session is minted.
   *
   * ENABLE_GOOGLE_AUTH is the deployment-level kill switch. `false`/`0`/`no`
   * prevents the routes from being mounted at all. When it is unset the legacy
   * behaviour is kept: a configured client id enables the feature. The primary
   * server sets ENABLE_GOOGLE_AUTH=true; Google-free deployments set it false.
   *
   * `domainMap` is an optional deployment-level fallback for domains that
   * cannot be stored in `institution_email_domains`, in the form
   * `domain:tenantId,other.edu.np:another-tenant-id`.
   */
  google: (() => {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const flag = (process.env.ENABLE_GOOGLE_AUTH || '').trim().toLowerCase();
    const disabled = flag === 'false' || flag === '0' || flag === 'no';
    const enabled = Boolean(clientId) && !disabled;
    return {
      clientId,
      enabled,
      domainMap: new Map(
        (process.env.GOOGLE_DOMAIN_MAP || '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const separator = entry.indexOf(':');
            if (separator < 1) return null;
            return [
              entry.slice(0, separator).trim().toLowerCase(),
              entry.slice(separator + 1).trim(),
            ];
          })
          .filter((entry) => entry && entry[0] && entry[1]),
      ),
    };
  })(),

  bootstrap: {
    email: (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@transitsync.edu.np').toLowerCase(),
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'TransitSync@2024',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'System Administrator',
  },

  /**
   * Level 200 Platform Super Administrator.
   *
   * The platform owner is now created by the first-run wizard, so the operator
   * chooses their own email/name/password rather than inheriting a value from
   * the environment. Headless installs that still want an environment-seeded
   * owner can opt in with `SUPER_ADMIN_BOOTSTRAP=true`; the account is then
   * created once (when none exists) and forced to rotate on first sign-in.
   */
  superAdmin: {
    email: (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase() || null,
    password: process.env.SUPER_ADMIN_PASSWORD || null,
    name: process.env.SUPER_ADMIN_NAME || 'Platform Super Administrator',
    bootstrap: String(process.env.SUPER_ADMIN_BOOTSTRAP || '').toLowerCase() === 'true',
  },

  /**
   * Outbound SMTP for the email one-time-code second factor. Entirely optional:
   * with no `SMTP_HOST` the code is written to the server console instead of
   * being delivered, so the email factor still works on a single-operator box.
   */
  mail: {
    enabled: Boolean(process.env.SMTP_HOST),
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'TransitSync <no-reply@transitsync.local>',
  },

  /**
   * Hardware ingest. The Wokwi serial -> HTTP relay has no user session, so it
   * authenticates with a shared token rather than JWT. When unset, the
   * `/api/scans/sync` endpoint only accepts loopback traffic in development.
   */
  relay: {
    token: process.env.RELAY_TOKEN || '',
    url: process.env.TS_API_URL || `http://localhost:${port}/api/scans/sync`,
  },

  limits: {
    loginMax: toInt(process.env.LOGIN_RATE_LIMIT_MAX, 10),
    loginWindowMs: toInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    bodyLimit: process.env.BODY_LIMIT || '1mb',
    apiRateMax: toInt(process.env.API_RATE_LIMIT_MAX, 600),
    apiRateWindowMs: toInt(process.env.API_RATE_LIMIT_WINDOW_MS, 60 * 1000),
    // Account-probe budget for the two-step sign-in (check-email +
    // set-first-password), counted per IP including successes.
    probeMax: toInt(process.env.AUTH_PROBE_RATE_LIMIT_MAX, 30),
  },

  /**
   * CORS allowlist.
   *
   * This process serves the SPA as well as the API, so the app's own origin is
   * always legitimate and is included automatically — derived from PORT so it
   * can never drift out of sync with where the server actually listens. Without
   * it, signing in fails with "Origin http://localhost:8080 is not permitted by
   * CORS policy": browsers attach an `Origin` header to *every* POST, including
   * same-origin ones, and the cors layer judges any request that carries one.
   *
   * CORS_ORIGINS is for genuinely cross-origin clients, e.g. the Vite dev server
   * on 5173 proxying /api during development.
   */
  corsOrigins: [
    ...new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
  ],

  password: {
    minLength: toInt(process.env.PASSWORD_MIN_LENGTH, 10),
  },
};

export default config;
