import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  loginAdmin,
  loginSuperAdmin,
  ADMIN_EMAIL,
  SUPER_ADMIN_EMAIL,
  SUPER_ROTATED_PASSWORD,
} from './support/harness.js';
import {
  base32Decode,
  base32Encode,
  buildOtpAuthUrl,
  generateCode,
  generateSecret,
  verifyCode,
} from '../src/lib/totp.js';
import { setupSchema } from '../src/validation/schemas.js';

let ctx;
let superAdmin;

test.before(async () => {
  ctx = await bootServer();
  superAdmin = await loginSuperAdmin(ctx);
});

test.after(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
test('TOTP codes round-trip and reject drift outside the window', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const code = generateCode(secret, { now });

  assert.match(code, /^\d{6}$/);
  assert.equal(verifyCode(secret, code, { now }), true);
  // The immediately preceding step is accepted (±1 window) for clock drift.
  assert.equal(verifyCode(secret, generateCode(secret, { now: now - 30_000 }), { now }), true);
  // Three steps away is outside the window.
  assert.equal(verifyCode(secret, generateCode(secret, { now: now - 90_000 }), { now }), false);
  assert.equal(verifyCode(secret, 'abcdef', { now }), false);
  assert.equal(verifyCode('', code, { now }), false);
});

test('base32 encodes and decodes symmetrically', () => {
  const buffer = Buffer.from('TransitSync');
  assert.deepEqual(base32Decode(base32Encode(buffer)), buffer);
});

test('the otpauth URL carries the issuer, secret and parameters', () => {
  const url = buildOtpAuthUrl({ secret: 'ABC234', label: 'owner@example.com', issuer: 'TransitSync' });
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /secret=ABC234/);
  assert.match(url, /issuer=TransitSync/);
  assert.match(url, /algorithm=SHA1/);
});

test('the setup schema defaults to the platform owner and accepts the campus role', () => {
  const base = {
    email: 'a@b.com',
    password: 'LongEnough1!',
    confirmPassword: 'LongEnough1!',
    fullName: 'Someone',
    institution: 'TransitSync',
  };
  assert.equal(setupSchema.parse(base).role, 'super_admin');
  assert.equal(setupSchema.parse({ ...base, role: 'system_admin' }).role, 'system_admin');
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------
test('two-factor management is reserved for the platform owner', async () => {
  const admin = await loginAdmin(ctx);

  const status = await call(ctx, 'GET', '/api/auth/2fa/status', { token: admin.token });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.subject, false);
  assert.equal(status.body.data.enabled, false);

  const enroll = await call(ctx, 'POST', '/api/auth/2fa/setup', {
    token: admin.token,
    body: { method: 'TOTP' },
  });
  assert.equal(enroll.status, 403);
  assert.equal(enroll.body.error.code, 'SUPER_ADMIN_ONLY');
});

// ---------------------------------------------------------------------------
// Self-service email change
// ---------------------------------------------------------------------------
test('the owner can change their sign-in email with password proof', async () => {
  const wrongPassword = await call(ctx, 'POST', '/api/auth/change-email', {
    token: superAdmin.token,
    body: { newEmail: 'owner@transitsync.me', currentPassword: 'not-my-password' },
  });
  assert.equal(wrongPassword.status, 401);

  const taken = await call(ctx, 'POST', '/api/auth/change-email', {
    token: superAdmin.token,
    body: { newEmail: ADMIN_EMAIL, currentPassword: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(taken.status, 409);

  const changed = await call(ctx, 'POST', '/api/auth/change-email', {
    token: superAdmin.token,
    body: { newEmail: 'owner@transitsync.me', currentPassword: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.user.email, 'owner@transitsync.me');

  // The re-minted token stays valid after the token-version bump.
  const me = await call(ctx, 'GET', '/api/auth/me', { token: changed.body.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.email, 'owner@transitsync.me');

  // Restore the original address so later harness logins still resolve.
  const restore = await call(ctx, 'POST', '/api/auth/change-email', {
    token: changed.body.data.token,
    body: { newEmail: SUPER_ADMIN_EMAIL, currentPassword: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.data.user.email, SUPER_ADMIN_EMAIL);
  superAdmin = { ...superAdmin, token: restore.body.data.token };
});

// ---------------------------------------------------------------------------
// Enrolment + challenge sign-in
// ---------------------------------------------------------------------------
test('enrolling an authenticator app adds a second step to sign-in', async () => {
  const setup = await call(ctx, 'POST', '/api/auth/2fa/setup', {
    token: superAdmin.token,
    body: { method: 'TOTP' },
  });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.data.secret);
  assert.match(setup.body.data.otpauthUrl, /^otpauth:\/\/totp\//);

  const bad = await call(ctx, 'POST', '/api/auth/2fa/enable', {
    token: superAdmin.token,
    body: { method: 'TOTP', code: '000000' },
  });
  assert.equal(bad.status, 401);

  const code = generateCode(setup.body.data.secret);
  const enabled = await call(ctx, 'POST', '/api/auth/2fa/enable', {
    token: superAdmin.token,
    body: { method: 'TOTP', code },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.enabled, true);
  assert.equal(enabled.body.data.recoveryCodes.length, 8);

  const status = await call(ctx, 'GET', '/api/auth/2fa/status', { token: superAdmin.token });
  assert.equal(status.body.data.enabled, true);
  assert.equal(status.body.data.method, 'TOTP');
  assert.equal(status.body.data.recoveryCodesRemaining, 8);

  // Password alone no longer mints a session.
  const loginResponse = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.data.twoFactorRequired, true);
  assert.equal(loginResponse.body.data.method, 'TOTP');
  assert.ok(loginResponse.body.data.challengeId);
  assert.equal(loginResponse.body.data.token, undefined);

  const challengeId = loginResponse.body.data.challengeId;
  const wrongCode = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId, code: '000000' },
  });
  assert.equal(wrongCode.status, 401);

  const verified = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId, code: generateCode(setup.body.data.secret) },
  });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.data.token);

  // A challenge is single-use: replaying the consumed challenge fails.
  const replay = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId, code: generateCode(setup.body.data.secret) },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'TWO_FACTOR_EXPIRED');
});

test('a recovery code completes sign-in and is spent after use', async () => {
  const regenerated = await call(ctx, 'POST', '/api/auth/2fa/recovery-codes', {
    token: superAdmin.token,
    body: { password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(regenerated.status, 200);
  const [recoveryCode] = regenerated.body.data.recoveryCodes;
  assert.ok(recoveryCode);

  const first = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  const accepted = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId: first.body.data.challengeId, code: recoveryCode },
  });
  assert.equal(accepted.status, 200);

  // The same recovery code cannot be used twice.
  const second = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  const spent = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId: second.body.data.challengeId, code: recoveryCode },
  });
  assert.equal(spent.status, 401);
});

test('the owner can disable two-factor with password proof', async () => {
  const wrong = await call(ctx, 'POST', '/api/auth/2fa/disable', {
    token: superAdmin.token,
    body: { password: 'nope' },
  });
  assert.equal(wrong.status, 401);

  const off = await call(ctx, 'POST', '/api/auth/2fa/disable', {
    token: superAdmin.token,
    body: { password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.enabled, false);

  // Single-factor sign-in is restored.
  const loginResponse = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.data.twoFactorRequired, undefined);
  assert.ok(loginResponse.body.data.token);
});

// ---------------------------------------------------------------------------
// Email one-time codes (no SMTP in tests: codes land on the console)
// ---------------------------------------------------------------------------
test('email one-time codes work for enrolment and sign-in challenges', async () => {
  const ownerId = ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(SUPER_ADMIN_EMAIL).id;
  const hash = (code) => crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');

  // Begin email enrolment; delivery falls back to the server console.
  const setup = await call(ctx, 'POST', '/api/auth/2fa/setup', {
    token: superAdmin.token,
    body: { method: 'EMAIL' },
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.data.method, 'EMAIL');
  assert.equal(setup.body.data.delivered, false);
  assert.equal(setup.body.data.channel, 'console');

  // Plant the exact code the operator copied from the console. Set a newer
  // `created_at` explicitly so it outranks the setup-generated random code.
  ctx.db
    .prepare(
      `INSERT INTO email_otp_codes (id, user_id, code_hash, purpose, expires_at, created_at)
       VALUES (?, ?, ?, 'ENROLL_2FA', datetime('now', '+10 minutes'), datetime('now', '+1 minute'))`,
    )
    .run(crypto.randomUUID(), ownerId, hash('482913'));

  const enabled = await call(ctx, 'POST', '/api/auth/2fa/enable', {
    token: superAdmin.token,
    body: { method: 'EMAIL', code: '482913' },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.method, 'EMAIL');
  assert.equal(enabled.body.data.enabled, true);

  // A subsequent sign-in issues an EMAIL challenge instead of a session.
  const loginResponse = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(loginResponse.body.data.method, 'EMAIL');
  assert.equal(loginResponse.body.data.delivered, false);
  const challengeId = loginResponse.body.data.challengeId;

  ctx.db
    .prepare(
      `INSERT INTO email_otp_codes (id, user_id, code_hash, purpose, expires_at, created_at)
       VALUES (?, ?, ?, 'LOGIN_2FA', datetime('now', '+10 minutes'), datetime('now', '+1 minute'))`,
    )
    .run(crypto.randomUUID(), ownerId, hash('770214'));

  const verified = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId, code: '770214' },
  });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.data.token);

  // Wrong emailed code on a fresh challenge is rejected.
  const login2 = await call(ctx, 'POST', '/api/auth/login', {
    body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ROTATED_PASSWORD },
  });
  const rejected = await call(ctx, 'POST', '/api/auth/2fa/verify', {
    body: { challengeId: login2.body.data.challengeId, code: '000000' },
  });
  assert.equal(rejected.status, 401);

  // Turn it back off so the remaining run stays single-factor.
  const off = await call(ctx, 'POST', '/api/auth/2fa/disable', {
    token: superAdmin.token,
    body: { password: SUPER_ROTATED_PASSWORD },
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.enabled, false);
});
