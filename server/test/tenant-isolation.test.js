/**
 * Multi-tenant isolation for the operational registries and account
 * provisioning.
 *
 * Covers the contract that:
 *   - a campus principal (level < 200) is locked to their own campus on reads,
 *     on writes and on record-by-id access;
 *   - a platform principal (level >= 200) sees NO campus data by default and
 *     only what they explicitly drill into with a `tenantId`;
 *   - the platform owner can provision a peer Super Administrator (tenant NULL)
 *     or a campus System Administrator bound to a specific campus, while a
 *     campus administrator can never mint a System Administrator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  login,
  loginAdmin,
  loginSuperAdmin,
  roleIdOf,
  ROLE_KEYS,
} from './support/harness.js';
import { SUPER_ADMIN_LEVEL } from '../src/db/permissions.js';

const IIC_TENANT = '11111111-1111-4111-8111-111111111111';
const CAMPUS_PASSWORD = 'Campus7Falcon!2026';

let ctx;
let superAdmin;
let admin;
let tvcId;
let tvcAdminEmail;
let tvcAdminPassword;
let iicStudentId;
let tvcStudentId;
let tvcBusId;
let tvcRouteId;
let tvcStaffId;

/** Sign in, transparently rotating the forced first-login credential. */
async function rotateIn(context, email, temporaryPassword, newPassword) {
  const first = await call(context, 'POST', '/api/auth/login', {
    body: { email, password: temporaryPassword },
  });
  assert.equal(first.status, 200, `sign-in failed for ${email}: ${JSON.stringify(first.body)}`);
  const session = first.body.data;
  if (!session.mustChangePassword) return session;

  const rotated = await call(context, 'POST', '/api/auth/change-password', {
    token: session.token,
    body: {
      currentPassword: temporaryPassword,
      newPassword,
      confirmPassword: newPassword,
      revokeOtherSessions: false,
    },
  });
  assert.equal(rotated.status, 200, `rotation failed for ${email}: ${JSON.stringify(rotated.body)}`);
  return rotated.body.data;
}

const countRows = (table, tenant) =>
  ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenant).n;

test.before(async () => {
  ctx = await bootServer();
  superAdmin = await loginSuperAdmin(ctx);
  admin = await loginAdmin(ctx);

  // Provision a second campus (TVC) plus its level-100 administrator.
  const college = await call(ctx, 'POST', '/api/super-admin/colleges', {
    token: superAdmin.token,
    body: {
      name: 'Triveni Valley College',
      code: 'tvc',
      adminEmail: 'tvc-admin@transitsync.edu.np',
      adminName: 'TVC Administrator',
    },
  });
  assert.equal(college.status, 201, JSON.stringify(college.body));
  tvcId = college.body.data.college.id;
  tvcAdminEmail = college.body.data.credentials.email;
  tvcAdminPassword = college.body.data.credentials.temporaryPassword;

  // Campus-scoped records written by the platform owner, naming the campus they
  // belong to. These are the rows the IIC campus must never see.
  const route = await call(ctx, 'POST', '/api/routes', {
    token: superAdmin.token,
    body: {
      tenantId: tvcId,
      code: 'TVC-R1',
      name: 'TVC Hill Loop',
      startPoint: 'TVC Gate',
      endPoint: 'TVC Hostel',
      shift: 'MORNING',
      departureTime: '07:15',
      arrivalTime: '08:45',
      color: '#F97316',
      isActive: true,
    },
  });
  assert.equal(route.status, 201, JSON.stringify(route.body));
  tvcRouteId = route.body.data.route.id;

  const bus = await call(ctx, 'POST', '/api/buses', {
    token: superAdmin.token,
    body: {
      tenantId: tvcId,
      code: 'TVC-B1',
      registrationNo: 'BA-9-KHA-1234',
      name: 'TVC Shuttle One',
      seatCapacity: 32,
      status: 'ACTIVE',
      currentRouteId: tvcRouteId,
    },
  });
  assert.equal(bus.status, 201, JSON.stringify(bus.body));
  tvcBusId = bus.body.data.bus.id;

  const tvcStudent = await call(ctx, 'POST', '/api/students', {
    token: superAdmin.token,
    body: {
      tenantId: tvcId,
      fullName: 'TVC Rider',
      collegeId: 'TVC-ISO-1',
      routeId: tvcRouteId,
      busId: tvcBusId,
    },
  });
  assert.equal(tvcStudent.status, 201, JSON.stringify(tvcStudent.body));
  tvcStudentId = tvcStudent.body.data.student.id;

  // A campus-bound staff member the platform owner will later promote.
  const staff = await call(ctx, 'POST', '/api/users', {
    token: superAdmin.token,
    body: {
      email: 'tvc-staff@transitsync.edu.np',
      fullName: 'TVC Coordinator',
      roleId: roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
      tenantId: tvcId,
      temporaryPassword: 'CoordPass!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(staff.status, 201, JSON.stringify(staff.body));
  tvcStaffId = staff.body.data.user.id;

  // A known IIC roster row created by the IIC administrator themselves.
  const iicStudent = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'IIC Rider', collegeId: 'IIC-ISO-1' },
  });
  assert.equal(iicStudent.status, 201, JSON.stringify(iicStudent.body));
  iicStudentId = iicStudent.body.data.student.id;
});

test.after(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------
// Campus principal: locked to its own campus
// ---------------------------------------------------------------------------

test('campus staff lists contain only their own campus rows', async () => {
  const students = await call(ctx, 'GET', '/api/students?limit=500', { token: admin.token });
  assert.equal(students.status, 200);
  assert.equal(students.body.data.meta.total, countRows('students', IIC_TENANT));
  assert.ok(!students.body.data.students.some((row) => row.id === tvcStudentId));
  assert.ok(students.body.data.students.some((row) => row.id === iicStudentId));

  const buses = await call(ctx, 'GET', '/api/buses', { token: admin.token });
  assert.equal(buses.status, 200);
  assert.equal(buses.body.data.summary.total, countRows('buses', IIC_TENANT));
  assert.ok(!buses.body.data.buses.some((row) => row.id === tvcBusId));

  const routes = await call(ctx, 'GET', '/api/routes', { token: admin.token });
  assert.equal(routes.status, 200);
  assert.ok(!routes.body.data.routes.some((row) => row.id === tvcRouteId));
});

test('a campus tenant filter from a campus principal is ignored, not honoured', async () => {
  const response = await call(ctx, 'GET', `/api/students?limit=500&tenantId=${tvcId}`, {
    token: admin.token,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.meta.total, countRows('students', IIC_TENANT));
  assert.ok(!response.body.data.students.some((row) => row.id === tvcStudentId));
});

test('a campus principal cannot read a foreign campus record by id', async () => {
  for (const [path, id] of [
    ['/api/students', tvcStudentId],
    ['/api/buses', tvcBusId],
    ['/api/routes', tvcRouteId],
  ]) {
    const response = await call(ctx, 'GET', `${path}/${id}`, { token: admin.token });
    assert.equal(response.status, 404, `${path}/${id} should be invisible`);
  }
});

test('a campus principal cannot mutate a foreign campus record', async () => {
  const patchStudent = await call(ctx, 'PATCH', `/api/students/${tvcStudentId}`, {
    token: admin.token,
    body: { fullName: 'Hijacked' },
  });
  assert.equal(patchStudent.status, 404);

  const patchRoute = await call(ctx, 'PATCH', `/api/routes/${tvcRouteId}`, {
    token: admin.token,
    body: { name: 'Hijacked Route' },
  });
  assert.equal(patchRoute.status, 404);

  const deleteBus = await call(ctx, 'DELETE', `/api/buses/${tvcBusId}`, { token: admin.token });
  assert.equal(deleteBus.status, 404);
});

// ---------------------------------------------------------------------------
// Platform principal: no campus data by default, drill-down on demand
// ---------------------------------------------------------------------------

test('platform registries are empty until a campus is chosen', async () => {
  const students = await call(ctx, 'GET', '/api/students?limit=500', { token: superAdmin.token });
  assert.equal(students.status, 200);
  assert.deepEqual(students.body.data.students, []);
  assert.equal(students.body.data.meta.total, 0);

  const buses = await call(ctx, 'GET', '/api/buses', { token: superAdmin.token });
  assert.equal(buses.status, 200);
  assert.deepEqual(buses.body.data.buses, []);
  assert.equal(buses.body.data.summary.total, 0);

  const routes = await call(ctx, 'GET', '/api/routes', { token: superAdmin.token });
  assert.equal(routes.status, 200);
  assert.deepEqual(routes.body.data.routes, []);
});

test('the platform owner can drill into exactly one campus', async () => {
  const iic = await call(ctx, 'GET', `/api/students?limit=500&tenantId=${IIC_TENANT}`, {
    token: superAdmin.token,
  });
  assert.equal(iic.status, 200);
  assert.equal(iic.body.data.meta.total, countRows('students', IIC_TENANT));
  assert.ok(iic.body.data.students.some((row) => row.id === iicStudentId));
  assert.ok(!iic.body.data.students.some((row) => row.id === tvcStudentId));

  const tvc = await call(ctx, 'GET', `/api/students?limit=500&tenantId=${tvcId}`, {
    token: superAdmin.token,
  });
  assert.equal(tvc.status, 200);
  assert.deepEqual(
    tvc.body.data.students.map((row) => row.id),
    [tvcStudentId],
  );

  const tvcBuses = await call(ctx, 'GET', `/api/buses?tenantId=${tvcId}`, {
    token: superAdmin.token,
  });
  assert.equal(tvcBuses.status, 200);
  assert.equal(tvcBuses.body.data.summary.total, 1);
  assert.deepEqual(
    tvcBuses.body.data.buses.map((row) => row.id),
    [tvcBusId],
  );
});

test('an unknown campus filter is rejected rather than silently empty', async () => {
  const response = await call(ctx, 'GET', '/api/students?tenantId=00000000-0000-4000-8000-000000000000', {
    token: superAdmin.token,
  });
  assert.equal(response.status, 422);
});

// ---------------------------------------------------------------------------
// Writes: a campus principal inherits its campus; the platform must name one
// ---------------------------------------------------------------------------

test('platform writes must name the campus they belong to', async () => {
  const students = await call(ctx, 'POST', '/api/students', {
    token: superAdmin.token,
    body: { fullName: 'Orphan Rider', collegeId: 'NOCAMP-1' },
  });
  assert.equal(students.status, 422);
  assert.equal(students.body.error.code, 'VALIDATION_FAILED');
  assert.ok(students.body.error.details?.some((issue) => issue.field === 'tenantId'));

  const buses = await call(ctx, 'POST', '/api/buses', {
    token: superAdmin.token,
    body: { code: 'NOCAMP-B1', registrationNo: 'BA-1-PA-0001', name: 'Orphan Bus', seatCapacity: 20 },
  });
  assert.equal(buses.status, 422);

  const routes = await call(ctx, 'POST', '/api/routes', {
    token: superAdmin.token,
    body: {
      code: 'NOCAMP-R1',
      name: 'Orphan Route',
      startPoint: 'A',
      endPoint: 'B',
      departureTime: '07:00',
      arrivalTime: '08:00',
    },
  });
  assert.equal(routes.status, 422);

  // Nothing unowned leaked into the table.
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM students WHERE college_id = 'NOCAMP-1'").get().n, 0);
});

test('a campus principal writes into its own campus regardless of the body', async () => {
  const response = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Escape Attempt', collegeId: 'IIC-ESC-1', tenantId: tvcId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const row = ctx.db
    .prepare("SELECT tenant_id FROM students WHERE college_id = 'IIC-ESC-1'")
    .get();
  assert.equal(row.tenant_id, IIC_TENANT);
});

// ---------------------------------------------------------------------------
// Platform account provisioning
// ---------------------------------------------------------------------------

test('the platform owner can provision a peer Super Administrator', async () => {
  const email = `peer-super-${Date.now()}@transitsync.me`;
  const response = await call(ctx, 'POST', '/api/users', {
    token: superAdmin.token,
    body: {
      email,
      fullName: 'Peer Platform Owner',
      roleId: roleIdOf(ctx, ROLE_KEYS.SUPER_ADMIN),
      temporaryPassword: 'PeerRoot!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const row = ctx.db.prepare('SELECT tenant_id FROM users WHERE email = ?').get(email);
  assert.equal(row.tenant_id, null, 'a Super Administrator is platform-global');

  // Appears immediately in the platform directory.
  const listed = await call(ctx, 'GET', `/api/users?search=${encodeURIComponent(email)}`, {
    token: superAdmin.token,
  });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.users.some((user) => user.email === email));

  // But a campus administrator never even sees that level-200 accounts exist.
  const hidden = await call(ctx, 'GET', `/api/users?search=${encodeURIComponent(email)}`, {
    token: admin.token,
  });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.data.users.length, 0);

  // The new owner can sign in and gets the (empty) platform-level view.
  const session = await login(ctx, email, 'PeerRoot!2024x');
  assert.equal(session.user.roleLevel, SUPER_ADMIN_LEVEL);
  const students = await call(ctx, 'GET', '/api/students', { token: session.token });
  assert.equal(students.status, 200);
  assert.deepEqual(students.body.data.students, []);
});

test('a platform Super Administrator is refused a campus binding', async () => {
  const response = await call(ctx, 'POST', '/api/users', {
    token: superAdmin.token,
    body: {
      email: `bound-super-${Date.now()}@transitsync.me`,
      fullName: 'Bound Owner',
      roleId: roleIdOf(ctx, ROLE_KEYS.SUPER_ADMIN),
      tenantId: tvcId,
      temporaryPassword: 'PeerRoot!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(response.status, 422);
});

test('platform-created campus accounts must be bound to a campus', async () => {
  const missing = await call(ctx, 'POST', '/api/users', {
    token: superAdmin.token,
    body: {
      email: `unbound-admin-${Date.now()}@transitsync.edu.np`,
      fullName: 'Unbound Admin',
      roleId: roleIdOf(ctx, ROLE_KEYS.SYSTEM_ADMIN),
      temporaryPassword: 'Unbound!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(missing.status, 422);

  const email = `tvc-sysadmin-${Date.now()}@transitsync.edu.np`;
  const bound = await call(ctx, 'POST', '/api/users', {
    token: superAdmin.token,
    body: {
      email,
      fullName: 'TVC Sysadmin',
      roleId: roleIdOf(ctx, ROLE_KEYS.SYSTEM_ADMIN),
      tenantId: tvcId,
      temporaryPassword: 'TvcAdmin!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(bound.status, 201, JSON.stringify(bound.body));
  const row = ctx.db.prepare('SELECT tenant_id FROM users WHERE email = ?').get(email);
  assert.equal(row.tenant_id, tvcId);
});

test('a campus principal still cannot mint a System or Super Administrator', async () => {
  for (const roleKey of [ROLE_KEYS.SYSTEM_ADMIN, ROLE_KEYS.SUPER_ADMIN]) {
    const response = await call(ctx, 'POST', '/api/users', {
      token: admin.token,
      body: {
        email: `mint-${roleKey}-${Date.now()}@transitsync.edu.np`,
        fullName: 'Would-be Root',
        roleId: roleIdOf(ctx, roleKey),
        temporaryPassword: 'Root!2024x',
        forcePasswordChange: false,
      },
    });
    assert.equal(response.status, 403, `${roleKey} must stay un-mintable`);
    assert.equal(response.body.error.code, 'LEVEL_LOCKED');
  }
});

test('promoting an account to Super Administrator detaches it from its campus', async () => {
  const response = await call(ctx, 'PATCH', `/api/users/${tvcStaffId}`, {
    token: superAdmin.token,
    body: { roleId: roleIdOf(ctx, ROLE_KEYS.SUPER_ADMIN) },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const row = ctx.db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(tvcStaffId);
  assert.equal(row.tenant_id, null);
});

// ---------------------------------------------------------------------------
// Second campus end-to-end: the two campuses are mutually invisible
// ---------------------------------------------------------------------------

test('a second campus administrator sees their campus and nothing else', async () => {
  const tvcAdmin = await rotateIn(ctx, tvcAdminEmail, tvcAdminPassword, CAMPUS_PASSWORD);

  const students = await call(ctx, 'GET', '/api/students?limit=500', { token: tvcAdmin.token });
  assert.equal(students.status, 200);
  assert.deepEqual(
    students.body.data.students.map((row) => row.id),
    [tvcStudentId],
  );
  assert.ok(!students.body.data.students.some((row) => row.id === iicStudentId));

  const routes = await call(ctx, 'GET', '/api/routes', { token: tvcAdmin.token });
  assert.equal(routes.status, 200);
  assert.deepEqual(
    routes.body.data.routes.map((row) => row.id),
    [tvcRouteId],
  );
});
