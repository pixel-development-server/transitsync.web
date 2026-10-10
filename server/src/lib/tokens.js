import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';

export function newSessionId() {
  return crypto.randomUUID();
}

export function issueAccessToken({ userId, email, roleKey, tokenVersion, sessionId }) {
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
      expiresIn: config.jwt.expiresIn,
    },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
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

export default { issueAccessToken, verifyAccessToken, tokenExpiry, newSessionId, randomSerial };
