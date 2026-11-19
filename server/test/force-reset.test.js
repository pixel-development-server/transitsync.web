/**
 * Forced password rotation — the reworked contract.
 *
 * When an administrator demands a fresh password (or a first-login credential is
 * still pending), `POST /api/auth/login` no longer mints a gated session. It
 * HALTS with HTTP 200 and `{ success: false, requireNewPassword: true }`, handing
 * back a short-lived, single-purpose `resetToken` bound to the account and its
 * `token_version`. Nothing is reachable until the caller exchanges that token at
 * `POST /api/auth/set-new-password`, which clears the flag and revokes every
 * outstanding session. A normal credential — one with `force_password_reset = 0`
 * — is completely unaffected and still signs in with a real token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer,
  call,
  login,
  loginAdmin,
  roleIdOf,
  ROLE_KEYS,
} from './support/harness.js';

// Satisfies the password policy and shares no substring with the fixture emails
// or display names used below.
const NEW_PASSWORD = 'Quartz7Falcon!Lantana';
const SUBJECT_TEMP = 'Forced7Reset!2026';

let ctx;
let admin;

test.before(async () => {
  ctx = await bootServer();
  admin = await loginAdmin(ctx);
});

test.after(async () => {
  await ctx?.close();
});

/** Create a staff account whose first sign-in must rotate the credential. */
async function createForcedSubject(tag) {
  const email = `forced-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'Forced Reset Subject',
      roleId: await roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
      temporaryPassword: SUBJECT_TEMP,
      forcePasswordChange: true,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { email, userId: created.body.data.user.id };
}

/** Create an ordinary staff account that signs in with a live session. */
async function createActiveSubject(tag, password) {
  const email = `active-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@transitsync.edu.np`;
  const created = await call(ctx, 'POST', '/api/users', {
    token: admin.token,
    body: {
      email,
      fullName: 'Regular Staffer',
      roleId: await roleIdOf(ctx, ROLE_KEYS.TRANSPORT_STAFF),
      temporaryPassword: password,
      forcePasswordChange: false,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { email, userId: created.body.data.user.id };
}

const haltLogin = (email, password) =>
  call(ctx, 'POST', '/api/auth/login', { body: { email, password } });

const setNewPassword = (email, resetToken, newPassword = NEW_PASSWORD) =>
  call(ctx, 'POST', '/api/auth/set-new-password', {
    body: { email, resetToken, newPassword, confirmPassword: newPassword },
  });

test('a forced-reset sign-in halts and returns a reset token instead of a session', async () => {
  const subject = await createForcedSubject('halt');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);

  assert.equal(halt.status, 200, JSON.stringify(halt.body));
  assert.equal(halt.body.success, false);
  assert.equal(halt.body.requireNewPassword, true);
  assert.equal(halt.body.data.mustChangePassword, true);
  assert.equal(halt.body.data.email, subject.email);
  assert.equal(typeof halt.body.data.resetToken, 'string');
  assert.ok(halt.body.data.resetToken.length > 20);
  // No session is minted while the reset is outstanding.
  assert.equal(halt.body.data.token, undefined);

  const live = (
    await ctx.db.get(
      'SELECT COUNT(*) AS n FROM login_sessions WHERE user_id = ? AND revoked_at IS NULL',
      subject.userId,
    )
  ).n;
  assert.equal(live, 0);
});

test('the reset token cannot be used as a session bearer', async () => {
  const subject = await createForcedSubject('bearer');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);

  const dashboard = await call(ctx, 'GET', '/api/dashboard', { token: halt.body.data.resetToken });
  assert.equal(dashboard.status, 401);
  assert.equal(dashboard.body.error.code, 'TOKEN_INVALID');
});

test('setting a new password clears the gate and the new credential signs in', async () => {
  const subject = await createForcedSubject('rotate');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);

  const set = await setNewPassword(subject.email, halt.body.data.resetToken);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.success, true);
  assert.equal(set.body.data.email, subject.email);
  assert.equal(set.body.data.mustChangePassword, false);

  const session = await login(ctx, subject.email, NEW_PASSWORD);
  assert.equal(typeof session.token, 'string');
  assert.equal(session.mustChangePassword, false);

  const dashboard = await call(ctx, 'GET', '/api/dashboard', { token: session.token });
  assert.equal(dashboard.status, 200);

  const row = await ctx.db.get(
    'SELECT force_password_reset, is_first_login, password_changed FROM users WHERE id = ?',
    subject.userId,
  );
  assert.equal(row.force_password_reset, 0);
  assert.equal(row.is_first_login, 0);
  assert.equal(row.password_changed, 1);
});

test('the old password no longer authenticates after a forced reset', async () => {
  const subject = await createForcedSubject('oldpass');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);
  const set = await setNewPassword(subject.email, halt.body.data.resetToken);
  assert.equal(set.status, 200, JSON.stringify(set.body));

  const old = await haltLogin(subject.email, SUBJECT_TEMP);
  assert.equal(old.status, 401);
  assert.equal(old.body.error.code, 'INVALID_CREDENTIALS');
});

test('a consumed reset token cannot be replayed', async () => {
  const subject = await createForcedSubject('replay');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);
  const resetToken = halt.body.data.resetToken;

  const first = await setNewPassword(subject.email, resetToken);
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const replay = await setNewPassword(subject.email, resetToken, 'Lantana7!QuartzFalcon');
  assert.equal(replay.status, 403);
  assert.equal(replay.body.error.code, 'RESET_TOKEN_INVALID');
});

test('a reset token is bound to the account it was issued for', async () => {
  const issuer = await createForcedSubject('bind-a');
  const other = await createForcedSubject('bind-b');
  const halt = await haltLogin(issuer.email, SUBJECT_TEMP);

  // Presented with the wrong email the token is refused...
  const crossed = await setNewPassword(other.email, halt.body.data.resetToken);
  assert.equal(crossed.status, 403);
  assert.equal(crossed.body.error.code, 'RESET_TOKEN_INVALID');

  // ...and a failed attempt does not consume it for the true owner.
  const valid = await setNewPassword(issuer.email, halt.body.data.resetToken);
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test('a garbage reset token is refused', async () => {
  const subject = await createForcedSubject('garbage');
  const attempt = await setNewPassword(subject.email, 'not-a-real-reset-token');

  assert.equal(attempt.status, 403);
  assert.equal(attempt.body.error.code, 'RESET_TOKEN_INVALID');
});

test('a weak replacement password is refused with per-rule feedback', async () => {
  const subject = await createForcedSubject('weak');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);

  const weak = await setNewPassword(subject.email, halt.body.data.resetToken, 'weak');
  assert.equal(weak.status, 422);
  assert.equal(weak.body.error.code, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(weak.body.error.details));
  assert.ok(weak.body.error.details.length > 0);
  assert.ok(weak.body.error.details.every((detail) => detail.field === 'newPassword'));
});

test('an administrator forcing a reset revokes the live session, issues a temporary password, and halts the next sign-in', async () => {
  const password = 'Live7Session!2026';
  const subject = await createActiveSubject('revoke', password);

  // A normal credential signs in cleanly and its token reaches a protected route.
  const live = await login(ctx, subject.email, password);
  assert.equal(typeof live.token, 'string');
  assert.equal(live.mustChangePassword, false);
  const before = await call(ctx, 'GET', '/api/dashboard', { token: live.token });
  assert.equal(before.status, 200);

  const forced = await call(ctx, 'POST', `/api/users/${subject.userId}/force-password-reset`, {
    token: admin.token,
  });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.equal(forced.body.data.user.forcePasswordReset, true);

  // The administrator is handed a one-time temporary password to pass on, so a
  // holder who has forgotten the old credential is never locked out.
  const temporaryPassword = forced.body.data.temporaryPassword;
  assert.equal(typeof temporaryPassword, 'string');
  assert.ok(temporaryPassword.length >= 6);

  // The previously issued session is dead the moment the reset lands.
  const stale = await call(ctx, 'GET', '/api/dashboard', { token: live.token });
  assert.equal(stale.status, 401);

  // The old credential is dead too...
  const old = await haltLogin(subject.email, password);
  assert.equal(old.status, 401);
  assert.equal(old.body.error.code, 'INVALID_CREDENTIALS');

  // ...and the temporary one halts with a reset token rather than a session.
  const halt = await haltLogin(subject.email, temporaryPassword);
  assert.equal(halt.status, 200, JSON.stringify(halt.body));
  assert.equal(halt.body.requireNewPassword, true);
  assert.equal(typeof halt.body.data.resetToken, 'string');
  assert.equal(halt.body.data.token, undefined);
});

test('an account that is not under a forced reset cannot be reset through this endpoint', async () => {
  const subject = await createForcedSubject('nogate');
  const halt = await haltLogin(subject.email, SUBJECT_TEMP);
  const resetToken = halt.body.data.resetToken;

  // Clear the flag out-of-band while leaving token_version untouched, so the
  // only reason to refuse is that the account is not actually under a reset.
  await ctx.db.run('UPDATE users SET force_password_reset = 0 WHERE id = ?', subject.userId);

  const attempt = await setNewPassword(subject.email, resetToken);
  assert.equal(attempt.status, 403);
  assert.equal(attempt.body.error.code, 'RESET_TOKEN_INVALID');
});
