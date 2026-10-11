import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  login,
  loginSuperAdmin,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  STAFF_PASSWORD,
  SUPER_ADMIN_EMAIL,
  SUPER_ROTATED_PASSWORD,
} from './support/harness.js';
import { setMaintenance } from '../src/services/maintenance.js';

let ctx;
let superAdmin;

const IIC_TENANT = '11111111-1111-4111-8111-111111111111';

test.before(async () => {
  ctx = await bootServer();
  // The harness provisions the platform owner (ensureSuperAdmin) and rotates its
  // forced first-login credential on the first sign-in.
  superAdmin = await loginSuperAdmin(ctx);
});

test.after(async () => {
  // Never leave the shared instance in maintenance mode.
  try {
    await call(ctx, 'PATCH', '/api/super-admin/maintenance', {
      token: superAdmin?.token,
      body: { enabled: false },
    });
  } catch {
    /* best effort */
  }
  await ctx?.close();
});

// ---------------------------------------------------------------------------
// Multi-tenancy foundation (migration 005)
// ---------------------------------------------------------------------------

test('the default institution is seeded and every existing row is attached to it', () => {
  const institution = ctx.db
    .prepare('SELECT id, name, code, status FROM institutions WHERE code = ?')
    .get('iic');
  assert.ok(institution, 'the iic institution should exist');
  assert.equal(institution.name, 'Itahari International College');
  assert.equal(institution.status, 'ACTIVE');
  assert.equal(institution.id, IIC_TENANT);

  // The platform Super Administrator is cross-tenant by design and carries no
  // campus tenant; every other row belongs to the default campus.
  const orphanUsers = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.key <> 'super_admin' AND (u.tenant_id IS NULL OR u.tenant_id <> ?)`,
    )
    .get(IIC_TENANT).n;
  assert.equal(orphanUsers, 0, 'campus user rows should belong to the default tenant');

  for (const table of ['students', 'buses', 'routes', 'scan_events', 'alerts']) {
    const orphans = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IS NULL OR tenant_id <> ?`)
      .get(IIC_TENANT).n;
    assert.equal(orphans, 0, `every ${table} row should belong to the default tenant`);
  }
});

test('the super_admin (200) and student (1) roles are seeded', () => {
  const superRole = ctx.db.prepare('SELECT level, is_system FROM roles WHERE key = ?').get('super_admin');
  assert.equal(superRole.level, 200);
  assert.equal(superRole.is_system, 1);

  const studentRole = ctx.db.prepare('SELECT level FROM roles WHERE key = ?').get('student');
  assert.equal(studentRole.level, 1);
});

// ---------------------------------------------------------------------------
// Public maintenance status
// ---------------------------------------------------------------------------

test('GET /api/system/status is public and reports maintenance off by default', async () => {
  const response = await call(ctx, 'GET', '/api/system/status');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.isMaintenanceMode, false);
  assert.equal(typeof response.body.data.message, 'string');
});

// ---------------------------------------------------------------------------
// Super Admin surface
// ---------------------------------------------------------------------------

test('the Super Admin maintenance endpoint is denied to everyone below level 200', async () => {
  const staff = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);
  const response = await call(ctx, 'GET', '/api/super-admin/maintenance', { token: staff.token });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'SUPER_ADMIN_ONLY');
});

test('maintenance mode refuses campus sign-ins but lets the Super Admin through', async () => {
  const enabled = await call(ctx, 'PATCH', '/api/super-admin/maintenance', {
    token: superAdmin.token,
    body: { enabled: true, message: 'Planned platform upgrade' },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.isMaintenanceMode, true);
  assert.equal(enabled.body.data.message, 'Planned platform upgrade');

  // Public status reflects the change with no session.
  const status = await call(ctx, 'GET', '/api/system/status');
  assert.equal(status.body.data.isMaintenanceMode, true);
  assert.equal(status.body.data.message, 'Planned platform upgrade');

  // Campus staff and the level-100 System Administrator are both refused.
  const staffLogin = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: 'transport@transitsync.edu.np', password: STAFF_PASSWORD },
  });
  assert.equal(staffLogin.status, 503);
  assert.equal(staffLogin.body.error.code, 'MAINTENANCE_MODE');
  assert.match(staffLogin.body.error.message, /Planned platform upgrade/);

  const adminLogin = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  assert.equal(adminLogin.status, 503);
  assert.equal(adminLogin.body.error.code, 'MAINTENANCE_MODE');

  // The platform owner still gets in (to turn it back off).
  const superLogin = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(superLogin.status, 200);
  assert.equal(superLogin.body.data.user.role, 'super_admin');
  assert.equal(superLogin.body.data.user.roleLevel, 200);

  // Disengage and confirm ordinary sign-in resumes.
  const disabled = await call(ctx, 'PATCH', '/api/super-admin/maintenance', {
    token: superAdmin.token,
    body: { enabled: false },
  });
  assert.equal(disabled.body.data.isMaintenanceMode, false);

  const recovered = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: 'transport@transitsync.edu.np', password: STAFF_PASSWORD },
  });
  assert.equal(recovered.status, 200);
});

// ---------------------------------------------------------------------------
// Safety interlock
// ---------------------------------------------------------------------------

test('maintenance cannot be enabled while no Super Administrator exists', () => {
  const stub = {
    prepare() {
      return { get: () => ({ n: 0 }), all: () => [], run: () => ({}) };
    },
  };
  assert.throws(
    () => setMaintenance(stub, { enabled: true }),
    /no Super Administrator/,
  );
});
