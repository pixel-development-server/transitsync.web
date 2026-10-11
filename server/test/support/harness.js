import process from 'node:process';

// Must be set before any application module is imported — config reads it at load.
process.env.TS_TEST = '1';
process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

// The suite must not depend on the developer's `server/.env`, which carries a
// randomly generated bootstrap password. Pin both the seed passwords and the
// signing secret so runs are reproducible on any machine.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@transitsync.edu.np';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'TransitSync@2024';
process.env.SUPER_ADMIN_EMAIL = 'super@transitsync.me';
process.env.SUPER_ADMIN_PASSWORD = 'SuperRoot!2024x';
process.env.SUPER_ADMIN_NAME = 'Platform Super Administrator';
process.env.JWT_SECRET = 'test-signing-secret-not-used-in-production-000000';

const { openDatabase } = await import('../../src/db/driver.js');
const { setDb, getDb } = await import('../../src/db/connection.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const { ensureBootstrapAdmin, ensureSuperAdmin, seedDemo, seedSettings } = await import('../../src/db/seed.js');
const { createApp } = await import('../../src/app.js');
const { ROLE_KEYS } = await import('../../src/db/permissions.js');
// bcryptjs ships its helpers on the default export when loaded dynamically.
const bcrypt = (await import('bcryptjs')).default;

export const ADMIN_EMAIL = 'admin@transitsync.edu.np';
export const ADMIN_PASSWORD = 'TransitSync@2024';
export const SUPER_ADMIN_EMAIL = 'super@transitsync.me';
export const SUPER_ADMIN_PASSWORD = 'SuperRoot!2024x';
// Deliberately free of the email local-part and the display name, so the
// password policy (which rejects "admin" here) does not reject the rotation.
export const ROTATED_ADMIN_PASSWORD = 'Bright7Falcon!Quartz';
export const SUPER_ROTATED_PASSWORD = 'Cobalt7!Marlin2026';
export const STAFF_PASSWORD = 'TransitStaff@2024';

// The suite rotates the admin password mid-run to prove the forced-change gate
// works, so the helper has to remember which credential is currently valid.
let currentAdminPassword = ADMIN_PASSWORD;
let currentSuperPassword = SUPER_ADMIN_PASSWORD;

let cached = null;

/**
 * Boot a fully isolated instance: in-memory database, freshly migrated, seeded
 * with the bootstrap admin and the demo dataset, listening on an ephemeral port.
 */
export async function bootServer({ demo = true } = {}) {
  if (cached) return cached;

  const db = openDatabase(':memory:');
  setDb(db);
  runMigrations(db, { log: () => {} });
  seedSettings(db);
  ensureBootstrapAdmin(db);
  ensureSuperAdmin(db);
  if (demo) seedDemo(db);

  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  const { port } = server.address();
  cached = {
    db,
    app,
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
  return cached;
}

export function roleIdOf(context, roleKey) {
  return context.db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey).id;
}

/**
 * Perform a request against the test server.
 * Returns `{ status, body, headers }`; never throws on non-2xx.
 */
export async function call(context, method, path, { token, body, headers = {}, raw = false } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

  const response = await fetch(`${context.baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (raw) {
    // The body can only be consumed once: read it as bytes, then derive the text
    // from those bytes. Calling `response.text()` after `arrayBuffer()` always
    // resolves to ''.
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      buffer,
      text: buffer.toString('utf8'),
    };
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers.entries()) };
}

export async function login(context, email, password) {
  const response = await call(context, 'POST', '/api/auth/login', { body: { email, password } });
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

/**
 * Sign in as the System Administrator, transparently rotating the password the
 * first time it is asked for. Returns a session that has already cleared the
 * forced-change gate.
 */
export async function loginAdmin(context) {
  const attempt = async (password) =>
    call(context, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password } });

  let response = await attempt(currentAdminPassword);

  // Stale remembered credential — fall back to the rotation target once.
  if (response.status !== 200 && currentAdminPassword !== ROTATED_ADMIN_PASSWORD) {
    currentAdminPassword = ROTATED_ADMIN_PASSWORD;
    response = await attempt(currentAdminPassword);
  }

  if (response.status !== 200) {
    throw new Error(
      `Admin login failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  const session = response.body.data;
  if (!session.mustChangePassword) return session;

  const rotated = await call(context, 'POST', '/api/auth/change-password', {
    token: session.token,
    body: {
      currentPassword: currentAdminPassword,
      newPassword: ROTATED_ADMIN_PASSWORD,
      confirmPassword: ROTATED_ADMIN_PASSWORD,
      revokeOtherSessions: false,
    },
  });
  if (rotated.status !== 200) {
    throw new Error(`Admin rotation failed: ${rotated.status} ${JSON.stringify(rotated.body)}`);
  }

  currentAdminPassword = ROTATED_ADMIN_PASSWORD;
  return rotated.body.data;
}

/**
 * Sign in as the Level 200 Super Administrator, rotating the forced first-login
 * credential once. Mirrors `loginAdmin` for the platform owner.
 */
export async function loginSuperAdmin(context) {
  const attempt = (password) =>
    call(context, 'POST', '/api/auth/login', { body: { email: SUPER_ADMIN_EMAIL, password } });

  let response = await attempt(currentSuperPassword);
  if (response.status !== 200 && currentSuperPassword !== SUPER_ROTATED_PASSWORD) {
    currentSuperPassword = SUPER_ROTATED_PASSWORD;
    response = await attempt(currentSuperPassword);
  }
  if (response.status !== 200) {
    throw new Error(`Super admin login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const session = response.body.data;
  if (!session.mustChangePassword) return session;

  const rotated = await call(context, 'POST', '/api/auth/change-password', {
    token: session.token,
    body: {
      currentPassword: currentSuperPassword,
      newPassword: SUPER_ROTATED_PASSWORD,
      confirmPassword: SUPER_ROTATED_PASSWORD,
      revokeOtherSessions: false,
    },
  });
  if (rotated.status !== 200) {
    throw new Error(`Super admin rotation failed: ${rotated.status} ${JSON.stringify(rotated.body)}`);
  }

  currentSuperPassword = SUPER_ROTATED_PASSWORD;
  return rotated.body.data;
}

export async function createStaffUser(context, adminToken, overrides = {}) {
  const payload = {
    email: `staff-${Math.random().toString(36).slice(2, 8)}@transitsync.edu.np`,
    fullName: 'Test Staff',
    roleId: roleIdOf(context, ROLE_KEYS.TRANSPORT_STAFF),
    jobTitle: 'Coordinator',
    department: 'Transport',
    temporaryPassword: 'TempPass!2024x',
    forcePasswordChange: false,
    ...overrides,
  };
  const response = await call(context, 'POST', '/api/users', {
    token: adminToken,
    body: payload,
  });
  if (response.status !== 201) {
    throw new Error(`Staff creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { ...response.body.data, payload };
}

/** Insert a user directly with a known password — avoids the admin round trip. */
export function insertUser(context, { email, password, fullName, roleKey }) {
  const db = context.db;
  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  // Cost 4 keeps the suite fast; this fixture path never touches production data.
  const passwordHash = bcrypt.hashSync(password, 4);
  const result = db
    .prepare(
      `INSERT INTO users (email, full_name, password_hash, role_id, status,
                          is_first_login, password_changed, force_password_reset)
       VALUES (?, ?, ?, ?, 'active', 0, 1, 0)`,
    )
    .run(email, fullName, passwordHash, role.id);
  return Number(result.lastInsertRowid);
}

export { ROLE_KEYS, getDb };
