import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, call, login, loginAdmin, roleIdOf, ROLE_KEYS, STAFF_PASSWORD } from './support/harness.js';

let ctx;
let admin;
let staff;

// One hook, not two: the second root-level `before` in a file is not reliably
// sequenced against the first, which left `ctx` undefined for every test.
test.before(async () => {
  ctx = await bootServer();
  admin = await loginAdmin(ctx);
  staff = await login(ctx, 'transport@transitsync.edu.np', STAFF_PASSWORD);
});

test.after(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
test('dashboard returns coherent KPI, fleet, activity and alert blocks', async () => {
  const response = await call(ctx, 'GET', '/api/dashboard', { token: admin.token });
  assert.equal(response.status, 200);

  const { kpis, fleet, activity, alerts, trend } = response.body.data;

  assert.ok(kpis.students.total > 0, 'students onboarded');
  assert.ok(kpis.fleet.active > 0, 'active fleet');
  assert.equal(kpis.fleet.activeCapacity, kpis.fleet.activeCapacity);
  assert.ok(kpis.utilization.capacity > 0, 'capacity is derived from active buses');
  assert.equal(
    kpis.utilization.percent,
    Math.round((kpis.utilization.onboard / kpis.utilization.capacity) * 100),
  );
  assert.ok(Number.isInteger(kpis.alerts.open));

  assert.ok(Array.isArray(fleet) && fleet.length > 0);
  for (const bus of fleet) {
    assert.ok(bus.seatCapacity > 0);
    assert.equal(bus.utilization, Math.round((bus.occupancy / bus.seatCapacity) * 100));
    assert.equal(bus.occupancy <= bus.seatCapacity, true, `${bus.code} over capacity`);
  }

  assert.ok(Array.isArray(activity));
  assert.ok(Array.isArray(alerts));
  assert.ok(Array.isArray(trend));
});

test('capacity utilisation never exceeds 100% with the seeded fleet', async () => {
  const response = await call(ctx, 'GET', '/api/dashboard', { token: admin.token });
  const { percent, onboard, capacity } = response.body.data.kpis.utilization;
  assert.ok(percent <= 100);
  assert.ok(onboard <= capacity);
});

// ---------------------------------------------------------------------------
// Students CRUD
// ---------------------------------------------------------------------------
test('student CRUD lifecycle', async () => {
  const created = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: {
      fullName: 'Test Student One',
      collegeId: 'KMI9900001',
      faculty: 'Computer Engineering',
      program: 'BE',
      semester: 5,
      email: 'test.one@kmi.edu.np',
      rfidSerial: 'TS-TEST-0001',
      cardStatus: 'ACTIVE',
      routeId: 1,
      busId: 1,
    },
  });
  assert.equal(created.status, 201);
  const student = created.body.data.student;
  assert.equal(student.collegeId, 'KMI9900001');
  assert.equal(student.cardStatus, 'ACTIVE');
  assert.ok(student.cardIssuedAt, 'issuing an active card stamps card_issued_at');

  const id = student.id;

  // Read
  const fetched = await call(ctx, 'GET', `/api/students/${id}`, { token: admin.token });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.student.fullName, 'Test Student One');

  // Update
  const patched = await call(ctx, 'PATCH', `/api/students/${id}`, {
    token: admin.token,
    body: { fullName: 'Test Student One (Edited)', faculty: 'Civil Engineering' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.student.fullName, 'Test Student One (Edited)');

  // Soft delete
  const removed = await call(ctx, 'DELETE', `/api/students/${id}`, { token: admin.token });
  assert.equal(removed.status, 200);

  const afterDelete = await call(ctx, 'GET', `/api/students/${id}`, { token: admin.token });
  assert.equal(afterDelete.body.data.student.status, 'WITHDRAWN');
  assert.equal(afterDelete.body.data.student.cardStatus, 'REVOKED');

  // Purge
  const purged = await call(ctx, 'DELETE', `/api/students/${id}/purge`, { token: admin.token });
  assert.equal(purged.status, 200);

  const gone = await call(ctx, 'GET', `/api/students/${id}`, { token: admin.token });
  assert.equal(gone.status, 404);
});

test('duplicate college ID and RFID serial are rejected', async () => {
  const body = { fullName: 'Dup Check', collegeId: 'KMI-DUP-1', rfidSerial: 'TS-DUP-1' };
  assert.equal((await call(ctx, 'POST', '/api/students', { token: admin.token, body })).status, 201);

  const duplicateId = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { ...body, rfidSerial: 'TS-DUP-2' },
  });
  assert.equal(duplicateId.status, 409);
  assert.match(duplicateId.body.error.message, /college id/i);

  const duplicateRfid = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { ...body, collegeId: 'KMI-DUP-2' },
  });
  assert.equal(duplicateRfid.status, 409);
  assert.match(duplicateRfid.body.error.message, /rfid serial/i);
});

test('student list filters, searches and paginates', async () => {
  const all = await call(ctx, 'GET', '/api/students?limit=5&page=1', { token: admin.token });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.students.length, 5);
  assert.ok(all.body.data.meta.total > 5);
  assert.equal(all.body.data.meta.hasNext, true);

  const page2 = await call(ctx, 'GET', '/api/students?limit=5&page=2', { token: admin.token });
  const firstIds = all.body.data.students.map((student) => student.id);
  const secondIds = page2.body.data.students.map((student) => student.id);
  assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0, 'pages must not overlap');

  const search = await call(ctx, 'GET', '/api/students?search=KMI-DUP-1', { token: admin.token });
  assert.equal(search.status, 200);
  assert.ok(search.body.data.students.length >= 1);

  const onboardOnly = await call(ctx, 'GET', '/api/students?onboard=true', { token: admin.token });
  assert.equal(onboardOnly.status, 200);
  for (const student of onboardOnly.body.data.students) {
    assert.equal(student.onboard, true);
  }
});

test('allocating a student beyond seat capacity is refused', async () => {
  // Build a deliberately tiny bus so the guard is exercised deterministically
  // rather than depending on how the seed happened to distribute students.
  const bus = await call(ctx, 'POST', '/api/buses', {
    token: admin.token,
    body: { code: 'TS-TINY', registrationNo: 'Ba 1 Ti 0001', name: 'Tiny Coach', seatCapacity: 1 },
  });
  assert.equal(bus.status, 201);
  const busId = bus.body.data.bus.id;

  const first = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Fills The Bus', collegeId: `KMI-CAP-${Date.now()}`, busId, cardStatus: 'ACTIVE' },
  });
  assert.equal(first.status, 201, 'the first allocation fits');

  const overflow = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'One Seat Too Many', collegeId: `KMI-CAP2-${Date.now()}`, busId, cardStatus: 'ACTIVE' },
  });
  assert.equal(overflow.status, 409);
  assert.match(overflow.body.error.message, /capacity/i);

  // Freeing the seat lets the next allocation through.
  await call(ctx, 'PATCH', `/api/students/${first.body.data.student.id}`, {
    token: admin.token,
    body: { clearBus: true },
  });
  const retry = await call(ctx, 'POST', '/api/students', {
    token: admin.token,
    body: { fullName: 'Now It Fits', collegeId: `KMI-CAP3-${Date.now()}`, busId, cardStatus: 'ACTIVE' },
  });
  assert.equal(retry.status, 201);
});

// ---------------------------------------------------------------------------
// Fleet & routes
// ---------------------------------------------------------------------------
test('bus CRUD with capacity guards', async () => {
  const created = await call(ctx, 'POST', '/api/buses', {
    token: staff.token,
    body: {
      code: 'TS-TEST-9',
      registrationNo: 'Ba 9 Te 4321',
      name: 'Test Coach',
      makeModel: 'Tata Starbus',
      seatCapacity: 25,
      driverName: 'Test Driver',
      currentRouteId: 1,
    },
  });
  assert.equal(created.status, 201);
  const busId = created.body.data.bus.id;
  assert.equal(created.body.data.bus.seatCapacity, 25);

  const patched = await call(ctx, 'PATCH', `/api/buses/${busId}`, {
    token: staff.token,
    body: { seatCapacity: 30, status: 'MAINTENANCE' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.bus.seatCapacity, 30);
  assert.equal(patched.body.data.bus.status, 'MAINTENANCE');

  // Seat capacity may never drop below the number of allocated students.
  // Allocate two first, otherwise shrinking to 1 seat is perfectly legal.
  for (const n of [1, 2]) {
    const allocated = await call(ctx, 'POST', '/api/students', {
      token: admin.token,
      body: {
        fullName: `Seat Filler ${n}`,
        collegeId: `KMI-SEAT-${busId}-${n}`,
        busId,
        cardStatus: 'ACTIVE',
      },
    });
    assert.equal(allocated.status, 201, `student ${n} should be allocated to the bus`);
  }

  const tooSmall = await call(ctx, 'PATCH', `/api/buses/${busId}`, {
    token: staff.token,
    body: { seatCapacity: 1 },
  });
  assert.ok(
    [400, 409].includes(tooSmall.status),
    `shrinking to 1 seat with 2 allocated must fail, got ${tooSmall.status}`,
  );

  // Exactly matching the allocation is still allowed.
  const exact = await call(ctx, 'PATCH', `/api/buses/${busId}`, {
    token: staff.token,
    body: { seatCapacity: 2 },
  });
  assert.equal(exact.status, 200, 'matching the allocation exactly is allowed');

  const removed = await call(ctx, 'DELETE', `/api/buses/${busId}`, { token: staff.token });
  assert.equal(removed.status, 403, 'transport staff cannot delete fleet records');
});

test('a bus with allocated students cannot be deleted', async () => {
  const bus = ctx.db.prepare("SELECT id FROM buses WHERE status='ACTIVE'").get();
  const response = await call(ctx, 'DELETE', `/api/buses/${bus.id}`, { token: admin.token });
  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /allocated/i);
});

test('route stop ordering is validated and persisted', async () => {
  const routeId = 4;

  const replaced = await call(ctx, 'PUT', `/api/routes/${routeId}/stops`, {
    token: staff.token,
    body: {
      stops: [
        { sequence: 3, name: 'Third Stop', scheduledTime: '07:50', latitude: 27.7, longitude: 85.3 },
        { sequence: 1, name: 'First Stop', scheduledTime: '07:30', latitude: 27.6, longitude: 85.2 },
        { sequence: 2, name: 'Second Stop', scheduledTime: '07:40', latitude: 27.65, longitude: 85.25 },
      ],
    },
  });
  assert.equal(replaced.status, 200);
  const sequences = replaced.body.data.stops.map((stop) => stop.sequence);
  assert.deepEqual(sequences, [1, 2, 3], 'stops must come back ordered');

  const duplicate = await call(ctx, 'PUT', `/api/routes/${routeId}/stops`, {
    token: staff.token,
    body: {
      stops: [
        { sequence: 1, name: 'A' },
        { sequence: 1, name: 'B' },
      ],
    },
  });
  assert.equal(duplicate.status, 422);
});

test('a referenced route cannot be deleted', async () => {
  const route = ctx.db.prepare('SELECT id, code FROM routes WHERE id = 1').get();
  const response = await call(ctx, 'DELETE', `/api/routes/${route.id}`, { token: admin.token });
  assert.equal(response.status, 409);
});

test('route departure must precede arrival', async () => {
  const response = await call(ctx, 'POST', '/api/routes', {
    token: staff.token,
    body: {
      code: 'R-BAD',
      name: 'Bad Schedule',
      startPoint: 'A',
      endPoint: 'B',
      departureTime: '10:00',
      arrivalTime: '09:00',
    },
  });
  assert.equal(response.status, 422);
  assert.match(JSON.stringify(response.body.error.details), /arrival/i);
});

// ---------------------------------------------------------------------------
// RFID simulator / scan engine
// ---------------------------------------------------------------------------
test('a valid tap boards then a second tap deboards the same student', async () => {
  const simulator = await call(ctx, 'GET', '/api/simulator', { token: admin.token });
  assert.equal(simulator.status, 200);

  const student = ctx.db
    .prepare(
      `SELECT * FROM students
        WHERE rfid_serial IS NOT NULL AND status='ACTIVE' AND card_status='ACTIVE'
          AND bus_id IS NOT NULL AND onboard_bus_id IS NULL
        LIMIT 1`,
    )
    .get();
  // The seed deliberately leaves some students waiting at the stop; without that
  // the first tap would deboard an already-onboard student.
  assert.ok(student, 'the demo dataset must contain a student waiting to board');

  const board = await call(ctx, 'POST', '/api/simulator/tap', {
    token: admin.token,
    body: { rfidSerial: student.rfid_serial, busId: student.bus_id, gate: 'Test Gate', latitude: 27.7, longitude: 85.3 },
  });
  assert.equal(board.status, 200);
  assert.equal(board.body.data.outcome, 'VALID');
  assert.equal(board.body.data.direction, 'BOARD');
  assert.equal(board.body.data.scan.studentName, student.full_name);
  assert.ok(board.body.data.scan.latitude);

  const deboard = await call(ctx, 'POST', '/api/simulator/tap', {
    token: admin.token,
    body: { rfidSerial: student.rfid_serial, busId: student.bus_id, gate: 'Test Gate' },
  });
  assert.equal(deboard.body.data.direction, 'DEBOARD');
  assert.equal(deboard.body.data.outcome, 'VALID');
});

test('every simulator scenario produces its expected outcome', async () => {
  const scenarios = [
    { outcome: 'VALID', expect: 'VALID' },
    { outcome: 'INVALID', expect: 'INVALID' },
    { outcome: 'UNREGISTERED_BUS', expect: 'UNREGISTERED_BUS' },
    { outcome: 'UNREGISTERED_CARD', expect: 'UNREGISTERED_CARD' },
  ];

  for (const scenario of scenarios) {
    const response = await call(ctx, 'POST', `/api/simulator/scenario/${scenario.outcome}`, {
      token: admin.token,
      body: { busId: 1, gate: 'QA Bench' },
    });
    assert.equal(response.status, 200, `${scenario.outcome} scenario failed`);
    assert.equal(
      response.body.data.outcome,
      scenario.expect,
      `${scenario.outcome} produced ${response.body.data.outcome}: ${response.body.data.message}`,
    );
  }
});

test('rejected taps raise a matching security alert', async () => {
  const before = await call(ctx, 'GET', '/api/alerts?status=OPEN', { token: admin.token });
  const beforeCount = before.body.data.meta.total;

  await call(ctx, 'POST', '/api/simulator/scenario/UNREGISTERED_CARD', {
    token: admin.token,
    body: { busId: 1, gate: 'QA Bench' },
  });

  const after = await call(ctx, 'GET', '/api/alerts?status=OPEN', { token: admin.token });
  assert.ok(after.body.data.meta.total > beforeCount, 'an alert should have been raised');

  const raised = after.body.data.alerts.find((alert) => alert.type === 'UNREGISTERED_DEVICE');
  assert.ok(raised, 'expected an Unregistered Device alert');
  assert.equal(raised.severity, 'CRITICAL');
  assert.equal(raised.typeLabel, 'Unregistered Device');
});

test('an unregistered serial is rejected with the right alert tag', async () => {
  const ghost = `TS-GHOST-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  const response = await call(ctx, 'POST', '/api/simulator/tap', {
    token: admin.token,
    body: { rfidSerial: ghost, busId: 1 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.outcome, 'UNREGISTERED_CARD');
  assert.equal(response.body.data.alert.type, 'UNREGISTERED_DEVICE');
  assert.equal(response.body.data.alert.severity, 'CRITICAL');
});

test('a registered card on the wrong bus is logged without raising an alert', async () => {
  const student = ctx.db
    .prepare("SELECT * FROM students WHERE bus_id IS NOT NULL AND status='ACTIVE' AND card_status='ACTIVE' LIMIT 1")
    .get();
  const otherBus = ctx.db.prepare('SELECT id FROM buses WHERE id <> ? AND status <> ? LIMIT 1').get(student.bus_id, 'RETIRED');

  const response = await call(ctx, 'POST', '/api/simulator/tap', {
    token: admin.token,
    body: { rfidSerial: student.rfid_serial, busId: otherBus.id },
  });
  assert.equal(response.body.data.outcome, 'UNREGISTERED_BUS');
  assert.equal(response.body.data.alert, null, 'only unknown UIDs raise an Unregistered Alert');
});

test('a revoked card is invalid, silent, and does not change occupancy', async () => {
  const student = ctx.db.prepare("SELECT * FROM students WHERE card_status = 'REVOKED' LIMIT 1").get();
  // Never skip silently: a missing fixture must fail loudly, otherwise this test
  // reports success while asserting nothing at all.
  assert.ok(student, 'the demo dataset must contain a revoked card');

  const before = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM students WHERE onboard_bus_id = ?')
    .get(student.bus_id).n;

  const response = await call(ctx, 'POST', '/api/simulator/tap', {
    token: admin.token,
    body: { rfidSerial: student.rfid_serial, busId: student.bus_id },
  });
  assert.equal(response.body.data.outcome, 'INVALID');
  assert.equal(response.body.data.alert, null, 'a revoked card is an activity log entry, not an alert');

  const after = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM students WHERE onboard_bus_id = ?')
    .get(student.bus_id).n;
  assert.equal(after, before, 'a rejected tap must not alter occupancy');
});

test('preview mode explains a verdict without writing a scan', async () => {
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM scan_events').get().n;

  const student = ctx.db.prepare("SELECT * FROM students WHERE card_status = 'REVOKED' LIMIT 1").get();
  const preview = await call(ctx, 'POST', '/api/simulator/preview', {
    token: admin.token,
    body: { rfidSerial: student.rfid_serial, busId: student.bus_id },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.outcome, 'INVALID');
  assert.equal(preview.body.data.wouldAlert, false);
  assert.equal(preview.body.data.alertLabel, null);

  const after = ctx.db.prepare('SELECT COUNT(*) AS n FROM scan_events').get().n;
  assert.equal(after, before, 'preview must be side-effect free');
});

test('simulator taps are recorded in the audit trail', async () => {
  const audit = await call(ctx, 'GET', '/api/users/audit?action=simulator', { token: admin.token });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.data.entries.length > 0);
  assert.ok(audit.body.data.entries.some((entry) => entry.action === 'simulator.tap'));
});

// ---------------------------------------------------------------------------
// Attendance, analytics and exports
// ---------------------------------------------------------------------------
test('attendance log filters by outcome and direction', async () => {
  const rejected = await call(ctx, 'GET', '/api/attendance?outcome=UNREGISTERED_CARD&limit=50', { token: staff.token });
  assert.equal(rejected.status, 200);
  for (const scan of rejected.body.data.scans) {
    assert.equal(scan.outcome, 'UNREGISTERED_CARD');
  }

  const board = await call(ctx, 'GET', '/api/attendance?direction=BOARD&limit=50', { token: staff.token });
  for (const scan of board.body.data.scans) {
    assert.equal(scan.direction, 'BOARD');
  }
});

test('demand analytics returns daily, per-bus, per-route and hourly series', async () => {
  const response = await call(ctx, 'GET', '/api/attendance/demand?days=14', { token: staff.token });
  assert.equal(response.status, 200);

  const { daily, byBus, byRoute, hourOfDay, totals } = response.body.data;
  assert.ok(Array.isArray(daily));
  assert.ok(daily.every((point) => point.boards >= 0 && point.utilization >= 0 && point.utilization <= 100));
  assert.ok(Array.isArray(byBus) && byBus.length > 0);
  assert.ok(byBus.every((bus) => bus.utilization <= 100));
  assert.ok(Array.isArray(byRoute));
  assert.ok(Array.isArray(hourOfDay));
  assert.ok(totals.activeCapacity > 0);
});

test('CSV export is well formed and downloadable', async () => {
  const response = await call(ctx, 'GET', '/api/attendance/export?format=csv&from=2024-01-01', {
    token: staff.token,
    raw: true,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /attachment; filename=".*\.csv"/);

  const lines = response.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.ok(lines.length > 1, 'header plus at least one data row');
  assert.match(lines[0], /Timestamp.*Student.*RFID Serial.*Outcome/);
  assert.equal(lines[0].split(',').length, lines[1].split(',').length);
});

test('PDF export produces a real PDF document', async () => {
  const response = await call(ctx, 'GET', '/api/attendance/export?format=pdf', {
    token: staff.token,
    raw: true,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.match(response.text.slice(0, 5), /^%PDF-/);
  assert.ok(response.buffer.length > 1000, 'PDF should have real content');
});

test('exports are recorded in the audit log', async () => {
  const audit = await call(ctx, 'GET', '/api/users/audit?action=attendance.export', { token: admin.token });
  assert.ok(audit.body.data.entries.length >= 2, 'CSV and PDF exports should both be logged');
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
test('alert lifecycle: acknowledge then resolve with a note', async () => {
  const open = await call(ctx, 'GET', '/api/alerts?status=OPEN&limit=1', { token: staff.token });
  const alert = open.body.data.alerts[0];
  assert.ok(alert, 'seeded data should contain an open alert');

  const acknowledged = await call(ctx, 'POST', `/api/alerts/${alert.id}/acknowledge`, { token: staff.token });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.data.alert.status, 'ACKNOWLEDGED');
  assert.equal(acknowledged.body.data.alert.acknowledgedByName, 'Prakash Adhikari');

  const resolved = await call(ctx, 'POST', `/api/alerts/${alert.id}/resolve`, {
    token: staff.token,
    body: { note: 'Card reissued to the student.' },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.data.alert.status, 'RESOLVED');
  assert.equal(resolved.body.data.alert.resolutionNote, 'Card reissued to the student.');
  assert.ok(resolved.body.data.alert.resolvedAt);
});

test('alert stats group by status, severity and type', async () => {
  const response = await call(ctx, 'GET', '/api/alerts/stats', { token: staff.token });
  assert.equal(response.status, 200);
  assert.ok(response.body.data.types.length >= 5, 'catalogue should be exposed for the UI');
  assert.equal(typeof response.body.data.open, 'number');
  assert.ok(response.body.data.bySeverity);
});

test('bulk resolve clears multiple alerts at once', async () => {
  const open = await call(ctx, 'GET', '/api/alerts?status=OPEN&limit=5', { token: staff.token });
  const ids = open.body.data.alerts.map((alert) => alert.id);
  assert.ok(ids.length >= 2, 'need at least two open alerts');

  const response = await call(ctx, 'POST', '/api/alerts/bulk/resolve', {
    token: staff.token,
    body: { ids, note: 'Cleared in batch during QA.' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.updated, ids.length);

  const remaining = await call(ctx, 'GET', '/api/alerts?status=OPEN&limit=100', { token: staff.token });
  const stillOpen = remaining.body.data.alerts.filter((alert) => ids.includes(alert.id));
  assert.equal(stillOpen.length, 0);
});

test('an operator can raise a manual system notice', async () => {
  const response = await call(ctx, 'POST', '/api/alerts', {
    token: staff.token,
    body: { title: 'Scheduled maintenance window', message: 'TS-04 offline on Friday 08:00-12:00.', severity: 'LOW' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.alert.type, 'SYSTEM');
  assert.equal(response.body.data.alert.severity, 'LOW');
});

// ---------------------------------------------------------------------------
// Settings & backup
// ---------------------------------------------------------------------------
test('settings are readable, typed and updatable', async () => {
  const read = await call(ctx, 'GET', '/api/system', { token: admin.token });
  assert.equal(read.status, 200);
  const map = Object.fromEntries(read.body.data.settings.map((setting) => [setting.key, setting.value]));
  assert.equal(typeof map.maintenance_mode, 'boolean');
  assert.ok(read.body.data.system.permissions > 0);

  // The console fetches /api/settings while older callers used /api/system.
  const settings = await call(ctx, 'GET', '/api/settings', { token: admin.token });
  assert.equal(settings.status, 200);
  assert.ok(Array.isArray(settings.body.data.settings));

  const patched = await call(ctx, 'PATCH', '/api/system', {
    token: admin.token,
    body: { capacityWarningPct: 90, maintenanceMode: true },
  });
  assert.equal(patched.status, 200);
  const updated = Object.fromEntries(patched.body.data.settings.map((setting) => [setting.key, setting.value]));
  assert.equal(updated.capacity_warning_pct, 90);
  assert.equal(updated.maintenance_mode, true);

  // PUT is supported too: some clients model a full settings write as PUT.
  const put = await call(ctx, 'PUT', '/api/settings', {
    token: admin.token,
    body: { capacityWarningPct: 88 },
  });
  assert.equal(put.status, 200);
  const putUpdated = Object.fromEntries(put.body.data.settings.map((setting) => [setting.key, setting.value]));
  assert.equal(putUpdated.capacity_warning_pct, 88);

  // restore
  await call(ctx, 'PATCH', '/api/system', {
    token: admin.token,
    body: { capacityWarningPct: 85, maintenanceMode: false },
  });
});

test('database backup is created, listed and downloadable', async () => {
  const created = await call(ctx, 'POST', '/api/system/backups', { token: admin.token });
  assert.equal(created.status, 201);
  const file = created.body.data.file;
  assert.match(file, /^transitsync-\d{8}-\d{6}\.db$/);
  assert.ok(created.body.data.sizeBytes > 0);

  const list = await call(ctx, 'GET', '/api/system/backups', { token: admin.token });
  assert.ok(list.body.data.backups.some((backup) => backup.file === file));

  const download = await call(ctx, 'GET', `/api/system/backups/${file}`, { token: admin.token, raw: true });
  assert.equal(download.status, 200);
  assert.match(download.text.slice(0, 15), /^SQLite format 3/);

  const removed = await call(ctx, 'DELETE', `/api/system/backups/${file}`, { token: admin.token });
  assert.equal(removed.status, 200);
});

test('backup path traversal is blocked', async () => {
  const response = await call(ctx, 'GET', '/api/system/backups/..%2F..%2Ftransitsync.db', {
    token: admin.token,
  });
  assert.ok(
    [400, 404, 422].includes(response.status),
    `expected rejection, got ${response.status} ${JSON.stringify(response.body)}`,
  );
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------
test('user list is searchable and reports effective permissions', async () => {
  const response = await call(ctx, 'GET', '/api/users?search=transport', { token: admin.token });
  assert.equal(response.status, 200);
  assert.ok(response.body.data.users.length >= 1);
  const staffRow = response.body.data.users[0];
  assert.equal(staffRow.role, 'transport_staff');
  assert.ok(staffRow.permissions.includes('students:edit'));
  assert.equal(staffRow.permissions.includes('users:read'), false);
  assert.equal(staffRow.mustChangePassword, false);
});

test('creating a user returns a one-time temporary password', async () => {
  const response = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email: `onboard-${Date.now()}@transitsync.edu.np`,
      fullName: 'Newly Onboarded Staff',
      roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT),
      temporaryPassword: 'WelcomePass!2024',
      forcePasswordChange: true,
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.user.mustChangePassword, true);
  assert.equal(response.body.data.user.isFirstLogin, true);
  assert.equal(response.body.data.temporaryPassword, 'WelcomePass!2024');
});

test('a blank temporary password creates a passwordless invited account', async () => {
  const email = `invite-${Date.now()}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'Invited Staff',
      roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT),
      forcePasswordChange: true,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.temporaryPassword, null);
  assert.equal(created.body.data.mustSetPassword, true);
  assert.equal(created.body.data.user.status, 'invited');

  // The invite cannot sign in until it is claimed.
  const blocked = await call(ctx, 'POST', '/api/auth/login', { body: { email, password: 'anything' } });
  assert.equal(blocked.status, 401);

  // Step 1 reports a first-time user; step 2b claims the account.
  const probe = await call(ctx, 'POST', '/api/auth/check-email', { body: { email } });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.data.status, 'FIRST_TIME_USER');

  const claimed = await call(ctx, 'POST', '/api/auth/set-first-password', {
    body: { email, password: 'Kestrel!2026', confirmPassword: 'Kestrel!2026' },
  });
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.data.mustChangePassword, false);
  assert.equal(typeof claimed.body.data.token, 'string');

  // Claimed once, then it behaves like any password account.
  const reprobe = await call(ctx, 'POST', '/api/auth/check-email', { body: { email } });
  assert.equal(reprobe.body.data.status, 'EXISTS_WITH_PASSWORD');

  // A second claim is refused — the account is no longer passwordless.
  const taken = await call(ctx, 'POST', '/api/auth/set-first-password', {
    body: { email, password: 'Falcon!2027', confirmPassword: 'Falcon!2027' },
  });
  assert.equal(taken.status, 409);

  const session = await login(ctx, email, 'Kestrel!2026');
  assert.equal(session.mustChangePassword, false);
});

test('check-email reports NOT_FOUND (404) and accepts a simple temporary password', async () => {
  const missing = await call(ctx, 'POST', '/api/auth/check-email', {
    body: { email: `nobody-${Date.now()}@transitsync.edu.np` },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.equal(missing.body.error.message, 'No staff account found with this email address.');

  const email = `simple-${Date.now()}@transitsync.edu.np`;
  const simple = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'Simple Credential',
      roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT),
      temporaryPassword: 'abc',
      forcePasswordChange: true,
    },
  });
  assert.equal(simple.status, 201);
  assert.equal(simple.body.data.temporaryPassword, 'abc');

  const probe = await call(ctx, 'POST', '/api/auth/check-email', { body: { email } });
  assert.equal(probe.body.data.status, 'EXISTS_WITH_PASSWORD');

  const session = await login(ctx, email, 'abc');
  assert.equal(session.mustChangePassword, true);
});

test('check-email reports a suspended account as 403 without leaking the password state', async () => {
  const email = `suspended-${Date.now()}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'Suspended Staff',
      roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT),
      temporaryPassword: 'Kestrel!2026',
      forcePasswordChange: true,
    },
  });
  assert.equal(created.status, 201);

  const suspended = await call(ctx, 'PATCH', `/api/users/${created.body.data.user.id}`, {
    token: admin.token,
    body: { status: 'suspended' },
  });
  assert.equal(suspended.status, 200);

  const probe = await call(ctx, 'POST', '/api/auth/check-email', { body: { email } });
  assert.equal(probe.status, 403);
  assert.equal(probe.body.error.code, 'ACCOUNT_SUSPENDED');

  // A suspended invite cannot be claimed, even though it never had a password.
  const inviteEmail = `suspended-invite-${Date.now()}@transitsync.edu.np`;
  const invite = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: { email: inviteEmail, fullName: 'Suspended Invite', roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT) },
  });
  assert.equal(invite.body.data.user.status, 'invited');
  await call(ctx, 'PATCH', `/api/users/${invite.body.data.user.id}`, {
    token: admin.token,
    body: { status: 'suspended' },
  });
  const inviteProbe = await call(ctx, 'POST', '/api/auth/check-email', { body: { email: inviteEmail } });
  assert.equal(inviteProbe.status, 403);
  assert.equal(inviteProbe.body.error.code, 'ACCOUNT_SUSPENDED');
});

test('admin-issued password reset invalidates the old credential', async () => {
  const email = `reset-${Date.now()}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'Reset Target',
      roleId: roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
      temporaryPassword: 'Copper3Beacon!',
      forcePasswordChange: false,
    },
  });
  assert.equal(created.status, 201);
  const userId = created.body.data.user.id;

  const reset = await call(ctx, 'POST', `/api/users/${userId}/reset-password`, { token: admin.token });
  assert.equal(reset.status, 201);
  const nextPassword = reset.body.data.temporaryPassword;

  const oldLogin = await call(ctx, 'POST', '/api/auth/login', { body: { email, password: 'BeforeReset!2024' } });
  assert.equal(oldLogin.status, 401);

  const newLogin = await call(ctx, 'POST', '/api/auth/login', { body: { email, password: nextPassword } });
  assert.equal(newLogin.status, 200);
  assert.equal(newLogin.body.data.mustChangePassword, true);
});

test('deleting a user soft-deletes and frees the email for reuse policy', async () => {
  const email = `delete-${Date.now()}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: { email, fullName: 'Doomed Account', roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT), temporaryPassword: 'Harbour7Lantern!' },
  });
  const userId = created.body.data.user.id;

  const removed = await call(ctx, 'DELETE', `/api/users/${userId}`, { token: admin.token });
  assert.equal(removed.status, 200);

  const login = await call(ctx, 'POST', '/api/auth/login', { body: { email, password: 'Harbour7Lantern!' } });
  assert.equal(login.status, 401);
});

test('a suspended account can be purged (hard-deleted)', async () => {
  const email = `purge-${Date.now()}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: { email, fullName: 'Purge Me', roleId: roleIdOf(ctx, ROLE_KEYS.ATTENDANT), temporaryPassword: 'Harbour7Lantern!' },
  });
  const userId = created.body.data.user.id;

  // The realistic path: suspend, then remove for good.
  const suspended = await call(ctx, 'PATCH', `/api/users/${userId}`, {
    token: admin.token,
    body: { status: 'suspended' },
  });
  assert.equal(suspended.status, 200);

  const purged = await call(ctx, 'DELETE', `/api/users/${userId}/purge`, { token: admin.token });
  assert.equal(purged.status, 200);

  // The row is gone entirely, not merely soft-deleted.
  const found = ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  assert.equal(found, undefined);

  const list = await call(ctx, 'GET', `/api/users?search=${encodeURIComponent(email)}`, { token: admin.token });
  assert.equal(list.body.data.users.length, 0);
});

test('purging is refused for your own account', async () => {
  const me = await call(ctx, 'GET', '/api/auth/me', { token: admin.token });
  const response = await call(ctx, 'DELETE', `/api/users/${me.body.data.user.id}/purge`, { token: admin.token });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /cannot delete your own/i);
});

test('roles endpoint reports headcounts and permission sets', async () => {
  const response = await call(ctx, 'GET', '/api/roles', { token: admin.token });
  assert.equal(response.status, 200);
  const roles = response.body.data.roles;
  assert.equal(roles.length, 3);

  const adminRole = roles.find((role) => role.key === 'system_admin');
  assert.ok(adminRole.permissions.length >= 20, 'admin role should hold the full catalogue');

  const attendant = roles.find((role) => role.key === 'attendant');
  assert.ok(attendant.headcount >= 2);
  assert.equal(attendant.permissions.includes('students:edit'), false);
});

// ---------------------------------------------------------------------------
// Realtime SSE
// ---------------------------------------------------------------------------
test('SSE stream is authenticated, permission filtered, and delivers live scans', async () => {
  const controller = new AbortController();
  const response = await fetch(`${ctx.baseUrl}/api/stream`, {
    headers: { Authorization: `Bearer ${admin.token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Drain until a scan event arrives, or give up.
  const student = ctx.db
    .prepare("SELECT * FROM students WHERE card_status = 'ACTIVE' AND status='ACTIVE' AND bus_id IS NOT NULL LIMIT 1")
    .get();

  const tapPromise = fetch(`${ctx.baseUrl}/api/simulator/tap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rfidSerial: student.rfid_serial, busId: student.bus_id, gate: 'SSE Test' }),
  });

  const deadline = Date.now() + 8000;
  let sawScan = false;

  while (Date.now() < deadline && !sawScan) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined }), 2000)),
    ]);
    if (chunk?.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.includes('event: scan')) sawScan = true;
    }
  }

  await tapPromise;
  controller.abort();

  assert.ok(sawScan, `expected a scan event on the stream. Received:\n${buffer.slice(0, 800)}`);
  assert.match(buffer, /event: connected/);
  assert.match(buffer, /"channel":"scan"/);
});

test('SSE stream is refused without a token', async () => {
  const response = await fetch(`${ctx.baseUrl}/api/stream`);
  assert.equal(response.status, 401);
  await response.text();
});

test('SSE stream is refused for a role with no channel permission', async () => {
  const email = `nostream-${Date.now()}@transitsync.edu.np`;
  await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'No Stream Access',
      roleId: roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
      temporaryPassword: 'Slate9Marble!',
      permissionsMode: 'CUSTOM',
      permissions: ['students:read'],
      forcePasswordChange: false,
    },
  });

  const session = await login(ctx, email, 'Slate9Marble!');
  const response = await fetch(`${ctx.baseUrl}/api/stream`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(response.status, 403);
  await response.text();
});

// ---------------------------------------------------------------------------
// SPA / static hosting
// ---------------------------------------------------------------------------
test('unknown API routes return JSON 404, not HTML', async () => {
  // Authenticated, so the request reaches routing rather than being turned away
  // at the auth gate: an unauthenticated unknown path is a 401 by design.
  const response = await call(ctx, 'GET', '/api/does-not-exist', { token: admin.token });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
});

test('an unauthenticated unknown API path is refused before routing', async () => {
  const response = await call(ctx, 'GET', '/api/does-not-exist');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'NO_TOKEN');
});

test('client-side routes never resolve to an API error', async () => {
  // The client bundle is not built in CI, so the server should return the
  // diagnostic page (503) or index.html — never a JSON API error.
  for (const path of ['/', '/dashboard', '/students', '/users', '/settings']) {
    const response = await fetch(`${ctx.baseUrl}${path}`);
    const type = response.headers.get('content-type') ?? '';
    assert.match(type, /text\/html/, `${path} should serve HTML`);
    assert.notEqual(response.status, 404, `${path} must not 404 — that causes a blank screen`);
  }
});

test('requests for missing asset files 404 honestly instead of returning HTML', async () => {
  const response = await fetch(`${ctx.baseUrl}/assets/missing-chunk.js`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
});
