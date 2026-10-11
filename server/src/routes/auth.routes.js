import express from 'express';
import rateLimit from 'express-rate-limit';

import config from '../config/env.js';
import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { hashPassword, verifyPassword, checkPasswordPolicy, isPasswordSet } from '../lib/password.js';
import { issueAccessToken, newSessionId, tokenExpiry } from '../lib/tokens.js';
import { generateSecret, verifyCode, buildOtpAuthUrl } from '../lib/totp.js';
import AppError, { unauthorized, badRequest, conflict, accountLocked, unprocessable, maintenanceMode } from '../lib/errors.js';
import { parseSqliteDate, parseDurationMs } from '../lib/time.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { loadUserForAuth, requiresPasswordChange } from '../services/permissions.js';
import { recordAudit, clientIp } from '../services/audit.js';
import {
  isTwoFactorSubject,
  twoFactorEnabled,
  maskEmail,
  generateRecoveryCodes,
  storeRecoveryCodes,
  remainingRecoveryCodes,
  createChallenge,
  getChallenge,
  consumeChallenge,
  recordChallengeFailure,
  issueEmailOtp,
  verifyEmailOtp,
  verifyChallengeCode,
} from '../services/twoFactor.js';
import { mailDeliverable } from '../services/mailer.js';
import {
  getMaintenance,
  getInstitutionMaintenance,
  isExemptFromInstitutionMaintenance,
  institutionMaintenanceRejection,
} from '../services/maintenance.js';
import { ROLE_KEYS, SUPER_ADMIN_LEVEL } from '../db/permissions.js';
import {
  loginSchema,
  checkEmailSchema,
  setFirstPasswordSchema,
  studentCheckEmailSchema,
  studentRegisterSchema,
  setupSchema,
  changePasswordSchema,
  updateProfileSchema,
  changeEmailSchema,
  twoFactorSetupSchema,
  twoFactorEnableSchema,
  twoFactorVerifySchema,
  twoFactorResendSchema,
  twoFactorDisableSchema,
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
    institutionName: user.institution_name ?? null,
    tenantId: user.tenant_id ?? null,
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

/**
 * "Initialised" means a master account exists that can sign in. In a
 * multi-tenant deployment that is either the campus System Administrator or the
 * Level 200 Platform Super Administrator — if the latter exists, the first-run
 * wizard is skipped and campus admins arrive via college provisioning instead.
 */
function systemIsBootstrapped(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key IN (?, ?)`,
    )
    .get(ROLE_KEYS.SYSTEM_ADMIN, ROLE_KEYS.SUPER_ADMIN);
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

    const { email, password, confirmPassword, fullName, institution, phone, role: requestedRole } = req.body;
    if (password !== confirmPassword) throw unprocessable('Passwords do not match.', [{ field: 'confirmPassword', message: 'Passwords do not match' }]);

    const policy = checkPasswordPolicy(password, { email, fullName });
    if (!policy.valid) throw unprocessable('Password does not meet the policy.', policy.errors.map((message) => ({ field: 'password', message })));

    // The first master account is either the multi-campus platform owner
    // (Level 200, no tenant) or the single-campus System Administrator
    // (Level 100). The wizard lets the operator choose; the default is the
    // platform owner, which is what a multi-tenant deployment needs first and
    // what lets the operator define their own email/name rather than inheriting
    // them from the environment.
    const isPlatformOwner = requestedRole !== 'system_admin';
    const roleKey = isPlatformOwner ? ROLE_KEYS.SUPER_ADMIN : ROLE_KEYS.SYSTEM_ADMIN;
    const jobTitle = isPlatformOwner ? 'Platform Super Administrator' : 'System Administrator';
    const department = isPlatformOwner ? 'Platform' : 'Administration';

    const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
    if (!role) throw badRequest('That role is not available on this deployment.');

    const passwordHash = await hashPassword(password);

    const result = db
      .prepare(
        `INSERT INTO users
           (email, full_name, password_hash, phone, job_title, department, role_id,
            is_first_login, password_changed, force_password_reset, permissions_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 'INHERIT')`,
      )
      .run(email, fullName, passwordHash, phone ?? null, jobTitle, department, role.id);

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

    // Maintenance gates — checked before the password so a locked platform
    // leaks nothing about credential validity.
    //
    // 1) Global maintenance (platform-wide switch in `settings`) refuses every
    //    campus sign-in (role level 1–100); only the Level 200 Super
    //    Administrator bypasses, so the platform owner can disengage it.
    // 2) Institution maintenance is tenant-scoped: only sign-ins whose own
    //    campus (`institutions.is_maintenance_mode`) is under maintenance are
    //    refused — every other institution is completely unaffected. That
    //    campus's own Level 100 System Administrator is exempt so they can log
    //    in and turn the switch back off, as is the Level 200 Super Admin.
    const maintenance = getMaintenance(db);
    const role = row.role_id
      ? db.prepare('SELECT level, key FROM roles WHERE id = ?').get(row.role_id)
      : null;
    const level = role?.level ?? 0;

    if (maintenance.isMaintenanceMode && level < SUPER_ADMIN_LEVEL) {
      recordAudit({ userId: row.id, actorEmail: email, action: 'auth.login', ip, status: 'maintenance' });
      throw maintenanceMode(maintenance.message);
    }

    const campusMaintenance = getInstitutionMaintenance(db, row.tenant_id);
    if (
      campusMaintenance?.isMaintenanceMode &&
      !isExemptFromInstitutionMaintenance(
        { role_key: role?.key, role_level: level, tenant_id: row.tenant_id },
        campusMaintenance,
      )
    ) {
      recordAudit({ userId: row.id, actorEmail: email, action: 'auth.login', ip, status: 'maintenance' });
      throw maintenanceMode(institutionMaintenanceRejection(campusMaintenance));
    }

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

    // Platform-owner second factor. Only the Level 200 Super Administrator is
    // ever challenged; every other role proceeds straight to a session exactly
    // as before. The challenge is created only *after* the password is proven,
    // so an anonymous caller cannot use this branch to probe whether 2FA is on
    // for a given account.
    if (row.two_factor_enabled && row.two_factor_method && level >= SUPER_ADMIN_LEVEL) {
      const method = row.two_factor_method === 'EMAIL' ? 'EMAIL' : 'TOTP';
      const challenge = createChallenge(db, row, {
        method,
        remember: Boolean(remember),
        ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
        device: parseDevice(req.headers['user-agent']),
      });

      let delivery = null;
      if (method === 'EMAIL') delivery = await issueEmailOtp(db, row);

      db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(row.id);
      recordAudit({ userId: row.id, actorEmail: email, action: 'auth.login_2fa', ip, status: 'challenge' });

      res.json({
        success: true,
        data: {
          twoFactorRequired: true,
          challengeId: challenge.id,
          method,
          email: maskEmail(row.email),
          delivered: delivery ? delivery.delivered : null,
          expiresAt: challenge.expiresAt,
        },
      });
      return;
    }

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
 * Step 2 of the two-step sign-in for a platform owner.
 *
 * Public by necessity — the caller holds only the short-lived `challengeId`
 * minted by `/login`. Single-use and attempt-limited: it accepts the enrolled
 * factor's code (authenticator or email) or a one-time recovery code, and on
 * success mints the real session.
 */
router.post(
  '/2fa/verify',
  loginLimiter,
  validate(twoFactorVerifySchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { challengeId, code } = req.body;
    const ip = clientIp(req);

    const challenge = getChallenge(db, challengeId);
    if (!challenge) throw unauthorized('This verification session has expired. Sign in again.', 'TWO_FACTOR_EXPIRED');

    const user = db
      .prepare(
        `SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level
           FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      )
      .get(challenge.user_id);

    if (!user || !isTwoFactorSubject(user) || !twoFactorEnabled(user)) {
      consumeChallenge(db, challengeId);
      throw unauthorized(
        'Two-factor authentication is no longer available for this account. Sign in again.',
        'TWO_FACTOR_UNAVAILABLE',
      );
    }

    const result = verifyChallengeCode(db, user, challenge, code);
    if (!result.ok) {
      recordChallengeFailure(db, challengeId);
      recordAudit({ userId: user.id, actorEmail: user.email, action: 'auth.login_2fa', ip, status: 'failure' });
      throw unauthorized('That code is not valid. Try again.', 'INVALID_TWO_FACTOR_CODE');
    }

    consumeChallenge(db, challengeId);
    const session = createSession(db, user, req, { remember: Boolean(challenge.remember) });
    setAuthCookie(req, res, session.token, session.expiresAt);

    db.prepare(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL,
                        last_login_at = datetime('now'), last_login_ip = ? WHERE id = ?`,
    ).run(ip, user.id);

    recordAudit({ userId: user.id, actorEmail: user.email, action: 'auth.login_2fa', ip, detail: { via: result.via } });

    const principal = loadUserForAuth(db, user.id);
    res.json({
      success: true,
      data: {
        token: session.token,
        expiresAt: session.expiresAt,
        sessionId: session.sessionId,
        mustChangePassword: requiresPasswordChange(principal),
        user: publicUser(principal, { twoFactorEnabled: true, twoFactorMethod: user.two_factor_method }),
      },
    });
  }),
);

/** Re-send an emailed verification code for a still-pending challenge. */
router.post(
  '/2fa/resend',
  probeLimiter,
  validate(twoFactorResendSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const challenge = getChallenge(db, req.body.challengeId);
    if (!challenge || challenge.method !== 'EMAIL') throw badRequest('No email verification is pending.');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(challenge.user_id);
    if (!user) throw badRequest('This verification session is no longer valid.');

    const delivery = await issueEmailOtp(db, user);
    res.json({
      success: true,
      data: { delivered: delivery.delivered, channel: delivery.channel, email: maskEmail(user.email) },
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
// Pre-authorized student access portal
//
// A student is *pre-authorized* by the college: a staff member places a roster
// row carrying the student's email. These two public endpoints let that student
// claim the row with a password of their own, then sign in. They mirror the
// staff two-step flow but read the `students` roster instead of `users`.
// ---------------------------------------------------------------------------

/** Step 1: is this a known student, and have they set a password yet? */
router.post(
  '/student-check-email',
  probeLimiter,
  validate(studentCheckEmailSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { email } = req.body;
    const ip = clientIp(req);

    // Maintenance refuses campus sign-ins, and a student is a campus sign-in.
    const maintenance = getMaintenance(db);
    if (maintenance.isMaintenanceMode) throw maintenanceMode(maintenance.message);

    const student = db
      .prepare(
        `SELECT s.id, s.full_name, s.status, s.is_claimed, s.user_id, s.tenant_id,
                i.name AS college_name, i.status AS college_status
           FROM students s LEFT JOIN institutions i ON i.id = s.tenant_id
          WHERE LOWER(s.email) = ?`,
      )
      .get(email);

    if (!student) {
      throw new AppError(404, 'No student record found with this email address. Contact your college office.', {
        code: 'NOT_FOUND',
      });
    }

    // Tenant-scoped maintenance: a campus under maintenance refuses its own
    // students too — the campus System Administrator is the exemption that can
    // log in and switch it back off.
    const campusMaintenance = getInstitutionMaintenance(db, student.tenant_id);
    if (campusMaintenance?.isMaintenanceMode) {
      recordAudit({ actorEmail: email, action: 'auth.student_check_email', ip, status: 'maintenance' });
      throw maintenanceMode(institutionMaintenanceRejection(campusMaintenance));
    }

    if (student.college_status === 'SUSPENDED') {
      recordAudit({ actorEmail: email, action: 'auth.student_check_email', ip, status: 'denied' });
      throw new AppError(403, 'This campus is currently suspended. Contact your college office.', {
        code: 'COLLEGE_SUSPENDED',
      });
    }

    if (String(student.status ?? '').toLowerCase() !== 'active') {
      recordAudit({ actorEmail: email, action: 'auth.student_check_email', ip, status: 'denied' });
      throw new AppError(403, 'This rider pass is no longer active. Contact your college office.', {
        code: 'STUDENT_INACTIVE',
      });
    }

    // "First time" means the student has no usable password yet. That covers a
    // plain unclaimed roster row and a staff-provisioned `role=student` account
    // (status 'invited', password sentinel) that is waiting on a first password.
    const linkedAccount = student.user_id
      ? db.prepare('SELECT password_hash FROM users WHERE id = ?').get(student.user_id)
      : null;
    const hasPassword = linkedAccount ? isPasswordSet(linkedAccount.password_hash) : false;
    const firstTime = !Number(student.is_claimed) || Boolean(linkedAccount && !hasPassword);

    return res.json({
      success: true,
      data: {
        status: firstTime ? 'FIRST_TIME_USER' : 'EXISTS_WITH_PASSWORD',
        exists: true,
        email,
        name: student.full_name,
        college: student.college_name ?? null,
        kind: 'student',
        message: firstTime ? 'Create a password to activate your rider pass.' : undefined,
      },
    });
  }),
);

/**
 * Step 2: the pre-authorized student claims the roster row by choosing their
 * password. This creates the paired `users` account (role `student`, level 1),
 * links it back onto the roster row and marks the row claimed.
 *
 * Security posture: reachable only for an active, unclaimed roster row on campus
 * + email, rate-limited, policy-checked and audited. Knowing a student's email
 * is the pre-authorization the college granted by adding them to the roster.
 */
router.post(
  '/student-register',
  probeLimiter,
  validate(studentRegisterSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { email, password } = req.body;
    const ip = clientIp(req);

    const student = db
      .prepare(
        `SELECT s.*, i.status AS college_status
           FROM students s LEFT JOIN institutions i ON i.id = s.tenant_id
          WHERE LOWER(s.email) = ?`,
      )
      .get(email);

    if (!student) {
      recordAudit({ actorEmail: email, action: 'auth.student_register', ip, status: 'failure' });
      throw new AppError(404, 'No student record found with this email address. Contact your college office.', {
        code: 'NOT_FOUND',
      });
    }

    if (student.college_status === 'SUSPENDED') {
      throw new AppError(403, 'This campus is currently suspended. Contact your college office.', {
        code: 'COLLEGE_SUSPENDED',
      });
    }

    if (String(student.status ?? '').toLowerCase() !== 'active') {
      throw new AppError(403, 'This rider pass is no longer active. Contact your college office.', {
        code: 'STUDENT_INACTIVE',
      });
    }

    // Resolve the paired account. Staff can pre-provision one (status
    // 'invited', password sentinel) when they add the roster row, in which case
    // this claim *sets* that first password instead of creating an account.
    const linkedById = student.user_id
      ? db.prepare('SELECT id, password_hash, status FROM users WHERE id = ?').get(student.user_id)
      : null;
    const emailClash = linkedById
      ? null
      : db.prepare('SELECT id, password_hash, status FROM users WHERE LOWER(email) = LOWER(?)').get(email);

    if (linkedById && isPasswordSet(linkedById.password_hash)) {
      throw conflict('This student account is already active. Sign in instead.');
    }
    if (emailClash && isPasswordSet(emailClash.password_hash)) {
      throw conflict('That email address is already in use. Sign in instead.');
    }
    if (!linkedById && Number(student.is_claimed)) {
      throw conflict('This student account is already active. Sign in instead.');
    }

    const maintenance = getMaintenance(db);
    if (maintenance.isMaintenanceMode) throw maintenanceMode(maintenance.message);

    // Tenant-scoped maintenance: the campus's own switch refuses its students
    // too (the campus System Administrator is the exemption).
    const campusMaintenance = getInstitutionMaintenance(db, student.tenant_id);
    if (campusMaintenance?.isMaintenanceMode) throw maintenanceMode(institutionMaintenanceRejection(campusMaintenance));

    const policy = checkPasswordPolicy(password, { email, fullName: student.full_name });
    if (!policy.valid) {
      throw unprocessable(
        'Password does not meet the policy.',
        policy.errors.map((message) => ({ field: 'password', message })),
      );
    }

    const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(ROLE_KEYS.STUDENT);
    if (!role) throw unprocessable('The Student role is not installed.');

    const passwordHash = await hashPassword(password);

    const userId = db.transaction(() => {
      const pending = linkedById ?? emailClash;
      if (pending) {
        db.prepare(
          `UPDATE users SET password_hash = ?, status = 'active', is_first_login = 0,
                            password_changed = 1, force_password_reset = 0,
                            updated_at = datetime('now') WHERE id = ?`,
        ).run(passwordHash, pending.id);
        db.prepare(
          "UPDATE students SET user_id = ?, is_claimed = 1, updated_at = datetime('now') WHERE id = ?",
        ).run(pending.id, student.id);
        return pending.id;
      }

      const result = db
        .prepare(
          `INSERT INTO users
             (email, full_name, password_hash, job_title, department, role_id, status,
              tenant_id, is_first_login, password_changed, force_password_reset, permissions_mode)
           VALUES (?, ?, ?, 'Student', 'Student Body', ?, 'active', ?, 0, 1, 0, 'INHERIT')`,
        )
        .run(email, student.full_name, passwordHash, role.id, student.tenant_id);
      const id = Number(result.lastInsertRowid);

      db.prepare(
        "UPDATE students SET user_id = ?, is_claimed = 1, updated_at = datetime('now') WHERE id = ?",
      ).run(id, student.id);

      return id;
    });

    recordAudit({
      userId,
      actorEmail: email,
      action: 'auth.student_register',
      entity: 'user',
      entityId: userId,
      ip,
    });

    const user = loadUserForAuth(db, userId);
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

/**
 * Self-service email change.
 *
 * Email is the sign-in identity, so it is re-proven with the current password
 * and kept unique across the platform. The `tv` (token version) claim is bumped,
 * which invalidates every *other* live session; the caller's own token is then
 * re-minted so they stay signed in.
 */
router.post(
  '/change-email',
  requireAuth,
  validate(changeEmailSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { newEmail, currentPassword } = req.body;

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      recordAudit({ userId: row.id, actorEmail: row.email, action: 'auth.email_change', ip: clientIp(req), status: 'failure' });
      throw unauthorized('Your password is incorrect.', 'INVALID_CREDENTIALS');
    }
    if (newEmail === row.email) throw badRequest('That is already your email address.');

    const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(newEmail, row.id);
    if (clash) throw conflict('Another account already uses that email address.');

    db.transaction(() => {
      db.prepare("UPDATE users SET email = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?").run(newEmail, row.id);
      db.prepare('DELETE FROM login_sessions WHERE user_id = ? AND id <> ?').run(row.id, req.sessionId ?? '');
    });

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

    recordAudit({ userId: row.id, actorEmail: newEmail, action: 'auth.email_change', entity: 'user', entityId: row.id, ip: clientIp(req), detail: { from: row.email } });

    res.json({ success: true, data: { token, expiresAt, user: publicUser(loadUserForAuth(db, fresh.id)) } });
  }),
);

// ---------------------------------------------------------------------------
// Platform-owner two-factor authentication
//
// Scoped to the Level 200 Super Administrator. The status endpoint answers for
// any authenticated caller (so the UI can hide the panel), while enrolment and
// removal are gated to the owner. Campus roles never carry a second factor, so
// this can never lock a campus out of its own console.
// ---------------------------------------------------------------------------
router.get(
  '/2fa/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    res.json({
      success: true,
      data: {
        subject: isTwoFactorSubject(user),
        enabled: twoFactorEnabled(user),
        method: user.two_factor_method ?? null,
        email: maskEmail(user.email),
        recoveryCodesRemaining: twoFactorEnabled(user) ? remainingRecoveryCodes(user) : 0,
        available: { totp: true, email: mailDeliverable() },
      },
    });
  }),
);

/** Begin enrolment: mint a TOTP secret, or send an email code to verify. */
router.post(
  '/2fa/setup',
  requireAuth,
  requireSuperAdmin,
  validate(twoFactorSetupSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { method } = req.body;

    if (method === 'TOTP') {
      const secret = generateSecret();
      db.prepare("UPDATE users SET totp_secret = ?, updated_at = datetime('now') WHERE id = ?").run(secret, req.user.id);
      recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_setup', ip: clientIp(req), detail: { method } });
      return res.json({
        success: true,
        data: {
          method: 'TOTP',
          secret,
          otpauthUrl: buildOtpAuthUrl({ secret, label: req.user.email, issuer: 'TransitSync' }),
        },
      });
    }

    if (method === 'EMAIL' && !mailDeliverable() && !config.isTest) {
      throw badRequest('Email delivery is not configured on this server. Use an authenticator app instead.');
    }
    const delivery = await issueEmailOtp(db, req.user, { purpose: 'ENROLL_2FA' });
    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_setup', ip: clientIp(req), detail: { method } });
    res.json({
      success: true,
      data: { method: 'EMAIL', delivered: delivery.delivered, channel: delivery.channel, email: maskEmail(req.user.email) },
    });
  }),
);

/** Confirm enrolment with a code, switch the factor on, and mint recovery codes. */
router.post(
  '/2fa/enable',
  requireAuth,
  requireSuperAdmin,
  validate(twoFactorEnableSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { method, code } = req.body;

    if (method === 'TOTP') {
      const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
      if (!row?.totp_secret) throw badRequest('Start the authenticator setup first.');
      if (!verifyCode(row.totp_secret, code)) {
        recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_enable', ip: clientIp(req), status: 'failure' });
        throw unauthorized('That code is not valid. Check your authenticator app and try again.', 'INVALID_TWO_FACTOR_CODE');
      }
    } else if (!verifyEmailOtp(db, req.user.id, code, 'ENROLL_2FA')) {
      recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_enable', ip: clientIp(req), status: 'failure' });
      throw unauthorized('That code is not valid or has expired.', 'INVALID_TWO_FACTOR_CODE');
    }

    const recoveryCodes = generateRecoveryCodes();
    db.transaction(() => {
      db.prepare(
        `UPDATE users SET two_factor_method = ?, two_factor_enabled = 1,
                          two_factor_confirmed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`,
      ).run(method, req.user.id);
      storeRecoveryCodes(db, req.user.id, recoveryCodes);
    });

    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_enabled', ip: clientIp(req), detail: { method } });
    res.json({ success: true, data: { enabled: true, method, recoveryCodes } });
  }),
);

/** Turn the second factor off. Requires the account password. */
router.post(
  '/2fa/disable',
  requireAuth,
  requireSuperAdmin,
  validate(twoFactorDisableSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(req.body.password, row.password_hash))) {
      recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_disable', ip: clientIp(req), status: 'failure' });
      throw unauthorized('Your password is incorrect.', 'INVALID_CREDENTIALS');
    }

    db.prepare(
      `UPDATE users SET two_factor_enabled = 0, two_factor_method = NULL, totp_secret = NULL,
                        two_factor_confirmed_at = NULL, recovery_codes = NULL, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(req.user.id);

    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_disabled', ip: clientIp(req) });
    res.json({ success: true, data: { enabled: false, method: null } });
  }),
);

/** Regenerate the one-time recovery codes (the previous set is destroyed). */
router.post(
  '/2fa/recovery-codes',
  requireAuth,
  requireSuperAdmin,
  validate(twoFactorDisableSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    if (!twoFactorEnabled(req.user)) throw badRequest('Enable two-factor authentication first.');

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(req.body.password, row.password_hash))) {
      throw unauthorized('Your password is incorrect.', 'INVALID_CREDENTIALS');
    }

    const recoveryCodes = generateRecoveryCodes();
    storeRecoveryCodes(db, req.user.id, recoveryCodes);
    recordAudit({ userId: req.user.id, actorEmail: req.user.email, action: 'auth.2fa_recovery_codes', ip: clientIp(req) });
    res.json({ success: true, data: { recoveryCodes } });
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
