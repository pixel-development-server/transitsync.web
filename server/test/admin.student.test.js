/**
 * Admin Console — Student Accounts population.
 *
 * The list is driven by the `users` table (role alone), not by whether a roster
 * row in `students` has been linked yet: a student account must appear the moment
 * it can sign in. It also proves the roster join yields AT MOST ONE row per
 * account, so an unlinked CSV import sitting beside a linked row for the same
 * student cannot repeat the account or make the page count disagree with the
 * pagination total.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, call, loginAdmin, ROLE_KEYS } from './support/harness.js';

const ctx = await bootServer();

// Node 24's test runner waits for the event loop to drain before the worker
// exits, so an un-closed server + MySQL pool keeps the file hanging forever.
test.after(async () => {
  await ctx.close();
});
const { db } = ctx;

const TENANT = '11111111-1111-4111-8111-111111111111';

/** A student sign-in account with NO `students` row attached to it. */
async function addStudentAccount(email, fullName = 'Rider Account') {
  const role = await db.get('SELECT id FROM roles WHERE `key` = ?', ROLE_KEYS.STUDENT);
  const result = await db.run(
    `INSERT INTO users (email, full_name, password_hash, role_id, status, tenant_id,
                        is_first_login, password_changed, force_password_reset)
     VALUES (?, ?, 'not-a-real-hash', ?, 'active', ?, 0, 1, 0)`,
    email, fullName, role.id, TENANT,
  );
  return Number(result.lastInsertRowid);
}

/** A roster row, optionally linked to a sign-in account. */
async function addRosterRow({ email, name = 'Rider', userId = null, collegeId }) {
  const result = await db.run(
    `INSERT INTO students (full_name, college_id, email, rfid_status, card_status,
                           status, tenant_id, user_id)
     VALUES (?, ?, ?, 'ACTIVE', 'ACTIVE', 'ACTIVE', ?, ?)`,
    name, collegeId ?? `TST${Math.floor(Math.random() * 1_000_000)}`, email, TENANT, userId,
  );
  return Number(result.lastInsertRowid);
}

async function list(token) {
  const response = await call(ctx, 'GET', '/api/admin/student-accounts?limit=100', { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

const { token } = await loginAdmin(ctx);

test('a student account with no roster link appears immediately', async () => {
  const email = 'no-roster-rider@kmi.edu.np';
  await addStudentAccount(email, 'Unlinked Rider');

  const data = await list(token);
  const row = data.users.find((u) => u.email === email);

  assert.ok(row, 'the account must be listed even though students has no row for it');
  assert.equal(row.roleKey, 'student');
  // No roster row linked — the profile fields stay null rather than hiding it.
  assert.equal(row.studentId, null);
  assert.equal(row.studentCollegeId, null);
});

test('a linked account surfaces its roster profile', async () => {
  const email = 'linked-rider@kmi.edu.np';
  const userId = await addStudentAccount(email, 'Linked Rider');
  await addRosterRow({ email, name: 'Linked Rider', userId, collegeId: 'IOE-4242' });

  const data = await list(token);
  const row = data.users.find((u) => u.email === email);

  assert.ok(row, 'the linked account must be listed');
  assert.equal(row.studentCollegeId, 'IOE-4242');
  assert.equal(row.studentCardStatus, 'ACTIVE');
});

test('duplicate roster rows do not repeat an account or skew the count', async () => {
  const email = 'duplicate-rider@kmi.edu.np';
  const userId = await addStudentAccount(email, 'Duplicate Rider');
  // An unlinked CSV import for the same student...
  await addRosterRow({ email, name: 'Imported Stub', userId: null });
  // ...plus the row the portal linked on sign-in.
  await addRosterRow({ email, name: 'Claimed Rider', userId });

  const data = await list(token);
  const matches = data.users.filter((u) => u.email === email);

  assert.equal(matches.length, 1, 'an account must appear exactly once, however many roster rows match');
  // No account may be repeated within a page, which is what keeps the row count
  // consistent with the pagination total computed from `users`.
  const distinct = new Set(data.users.map((u) => u.id));
  assert.equal(distinct.size, data.users.length, 'no account is duplicated within a page');
  assert.ok(data.meta.total >= distinct.size, 'total is at least the rows returned');
});
