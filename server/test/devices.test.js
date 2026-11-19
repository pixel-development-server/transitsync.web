/**
 * "Remember Me" device recognition.
 *
 * A sign-in may carry a browser-minted `deviceFingerprint`. With `rememberMe`
 * this must:
 *   - register a brand-new fingerprint as a `user_devices` row and flag the
 *     session as a new device,
 *   - recognise a fingerprint it has already seen (no duplicate row, the
 *     login counter advances, `newDevice` is false),
 *   - extend the session — and, crucially, the JWT `exp` — to ~30 days so the
 *     remembered browser is not silently capped at the 8h token default,
 *   - expose the caller's own devices and let them revoke one, which must also
 *     revoke the sessions that device minted.
 *
 * A login with no fingerprint at all must keep working exactly as before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { bootServer, call, insertUser, ROLE_KEYS, STAFF_PASSWORD } from './support/harness.js';

const ctx = await bootServer();
const { db } = ctx;

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/** A staff user with a known password, kept active (no forced rotation). */
async function insertStaff() {
  return insertUser(ctx, {
    email: `devices-${Math.random().toString(36).slice(2, 8)}@transitsync.edu.np`,
    password: STAFF_PASSWORD,
    fullName: 'Device Tester',
    roleKey: ROLE_KEYS.TRANSPORT_STAFF,
  });
}

function loginBody(email, extra = {}) {
  return { email, password: STAFF_PASSWORD, portalType: 'staff', ...extra };
}

/** A remembered login; returns the parsed session data. */
async function rememberLogin(email, fingerprint) {
  const response = await call(ctx, 'POST', '/api/auth/login', {
    body: loginBody(email, { rememberMe: true, deviceFingerprint: fingerprint }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

test.after(async () => {
  await ctx?.close();
});

test('a login with no fingerprint still works and is not remembered', async () => {
  const userId = await insertStaff();
  const email = (await db.get('SELECT email FROM users WHERE id = ?', userId)).email;

  const response = await call(ctx, 'POST', '/api/auth/login', { body: loginBody(email) });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.remembered, false);
  assert.equal(response.body.data.newDevice, false);

  // No device row was created for a fingerprint-less sign-in.
  const devices = (await db.get('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', userId)).n;
  assert.equal(devices, 0);
});

test('rememberMe + fingerprint registers a device and a ~30-day session', async () => {
  const userId = await insertStaff();
  const email = (await db.get('SELECT email FROM users WHERE id = ?', userId)).email;
  const fingerprint = `fp_remember_${Math.random().toString(16).slice(2)}`;

  const data = await rememberLogin(email, fingerprint);
  assert.equal(data.remembered, true);
  assert.equal(data.newDevice, true);

  const device = await db.get(
    'SELECT * FROM user_devices WHERE user_id = ? AND device_fingerprint = ?',
    userId,
    fingerprint,
  );
  assert.ok(device, 'a user_devices row should have been registered');
  assert.equal(Number(device.login_count), 1);
  assert.equal(Number(device.trusted), 1);
  assert.equal(device.revoked_at, null);

  const session = await db.get(
    'SELECT remembered, device_id, expires_at FROM login_sessions WHERE id = ?',
    data.sessionId,
  );
  assert.equal(Number(session.remembered), 1);
  assert.equal(Number(session.device_id), Number(device.id));

  // The returned ISO expiry should be roughly 30 days out. Allow a minute of
  // slack so a slow test host cannot flake the assertion.
  const remainingDays = (new Date(data.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(remainingDays > 29.9 && remainingDays <= 30, `expected ~30 days, got ${remainingDays}`);
});

test('a second login on the same fingerprint is recognised, not duplicated', async () => {
  const userId = await insertStaff();
  const email = (await db.get('SELECT email FROM users WHERE id = ?', userId)).email;
  const fingerprint = `fp_repeat_${Math.random().toString(16).slice(2)}`;

  const first = await rememberLogin(email, fingerprint);
  assert.equal(first.newDevice, true);

  const second = await rememberLogin(email, fingerprint);
  assert.equal(second.remembered, true);
  assert.equal(second.newDevice, false, 'a known fingerprint must not be a new device');

  const rows = await db.all(
    'SELECT * FROM user_devices WHERE user_id = ? AND device_fingerprint = ?',
    userId,
    fingerprint,
  );
  assert.equal(rows.length, 1, 'the same fingerprint must not register twice');
  assert.equal(Number(rows[0].login_count), 2, 'login_count should advance on each sign-in');
});

test('a different fingerprint registers a second device', async () => {
  const userId = await insertStaff();
  const email = (await db.get('SELECT email FROM users WHERE id = ?', userId)).email;

  const first = await rememberLogin(email, `fp_a_${Math.random().toString(16).slice(2)}`);
  const second = await rememberLogin(email, `fp_b_${Math.random().toString(16).slice(2)}`);
  assert.equal(first.newDevice, true);
  assert.equal(second.newDevice, true);

  const count = (await db.get('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', userId)).n;
  assert.equal(count, 2);
});

test('the caller can list their devices and revoke one', async () => {
  const userId = await insertStaff();
  const email = (await db.get('SELECT email FROM users WHERE id = ?', userId)).email;
  const fingerprint = `fp_revoke_${Math.random().toString(16).slice(2)}`;

  const data = await rememberLogin(email, fingerprint);

  const listed = await call(ctx, 'GET', '/api/auth/devices', { token: data.token });
  assert.equal(listed.status, 200);
  const devices = listed.body.data.devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].current, true, 'the session device must be flagged current');
  assert.equal(devices[0].loginCount, 1);
  assert.equal(devices[0].revokedAt, null);

  const deviceId = devices[0].id;
  const revoked = await call(ctx, 'DELETE', `/api/auth/devices/${deviceId}`, { token: data.token });
  assert.equal(revoked.status, 200);

  const row = await db.get('SELECT revoked_at, revoked_reason FROM user_devices WHERE id = ?', deviceId);
  assert.ok(row.revoked_at, 'the device row must be stamped revoked');
  assert.equal(row.revoked_reason, 'user_revoked');

  // Every session that device minted must be revoked too.
  const liveSessions = (
    await db.get('SELECT COUNT(*) AS n FROM login_sessions WHERE device_id = ? AND revoked_at IS NULL', deviceId)
  ).n;
  assert.equal(liveSessions, 0, 'revoking a device must revoke its live sessions');
});

test('deleting another account\'s device answers 404', async () => {
  const ownerId = await insertStaff();
  const ownerEmail = (await db.get('SELECT email FROM users WHERE id = ?', ownerId)).email;
  const owner = await rememberLogin(ownerEmail, `fp_owner_${Math.random().toString(16).slice(2)}`);

  const listed = await call(ctx, 'GET', '/api/auth/devices', { token: owner.token });
  const ownerDeviceId = listed.body.data.devices[0].id;

  const strangerId = await insertStaff();
  const strangerEmail = (await db.get('SELECT email FROM users WHERE id = ?', strangerId)).email;
  const stranger = await rememberLogin(strangerEmail, `fp_stranger_${Math.random().toString(16).slice(2)}`);

  const attempt = await call(ctx, 'DELETE', `/api/auth/devices/${ownerDeviceId}`, { token: stranger.token });
  assert.equal(attempt.status, 404);
  assert.equal(attempt.body.error.code, 'NOT_FOUND');

  const stillLive = await db.get('SELECT revoked_at FROM user_devices WHERE id = ?', ownerDeviceId);
  assert.equal(stillLive.revoked_at, null, 'a stranger must not be able to revoke the device');
});

test('the remembered JWT exp matches the ~30-day session', async () => {
  const userId = await insertStaff();
  const email = (await db.get('SELECT email FROM users WHERE id = ?', userId)).email;

  const remembered = await rememberLogin(email, `fp_jwt_${Math.random().toString(16).slice(2)}`);
  const payload = jwt.decode(remembered.token);
  assert.ok(payload?.exp && payload?.iat, 'the token must carry exp and iat');
  const lifetime = payload.exp - payload.iat;
  assert.ok(
    Math.abs(lifetime - THIRTY_DAYS_S) <= 5,
    `remembered token lifetime should be ~${THIRTY_DAYS_S}s, got ${lifetime}s`,
  );

  // Contrast: an ordinary sign-in keeps the (much shorter) default lifetime.
  const ordinary = await call(ctx, 'POST', '/api/auth/login', { body: loginBody(email) });
  assert.equal(ordinary.status, 200);
  const plain = jwt.decode(ordinary.body.data.token);
  assert.ok(plain.exp - plain.iat < THIRTY_DAYS_S, 'a plain session must not get the 30-day lifetime');
});
