import crypto from 'node:crypto';

import { SUPER_ADMIN_LEVEL } from '../db/permissions.js';
import { verifyCode } from '../lib/totp.js';
import { sendMail } from './mailer.js';

/**
 * Platform-owner second factor.
 *
 * Scope is deliberately narrow: only the Level 200 Super Administrator is ever
 * challenged. Campus identities keep the existing single-factor flow, so this
 * cannot lock a campus out of its own console.
 *
 * The sign-in second step is modelled as a short-lived, single-use row in
 * `login_challenges` rather than a signed token. A row can be consumed exactly
 * once and carries an attempt counter, so a stolen challenge id is worth at most
 * a handful of guesses before it is burned — properties a stateless JWT lacks.
 */

const CHALLENGE_TTL_MINUTES = 5;
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 6;
const RECOVERY_CODE_COUNT = 8;

/** Only the platform owner carries a second factor. */
export function isTwoFactorSubject(user) {
  return Number(user?.role_level) >= SUPER_ADMIN_LEVEL;
}

export function twoFactorEnabled(user) {
  return Boolean(user?.two_factor_enabled) && Boolean(user?.two_factor_method);
}

export function maskEmail(email) {
  const [local, domain] = String(email ?? '').split('@');
  if (!domain) return 'your email';
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------
/** Crockford-ish alphabet: no I/L/O/0/1 so codes survive being read aloud. */
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = crypto.randomBytes(8);
    let block = '';
    for (const byte of bytes) block += alphabet[byte % alphabet.length];
    codes.push(`${block.slice(0, 4)}-${block.slice(4)}`);
  }
  return codes;
}

export async function storeRecoveryCodes(db, userId, codes) {
  const payload = codes.map((code) => ({ h: hashCode(code), u: null }));
  await db.run("UPDATE users SET recovery_codes = ?, updated_at = NOW() WHERE id = ?", JSON.stringify(payload), userId);
}

export function remainingRecoveryCodes(user) {
  try {
    return JSON.parse(user.recovery_codes || '[]').filter((entry) => !entry.u).length;
  } catch {
    return 0;
  }
}

/** Single-use: a matching unused code is marked used as it is accepted. */
export async function consumeRecoveryCode(db, user, code) {
  let entries;
  try {
    entries = JSON.parse(user.recovery_codes || '[]');
  } catch {
    return false;
  }
  const target = hashCode(code);
  const entry = entries.find((candidate) => !candidate.u && candidate.h === target);
  if (!entry) return false;

  entry.u = new Date().toISOString();
  await db.run("UPDATE users SET recovery_codes = ?, updated_at = NOW() WHERE id = ?", JSON.stringify(entries), user.id);
  return true;
}

// ---------------------------------------------------------------------------
// Login challenges
// ---------------------------------------------------------------------------
export async function createChallenge(db, user, { method, remember = false, ip = null, userAgent = null, device = null } = {}) {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO login_challenges (id, user_id, method, remember, ip, user_agent, device, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    id, user.id, method, remember ? 1 : 0, ip, userAgent, device, CHALLENGE_TTL_MINUTES,
  );
  return getChallenge(db, id);
}

export async function getChallenge(db, id) {
  if (!id) return null;
  return db.get(
    `SELECT * FROM login_challenges
      WHERE id = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    id,
  );
}

export async function consumeChallenge(db, id) {
  await db.run("UPDATE login_challenges SET consumed_at = NOW() WHERE id = ?", id);
}

/** Count a bad guess; burn the challenge once the budget is spent. */
export async function recordChallengeFailure(db, id) {
  const row = await db.get('SELECT attempts FROM login_challenges WHERE id = ?', id);
  if (!row) return;
  const attempts = row.attempts + 1;
  await db.run(
    attempts >= MAX_ATTEMPTS
      ? 'UPDATE login_challenges SET attempts = ?, consumed_at = NOW() WHERE id = ?'
      : 'UPDATE login_challenges SET attempts = ?, consumed_at = NULL WHERE id = ?',
    attempts,
    id,
  );
}

// ---------------------------------------------------------------------------
// Email one-time codes
// ---------------------------------------------------------------------------
export async function issueEmailOtp(db, user, { purpose = 'LOGIN_2FA' } = {}) {
  // Invalidate any outstanding code for this purpose so only the newest works.
  await db.run(
    "UPDATE email_otp_codes SET consumed_at = NOW() WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL",
    user.id, purpose,
  );

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.run(
    `INSERT INTO email_otp_codes (id, user_id, code_hash, purpose, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    crypto.randomUUID(), user.id, hashCode(code), purpose, OTP_TTL_MINUTES,
  );

  const result = await sendMail({
    to: user.email,
    subject: 'Your TransitSync verification code',
    text:
      `Your TransitSync verification code is ${code}.\n\n` +
      `It expires in ${OTP_TTL_MINUTES} minutes. If you did not try to sign in, ` +
      'change your password immediately.',
  });
  return { ...result, ttlMinutes: OTP_TTL_MINUTES };
}

export async function verifyEmailOtp(db, userId, code, purpose = 'LOGIN_2FA') {
  const row = await db.get(
    `SELECT * FROM email_otp_codes
      WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    userId, purpose,
  );
  if (!row) return false;

  if (row.code_hash !== hashCode(code)) {
    await db.run('UPDATE email_otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return false;
  }

  await db.run("UPDATE email_otp_codes SET consumed_at = NOW() WHERE id = ?", row.id);
  return true;
}

/** TOTP, email code, or a one-time recovery code. */
export async function verifyChallengeCode(db, user, challenge, code) {
  if (challenge.method === 'TOTP') {
    if (verifyCode(user.totp_secret, code)) return { ok: true, via: 'TOTP' };
    if (await consumeRecoveryCode(db, user, code)) return { ok: true, via: 'RECOVERY_CODE' };
    return { ok: false };
  }
  if (challenge.method === 'EMAIL') {
    return (await verifyEmailOtp(db, user.id, code)) ? { ok: true, via: 'EMAIL' } : { ok: false };
  }
  return { ok: false };
}

/** Housekeeping — drop challenges and codes that can no longer be used. */
export async function purgeExpired(db) {
  await db.run("DELETE FROM login_challenges WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");
  await db.run("DELETE FROM email_otp_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");
}

export default {
  isTwoFactorSubject,
  twoFactorEnabled,
  maskEmail,
  generateRecoveryCodes,
  storeRecoveryCodes,
  remainingRecoveryCodes,
  consumeRecoveryCode,
  createChallenge,
  getChallenge,
  consumeChallenge,
  recordChallengeFailure,
  issueEmailOtp,
  verifyEmailOtp,
  verifyChallengeCode,
  purgeExpired,
};
