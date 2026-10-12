/**
 * Pre-authorized student access portal.
 *
 * Exercises the roster-based claim flow (check-email -> register), the
 * self-service read of the portal record, and the boundary that keeps a student
 * out of the staff console and staff out of the rider portal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, call, login, loginSuperAdmin, insertUser, ROLE_KEYS } from './support/harness.js';

const ctx = await bootServer();
const { db } = ctx;

const TENANT = '11111111-1111-4111-8111-111111111111';
const STUDENT_PASSWORD = 'Marble7!FalconRidge';

/** Drop a roster row in directly — the portal reads `students`, not `users`. */
function addRosterStudent({ email, name = 'Rider Test', status = 'ACTIVE', claimed = 0 }) {
  const result = db
    .prepare(
      `INSERT INTO students
         (full_name, college_id, email, rfid_status, card_status, status, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(name, `TST${Math.floor(Math.random() * 1_000_000)}`, email, status, TENANT);
  return Number(result.lastInsertRowid);
}

let riderToken = null;

test('an unknown student email is not found', async () => {
  const response = await call(ctx, 'POST', '/api/auth/student-check-email', {
    body: { email: 'nobody@kmi.edu.np' },
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('a pre-authorized roster email is offered password creation', async () => {
  addRosterStudent({ email: 'rider.one@kmi.edu.np', name: 'Rider One' });

  const response = await call(ctx, 'POST', '/api/auth/student-check-email', {
    body: { email: 'rider.one@kmi.edu.np' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'FIRST_TIME_USER');
  assert.equal(response.body.data.kind, 'student');
  assert.equal(response.body.data.name, 'Rider One');
});

test('student registration enforces the password policy and the match', async () => {
  const weak = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email: 'rider.one@kmi.edu.np', password: 'short', confirmPassword: 'short' },
  });
  assert.equal(weak.status, 422);

  const mismatch = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email: 'rider.one@kmi.edu.np', password: STUDENT_PASSWORD, confirmPassword: 'SomethingElse!9' },
  });
  assert.equal(mismatch.status, 422);
});

test('claiming a roster row creates a level-1 student account and links it', async () => {
  const response = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email: 'rider.one@kmi.edu.np', password: STUDENT_PASSWORD, confirmPassword: STUDENT_PASSWORD },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.user.role, 'student');
  assert.equal(response.body.data.user.roleLevel, 1);
  riderToken = response.body.data.token;

  const row = db
    .prepare('SELECT user_id FROM students WHERE email = ?')
    .get('rider.one@kmi.edu.np');
  assert.ok(row.user_id, 'the roster row should link to its new user');
});

test('a claimed roster email switches to the password path', async () => {
  const check = await call(ctx, 'POST', '/api/auth/student-check-email', {
    body: { email: 'rider.one@kmi.edu.np' },
  });
  assert.equal(check.status, 200);
  assert.equal(check.body.data.status, 'EXISTS_WITH_PASSWORD');

  const again = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email: 'rider.one@kmi.edu.np', password: STUDENT_PASSWORD, confirmPassword: STUDENT_PASSWORD },
  });
  assert.equal(again.status, 409);
});

test('a student can read their own portal record', async () => {
  const response = await call(ctx, 'GET', '/api/student/me', { token: riderToken });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.student.fullName, 'Rider One');
  assert.equal(response.body.data.college.code, 'iic');
  assert.ok(response.body.data.live, 'a live status should always be present');
});

test('the portal boundary is enforced in both directions', async () => {
  const intoConsole = await call(ctx, 'GET', '/api/users', { token: riderToken });
  assert.equal(intoConsole.status, 403);

  insertUser(ctx, {
    email: 'boundary.staff@transitsync.edu.np',
    password: 'TransitStaff@2024',
    fullName: 'Boundary Staff',
    roleKey: ROLE_KEYS.TRANSPORT_STAFF,
  });
  const staff = await login(ctx, 'boundary.staff@transitsync.edu.np', 'TransitStaff@2024');

  const intoPortal = await call(ctx, 'GET', '/api/student/me', { token: staff.token });
  assert.equal(intoPortal.status, 403);
  assert.equal(intoPortal.body.error.code, 'STUDENT_ONLY');
});

test('the student can sign in normally afterwards', async () => {
  const session = await login(ctx, 'rider.one@kmi.edu.np', STUDENT_PASSWORD);
  assert.equal(session.user.role, 'student');
  assert.equal(session.mustChangePassword, false);
});

test('a withdrawn rider cannot claim the portal', async () => {
  addRosterStudent({ email: 'rider.gone@kmi.edu.np', name: 'Gone Rider', status: 'WITHDRAWN' });

  const response = await call(ctx, 'POST', '/api/auth/student-check-email', {
    body: { email: 'rider.gone@kmi.edu.np' },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'STUDENT_INACTIVE');
});

test('maintenance mode refuses student sign-in and is lifted afterwards', async () => {
  const superAdmin = await loginSuperAdmin(ctx);
  await call(ctx, 'PATCH', '/api/super-admin/maintenance', {
    token: superAdmin.token,
    body: { enabled: true },
  });

  const blocked = await call(ctx, 'POST', '/api/auth/student-check-email', {
    body: { email: 'rider.one@kmi.edu.np' },
  });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.code, 'MAINTENANCE_MODE');

  await call(ctx, 'PATCH', '/api/super-admin/maintenance', {
    token: superAdmin.token,
    body: { enabled: false },
  });
});

test.after(async () => {
  await ctx?.close();
});
