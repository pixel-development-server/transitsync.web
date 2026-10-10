import express from 'express';
import rateLimit from 'express-rate-limit';

import config from '../config/env.js';
import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { hashPassword, verifyPassword, checkPasswordPolicy, isPasswordSet } from '../lib/password.js';
import { issueAccessToken, newSessionId, tokenExpiry } from '../lib/tokens.js';
import AppError, { unauthorized, badRequest, conflict, accountLocked, unprocessable } from '../lib/errors.js';
import { parseSqliteDate, parseDurationMs } from '../lib/time.js';
import { requireAuth } from '../middleware/auth.js';
import { loadUserForAuth, requiresPasswordChange } from '../services/permissions.js';
import { recordAudit, clientIp } from '../services/audit.js';
import { ROLE_KEYS } from '../db/permissions.js';
import {
  loginSchema,
  checkEmailSchema,
  setFirstPasswordSchema,
  setupSchema,
  changePasswordSchema,
  updateProfileSchema,
} from '../validation/schemas.js';

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Brute-force protection — keyed by IP + submitted email.
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: config.limits.loginWindowMs,
  max: config.limits.loginMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // The RBAC suite signs in dozens of times; throttling would mask real results.
  skip: () => config.isTest,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a few minutes.' },
  },
});

/**
 * Protection for the account-probe endpoints behind the two-step sign-in.
 *
 * Unlike `loginLimiter` this counts successes too, because a *successful*
 * `check-email` is precisely the account-enumeration signal we are throttling.
 */
const probeLimiter = rateLimit({
  windowMs: config.limits.loginWindowMs,
  max: config.limits.probeMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isTest,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicUser(user, extras = {}) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    phone: user.phone,
    department: user.department,
    jobTitle: user.job_title,
    status: user.status,
    role: user.role_key ?? null,
    roleName: user.role_name ?? null,
    roleLevel: user.role_level ?? null,
    permissions: user.permissions ?? [],
    permissionsMode: user.permissions_mode ?? 'INHERIT',
    isFirstLogin: Boolean(user.is_first_login),
    passwordChanged: Boolean(user.password_changed),
    forcePasswordReset: Boolean(user.force_password_reset),
    mustChangePassword: requiresPasswordChange(user),
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    ...extras,
  };
}

function parseDevice(userAgent = '') {
  const ua = String(userAgent);
  const browser =
    /edg\//i.test(ua) ? 'Edge'
    : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari'
    : 'Browser';
  const platform =
    /windows/i.test(ua) ? 'Windows'
    : /mac os x|macintosh/i.test(ua) ? 'macOS'
    : /android/i.test(ua) ? 'Android'
    : /iphone|ipad|ios/i.test(ua) ? 'iOS'
    : /linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  return `${browser} on ${platform}`;
}

function createSession(db, user, req, { remember }) {
  const sessionId = newSessionId();
  const configuredTtlMs = parseDurationMs(config.jwt.expiresIn, 8 * 60 * 60 * 1000);
  const ttlMs = remember ? 30 * 24 * 60 * 60 * 1000 : configuredTtlMs;

  db.prepare(
    `INSERT INTO login_sessions (id, user_id, ip, user_agent, device, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
  ).run(
    sessionId,
    user.id,
    clientIp(req),
    String(req.headers['user-agent'] ?? '').slice(0, 400),
    parseDevice(req.headers['user-agent']),
    `+${Math.round(ttlMs / 1000)} seconds`,
  );

  const token = issueAccessToken({
    userId: user.id,
    email: user.email,
    roleKey: user.role_key,
    tokenVersion: user.token_version,
    sessionId,
  });

  return { token, sessionId, expiresAt: tokenExpiry(token) };
}

function setAuthCookie(req, res, token, expiresAt) {
  res.cookie(config.jwt.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Mark the cookie `Secure` only when this request actually arrived over TLS,
    // instead of keying it off NODE_ENV. An internal console reached over plain
    // HTTP (a LAN address or a Tailscale machine name) would otherwise have its
    // session cookie silently dropped by the browser and sign-in would loop.
    // Behind an HTTPS reverse proxy, `trust proxy` makes req.secure true.
    secure: req.secure,
    expires: new Date(expiresAt),
    path: '/',
  });
}

function systemIsBootstrapped(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = ?`,
    )
    .get(ROLE_KEYS.SYSTEM_ADMIN);
  return row.n > 0;
}

// ---------------------------------------------------------------------------
// Public bootstrap endpoints
// ---------------------------------------------------------------------------

/** Drives the first-run wizard: "needs setup?" vs "sign in". */
router.get(
  '/setup-status',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const meta = db.prepare("SELECT value FROM system_meta WHERE key = 'institution_name'").get();
    res.json({
      success: true,
      data: {
        bootstrapped: systemIsBootstrapped(db),
        institutionName: meta?.value ?? 'TransitSync',
        bootstrapEmail: config.bootstrap.email,
        passwordPolicy: {
          minLength: config.password.minLength,
          requiresUppercase: true,
          requiresLowercase: true,
          requiresNumber: true,
          requiresSymbol: true,
        },
      },
    });
  }),
);

/**
 * One-shot initialisation. Only accepted while no System Administrator exists,
 * so it cannot be used to hijack an installed system.
 */
router.post(
  '/setup',
  loginLimiter,
  validate(setupSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    if (systemIsBootstrapped(db)) {
      throw conflict('TransitSync is already initialised. Sign in with your administrator account.');
    }

    const { email, password, confirmPassword, fullName, institution, phone } = req.body;
    if (password !== confirmPassword) throw unprocessable('Passwords do not match.', [{ field: 'confirmPassword', message: 'Passwords do not match' }]);

    const policy = checkPasswordPolicy(password, { email, fullName });
    if (!policy.valid) throw unprocessable('Password does not meet the policy.', policy.errors.map((message) => ({ field: 'password', message })));

    const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(ROLE_KEYS.SYSTEM_ADMIN);
    const passwordHash = await hashPassword(password);

    const result = db
      .prepare(
        `INSERT INTO users
           (email, full_name, password_hash, phone, job_title, department, role_id,
            is_first_login, password_changed, force_password_reset, permissions_mode)
         VALUES (?, ?, ?, ?, 'System Administrator', 'Administration', ?, 0, 1, 0, 'INHERIT')`,
      )
      .run(email, fullName, passwordHash, phone ?? null, role.id);

    db.prepare("INSERT OR REPLACE INTO system_meta (key, value, updated_at) VALUES ('institution_name', ?, datetime('now'))").run(institution);
    db.prepare("INSERT OR REPLACE INTO system_meta (key, value, updated_at) VALUES ('initialised_at', datetime('now'), datetime('now'))").run();

    recordAudit({ userId: Number(result.lastInsertRowid), actorEmail: email, action: 'system.setup', entity: 'system', ip: clientIp(req) });

    const user = loadUserForAuth(db, Number(result.lastInsertRowid));
    const session = createSession(db, user, req, { remember: false });
    setAuthCookie(req, res, session.token, session.expiresAt);

    res.status(201).json({
      success: true,
      data: { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) },
    });
  }),
);

/** Live password-policy feedback for the setup / change-password screens. */
router.post(
  '/password-policy',
  asyncHandler(async (req, res) => {
    const { password, email, fullName } = req.body ?? {};
    const result = checkPasswordPolicy(password, { email, fullName });
    res.json({
      success: true,
      data: {
        ...result,
        minLength: config.password.minLength,
        requirements: [
          `At least ${config.password.minLength} characters`,
          'One uppercase letter',
          'One lowercase letter',
          'One number',
          'One symbol',
          'Not a commonly used password',
        ],
      },
    });
  }),
);

router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { email, password, remember } = req.body;
    const ip = clientIp(req);

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    const fail = (message, code = 'INVALID_CREDENTIALS', status = 401) => {
      if (row) {
        const attempts = row.failed_login_count + 1;
        const locked = attempts >= MAX_FAILED_ATTEMPTS;
        db.prepare(
          `UPDATE users SET failed_login_count = ?,
                            locked_until = CASE WHEN ? THEN datetime('now', ?) ELSE locked_until END
            WHERE id = ?`,
        ).run(attempts, locked ? 1 : 0, `+${LOCK_MINUTES} minutes`, row.id);
      }
      recordAudit({ userId: row?.id ?? null, actorEmail: email, action: 'auth.login', ip, status: 'failure' });
      const error = new Error(message);
      error.status = status;
      error.code = code;
      throw error;
    };

    if (!row) fail('Incorrect email or password.');

    const lockedUntil = parseSqliteDate(row.locked_until);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
      throw accountLocked(`Account locked after repeated failed attempts. Try again in ${minutes} minute(s).`);
    }
    if (row.status !== 'active') {
      recordAudit({ userId: row.id, actorEmail: email, action: 'auth.login', ip, status: 'denied' });
      throw unauthorized(
        row.status === 'suspended'
          ? 'This account has been suspended. Contact your System Administrator.'
          : 'This account has not been activated yet.',
        'ACCOUNT_INACTIVE',
      );
    }

    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) fail('Incorrect email or password.');

    const user = db
      .prepare(
        `SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level
           FROM users u LEFT JOIN roles r ON r.id = u.role_id
          WHERE u.id = ?`,
      )
      .get(row.id);

    const session = createSession(db, user, req, { remember });
    setAuthCookie(req, res, session.token, session.expiresAt);

    db.prepare(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL,
                        last_login_at = datetime('now'), last_login_ip = ? WHERE id = ?`,
    ).run(ip, row.id);
    // `is_first_login` is deliberately NOT cleared here. It is cleared by the
    // password change itself, so an admin can still see accounts that signed in
    // but never rotated. The forced-change gate is unaffected because
    // `requiresPasswordChange` also tests `password_changed`.

    recordAudit({ userId: row.id, actorEmail: email, action: 'auth.login', ip });

    const principal = loadUserForAuth(db, row.id);
    res.json({
      success: true,
      data: {
        token: session.token,
        expiresAt: session.expiresAt,
        sessionId: session.sessionId,
        mustChangePassword: requiresPasswordChange(principal),
        user: publicUser(principal),
      },
    });
  }),
);

/**
 * Step 1 of the two-step sign-in.
 *
 * Public by design: the caller answers "does this account exist, does it still
 * need a password, and is it locked out?" before offering any credential.
 * Rate-limited because it would otherwise be a clean account-enumeration
 * oracle.
 *
 * Response contract (mirrors the front-end's Step 1 handling):
 *   404 { status: 'NOT_FOUND' }            — no such account
 *   403 { status: 'ACCOUNT_SUSPENDED' }    — account exists but is suspended
 *   200 { status: 'FIRST_TIME_USER' }      — no password yet; offer setup
 *   200 { status: 'EXISTS_WITH_PASSWORD' } — offer the password field
 *
 * The reserved bootstrap/`invited` states are the only ones that resolve to
 * FIRST_TIME_USER. A suspended account is rejected *before* the first-time
 * check so a locked-out account can never reach the password-setup step.
 */
router.post(
  '/check-email',
  probeLimiter,
  validate(checkEmailSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { email } = req.body;
    const ip = clientIp(req);
    const row = db
      .prepare('SELECT id, email, full_name, status, password_hash FROM users WHERE email = ?')
      .get(email);

    if (!row) {
      throw new AppError(404, 'No staff account found with this email address.', { code: 'NOT_FOUND' });
    }

    if (row.status === 'suspended') {
      recordAudit({ userId: row.id, actorEmail: email, action: 'auth.check_email', ip, status: 'denied' });
      throw new AppError(403, 'This account is suspended. Contact your System Administrator.', {
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    // Note: an account carrying a one-time *temporary* password (with
    // `force_password_reset`) is intentionally NOT a first-time user. It already
    // holds a credential, so its holder signs in with it and is rotated to their
    // own password afterwards — that keeps a known email alone insufficient to
    // claim the account.
    const firstTime = !isPasswordSet(row.password_hash) || row.status === 'invited';

    return res.json({
      success: true,
      data: {
        status: firstTime ? 'FIRST_TIME_USER' : 'EXISTS_WITH_PASSWORD',
        exists: true,
        email: row.email,
        name: row.full_name,
        message: firstTime ? 'First-time setup required.' : undefined,
      },
    });
  }),
);

/**
 * Step 2b of the two-step sign-in: an administrator created the account but its
 * owner has never chosen a password, so this is the "claim" step.
 *
 * Security posture: unreachable for any account that already holds a password
 * or is suspended, rate-limited through `probeLimiter`, and audited. It still
 * rests on knowing a valid staff email — the residual risk of a passwordless
 * invite with no email channel — so the account is deliberately created in the
 * `invited` state and can only be claimed until it is activated.
 */
router.post(
  '/set-first-password',
  probeLimiter,
  validate(setFirstPasswordSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { email, password } = req.body;
    const ip = clientIp(req);

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      recordAudit({ actorEmail: email, action: 'auth.first_password_set', ip, status: 'failure' });
      throw badRequest('This invitation is no longer valid. Ask your administrator to resend it.');
    }
    if (row.status === 'suspended') {
      throw unauthorized('This account has been suspended. Contact your System Administrator.', 'ACCOUNT_INACTIVE');
    }
    if (isPasswordSet(row.password_hash)) {
      throw conflict('This account already has a password. Sign in instead.');
    }

    const policy = checkPasswordPolicy(password, { email: row.email, fullName: row.full_name });
    if (!policy.valid) {
      throw unprocessable(
        'Password does not meet the policy.',
        policy.errors.map((message) => ({ field: 'password', message })),
      );
    }

    const passwordHash = await hashPassword(password);
    db.prepare(
      `UPDATE users SET
         password_hash        = ?,
         status               = 'active',
         is_first_login       = 0,
         password_changed     = 1,
         force_password_reset = 0,
         last_password_change = datetime('now'),
         failed_login_count   = 0,
         locked_until         = NULL,
         token_version        = token_version + 1,
         updated_at           = datetime('now')
       WHERE id = ?`,
    ).run(passwordHash, row.id);

    recordAudit({
      userId: row.id,
      actorEmail: email,
      action: 'auth.first_password_set',
      entity: 'user',
      entityId: row.id,
      ip,
    });

    const user = loadUserForAuth(db, row.id);
    const session = createSession(db, user, req, { remember: false });
    setAuthCookie(req, res, session.token, session.expiresAt);

    res.status(201).json({
      success: true,
      data: {
        token: session.token,
        expiresAt: session.expiresAt,
        sessionId: session.sessionId,
        mustChangePassword: false,
        user: publicUser(user),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Authenticated endpoints (reachable while a password rotation is pending)
// ---------------------------------------------------------------------------

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const overrides = db
      .prepare(
        `SELECT p.key, up.effect FROM user_permissions up
           JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = ?`,
      )
      .all(req.user.id);

    const session = req.sessionId
      ? db.prepare('SELECT id, device, ip, created_at, last_seen_at, expires_at FROM login_sessions WHERE id = ?').get(req.sessionId)
      : null;

    res.json({
      success: true,
      data: {
        user: publicUser(req.user),
        overrides,
        session,
      },
    });
  }),
);

router.patch(
  '/profile',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { fullName, phone, department, jobTitle } = req.body;
    db.prepare(
      `UPDATE users SET
         full_name  = COALESCE(?, full_name),
         phone      = COALESCE(?, phone),
         department = COALESCE(?, department),
         job_title  = COALESCE(?, job_title),
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(fullName ?? null, phone ?? null, department ?? null, jobTitle ?? null, req.user.id);

    const updated = db
      .prepare(
        `SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level
           FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      )
      .get(req.user.id);

    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.profile_update', entity: 'user', entityId: req.user.id, ip: clientIp(req) });
    res.json({ success: true, data: { user: publicUser(loadUserForAuth(db, updated.id)) } });
  }),
);

router.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { currentPassword, newPassword, revokeOtherSessions } = req.body;

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.change_password', ip: clientIp(req), status: 'failure' });
      throw unauthorized('Your current password is incorrect.', 'INVALID_CREDENTIALS');
    }

    const policy = checkPasswordPolicy(newPassword, { email: row.email, fullName: row.full_name });
    if (!policy.valid) {
      throw unprocessable('Password does not meet the policy.', policy.errors.map((message) => ({ field: 'newPassword', message })));
    }

    const passwordHash = await hashPassword(newPassword);
    const wasRotating = requiresPasswordChange(row);

    db.transaction(() => {
      db.prepare(
        `UPDATE users SET
           password_hash       = ?,
           is_first_login      = 0,
           password_changed    = 1,
           force_password_reset = 0,
           last_password_change = datetime('now'),
           token_version       = token_version + 1,
           updated_at          = datetime('now')
         WHERE id = ?`,
      ).run(passwordHash, row.id);

      if (revokeOtherSessions) {
        db.prepare('DELETE FROM login_sessions WHERE user_id = ? AND id <> ?').run(row.id, req.sessionId ?? '');
      }
    });

    // token_version changed, so the current JWT is stale — mint a replacement
    // bound to the existing session row and hand it straight back.
    const fresh = db
      .prepare(
        `SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level
           FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      )
      .get(row.id);

    const token = issueAccessToken({
      userId: fresh.id,
      email: fresh.email,
      roleKey: fresh.role_key,
      tokenVersion: fresh.token_version,
      sessionId: req.sessionId,
    });
    const expiresAt = tokenExpiry(token);
    setAuthCookie(req, res, token, expiresAt);

    recordAudit({
      userId: row.id,
      actorEmail: row.email,
      action: wasRotating ? 'auth.first_login_password_set' : 'auth.change_password',
      entity: 'user',
      entityId: row.id,
      ip: clientIp(req),
    });

    res.json({
      success: true,
      data: { token, expiresAt, mustChangePassword: false, user: publicUser(loadUserForAuth(db, fresh.id)) },
    });
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getDb();
    if (req.sessionId) {
      db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'user_logout' WHERE id = ?").run(req.sessionId);
    }
    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.logout', ip: clientIp(req) });
    res.clearCookie(config.jwt.cookieName, { path: '/', sameSite: 'lax', secure: req.secure });
    res.json({ success: true, data: { message: 'Signed out.' } });
  }),
);

// ---------------------------------------------------------------------------
// Active sessions for the signed-in account
// ---------------------------------------------------------------------------
router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, ip, device, user_agent, created_at, last_seen_at, expires_at,
                revoked_at, revoked_reason,
                CASE WHEN id = ? THEN 1 ELSE 0 END AS is_current
           FROM login_sessions
          WHERE user_id = ?
          ORDER BY is_current DESC, last_seen_at DESC
          LIMIT 50`,
      )
      .all(req.sessionId ?? '', req.user.id);

    res.json({ success: true, data: { sessions: rows, currentSessionId: req.sessionId ?? null } });
  }),
);

router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM login_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!session) throw badRequest('Session not found.');

    db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'user_revoked' WHERE id = ?").run(req.params.id);
    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.revoke_session', entity: 'session', entityId: req.params.id, ip: clientIp(req) });
    res.json({ success: true, data: { message: 'Session revoked.' } });
  }),
);

router.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const result = db
      .prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'user_revoke_all' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL")
      .run(req.user.id, req.sessionId ?? '');
    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.revoke_all_sessions', ip: clientIp(req), detail: { revoked: result.changes } });
    res.json({ success: true, data: { revoked: result.changes } });
  }),
);

export { publicUser };
export default router;
