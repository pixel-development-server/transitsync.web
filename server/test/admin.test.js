import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  login,
  loginAdmin,
  insertUser,
  createStaffUser,
  roleIdOf,
  ROLE_KEYS,
  ADMIN_EMAIL,
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
// Role hierarchy
// ---------------------------------------------------------------------------

test('the level-90 Administrator role is seeded below System Administrator', async () => {
  const admin = await loginAdmin(ctx);
  const matrix = await call(ctx, 'GET', '/api/users/matrix', { token: admin.token });
  assert.equal(matrix.status, 200);

  const role = matrix.body.data.roles.find((entry) => entry.key === 'admin');
  assert.ok(role, 'admin role should exist in the matrix');
  assert.equal(role.level, 90);
  assert.equal(role.is_system, 1);

  for (const key of [
    'dashboard:read',
    'students:edit',
    'fleet:create',
    'fleet:edit',
    'attendance:export',
    'alerts:resolve',
    'users:create',
    'users:assign_permissions',
    'roles:read',
    'settings:edit',
    'backup:create',
  ]) {
    assert.ok(role.permissions.includes(key), `admin role should hold ${key}`);
  }
  assert.ok(!role.permissions.includes('roles:edit'), 'admin role must not hold roles:edit');
  assert.ok(
    !role.permissions.some((key) => key.startsWith('system:')),
    'admin role must not hold System Control permissions',
  );

  const systemAdmin = matrix.body.data.roles.find((entry) => entry.key === 'system_admin');
  assert.ok(
    systemAdmin.permissions.some((key) => key.startsWith('system:')),
    'system_admin should hold the exclusive System Control permissions',
  );
});

test('no one can mint a System Administrator account', async () => {
  const admin = await loginAdmin(ctx);
  const response = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email: `new-root-${Date.now()}@transitsync.edu.np`,
      fullName: 'New Root',
      roleId: roleIdOf(ctx, ROLE_KEYS.SYSTEM_ADMIN),
      temporaryPassword: 'Root!2024x',
      forcePasswordChange: false,
    },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'LEVEL_LOCKED');
});

test('even a System Administrator cannot modify another System Administrator', async () => {
  const admin = await loginAdmin(ctx);
  const secondAdminId = insertUser(ctx, {
    email: 'second-root@transitsync.edu.np',
    password: 'Root2!2024x',
    fullName: 'Second Root',
    roleKey: ROLE_KEYS.SYSTEM_ADMIN,
  });

  const blockedEdit = await call(ctx, 'PATCH', `/api/users/${secondAdminId}`, {
    token: admin.token,
    body: { jobTitle: 'Changed' },
  });
  assert.equal(blockedEdit.status, 403);
  assert.equal(blockedEdit.body.error.code, 'LEVEL_LOCKED');

  const blockedPerms = await call(ctx, 'PUT', `/api/users/${secondAdminId}/permissions`, {
    token: admin.token,
    body: { permissionsMode: 'CUSTOM', permissions: ['dashboard:read'] },
  });
  assert.equal(blockedPerms.status, 403);
  assert.equal(blockedPerms.body.error.code, 'LEVEL_LOCKED');
});

// ---------------------------------------------------------------------------
// System Control facilities
// ---------------------------------------------------------------------------

test('System Control is reserved for the System Administrator', async () => {
  const staff = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);
  for (const [method, path, body] of [
    ['GET', '/api/admin/lockdown'],
    ['POST', '/api/admin/audit/purge', { olderThanDays: 0 }],
    ['POST', '/api/admin/sessions/revoke', { all: true }],
  ]) {
    const response = await call(ctx, method, path, { token: staff.token, body });
    assert.equal(response.status, 403, `${method} ${path} should be denied`);
    assert.equal(response.body.error.code, 'SYSTEM_ADMIN_ONLY');
  }
});

test('global emergency lockout freezes every non-admin session', async () => {
  const admin = await loginAdmin(ctx);
  const staff = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);

  try {
    const engaged = await call(ctx, 'POST', '/api/admin/lockdown', {
      token: admin.token,
      body: { locked: true, message: 'Emergency maintenance window' },
    });
    assert.equal(engaged.status, 200);
    assert.equal(engaged.body.data.locked, true);
    assert.equal(engaged.body.data.by, 'admin@transitsync.edu.np');

    const state = await call(ctx, 'GET', '/api/admin/lockdown', { token: admin.token });
    assert.equal(state.body.data.locked, true);

    const frozen = await call(ctx, 'GET', '/api/dashboard', { token: staff.token });
    assert.equal(frozen.status, 503);
    assert.equal(frozen.body.error.code, 'SYSTEM_LOCKDOWN');

    const adminOk = await call(ctx, 'GET', '/api/dashboard', { token: admin.token });
    assert.equal(adminOk.status, 200);
  } finally {
    if (admin) {
      await call(ctx, 'POST', '/api/admin/lockdown', { token: admin.token, body: { locked: false } });
    }
  }
});

test('audit purge flushes the trail yet keeps its own record', async () => {
  const admin = await loginAdmin(ctx);

  // Two audited events so the flush has something to remove.
  await call(ctx, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong-1' } });
  await call(ctx, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong-2' } });

  const before = await call(ctx, 'GET', '/api/users/audit', { token: admin.token });
  assert.ok(before.body.data.meta.total >= 2, 'expected audited events before purge');

  const purged = await call(ctx, 'POST', '/api/admin/audit/purge', {
    token: admin.token,
    body: { olderThanDays: 0 },
  });
  assert.equal(purged.status, 200);
  assert.equal(purged.body.data.purged, before.body.data.meta.total);

  const after = await call(ctx, 'GET', '/api/users/audit', { token: admin.token });
  assert.equal(after.body.data.meta.total, 1, 'only the purge event itself should remain');
  assert.equal(after.body.data.entries[0].action, 'audit.purge');
});

test('audit archive returns a CSV snapshot', async () => {
  const admin = await loginAdmin(ctx);
  const response = await call(ctx, 'GET', '/api/admin/audit/export', { token: admin.token, raw: true });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /attachment/);
  assert.match(response.text, /ID,Timestamp,Actor email,Actor name,Action/);
});

test('sessions can be revoked globally, preserving the System Administrator', async () => {
  const admin = await loginAdmin(ctx);
  const staffSession = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);

  const revoked = await call(ctx, 'POST', '/api/admin/sessions/revoke', {
    token: admin.token,
    body: { all: true },
  });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.data.revoked >= 1);

  const staffNow = await call(ctx, 'GET', '/api/dashboard', { token: staffSession.token });
  assert.equal(staffNow.status, 401);
  assert.equal(staffNow.body.error.code, 'SESSION_REVOKED');

  const adminStill = await call(ctx, 'GET', '/api/dashboard', { token: admin.token });
  assert.equal(adminStill.status, 200);
});

test('the password reset override bypasses every seniority cap', async () => {
  const admin = await loginAdmin(ctx);
  const staff = await createStaffUser(ctx, admin.token);
  const oldPassword = staff.payload.temporaryPassword;

  const override = await call(ctx, 'POST', `/api/admin/users/${staff.user.id}/reset-password`, {
    token: admin.token,
  });
  assert.equal(override.status, 201);
  const temp = override.body.data.temporaryPassword;
  assert.ok(temp && temp.length >= 8, 'should issue a fresh temporary password');

  const oldLogin = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: staff.user.email, password: oldPassword },
  });
  assert.equal(oldLogin.status, 401);

  const newSession = await login(ctx, staff.user.email, temp);
  assert.equal(newSession.mustChangePassword, true, 'override should force a rotation at sign-in');
});

// ---------------------------------------------------------------------------
// Seniority enforcement for the level-90 Administrator
// ---------------------------------------------------------------------------

test('a level-90 Administrator cannot modify accounts or roles at or above their level', async () => {
  const admin = await loginAdmin(ctx);
  const myId = (await call(ctx, 'GET', '/api/auth/me', { token: admin.token })).body.data.user.id;

  const create = async (suffix) => {
    const response = await call(ctx, 'POST', '/api/users', {
      token: admin.token,
      body: {
        email: `admin90-${suffix}-${Date.now()}@transitsync.edu.np`,
        fullName: `Campus Admin ${suffix}`,
        roleId: roleIdOf(ctx, ROLE_KEYS.ADMIN),
        jobTitle: 'Administrator',
        department: 'Administration',
        temporaryPassword: 'Admin90!2024x',
        forcePasswordChange: false,
      },
    });
    assert.equal(response.status, 201);
    return response.body.data.user;
  };

  const a901User = await create('one');
  const a901 = await login(ctx, a901User.email, 'Admin90!2024x');
  const peer = await create('two');
  const staff = await createStaffUser(ctx, admin.token);

  // Blocked: System Administrator account (level 100).
  const blockedRoot = await call(ctx, 'PATCH', `/api/users/${myId}`, {
    token: a901.token,
    body: { jobTitle: 'Hacked' },
  });
  assert.equal(blockedRoot.status, 403);
  assert.equal(blockedRoot.body.error.code, 'LEVEL_LOCKED');

  // Blocked: a peer Administrator at their own level (90).
  const blockedPeer = await call(ctx, 'PATCH', `/api/users/${peer.id}`, {
    token: a901.token,
    body: { jobTitle: 'Changed' },
  });
  assert.equal(blockedPeer.status, 403);
  assert.equal(blockedPeer.body.error.code, 'LEVEL_LOCKED');

  // Allowed: a staff member strictly below (level 50).
  const editedStaff = await call(ctx, 'PATCH', `/api/users/${staff.user.id}`, {
    token: a901.token,
    body: { jobTitle: 'Re-titled by campus admin' },
  });
  assert.equal(editedStaff.status, 200);

  // Roles: reported editable only when strictly below the caller's level.
  const roles = await call(ctx, 'GET', '/api/roles', { token: a901.token });
  assert.equal(roles.status, 200);
  const editableByKey = Object.fromEntries(roles.body.data.roles.map((row) => [row.key, row.editable]));
  assert.equal(editableByKey.system_admin, false, 'the System Administrator role must never be editable');
  assert.equal(editableByKey.admin, false, 'a peer role must not be editable');
  assert.equal(editableByKey.transport_staff, true);
  assert.equal(editableByKey.attendant, true);

  // Roles: grant roles:edit via a CUSTOM set so the roles-level guard is
  // exercised directly (a plain level-90 Administrator only holds roles:read).
  const granted = await call(ctx, 'PUT', `/api/users/${a901User.id}/permissions`, {
    token: admin.token,
    body: { permissionsMode: 'CUSTOM', permissions: ['users:edit', 'roles:read', 'roles:edit'] },
  });
  assert.equal(granted.status, 200);

  // Changing permissions revokes the live session — sign back in.
  const a901B = await login(ctx, a901User.email, 'Admin90!2024x');

  // The System Administrator role is immutable (400) for anyone, including a
  // level-90 holder of roles:edit.
  const immutable = await call(ctx, 'PUT', '/api/roles/system_admin/permissions', {
    token: a901B.token,
    body: { permissions: ['dashboard:read'] },
  });
  assert.equal(immutable.status, 400);
  assert.match(immutable.body.error.message, /cannot be edited/);

  // A peer role at the caller's own level is refused by seniority.
  const levelLocked = await call(ctx, 'PUT', '/api/roles/admin/permissions', {
    token: a901B.token,
    body: { permissions: ['dashboard:read'] },
  });
  assert.equal(levelLocked.status, 403);
  assert.equal(levelLocked.body.error.code, 'LEVEL_LOCKED');

  // A role strictly below the caller's level remains editable by it.
  const below = await call(ctx, 'PUT', '/api/roles/transport_staff/permissions', {
    token: a901B.token,
    body: { permissions: ['dashboard:read'] },
  });
  assert.equal(below.status, 200);
});