import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  login,
  loginAdmin,
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
// College provisioning
// ---------------------------------------------------------------------------

test('the master panel lists the seeded campus with its administrator', async () => {
  const response = await call(ctx, 'GET', '/api/super-admin/colleges', { token: superAdmin.token });
  assert.equal(response.status, 200);

  const iic = response.body.data.colleges.find((college) => college.code === 'iic');
  assert.ok(iic, 'the default campus should be listed');
  assert.equal(iic.status, 'ACTIVE');
  assert.equal(iic.adminEmail, ADMIN_EMAIL);
});

test('a level-100 campus administrator cannot reach the platform surface', async () => {
  const admin = await loginAdmin(ctx);
  const response = await call(ctx, 'GET', '/api/super-admin/colleges', { token: admin.token });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'SUPER_ADMIN_ONLY');
});

test('registering a college provisions its level-100 administrator with a one-time password', async () => {
  const created = await call(ctx, 'POST', '/api/super-admin/colleges', {
    token: superAdmin.token,
    body: {
      name: 'Test Valley College',
      code: 'tvc',
      adminEmail: 'admin@tvc.edu.np',
      adminName: 'TVC Administrator',
    },
  });
  assert.equal(created.status, 201);

  const { college, credentials } = created.body.data;
  assert.equal(college.code, 'tvc');
  assert.equal(college.status, 'ACTIVE');
  assert.equal(college.adminEmail, 'admin@tvc.edu.np');
  assert.ok(credentials.temporaryPassword.length >= 6);

  // The new administrator sits at level 100 and is tenant-scoped to the campus.
  const adminRow = ctx.db
    .prepare(
      `SELECT r.level, u.tenant_id, u.force_password_reset
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?`,
    )
    .get('admin@tvc.edu.np');
  assert.equal(adminRow.level, 100);
  assert.equal(adminRow.tenant_id, college.id);
  assert.equal(adminRow.force_password_reset, 1);

  // The handover credential signs in but is walled behind the rotation gate.
  const firstLogin = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: 'admin@tvc.edu.np', password: credentials.temporaryPassword },
  });
  assert.equal(firstLogin.status, 200);
  assert.equal(firstLogin.body.data.mustChangePassword, true);

  // Duplicate slug and duplicate administrator email are both refused.
  const duplicateCode = await call(ctx, 'POST', '/api/super-admin/colleges', {
    token: superAdmin.token,
    body: { name: 'Another Campus', code: 'tvc', adminEmail: 'other@tvc.edu.np' },
  });
  assert.equal(duplicateCode.status, 409);

  const duplicateEmail = await call(ctx, 'POST', '/api/super-admin/colleges', {
    token: superAdmin.token,
    body: { name: 'Another Campus', code: 'tvc-two', adminEmail: 'admin@tvc.edu.np' },
  });
  assert.equal(duplicateEmail.status, 409);
});

test('a college can be suspended and the platform overview reports figures', async () => {
  const list = await call(ctx, 'GET', '/api/super-admin/colleges', { token: superAdmin.token });
  const tvc = list.body.data.colleges.find((college) => college.code === 'tvc');

  const suspended = await call(ctx, 'PATCH', `/api/super-admin/colleges/${tvc.id}`, {
    token: superAdmin.token,
    body: { status: 'SUSPENDED' },
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.data.college.status, 'SUSPENDED');

  const overview = await call(ctx, 'GET', '/api/super-admin/overview', { token: superAdmin.token });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.data.colleges.total, 2);
  assert.equal(overview.body.data.colleges.suspended, 1);
  assert.ok(overview.body.data.users.total >= 6);
  assert.equal(typeof overview.body.data.maintenance.isMaintenanceMode, 'boolean');
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
