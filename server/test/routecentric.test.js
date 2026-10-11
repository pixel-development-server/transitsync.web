/**
 * Route-centric fleet provisioning and the student transit view.
 *
 *  - Route/bus creation answers duplicates with a clean 409 (top-level
 *    `message` + an *array* of details) — never a raw 500 whose non-array
 *    `details` crashes the frontend's iterating error renderer.
 *  - The `/users` console lists staff accounts only; student auth records live
 *    with the Students registry.
 *  - `POST /students` auto-provisions a role=student account (invited, no
 *    password) that the rider then claims with a first password, or links an
 *    already-existing account instead of duplicating it.
 *  - `GET /student/routes` is the live, read-only schedule board.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, call, loginAdmin } from './support/harness.js';

const ctx = await bootServer();
const { db } = ctx;

test.after(async () => {
  await ctx?.close();
});

const admin = await loginAdmin(ctx);

const RIDER_PASSWORD = 'Marble7!FalconRidge';

function uniqueEmail(tag) {
  return `routecentric-${tag}-${Math.random().toString(36).slice(2, 8)}@kmi.edu.np`;
}

function uniqueCode(prefix) {
  return `${prefix}-${Math.floor(Math.random() * 90000) + 10000}`;
}

function routePayload(overrides = {}) {
  return {
    code: uniqueCode('R'),
    name: `Loop ${Math.random().toString(36).slice(2, 8)}`,
    startPoint: 'Gate Alpha',
    endPoint: 'Gate Omega',
    shift: 'MORNING',
    departureTime: '07:00',
    arrivalTime: '08:30',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Clean duplicate handling on fleet provisioning
// ---------------------------------------------------------------------------

test('creating a route with a duplicate code answers 409 with a clean message', async () => {
  const payload = routePayload();

  const created = await call(ctx, 'POST', '/api/routes', { token: admin.token, body: payload });
  assert.equal(created.status, 201);

  const duplicate = await call(ctx, 'POST', '/api/routes', { token: admin.token, body: payload });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.success, false);
  assert.match(duplicate.body.message, /A route with this code already exists\./);
  assert.equal(duplicate.body.error.code, 'CONFLICT');
  assert.match(duplicate.body.error.message, /A route with this code already exists\./);
  // The client maps `details` with `.map()` — it must arrive as an array.
  assert.ok(Array.isArray(duplicate.body.error.details));
  assert.equal(duplicate.body.error.details.length, 1);
  assert.equal(duplicate.body.error.details[0].field, 'code');
});

test('creating a route with a duplicate name answers 409 too', async () => {
  const name = `Shared Corridor ${Math.random().toString(36).slice(2, 8)}`;
  const payload = routePayload({ name });

  const first = await call(ctx, 'POST', '/api/routes', { token: admin.token, body: payload });
  assert.equal(first.status, 201);

  const duplicate = await call(ctx, 'POST', '/api/routes', {
    token: admin.token,
    body: routePayload({ name }),
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error.message, /A route with this name already exists\./);
  assert.equal(duplicate.body.error.details[0].field, 'name');
});

test('renaming a route onto a taken code or name is rejected with 409', async () => {
  const first = await call(ctx, 'POST', '/api/routes', {
    token: admin.token,
    body: routePayload({ code: uniqueCode('RA') }),
  });
  const second = await call(ctx, 'POST', '/api/routes', {
    token: admin.token,
    body: routePayload({ code: uniqueCode('RB') }),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const clash = await call(ctx, 'PATCH', `/api/routes/${second.body.data.route.id}`, {
    token: admin.token,
    body: { code: first.body.data.route.code },
  });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error.message, /A route with this code already exists\./);
  assert.ok(Array.isArray(clash.body.error.details));
});

test('bus duplicates (code and registration) answer 409 cleanly', async () => {
  const code = uniqueCode('TS');
  const registration = `BA 2 KHA ${Math.floor(Math.random() * 9000) + 1000}`;
  const payload = {
    code,
    registrationNo: registration,
    name: 'Himalayan',
    seatCapacity: 40,
  };

  const created = await call(ctx, 'POST', '/api/buses', { token: admin.token, body: payload });
  assert.equal(created.status, 201);

  const dupCode = await call(ctx, 'POST', '/api/buses', {
    token: admin.token,
    body: { ...payload, registrationNo: `${registration} X` },
  });
  assert.equal(dupCode.status, 409);
  assert.match(dupCode.body.error.message, /A bus with the code/);
  assert.ok(Array.isArray(dupCode.body.error.details));

  const dupReg = await call(ctx, 'POST', '/api/buses', {
    token: admin.token,
    body: { ...payload, code: uniqueCode('TS') },
  });
  assert.equal(dupReg.status, 409);
  assert.match(dupReg.body.error.message, /registration number already exists/);
  assert.ok(Array.isArray(dupReg.body.error.details));
});

// ---------------------------------------------------------------------------
// /users is the staff console — students never appear there
// ---------------------------------------------------------------------------

test('GET /users lists staff only and hides student auth accounts', async () => {
  const email = uniqueEmail('hidden');
  const collegeId = `ROUTEC-${Math.floor(Math.random() * 90000) + 10000}`;

  const roster = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Hidden Rider', collegeId, email },
  });
  assert.equal(roster.status, 201);

  const claimed = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email, password: RIDER_PASSWORD, confirmPassword: RIDER_PASSWORD },
  });
  assert.equal(claimed.status, 201);

  const list = await call(ctx, 'GET', '/api/users?limit=200', { token: admin.token });
  assert.equal(list.status, 200);
  const emails = list.body.data.users.map((user) => String(user.email).toLowerCase());
  assert.ok(!emails.includes(email), 'student auth account leaked into the staff console');

  // The link still exists in the Students registry.
  const linked = db
    .prepare('SELECT user_id, is_claimed FROM students WHERE college_id = ?')
    .get(collegeId);
  assert.ok(linked.user_id, 'roster row was not linked to the student account');
  assert.equal(Number(linked.is_claimed), 1);
});

// ---------------------------------------------------------------------------
// Auto-sync: staff add → paired role=student account → student claims it
// ---------------------------------------------------------------------------

test('adding a student with an email provisions an invited, claimable account', async () => {
  const email = uniqueEmail('provision');
  const collegeId = `ROUTEC-${Math.floor(Math.random() * 90000) + 10000}`;

  const created = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Provisioned Rider', collegeId, email },
  });
  assert.equal(created.status, 201);

  const users = db
    .prepare('SELECT email, status, password_hash FROM users WHERE LOWER(email) = LOWER(?)')
    .all(email);
  assert.equal(users.length, 1, 'expected exactly one paired account');
  assert.equal(users[0].status, 'invited');

  const linked = db
    .prepare('SELECT user_id, is_claimed FROM students WHERE college_id = ?')
    .get(collegeId);
  assert.ok(linked.user_id, 'roster row must be linked to the provisioned account');
  assert.equal(Number(linked.is_claimed), 1);

  // Still appears as a first-time user: the sentinel means "no password yet".
  const probe = await call(ctx, 'POST', '/api/auth/student-check-email', { body: { email } });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.data.status, 'FIRST_TIME_USER');
});

test('a staff-provisioned account is activated when the rider claims it', async () => {
  const email = uniqueEmail('claim');
  const collegeId = `ROUTEC-${Math.floor(Math.random() * 90000) + 10000}`;

  await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Claiming Rider', collegeId, email },
  });

  const registered = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email, password: RIDER_PASSWORD, confirmPassword: RIDER_PASSWORD },
  });
  assert.equal(registered.status, 201);

  // Same row updated in place — not a duplicate account.
  const users = db
    .prepare('SELECT id, status, password_hash, is_first_login, password_changed FROM users WHERE LOWER(email) = LOWER(?)')
    .all(email);
  assert.equal(users.length, 1);
  assert.equal(users[0].status, 'active');
  assert.ok(users[0].password_hash.startsWith('$2'), 'password was not set on the existing account');
  assert.equal(Number(users[0].is_first_login), 0);
  assert.equal(Number(users[0].password_changed), 1);

  const probe = await call(ctx, 'POST', '/api/auth/student-check-email', { body: { email } });
  assert.equal(probe.body.data.status, 'EXISTS_WITH_PASSWORD');

  const login = await call(ctx, 'POST', '/api/auth/login', { body: { email, password: RIDER_PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.role, 'student');
});

test('adding a student whose account already exists links it without duplicating', async () => {
  const email = uniqueEmail('relink');
  const collegeId = `ROUTEC-${Math.floor(Math.random() * 90000) + 10000}`;

  await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Linked Rider', collegeId, email },
  });
  await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email, password: RIDER_PASSWORD, confirmPassword: RIDER_PASSWORD },
  });

  const before = db.prepare('SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = LOWER(?)').get(email).n;
  assert.equal(before, 1);

  const again = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: {
      fullName: 'Linked Rider (second roster row)',
      collegeId: `ROUTEC-${Math.floor(Math.random() * 90000) + 10000}`,
      email,
    },
  });
  assert.equal(again.status, 201);

  const after = db.prepare('SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = LOWER(?)').get(email).n;
  assert.equal(after, 1, 'linking an existing account must not create a duplicate user');
});

// ---------------------------------------------------------------------------
// Live route schedule board
// ---------------------------------------------------------------------------

test('a signed-in student can read the live route schedule board', async () => {
  const email = uniqueEmail('board');
  const collegeId = `ROUTEC-${Math.floor(Math.random() * 90000) + 10000}`;

  await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Board Rider', collegeId, email },
  });
  await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email, password: RIDER_PASSWORD, confirmPassword: RIDER_PASSWORD },
  });
  const session = await call(ctx, 'POST', '/api/auth/login', {
    body: { email, password: RIDER_PASSWORD },
  });
  assert.equal(session.status, 200);

  const board = await call(ctx, 'GET', '/api/student/routes', { token: session.body.data.token });
  assert.equal(board.status, 200);
  assert.ok(Array.isArray(board.body.data.routes));
  assert.ok(board.body.data.routes.length >= 1, 'the demo seed provisions routes');

  const seeded = board.body.data.routes.find((route) => route.code === 'R-01');
  assert.ok(seeded, 'R-01 should be on the board');
  assert.ok(Array.isArray(seeded.stops));
  assert.ok(seeded.stops.length > 0, 'routes carry their pickup stops');
  assert.ok(Array.isArray(seeded.buses));
  assert.ok(seeded.buses.length > 0, 'the seeded route must have its assigned bus');
  for (const bus of seeded.buses) {
    assert.equal(typeof bus.occupancy, 'number');
    assert.equal(typeof bus.utilization, 'number');
    assert.equal(bus.code, 'TS-01', 'the demo bus R-01 runs is TS-01');
    assert.ok('isMine' in seeded, 'board rows expose the rider-route match');
  }

  // A student can read the board without any individual route assignment.
  const me = await call(ctx, 'GET', '/api/student/me', { token: session.body.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.route, null);
});