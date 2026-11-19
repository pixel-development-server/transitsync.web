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

  // A forced reset halts sign-in and hands back a single-purpose reset token
  // instead of a session. Set the new password with it, then authenticate
  // normally with the credential just chosen.
  if (first.body.requireNewPassword) {
    const reset = await call(context, 'POST', '/api/auth/set-new-password', {
      body: {
        email,
        resetToken: first.body.data.resetToken,
        newPassword,
        confirmPassword: newPassword,
      },
    });
    assert.equal(reset.status, 200, `forced reset failed for ${email}: ${JSON.stringify(reset.body)}`);
    assert.equal(reset.body.data.mustChangePassword, false);
    return login(context, email, newPassword, 'staff');
  }

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

const countRows = async (table, tenant) =>
  (await ctx.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, tenant)).n;

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
      roleId: await roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
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
  assert.equal(students.body.data.meta.total, await countRows('students', IIC_TENANT));
  assert.ok(!students.body.data.students.some((row) => row.id === tvcStudentId));
  assert.ok(students.body.data.students.some((row) => row.id === iicStudentId));

  const buses = await call(ctx, 'GET', '/api/buses', { token: admin.token });
  assert.equal(buses.status, 200);
  assert.equal(buses.body.data.summary.total, await countRows('buses', IIC_TENANT));
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
  assert.equal(response.body.data.meta.total, await countRows('students', IIC_TENANT));
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
  assert.equal(iic.body.data.meta.total, await countRows('students', IIC_TENANT));
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
  const leaked = await ctx.db.get("SELECT COUNT(*) AS n FROM students WHERE college_id = 'NOCAMP-1'");
  assert.equal(leaked.n, 0);
});

test('a campus principal writes into its own campus regardless of the body', async () => {
  const response = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Escape Attempt', collegeId: 'IIC-ESC-1', tenantId: tvcId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const row = await ctx.db.get("SELECT tenant_id FROM students WHERE college_id = 'IIC-ESC-1'");
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
      roleId: await roleIdOf(ctx, ROLE_KEYS.SUPER_ADMIN),
      temporaryPassword: 'PeerRoot!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const row = await ctx.db.get('SELECT tenant_id FROM users WHERE email = ?', email);
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
      roleId: await roleIdOf(ctx, ROLE_KEYS.SUPER_ADMIN),
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
      roleId: await roleIdOf(ctx, ROLE_KEYS.SYSTEM_ADMIN),
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
      roleId: await roleIdOf(ctx, ROLE_KEYS.SYSTEM_ADMIN),
      tenantId: tvcId,
      temporaryPassword: 'TvcAdmin!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(bound.status, 201, JSON.stringify(bound.body));
  const row = await ctx.db.get('SELECT tenant_id FROM users WHERE email = ?', email);
  assert.equal(row.tenant_id, tvcId);
});

test('a campus principal still cannot mint a System or Super Administrator', async () => {
  for (const roleKey of [ROLE_KEYS.SYSTEM_ADMIN, ROLE_KEYS.SUPER_ADMIN]) {
    const response = await call(ctx, 'POST', '/api/users', {
      token: admin.token,
      body: {
        email: `mint-${roleKey}-${Date.now()}@transitsync.edu.np`,
        fullName: 'Would-be Root',
        roleId: await roleIdOf(ctx, roleKey),
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
    body: { roleId: await roleIdOf(ctx, ROLE_KEYS.SUPER_ADMIN) },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const row = await ctx.db.get('SELECT tenant_id FROM users WHERE id = ?', tvcStaffId);
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

// ---------------------------------------------------------------------------
// Dashboard & alert feeds
// ---------------------------------------------------------------------------
test('dashboard KPIs, fleet monitor and activity feed are campus-scoped', async () => {
  const dashboard = await call(ctx, 'GET', '/api/dashboard', { token: admin.token });
  assert.equal(dashboard.status, 200);
  const { kpis, fleet, activity } = dashboard.body.data;

  // The IIC principal's dashboard counts exactly IIC's roster.
  assert.ok(kpis.students.total > 0, 'IIC has roster rows');
  assert.equal(kpis.students.total, await countRows('students', IIC_TENANT));

  // The fleet monitor must never show another campus's bus.
  assert.ok(fleet.length > 0, 'IIC has an active fleet');
  assert.ok(fleet.every((bus) => bus.id !== tvcBusId), 'TVC bus leaked onto the IIC fleet monitor');

  // The activity feed shows the IIC (seeded) scan history.
  assert.ok(activity.length > 0, 'IIC sees its seeded scan history');

  // A platform principal sees no campus data until they drill in.
  const bare = await call(ctx, 'GET', '/api/dashboard', { token: superAdmin.token });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.data.kpis.students.total, 0);
  assert.equal(bare.body.data.fleet.length, 0);
  assert.equal(bare.body.data.activity.length, 0);

  // …and exactly one campus once they drill in with ?tenantId=.
  const drilled = await call(ctx, 'GET', `/api/dashboard?tenantId=${tvcId}`, { token: superAdmin.token });
  assert.equal(drilled.status, 200);
  assert.equal(drilled.body.data.kpis.students.total, await countRows('students', tvcId));
  assert.deepEqual(drilled.body.data.fleet.map((bus) => bus.id), [tvcBusId], 'drill-in shows exactly the TVC bus');
});

test('alerts list, stats and record access are campus-scoped', async () => {
  // A TVC alert: the platform owner references TVC's bus, so it lands on TVC.
  const tvcAlert = await call(ctx, 'POST', '/api/alerts', {
    token: superAdmin.token,
    body: { title: 'TVC-only notice', message: 'Belongs to TVC.', severity: 'LOW', busId: tvcBusId },
  });
  assert.equal(tvcAlert.status, 201, JSON.stringify(tvcAlert.body));
  const tvcAlertId = tvcAlert.body.data.alert.id;

  // An IIC alert: a campus-authored notice, stamped with the author's campus.
  const iicAlert = await call(ctx, 'POST', '/api/alerts', {
    token: admin.token,
    body: { title: 'IIC-only notice', message: 'Belongs to IIC.', severity: 'LOW' },
  });
  assert.equal(iicAlert.status, 201, JSON.stringify(iicAlert.body));
  const iicAlertId = iicAlert.body.data.alert.id;

  // The IIC list: own rows in, the other campus's out.
  const iicList = await call(ctx, 'GET', '/api/alerts?limit=200', { token: admin.token });
  const iicIds = iicList.body.data.alerts.map((alert) => alert.id);
  assert.ok(iicIds.includes(iicAlertId), 'IIC sees its own alert');
  assert.ok(!iicIds.includes(tvcAlertId), 'TVC alert leaked into the IIC alert list');

  // Platform default: nothing; drill-in: exactly that campus.
  const bare = await call(ctx, 'GET', '/api/alerts', { token: superAdmin.token });
  assert.equal(bare.body.data.alerts.length, 0, 'platform default sees no campus alerts');
  const drilled = await call(ctx, 'GET', `/api/alerts?tenantId=${tvcId}`, { token: superAdmin.token });
  assert.deepEqual(drilled.body.data.alerts.map((alert) => alert.id), [tvcAlertId]);

  // Cross-campus reads and mutations report not-found, never data.
  assert.equal((await call(ctx, 'GET', `/api/alerts/${tvcAlertId}`, { token: admin.token })).status, 404);
  assert.equal((await call(ctx, 'POST', `/api/alerts/${tvcAlertId}/acknowledge`, { token: admin.token })).status, 404);
  assert.equal((await call(ctx, 'POST', `/api/alerts/${tvcAlertId}/resolve`, { token: admin.token, body: {} })).status, 404);

  // Stats always agree with the scoped list for each principal.
  const iicStats = await call(ctx, 'GET', '/api/alerts/stats', { token: admin.token });
  assert.ok(iicStats.body.data.open >= 1, 'IIC stats count at least the seeded + own alerts');
  const bareStats = await call(ctx, 'GET', '/api/alerts/stats', { token: superAdmin.token });
  assert.equal(bareStats.body.data.open, 0, 'platform default stats are empty');
  const drilledStats = await call(ctx, 'GET', `/api/alerts/stats?tenantId=${tvcId}`, { token: superAdmin.token });
  assert.equal(drilledStats.body.data.open, 1, 'TVC drill-in counts exactly the TVC notice');
});
