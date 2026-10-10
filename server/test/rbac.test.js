import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  login,
  loginAdmin,
  insertUser,
  roleIdOf,
  ROLE_KEYS,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  STAFF_PASSWORD,
} from './support/harness.js';

let ctx;

test.before(async () => {
  ctx = await bootServer();
});

test.after(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------
// Public surface + bootstrap
// ---------------------------------------------------------------------------
test('health endpoint is public and reports a live database', async () => {
  const response = await call(ctx, 'GET', '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'healthy');
  assert.equal(response.body.data.database, 'up');
});

test('setup-status reports the system is already bootstrapped', async () => {
  const response = await call(ctx, 'GET', '/api/auth/setup-status');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.bootstrapped, true);
  assert.equal(response.body.data.bootstrapEmail, ADMIN_EMAIL);
});

test('setup cannot be replayed once a System Administrator exists', async () => {
  const response = await call(ctx, 'POST', '/api/auth/setup', {
    body: {
      email: 'attacker@transitsync.edu.np',
      password: 'TotallyLegit!99',
      confirmPassword: 'TotallyLegit!99',
      fullName: 'Mallory',
      institution: 'Rogue University',
    },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'CONFLICT');
});

test('unauthenticated access to protected routes is rejected', async () => {
  for (const path of [
    '/api/dashboard',
    '/api/students',
    '/api/users',
    '/api/attendance',
    '/api/alerts',
    '/api/system',
  ]) {
    const response = await call(ctx, 'GET', path);
    assert.equal(response.status, 401, `${path} should require auth`);
    // A missing credential is reported distinctly from a bad one, so the UI can
    // tell "sign in" apart from "your session is broken".
    assert.equal(response.body.error.code, 'NO_TOKEN', `${path} should report NO_TOKEN`);
  }
});

test('a garbage bearer token is rejected, not trusted', async () => {
  const response = await call(ctx, 'GET', '/api/dashboard', { token: 'not-a-real-jwt' });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'TOKEN_INVALID');
});

test('wrong password does not authenticate and is audit logged', async () => {
  const response = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: 'definitely-wrong' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
});

// ---------------------------------------------------------------------------
// Forced first-login password rotation
// ---------------------------------------------------------------------------
test('bootstrap admin is forced to rotate before touching anything else', async () => {
  const session = await login(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(session.mustChangePassword, true);
  assert.equal(session.user.isFirstLogin, true);
  assert.equal(session.user.passwordChanged, false);

  // Bootstrap endpoints stay reachable.
  const me = await call(ctx, 'GET', '/api/auth/me', { token: session.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.mustChangePassword, true);

  // Everything else is gated.
  for (const path of ['/api/dashboard', '/api/students', '/api/users', '/api/buses']) {
    const blocked = await call(ctx, 'GET', path, { token: session.token });
    assert.equal(blocked.status, 403, `${path} should be blocked during rotation`);
    // A dedicated code lets the SPA route to the change-password screen instead
    // of rendering a generic "permission denied".
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(blocked.body.error.details.mustChangePassword, true);
  }
});

test('a weak replacement password is refused with per-rule feedback', async () => {
  const session = await login(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  const response = await call(ctx, 'POST', '/api/auth/change-password', {
    token: session.token,
    body: { currentPassword: ADMIN_PASSWORD, newPassword: 'weak', confirmPassword: 'weak' },
  });
  assert.equal(response.status, 422);
  const messages = response.body.error.details.map((detail) => detail.message).join(' ');
  assert.match(messages, /uppercase|at least/i);
});

test('after rotation the same account reaches the dashboard', async () => {
  const session = await loginAdmin(ctx);
  assert.equal(session.mustChangePassword, false);
  assert.equal(session.user.passwordChanged, true);
  assert.equal(session.user.forcePasswordReset, false);

  const dashboard = await call(ctx, 'GET', '/api/dashboard', { token: session.token });
  assert.equal(dashboard.status, 200);
});

test('admin can force a password reset on another account, gating it immediately', async () => {
  const admin = await loginAdmin(ctx);

  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email: `forced-${Date.now()}@transitsync.edu.np`,
      fullName: 'Forced Reset Subject',
      roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT),
      temporaryPassword: 'InitialPass!2024',
      forcePasswordChange: true,
    },
  });
  assert.equal(created.status, 201);
  const userId = created.body.data.user.id;

  const session = await login(ctx, created.body.data.user.email, 'InitialPass!2024');
  assert.equal(session.mustChangePassword, true);

  const reset = await call(ctx, 'POST', `/api/users/${userId}/force-password-reset`, {
    token: admin.token,
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.user.forcePasswordReset, true);
  assert.equal(reset.body.data.user.mustChangePassword, true);

  // The old session is dead the moment the reset lands.
  const stale = await call(ctx, 'GET', '/api/dashboard', { token: session.token });
  assert.equal(stale.status, 401);
});

// ---------------------------------------------------------------------------
// The permission matrix, exercised across all three roles
// ---------------------------------------------------------------------------

/**
 * Expected outcome per endpoint per role.
 *   'allow' -> 2xx, 'deny' -> 403, 'own' -> 200
 */
const MATRIX = [
  { label: 'read dashboard', method: 'GET', path: '/api/dashboard', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'list students', method: 'GET', path: '/api/students', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'create student', method: 'POST', path: '/api/students', admin: 'allow', staff: 'allow', attendant: 'deny', body: {} },
  { label: 'list buses', method: 'GET', path: '/api/buses', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'create bus', method: 'POST', path: '/api/buses', admin: 'allow', staff: 'allow', attendant: 'deny', body: {} },
  { label: 'delete bus', method: 'DELETE', path: '/api/buses/999999', admin: 'allow', staff: 'deny', attendant: 'deny' },
  { label: 'list routes', method: 'GET', path: '/api/routes', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'edit route stops', method: 'PUT', path: '/api/routes/1/stops', admin: 'allow', staff: 'allow', attendant: 'deny', body: { stops: [] } },
  { label: 'read attendance', method: 'GET', path: '/api/attendance', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'read demand analytics', method: 'GET', path: '/api/attendance/demand', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'export CSV', method: 'GET', path: '/api/attendance/export?format=csv', admin: 'allow', staff: 'allow', attendant: 'deny' },
  { label: 'export PDF', method: 'GET', path: '/api/attendance/export?format=pdf', admin: 'allow', staff: 'allow', attendant: 'deny' },
  { label: 'read alerts', method: 'GET', path: '/api/alerts', admin: 'allow', staff: 'allow', attendant: 'allow' },
  { label: 'resolve alert', method: 'POST', path: '/api/alerts/1/resolve', admin: 'allow', staff: 'allow', attendant: 'deny', body: {} },
  { label: 'bulk resolve alerts', method: 'POST', path: '/api/alerts/bulk/resolve', admin: 'allow', staff: 'allow', attendant: 'deny', body: { ids: [1] } },
  { label: 'drive RFID simulator', method: 'POST', path: '/api/simulator/tap', admin: 'allow', staff: 'allow', attendant: 'deny', body: { rfidSerial: 'TS-TEST-1' } },
  { label: 'list users', method: 'GET', path: '/api/users', admin: 'allow', staff: 'deny', attendant: 'deny' },
  { label: 'create user', method: 'POST', path: '/api/users', admin: 'allow', staff: 'deny', attendant: 'deny', body: {} },
  { label: 'read permission matrix', method: 'GET', path: '/api/users/matrix', admin: 'allow', staff: 'deny', attendant: 'deny' },
  { label: 'assign permissions', method: 'PUT', path: '/api/users/1/permissions', admin: 'allow', staff: 'deny', attendant: 'deny', body: { permissions: [] } },
  { label: 'audit log', method: 'GET', path: '/api/users/audit', admin: 'allow', staff: 'deny', attendant: 'deny' },
  { label: 'read roles', method: 'GET', path: '/api/roles', admin: 'allow', staff: 'deny', attendant: 'deny' },
  // A non-existent role keeps this probe non-destructive: a real role edit here
  // would strip permissions the staff assertions below depend on.
  { label: 'edit role permissions', method: 'PUT', path: '/api/roles/does_not_exist/permissions', admin: 'allow', staff: 'deny', attendant: 'deny', body: { permissions: [] } },
  { label: 'read settings', method: 'GET', path: '/api/system', admin: 'allow', staff: 'allow', attendant: 'deny' },
  { label: 'edit settings', method: 'PATCH', path: '/api/system', admin: 'allow', staff: 'deny', attendant: 'deny', body: {} },
  { label: 'create backup', method: 'POST', path: '/api/system/backups', admin: 'allow', staff: 'deny', attendant: 'deny' },
  { label: 'list backups', method: 'GET', path: '/api/system/backups', admin: 'allow', staff: 'deny', attendant: 'deny' },
  { label: 'open realtime stream', method: 'GET', path: '/api/stream/status', admin: 'allow', staff: 'allow', attendant: 'allow' },
];

test('permission matrix is enforced for every role', async (t) => {
  const admin = await loginAdmin(ctx);
  const staff = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);
  const attendant = await login(ctx, 'attendant@transitsync.edu.np', STAFF_PASSWORD);

  const tokens = { admin: admin.token, staff: staff.token, attendant: attendant.token };

  for (const entry of MATRIX) {
    await t.test(`${entry.label} — ${entry.method} ${entry.path}`, async () => {
      for (const role of ['admin', 'staff', 'attendant']) {
        const expected = entry[role];
        const response = await call(ctx, entry.method, entry.path, {
          token: tokens[role],
          body: entry.body,
        });

        if (expected === 'deny') {
          assert.equal(
            response.status,
            403,
            `${role} should be denied ${entry.method} ${entry.path}, got ${response.status}`,
          );
          assert.ok(
            ['PERMISSION_DENIED', 'FORBIDDEN'].includes(response.body?.error?.code),
            `${role} denial should report PERMISSION_DENIED, got ${response.body?.error?.code}`,
          );
        } else {
          assert.notEqual(
            response.status,
            403,
            `${role} should be allowed ${entry.method} ${entry.path} but was denied`,
          );
          assert.ok(
            response.status < 500,
            `${role} on ${entry.path} returned a server error (${response.status}): ${JSON.stringify(response.body)}`,
          );
        }
      }
    });
  }
});

test('System Administrator holds every catalogue permission', async () => {
  const admin = await loginAdmin(ctx);
  const matrix = await call(ctx, 'GET', '/api/users/matrix', { token: admin.token });
  assert.equal(matrix.status, 200);

  const expected = matrix.body.data.modules.flatMap((module) =>
    module.actions.map((action) => `${module.key}:${action.action}`),
  );

  const me = await call(ctx, 'GET', '/api/auth/me', { token: admin.token });
  for (const permission of expected) {
    assert.ok(
      me.body.data.user.permissions.includes(permission),
      `admin is missing ${permission}`,
    );
  }
  assert.deepEqual([...me.body.data.user.permissions].sort(), [...expected].sort());
});

test('attendant is strictly read-only across every module', async () => {
  const attendant = await login(ctx, 'attendant@transitsync.edu.np', STAFF_PASSWORD);
  const me = await call(ctx, 'GET', '/api/auth/me', { token: attendant.token });
  const held = me.body.data.user.permissions;

  const writeLike = held.filter((key) => {
    const [, action] = key.split(':');
    return ['create', 'edit', 'delete', 'resolve', 'assign_permissions', 'export', 'scan'].includes(action);
  });
  assert.deepEqual(writeLike, [], `attendant must not hold any write permission, found ${writeLike}`);
  assert.ok(held.includes('dashboard:read'));
  assert.ok(held.includes('attendance:read'));
});

test('transport staff cannot reach User Management at all', async () => {
  const staff = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);
  for (const path of ['/api/users', '/api/roles', '/api/system/backups']) {
    const response = await call(ctx, 'GET', path, { token: staff.token });
    assert.equal(response.status, 403, `staff should not reach ${path}`);
  }
  // ...but does have full operational write access within their remit.
  const created = await call(ctx, 'POST', '/api/buses', {
    token: staff.token,
    body: {
      code: 'TS-STAFF',
      registrationNo: 'Ba 9 Te 1234',
      name: 'Staff Created Bus',
      seatCapacity: 30,
    },
  });
  assert.equal(created.status, 201);
});

// ---------------------------------------------------------------------------
// Per-user permission overrides
// ---------------------------------------------------------------------------
test('CUSTOM permissions override the role and take effect on the next sign-in', async () => {
  const admin = await loginAdmin(ctx);

  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email: `restricted-${Date.now()}@transitsync.edu.np`,
      fullName: 'Restricted Attendant',
      roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT),
      temporaryPassword: 'RestrictPass!24',
      permissionsMode: 'CUSTOM',
      permissions: ['dashboard:read'],
      forcePasswordChange: false,
    },
  });
  assert.equal(created.status, 201);
  const userId = created.body.data.user.id;
  assert.deepEqual(created.body.data.user.permissions, ['dashboard:read']);

  const session = await login(ctx, created.body.data.user.email, 'RestrictPass!24');

  const dashboard = await call(ctx, 'GET', '/api/dashboard', { token: session.token });
  assert.equal(dashboard.status, 200, 'granted permission should work');

  const students = await call(ctx, 'GET', '/api/students', { token: session.token });
  assert.equal(students.status, 403, 'permission removed from the role should now be denied');

  // Widen the grant through the admin API and confirm the effect after re-login.
  const widened = await call(ctx, 'PUT', `/api/users/${userId}/permissions`, {
    token: admin.token,
    body: { permissionsMode: 'CUSTOM', permissions: ['dashboard:read', 'students:read'] },
  });
  assert.equal(widened.status, 200);

  const session2 = await login(ctx, created.body.data.user.email, 'RestrictPass!24');
  const students2 = await call(ctx, 'GET', '/api/students', { token: session2.token });
  assert.equal(students2.status, 200);
});

test('an admin cannot be stripped of User Management permissions', async () => {
  const admin = await loginAdmin(ctx);
  const me = await call(ctx, 'GET', '/api/auth/me', { token: admin.token });
  const myId = me.body.data.user.id;

  const response = await call(ctx, 'PUT', `/api/users/${myId}/permissions`, {
    token: admin.token,
    body: { permissionsMode: 'CUSTOM', permissions: ['dashboard:read'] },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /cannot be stripped/i);
});

test('the System Administrator role itself is immutable', async () => {
  const admin = await loginAdmin(ctx);
  const response = await call(ctx, 'PUT', '/api/roles/system_admin/permissions', {
    token: admin.token,
    body: { permissions: ['dashboard:read'] },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /cannot be edited/i);
});

test('unknown permission keys are rejected before they reach the database', async () => {
  const admin = await loginAdmin(ctx);
  const response = await call(ctx, 'PUT', '/api/users/1/permissions', {
    token: admin.token,
    body: { permissionsMode: 'CUSTOM', permissions: ['students:teleport', 'root:shell'] },
  });
  assert.equal(response.status, 422);
  assert.match(JSON.stringify(response.body.error.details), /not a valid permission/);
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
test('revoking a session kills only the targeted device', async () => {
  const phone = await loginAdmin(ctx);
  const laptop = await loginAdmin(ctx);

  const sessions = await call(ctx, 'GET', '/api/auth/sessions', { token: laptop.token });
  assert.equal(sessions.status, 200);

  const currentId = sessions.body.data.currentSessionId;
  assert.equal(currentId, laptop.sessionId, 'the caller sees itself as the current session');
  assert.ok(
    sessions.body.data.sessions.some((session) => session.id === phone.sessionId),
    'the phone sign-in should appear as a separate session',
  );

  // Target the phone by its known id rather than by position — earlier tests in
  // this file have already left their own (still valid) admin sessions behind.
  const revoked = await call(ctx, 'DELETE', `/api/auth/sessions/${phone.sessionId}`, {
    token: laptop.token,
  });
  assert.equal(revoked.status, 200);

  const after = await call(ctx, 'GET', '/api/auth/sessions', { token: laptop.token });
  // Revocation is a soft delete so the audit trail keeps the device history.
  const phoneRow = after.body.data.sessions.find((session) => session.id === phone.sessionId);
  assert.ok(phoneRow, 'the revoked session is retained for the audit trail');
  assert.ok(phoneRow.revoked_at, 'the revoked session must be stamped as revoked');
  assert.equal(phoneRow.revoked_reason, 'user_revoked');

  const laptopRow = after.body.data.sessions.find((session) => session.id === currentId);
  assert.ok(laptopRow, 'the surviving session must be untouched');
  assert.equal(laptopRow.revoked_at, null, 'the surviving session must still be active');

  const phoneAfter = await call(ctx, 'GET', '/api/dashboard', { token: phone.token });
  assert.equal(phoneAfter.status, 401, 'revoked session token must stop working');

  const laptopAfter = await call(ctx, 'GET', '/api/dashboard', { token: laptop.token });
  assert.equal(laptopAfter.status, 200, 'the surviving session must keep working');
});

test('logout revokes the current session token', async () => {
  const admin = await loginAdmin(ctx);
  const out = await call(ctx, 'POST', '/api/auth/logout', { token: admin.token });
  assert.equal(out.status, 200);

  const after = await call(ctx, 'GET', '/api/dashboard', { token: admin.token });
  assert.equal(after.status, 401);
  assert.equal(after.body.error.code, 'SESSION_REVOKED');
});

test('a suspended account cannot use an existing token', async () => {
  const admin = await loginAdmin(ctx);
  const email = `suspend-${Date.now()}@transitsync.edu.np`;
  insertUser(ctx, { email, password: STAFF_PASSWORD, fullName: 'Suspend Me', roleKey: ROLE_KEYS.ATTENDANT });

  const session = await login(ctx, email, STAFF_PASSWORD);
  assert.equal((await call(ctx, 'GET', '/api/dashboard', { token: session.token })).status, 200);

  const users = await call(ctx, 'GET', '/api/users?search=suspend-', { token: admin.token });
  const target = users.body.data.users[0];

  const suspended = await call(ctx, 'PATCH', `/api/users/${target.id}`, {
    token: admin.token,
    body: { status: 'suspended' },
  });
  assert.equal(suspended.status, 200);

  const after = await call(ctx, 'GET', '/api/dashboard', { token: session.token });
  assert.ok([401, 403].includes(after.status), `suspended token should fail, got ${after.status}`);
});

test('the last active System Administrator cannot be demoted or deleted', async () => {
  const admin = await loginAdmin(ctx);
  const me = await call(ctx, 'GET', '/api/auth/me', { token: admin.token });
  const myId = me.body.data.user.id;

  const demote = await call(ctx, 'PATCH', `/api/users/${myId}`, {
    token: admin.token,
    body: { roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT) },
  });
  assert.equal(demote.status, 400);
  assert.match(demote.body.error.message, /at least one active System Administrator/i);

  const remove = await call(ctx, 'DELETE', `/api/users/${myId}`, { token: admin.token });
  assert.equal(remove.status, 400);
});

test('an admin cannot delete their own account', async () => {
  const admin = await loginAdmin(ctx);
  const me = await call(ctx, 'GET', '/api/auth/me', { token: admin.token });
  const response = await call(ctx, 'DELETE', `/api/users/${me.body.data.user.id}`, { token: admin.token });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /cannot delete your own/i);
});
