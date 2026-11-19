import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';

export function newSessionId() {
  return crypto.randomUUID();
}

export function issueAccessToken({ userId, email, roleKey, tokenVersion, sessionId, expiresIn }) {
  return jwt.sign(
    {
      // `sub` is the registered JWT claim for the subject; jsonwebtoken rejects
      // the payload `sub` if the `subject` option is also supplied.
      sub: String(userId),
      email,
      role: roleKey,
      tv: tokenVersion,
      jti: sessionId,
    },
    config.jwt.secret,
    {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      // A "Remember Me" session lives for 30 days in `login_sessions`, but the
      // JWT would otherwise always die at the 8h `JWT_EXPIRES_IN` default — so a
      // remembered user is silently signed out long before their DB session
      // expires. When the caller knows the session TTL it passes it here, and
      // the token `exp` is minted to match the stored `expires_at`. Callers with
      // no session row to track (e.g. a re-minted token) keep the default.
      expiresIn: expiresIn ?? config.jwt.expiresIn,
    },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
}

/** How long a forced-password-reset handoff token stays usable. */
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_PURPOSE = 'password_reset';

/**
 * Derive a distinct signing key for reset tokens.
 *
 * Signing with a key *derived* from the JWT secret (never the secret itself)
 * means `verifyAccessToken` — and therefore the whole `authenticate` middleware —
 * can never accept a reset token as a session credential, even if the payload
 * shapes were ever confused. The two token families are cryptographically
 * disjoint by construction, not by convention.
 */
function passwordResetSecret() {
  return crypto
    .createHash('sha256')
    .update(`${config.jwt.secret}:${PASSWORD_RESET_PURPOSE}`)
    .digest('hex');
}

/**
 * Mint the short-lived proof that sign-in verified a forced-reset account.
 *
 * Returned by `/auth/login` (and `/auth/2fa/verify`) *instead of* a session when
 * `force_password_reset` is set. It carries the account's `token_version`, so a
 * rotation — or a second admin reset — instantly voids any token still in
 * flight.
 */
export function issuePasswordResetToken({ userId, email, tokenVersion }) {
  return jwt.sign(
    { sub: String(userId), email, tv: tokenVersion, purpose: PASSWORD_RESET_PURPOSE },
    passwordResetSecret(),
    {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      expiresIn: '15m',
    },
  );
}

/** Verify a reset token; returns the payload, or `null` for anything invalid. */
export function verifyPasswordResetToken(token) {
  try {
    const payload = jwt.verify(token, passwordResetSecret(), {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
    if (payload.purpose !== PASSWORD_RESET_PURPOSE) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Decode without verifying — only used to surface an expiry time on logout. */
export function decodeToken(token) {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
}

export function tokenExpiry(token) {
  const payload = decodeToken(token);
  if (!payload?.exp) return new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return new Date(payload.exp * 1000).toISOString();
}

export function randomSerial(prefix = 'RF') {
  const block = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${block()}${block()}`;
}

export default {
  issueAccessToken,
  verifyAccessToken,
  tokenExpiry,
  newSessionId,
  randomSerial,
  issuePasswordResetToken,
  verifyPasswordResetToken,
  PASSWORD_RESET_TTL_MS,
};
