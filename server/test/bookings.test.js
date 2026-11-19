/**
 * Student daily route/bus bookings.
 *
 * Exercises the rider-side booking lifecycle (create, same-day re-book upsert,
 * past-date refusal, cancel), the staff ledger read, and the boundary that
 * keeps staff from booking through the rider endpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, call, login, insertUser, ROLE_KEYS } from './support/harness.js';
import { nptDay } from '../src/lib/time.js';

const ctx = await bootServer();
const { db } = ctx;

const TENANT = '11111111-1111-4111-8111-111111111111';
const STUDENT_PASSWORD = 'Marble7!FalconRidge';
const STAFF_PASSWORD = 'TransitStaff@2024';

let riderToken = null;
let studentId = null;
let staffToken = null;

/** Drop a roster row in directly — the portal reads `students`, not `users`. */
async function addRosterStudent({ email, name = 'Rider Booker' }) {
  const result = await db.run(
    `INSERT INTO students
       (full_name, college_id, email, rfid_status, card_status, status, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', 'ACTIVE', 'ACTIVE', ?, NOW(), NOW())`,
    name,
    `BK${Math.floor(Math.random() * 1_000_000)}`,
    email,
    TENANT,
  );
  return Number(result.lastInsertRowid);
}

/** First active route, so the booking references a real, operating service. */
async function activeRoute() {
  return db.get('SELECT id FROM routes WHERE is_active = 1 ORDER BY id LIMIT 1');
}

/** First in-service bus, used to prove the bus selection path. */
async function activeBus() {
  return db.get("SELECT id FROM buses WHERE status = 'ACTIVE' ORDER BY id LIMIT 1");
}

test('a roster student claims the portal and signs in', async () => {
  studentId = await addRosterStudent({ email: 'booker.one@kmi.edu.np', name: 'Booker One' });

  const registered = await call(ctx, 'POST', '/api/auth/student-register', {
    body: { email: 'booker.one@kmi.edu.np', password: STUDENT_PASSWORD, confirmPassword: STUDENT_PASSWORD },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.data.user.role, 'student');

  const session = await login(ctx, 'booker.one@kmi.edu.np', STUDENT_PASSWORD, 'student');
  assert.equal(session.user.role, 'student');
  riderToken = session.token;
});

test('a rider creates a booking for today', async () => {
  const route = await activeRoute();
  assert.ok(route, 'the demo dataset should seed an active route');

  const response = await call(ctx, 'POST', '/api/bookings', {
    token: riderToken,
    body: { travelDate: nptDay(), routeId: route.id },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.booking.status, 'BOOKED');
  assert.equal(response.body.data.booking.routeId, route.id);
  assert.equal(response.body.data.booking.studentId, studentId);
  assert.equal(response.body.data.booking.travelDate, nptDay());
});

test('re-booking the same day upserts instead of duplicating', async () => {
  const routes = await db.all('SELECT id FROM routes WHERE is_active = 1 ORDER BY id LIMIT 2');
  assert.ok(routes.length >= 2, 'need two active routes to prove the update path');

  const response = await call(ctx, 'POST', '/api/bookings', {
    token: riderToken,
    body: { travelDate: nptDay(), routeId: routes[1].id },
  });

  // A second write for the same (student, day) is an update, not a create.
  assert.equal(response.status, 200);
  assert.equal(response.body.data.booking.routeId, routes[1].id);

  const { n: count } = await db.get(
    'SELECT COUNT(*) AS n FROM student_bookings WHERE student_id = ? AND travel_date = ?',
    studentId,
    nptDay(),
  );
  assert.equal(count, 1, 'the unique (student, travel_date) row must not duplicate');
});

test('a rider can attach a specific bus', async () => {
  const bus = await activeBus();
  assert.ok(bus, 'the demo dataset should seed an active bus');

  const response = await call(ctx, 'POST', '/api/bookings', {
    token: riderToken,
    body: { travelDate: nptDay(), busId: bus.id },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.booking.busId, bus.id);
});

test('a past travel date is refused', async () => {
  const response = await call(ctx, 'POST', '/api/bookings', {
    token: riderToken,
    body: { travelDate: '2020-01-01' },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'BAD_REQUEST');
});

test('GET /bookings/mine lists the rider’s own booking', async () => {
  const response = await call(ctx, 'GET', '/api/bookings/mine', { token: riderToken });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.data.bookings));
  assert.ok(response.body.data.bookings.length >= 1);
  assert.equal(response.body.data.bookings[0].studentId, studentId);
});

test('a rider cancels their booking', async () => {
  const booking = await db.get(
    'SELECT id FROM student_bookings WHERE student_id = ? AND travel_date = ?',
    studentId,
    nptDay(),
  );
  assert.ok(booking, 'the booking should exist before it is cancelled');

  const response = await call(ctx, 'DELETE', `/api/bookings/${booking.id}`, { token: riderToken });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.booking.status, 'CANCELLED');

  const row = await db.get('SELECT status FROM student_bookings WHERE id = ?', booking.id);
  assert.equal(row.status, 'CANCELLED');
});

test('staff with students:read can read the booking ledger', async () => {
  const staffId = await insertUser(ctx, {
    email: 'bookings.staff@transitsync.edu.np',
    password: STAFF_PASSWORD,
    fullName: 'Bookings Staff',
    roleKey: ROLE_KEYS.TRANSPORT_STAFF,
  });
  // Pin the staff account to the rider's campus so the tenant scope admits the
  // row (a NULL-tenant principal would see only tenant-less bookings).
  await db.run('UPDATE users SET tenant_id = ? WHERE id = ?', TENANT, staffId);

  const session = await login(ctx, 'bookings.staff@transitsync.edu.np', STAFF_PASSWORD, 'staff');
  staffToken = session.token;

  const response = await call(ctx, 'GET', '/api/bookings', { token: staffToken });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.data.bookings));
  assert.ok(response.body.data.meta, 'a paginated ledger should carry meta');

  const listed = response.body.data.bookings.find((b) => b.studentId === studentId);
  assert.ok(listed, 'the rider’s booking should appear in the campus ledger');
  assert.equal(listed.status, 'CANCELLED');
  assert.equal(listed.collegeId, (await db.get('SELECT college_id FROM students WHERE id = ?', studentId)).college_id);
});

test('staff are refused on the rider booking endpoint', async () => {
  const response = await call(ctx, 'POST', '/api/bookings', {
    token: staffToken,
    body: { travelDate: nptDay() },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'STUDENT_ONLY');
});

test.after(async () => {
  await ctx?.close();
});
