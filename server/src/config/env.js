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

const jwtSecret = process.env.JWT_SECRET || '';

if (!jwtSecret) {
  throw new Error('JWT_SECRET is not configured. Set it in server/.env and restart.');
}
if (isProduction && (jwtSecret.length < 32 || jwtSecret.startsWith('change-me'))) {
  throw new Error('JWT_SECRET must be at least 32 characters and not the example value in production.');
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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
    dbFile: process.env.DB_FILE || path.join(dataDir, 'transitsync.db'),
    clientDist: path.resolve(SERVER_ROOT, '..', 'client', 'dist'),
  },

  jwt: {
    secret: jwtSecret,
    issuer: process.env.JWT_ISSUER || 'transitsync',
    audience: process.env.JWT_AUDIENCE || 'transitsync-console',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    cookieName: process.env.JWT_COOKIE_NAME || 'transitsync_token',
  },

  bootstrap: {
    email: (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@transitsync.edu.np').toLowerCase(),
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'TransitSync@2024',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'System Administrator',
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
