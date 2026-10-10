import config from '../config/env.js';
import { getDb } from '../db/connection.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { unauthorized, forbidden, passwordChangeRequired } from '../lib/errors.js';
import { isExpired } from '../lib/time.js';
import { loadUserForAuth, requiresPasswordChange } from '../services/permissions.js';

/**
 * Pull the bearer token from the request.
 *
 * Order: Authorization header -> httpOnly cookie -> `?access_token=`.
 * The query fallback exists solely for EventSource, which cannot set headers;
 * it is only consulted on the SSE stream route.
 */
export function extractToken(req) {
  const header = req.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();

  const cookieToken = req.cookies?.[config.jwt.cookieName];
  if (cookieToken) return cookieToken;

  if (typeof req.query?.access_token === 'string' && req.query.access_token) {
    return req.query.access_token;
  }
  return null;
}

/**
 * Verify the JWT *and* the backing session row, then attach a fully resolved
 * principal to `req.user`.
 *
 * Both checks matter: the signature alone would keep working after an admin
 * revoked a session or bumped the user's `token_version`.
 */
export function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(unauthorized('Authentication required.', 'NO_TOKEN'));

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return next(unauthorized('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED'));
    }
    return next(unauthorized('Invalid authentication token.', 'TOKEN_INVALID'));
  }

  const db = getDb();

  if (payload.jti) {
    const session = db.prepare('SELECT * FROM login_sessions WHERE id = ?').get(payload.jti);
    if (!session) return next(unauthorized('Session is no longer valid.', 'SESSION_REVOKED'));
    if (session.revoked_at) return next(unauthorized('Session has been signed out.', 'SESSION_REVOKED'));
    if (isExpired(session.expires_at)) {
      return next(unauthorized('Session has expired. Please sign in again.', 'SESSION_EXPIRED'));
    }
    db.prepare("UPDATE login_sessions SET last_seen_at = datetime('now') WHERE id = ?").run(payload.jti);
  }

  const user = loadUserForAuth(db, Number(payload.sub));
  if (!user) return next(unauthorized('Account no longer exists.', 'USER_MISSING'));
  if (user.status !== 'active') return next(forbidden('This account has been suspended.'));
  if (Number(user.token_version) !== Number(payload.tv ?? 0)) {
    return next(unauthorized('Credentials have been revoked. Please sign in again.', 'TOKEN_REVOKED'));
  }

  req.user = user;
  req.token = token;
  req.sessionId = payload.jti ?? null;
  return next();
}

/** Same as `authenticate` but also fails hard when no valid token was supplied. */
export function requireAuth(req, res, next) {
  return authenticate(req, res, (error) => {
    if (error) return next(error);
    return next();
  });
}

/**
 * Forced-rotation gate.
 *
 * While `is_first_login`, `password_changed = 0` or `force_password_reset` is set,
 * the account is confined to the bootstrap endpoints, which are mounted *outside*
 * this gate. That is what makes a newly invited staff member unable to reach the
 * dashboard until they choose their own password.
 */
export function requirePasswordRotated(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!requiresPasswordChange(req.user)) return next();

  return next(passwordChangeRequired());
}

export default { authenticate, requireAuth, requirePasswordRotated, extractToken };
