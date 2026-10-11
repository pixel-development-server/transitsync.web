import config from '../config/env.js';
import { getDb } from '../db/connection.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { unauthorized, forbidden, passwordChangeRequired, serviceLocked, maintenanceMode } from '../lib/errors.js';
import { isExpired } from '../lib/time.js';
import { loadUserForAuth, requiresPasswordChange } from '../services/permissions.js';
import { getInstitutionMaintenance, isExemptFromInstitutionMaintenance, institutionMaintenanceRejection } from '../services/maintenance.js';
import { SUPER_ADMIN_LEVEL } from '../db/permissions.js';

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

  if (isLockedOut(user)) {
    return next(serviceLocked());
  }

  // Tenant-scoped maintenance gate (migration 008). When the user's own campus
  // is under maintenance, their session is frozen with a 503 — unless they are
  // the Level 200 platform owner or that campus's own Level 100 System
  // Administrator, who must stay in to manage the window and switch it off.
  // Other institutions are completely unaffected: the check only ever looks at
  // the requester's own tenant_id.
  const campusMaintenance = user.tenant_id ? getInstitutionMaintenance(db, user.tenant_id) : null;
  if (campusMaintenance?.isMaintenanceMode && !isExemptFromInstitutionMaintenance(user, campusMaintenance)) {
    return next(maintenanceMode(institutionMaintenanceRejection(campusMaintenance)));
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

/** Master-only gate: only the Level 100 System Administrator may pass. */
export function requireSystemAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role_key === 'system_admin') return next();
  return next(
    forbidden('This facility is reserved for the System Administrator.', {
      code: 'SYSTEM_ADMIN_ONLY',
    }),
  );
}

/**
 * Platform-owner gate: only a Level 200 Super Administrator may pass. Used by
 * college provisioning and the global maintenance switch.
 */
export function requireSuperAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (Number(req.user.role_level) >= SUPER_ADMIN_LEVEL) return next();
  return next(
    forbidden('This platform facility is reserved for the Super Administrator.', {
      code: 'SUPER_ADMIN_ONLY',
    }),
  );
}

/**
 * Rider-portal gate: only a Level 1 `student` principal may pass. The portal is
 * gated by role rather than permission because a student intentionally holds no
 * staff permissions at all.
 */
export function requireStudent(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role_key === 'student') return next();
  return next(
    forbidden('This portal is reserved for students.', {
      code: 'STUDENT_ONLY',
    }),
  );
}

/**
 * The Global Emergency Lockout switch (settings key `system.lockdown`).
 * While engaged, every non-System-Administrator session is frozen.
 */
export function isLockedOut(user) {
  if (!user || user.role_key === 'system_admin') return false;
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'system.lockdown'").get();
    if (!row?.value) return false;
    const state = JSON.parse(row.value);
    return Boolean(state?.locked);
  } catch {
    return false;
  }
}

export default {
  authenticate,
  requireAuth,
  requirePasswordRotated,
  requireSystemAdmin,
  requireSuperAdmin,
  requireStudent,
  isLockedOut,
  extractToken,
};
