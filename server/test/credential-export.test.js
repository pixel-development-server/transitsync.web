/**
 * Credential audit export.
 *
 * The export is deliberately inert under the API test harness, so this suite
 * drives `credentialStorage.js` directly against an isolated store directory and
 * asserts the two properties that matter: a clean, aligned per-account file with
 * NPT timestamps, and the absolute absence of anything secret.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STORE = mkdtempSync(join(tmpdir(), 'transitsync-credentials-'));

// The store directory is resolved once, when the module is first evaluated, so
// it must be set before the import — hence the dynamic import below.
process.env.CREDENTIAL_STORE_DIR = STORE;

const { writeCredentialRecord, credentialFileName, renderCredentialRecord, nptStamp } =
  await import('../credentialStorage.js');

test.after(() => rmSync(STORE, { recursive: true, force: true }));

test('writes one clean, human-readable file per account', () => {
  const path = writeCredentialRecord({
    source: 'student.create',
    userId: 42,
    fullName: 'Ram Bahadur Thapa',
    email: 'ram@iic.edu.np',
    roleKey: 'student',
    roleName: 'Student',
    collegeId: 'IIC-BCT-2024-014',
    tenantName: 'IIC',
    status: 'ACTIVE',
    busCardStatus: 'ACTIVE',
    busCardSerial: '1A2B3C4D',
    createdAt: '2026-10-01 03:27:00',
  });

  assert.equal(path, join(STORE, 'user_ram@iic.edu.np.txt'));
  assert.ok(existsSync(path));

  const text = readFileSync(path, 'utf8');
  assert.match(text, /Account Audit Record/);
  assert.match(text, /Ram Bahadur Thapa/);
  assert.match(text, /ram@iic\.edu\.np/);
  assert.match(text, /IIC-BCT-2024-014/);
  assert.match(text, /Student \(Rider portal\)/);
  // Bare DB stamps are NPT wall time end-to-end, so the record labels them
  // exactly as stored rather than re-shifting a UTC instant.
  assert.match(text, /2026-10-01 03:27:00 NPT/);
});

test('never writes a password or a password hash', () => {
  const text = renderCredentialRecord({
    fullName: 'No Secrets',
    email: 'plain@iic.edu.np',
    password: 'hunter2',
    password_hash: '$2a$10$abcdefghijklmnopqrstuv',
  });

  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /\$2[aby]\$/);
  assert.doesNotMatch(text, /password_hash/i);
});

test('re-writing an account refreshes the same file rather than forking it', () => {
  const first = writeCredentialRecord({ email: 'dup@iic.edu.np', fullName: 'First Name' });
  const second = writeCredentialRecord({ email: 'dup@iic.edu.np', fullName: 'Second Name' });

  assert.equal(first, second);
  assert.match(readFileSync(second, 'utf8'), /Second Name/);
});

test('falls back to the college ID when an account has no email yet', () => {
  assert.equal(credentialFileName({ collegeId: 'IIC/2024 014' }), 'student_iic_2024_014.txt');
});

test('the NPT stamp is sortable, day-first and zone-labelled', () => {
  // A bare stamp is Nepal wall time already — labelled, never re-shifted.
  assert.equal(nptStamp('2026-10-01 03:27:00'), '2026-10-01 03:27:00 NPT');
  // A zoned value still converts: 2026-10-01T03:27:00Z is 09:12 in Kathmandu.
  assert.equal(nptStamp('2026-10-01T03:27:00Z'), '2026-10-01 09:12:00 NPT');
});
