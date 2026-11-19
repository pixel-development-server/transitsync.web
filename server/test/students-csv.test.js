import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, call, login, loginAdmin, roleIdOf, ROLE_KEYS } from './support/harness.js';
import { parseCsv, parseCsvRows } from '../src/lib/csv.js';

/**
 * Student registry CSV export / import.
 *
 * The export is exercised with `raw: true` so the response bytes can be
 * inspected directly (content type, disposition header, BOM, header row).
 * The import is exercised both through the JSON `{ csv }` path the console
 * uses and through a raw `text/csv` upload.
 */

let ctx;
let admin;

test.before(async () => {
  ctx = await bootServer();
  admin = await loginAdmin(ctx);
});

test.after(async () => {
  await ctx?.close();
});

test('student CSV export is well formed and includes the seeded roster', async () => {
  const response = await call(ctx, 'GET', '/api/students/export', { token: admin.token, raw: true });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(
    response.headers['content-disposition'],
    /attachment; filename="transitsync-students-\d{8}-\d{4}\.csv"/,
  );

  // The BOM is present, then a header row naming the expected columns.
  assert.equal(response.text.charCodeAt(0), 0xfeff, 'export should start with a UTF-8 BOM');

  const lines = response.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.ok(lines.length > 1, 'header plus at least one data row');
  assert.match(lines[0], /^Full Name,College ID,Email,Phone,Faculty,Program,Semester,RFID Serial,Card Status,Status,Notes$/);
  assert.equal(lines[0].split(',').length, 11);

  // A known seeded student must appear in the body.
  const seeded = await ctx.db.get('SELECT college_id FROM students ORDER BY id LIMIT 1');
  assert.ok(seeded, 'the demo dataset must contain students');
  assert.ok(response.text.includes(seeded.college_id), 'the seeded roster should be exported');
});

test('student CSV export honours the search filter', async () => {
  const seeded = await ctx.db.get('SELECT college_id FROM students ORDER BY id LIMIT 1');

  const response = await call(
    ctx,
    'GET',
    `/api/students/export?search=${encodeURIComponent(seeded.college_id)}`,
    { token: admin.token, raw: true },
  );
  assert.equal(response.status, 200);

  const dataRows = response.text.replace(/^\uFEFF/, '').trim().split('\r\n').slice(1);
  assert.ok(dataRows.length >= 1);
  assert.ok(dataRows.every((row) => row.includes(seeded.college_id)));
});

test('CSV import creates new students keyed on college ID', async () => {
  const csv = [
    'fullName,collegeId,email,faculty,semester,status',
    'Import Created,KMI-CSV-NEW-1,csv.new@kmi.edu.np,Computer Engineering,3,ACTIVE',
  ].join('\r\n');

  const response = await call(ctx, 'POST', '/api/students/import', {
    token: admin.token,
    body: { csv },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.created, 1);
  assert.equal(response.body.data.updated, 0);
  assert.equal(response.body.data.skipped, 0);
  assert.deepEqual(response.body.data.errors, []);

  const row = await ctx.db.get('SELECT * FROM students WHERE college_id = ?', 'KMI-CSV-NEW-1');
  assert.ok(row, 'the imported student should exist');
  assert.equal(row.full_name, 'Import Created');
  assert.equal(row.email, 'csv.new@kmi.edu.np');
  assert.equal(row.faculty, 'Computer Engineering');
  assert.equal(row.semester, 3);
  assert.equal(row.status, 'ACTIVE');
});

test('CSV import updates an existing student without clearing omitted columns', async () => {
  // The previous test created KMI-CSV-NEW-1 with an email. This update mentions
  // neither email nor semester, so both must survive untouched.
  const csv = ['fullName,collegeId,faculty', 'Import Updated,KMI-CSV-NEW-1,Updated Faculty'].join('\r\n');

  const response = await call(ctx, 'POST', '/api/students/import', {
    token: admin.token,
    body: { csv },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.created, 0);
  assert.equal(response.body.data.updated, 1);
  assert.equal(response.body.data.skipped, 0);

  const row = await ctx.db.get('SELECT * FROM students WHERE college_id = ?', 'KMI-CSV-NEW-1');
  assert.equal(row.full_name, 'Import Updated');
  assert.equal(row.faculty, 'Updated Faculty');
  assert.equal(row.email, 'csv.new@kmi.edu.np', 'an omitted column must be preserved');
  assert.equal(row.semester, 3, 'an omitted column must be preserved');
});

test('CSV import reports per-row errors for missing required fields', async () => {
  const csv = [
    'fullName,collegeId',
    ',KMI-CSV-BAD-1',
    'No College,',
  ].join('\r\n');

  const response = await call(ctx, 'POST', '/api/students/import', {
    token: admin.token,
    body: { csv },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.created, 0);
  assert.equal(response.body.data.updated, 0);
  assert.equal(response.body.data.skipped, 2);
  assert.equal(response.body.data.errors.length, 2);

  assert.match(response.body.data.errors[0].message, /full name/i);
  assert.match(response.body.data.errors[1].message, /college id/i);
  // The row number points at the physical CSV line (1-based, header is line 1).
  assert.equal(response.body.data.errors[0].row, 2);
  assert.equal(response.body.data.errors[1].row, 3);
});

test('CSV import accepts a raw text/csv upload', async () => {
  // Bypass the JSON helper: the raw path goes through the route-scoped
  // express.text parser rather than express.json.
  const response = await fetch(`${ctx.baseUrl}/api/students/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'text/csv' },
    body: 'fullName,collegeId\r\nRaw Upload,KMI-CSV-RAW-1',
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.created, 1);
  assert.ok(await ctx.db.get('SELECT id FROM students WHERE college_id = ?', 'KMI-CSV-RAW-1'));
});

test('a user without students:read cannot export the roster', async () => {
  const email = `no-students-${Date.now()}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'No Students Access',
      roleId: await roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
      temporaryPassword: 'Slate9Marble!',
      permissionsMode: 'CUSTOM',
      permissions: ['settings:read'],
      forcePasswordChange: false,
    },
  });
  assert.equal(created.status, 201);

  const session = await login(ctx, email, 'Slate9Marble!');
  const response = await call(ctx, 'GET', '/api/students/export', { token: session.token });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'PERMISSION_DENIED');
});

// ---------------------------------------------------------------------------
// Parser unit tests — the RFC 4180 edge cases the import relies on
// ---------------------------------------------------------------------------
test('parseCsv strips a leading BOM, trims headers and keys rows by header', () => {
  const rows = parseCsv('\uFEFFfullName, collegeId\r\nAsha Gurung, KMI1\r\n');
  // Headers are trimmed; cell values are returned verbatim (import trims them).
  assert.deepEqual(rows, [{ fullName: 'Asha Gurung', collegeId: ' KMI1' }]);
});

test('parseCsv handles quoted commas, doubled quotes and embedded newlines', () => {
  const csv = 'name,notes\r\n"Doe, Jane","Said ""hi""\nsecond line"';
  assert.deepEqual(parseCsv(csv), [
    { name: 'Doe, Jane', notes: 'Said "hi"\nsecond line' },
  ]);
});

test('parseCsv skips blank lines, tolerates a trailing newline and header-only input', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n3,4'), [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
  // Header only → no records.
  assert.deepEqual(parseCsv('a,b\r\n'), []);
  // Empty input → no records.
  assert.deepEqual(parseCsv(''), []);
});

test('parseCsvRows returns raw cell matrices for callers that need them', () => {
  assert.deepEqual(parseCsvRows('a,b\n"x,y",z\n'), [
    ['a', 'b'],
    ['x,y', 'z'],
  ]);
});
