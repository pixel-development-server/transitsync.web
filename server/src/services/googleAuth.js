/**
 * Google Identity Services sign-in: token verification, campus resolution and
 * passwordless account provisioning.
 *
 * The browser only ever holds a Google ID-token `credential`. This module is
 * the trust boundary: it verifies that token against Google's published keys
 * with our client id as the audience, resolves the verified email domain to a
 * registered college, decides student vs. staff, and provisions a local account
 * that is *already* rotated (so the client never sees a "create a password"
 * screen). Administrator roles are deliberately excluded — they continue to
 * use the credential/admin flow.
 */

import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

import config from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { unauthorized, conflict, AppError } from '../lib/errors.js';
import { loadUserForAuth } from './permissions.js';
import { ROLE_KEYS } from '../db/permissions.js';
import * as logger from '../../logger.js';

/**
 * One line per stage of the Google exchange, in the same structured log as HTTP
 * requests. Never pass the raw ID token or the issued JWT here — only routing
 * fields (email, domain, tenant, role, user id) that explain a failure.
 */
export function googleLog(level, event, fields = {}) {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
  const message = `google_auth event=${event}${detail ? ` ${detail}` : ''}`;
  if (level === 'error') logger.error(message);
  else if (level === 'warn') logger.warn(message);
  else if (level === 'success') logger.success(message);
  else logger.info(message);
}

let client = null;
function googleClient() {
  if (!client) client = new OAuth2Client(config.google.clientId);
  return client;
}

/** Public configuration safe to send to the browser before sign-in. */
export function publicGoogleConfig() {
  return { enabled: config.google.enabled, clientId: config.google.clientId || null };
}

/** Verify a Google ID token and return only the claims TransitSync relies on. */
export async function verifyGoogleCredential(credential) {
  if (!config.google.enabled) {
    googleLog('error', 'token verification skipped', { reason: 'GOOGLE_NOT_CONFIGURED' });
    throw new AppError(400, 'Google Sign-In is not configured on this server.', {
      code: 'GOOGLE_NOT_CONFIGURED',
    });
  }

  let payload;
  try {
    const ticket = await googleClient().verifyIdToken({
      idToken: credential,
      audience: config.google.clientId,
    });
    payload = ticket.getPayload();
  } catch (cause) {
    googleLog('error', 'token verification failed', {
      code: 'GOOGLE_TOKEN_INVALID',
      reason: cause?.message || 'Google rejected the ID token',
      audienceConfigured: Boolean(config.google.clientId),
    });
    throw unauthorized('Google could not verify that sign-in. Please try again.', 'GOOGLE_TOKEN_INVALID');
  }

  if (!payload || !payload.email || !payload.sub) {
    googleLog('error', 'token verification failed', { code: 'IDENTITY_MISSING' });
    throw unauthorized('Google did not return a verified identity.', 'GOOGLE_TOKEN_INVALID');
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    googleLog('warn', 'token verification failed', {
      code: 'GOOGLE_EMAIL_UNVERIFIED',
      email: payload.email,
    });
    throw unauthorized('Please use a Google account with a verified email address.', 'GOOGLE_EMAIL_UNVERIFIED');
  }

  const profile = {
    email: String(payload.email).trim().toLowerCase(),
    name: String(payload.name || payload.given_name || payload.email.split('@')[0]).trim(),
    sub: String(payload.sub),
  };
  googleLog('success', 'token verified', { email: profile.email, sub: profile.sub });
  return profile;
}

/** Lower-cased domain portion of an email address. */
export function emailDomain(email) {
  const value = String(email || '').toLowerCase();
  const at = value.lastIndexOf('@');
  return at >= 0 && at < value.length - 1 ? value.slice(at + 1) : '';
}

/**
 * Resolve a verified email domain to exactly one active college.
 *
 * Priority: explicit `institution_email_domains` rows (Platform Master UI),
 * the deployment-level `GOOGLE_DOMAIN_MAP` fallback, then the domain of an
 * existing campus administrator account.
 */
export async function resolveInstitutionForDomain(db, domain) {
  const normalised = String(domain || '').trim().toLowerCase();
  if (!normalised) throw domainNotAllowed(domain);

  const configured = await db.get(
    `SELECT i.id, i.name, i.code, i.status
       FROM institution_email_domains d
       JOIN institutions i ON i.id = d.institution_id
      WHERE d.domain = ? AND i.deleted_at IS NULL`,
    normalised,
  );
  if (configured) {
    googleLog('success', 'domain resolved', { domain, source: 'institution_email_domains', tenantId: configured.id });
    return assertCollegeActive(configured, domain);
  }

  const mappedId = config.google.domainMap.get(normalised);
  if (mappedId) {
    const mapped = await db.get(
      'SELECT id, name, code, status FROM institutions WHERE id = ? AND deleted_at IS NULL',
      mappedId,
    );
    if (mapped) {
      googleLog('success', 'domain resolved', { domain, source: 'GOOGLE_DOMAIN_MAP', tenantId: mapped.id });
      return assertCollegeActive(mapped, domain);
    }
  }

  // Legacy colleges may have no explicit domain row: their administrator's
  // email address is the original domain declaration. Only a single college
  // may claim a domain — an ambiguous mapping fails closed.
  const owners = await db.all(
    `SELECT DISTINCT u.tenant_id
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id IS NOT NULL
        AND r.\`key\` IN ('system_admin', 'admin')
        AND LOWER(SUBSTRING_INDEX(u.email, '@', -1)) = ?`,
    normalised,
  );
  if (owners.length > 1) {
    throw conflict(`The email domain @${domain} is registered to more than one college. Ask the platform administrator to assign it explicitly.`);
  }
  if (owners.length === 1) {
    const college = await db.get(
      'SELECT id, name, code, status FROM institutions WHERE id = ? AND deleted_at IS NULL',
      owners[0].tenant_id,
    );
    if (college) {
      googleLog('success', 'domain resolved', { domain, source: 'admin_email', tenantId: college.id });
      return assertCollegeActive(college, domain);
    }
  }

  googleLog('warn', 'domain lookup failed', { domain, reason: 'GOOGLE_DOMAIN_NOT_ALLOWED' });
  throw domainNotAllowed(domain);
}

function assertCollegeActive(college, domain) {
  if (college.status === 'SUSPENDED') {
    throw new AppError(403, `The college registered for @${domain} is suspended. Contact your college office.`, {
      code: 'COLLEGE_SUSPENDED',
    });
  }
  return college;
}

function domainNotAllowed(domain) {
  return new AppError(
    403,
    domain
      ? `Google accounts with @${domain} are not registered to any college. Use your institutional email address.`
      : 'The Google account has no institutional email domain.',
    { code: 'GOOGLE_DOMAIN_NOT_ALLOWED' },
  );
}

/** True for the student-style roll numbers used by campus registries (`np05cp4a…`). */
export function isStudentEmailPattern(email) {
  return /^np[0-9a-z]/i.test(String(email || '').split('@')[0]);
}

/**
 * Decide the local role without trusting the caller. Existing accounts and
 * roster rows are authoritative; a brand-new institutional address is resolved
 * from the student email pattern first and the selected portal second.
 */
export async function resolveRoleForGoogleUser(db, { email, portalType, tenantId }) {
  const existing = await db.get(
    `SELECT u.id, u.role_id, r.\`key\` AS role_key, r.level AS role_level
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE LOWER(u.email) = LOWER(?)`,
    email,
  );
  if (existing) {
    if (existing.role_key === ROLE_KEYS.STUDENT) {
      googleLog('success', 'role resolved', { email, role: ROLE_KEYS.STUDENT, source: 'existing_user' });
      return { key: ROLE_KEYS.STUDENT, existing };
    }
    const level = Number(existing.role_level ?? 0);
    // Admin / System Admin / Super Admin never authenticate through Google.
    if (level >= 90 || existing.role_key === ROLE_KEYS.SYSTEM_ADMIN || existing.role_key === ROLE_KEYS.SUPER_ADMIN) {
      googleLog('warn', 'role resolution refused', { email, reason: 'GOOGLE_ADMIN_NOT_ALLOWED', level });
      throw new AppError(
        403,
        'Administrator accounts must sign in with their provisioned credentials on the Staff portal.',
        { code: 'GOOGLE_ADMIN_NOT_ALLOWED' },
      );
    }
    const roleKey = existing.role_key || ROLE_KEYS.TRANSPORT_STAFF;
    googleLog('success', 'role resolved', { email, role: roleKey, source: 'existing_user' });
    return { key: roleKey, existing };
  }

  const roster = await db.get(
    'SELECT id FROM students WHERE tenant_id = ? AND LOWER(email) = LOWER(?) LIMIT 1',
    tenantId, email,
  );
  if (roster) {
    googleLog('success', 'role resolved', { email, role: ROLE_KEYS.STUDENT, source: 'student_roster' });
    return { key: ROLE_KEYS.STUDENT, existing: null };
  }

  const roleKey = isStudentEmailPattern(email) || portalType === 'student'
    ? ROLE_KEYS.STUDENT
    : ROLE_KEYS.TRANSPORT_STAFF;
  googleLog('success', 'role resolved', { email, role: roleKey, source: 'new_account_hint' });
  return { key: roleKey, existing: null };
}

/**
 * Create or refresh the local principal and, for students, attach a roster row
 * so the account is visible in Admin Console → Student Accounts immediately.
 * Everything runs in one transaction; a failure leaves no half-provisioned user.
 */
export async function provisionGooglePrincipal(db, { profile, college, roleKey, existing }) {
  const role = await db.get('SELECT id FROM roles WHERE `key` = ?', roleKey);
  if (!role) throw new AppError(422, `The ${roleKey} role is not installed.`, { code: 'ROLE_MISSING' });

  const isStudent = roleKey === ROLE_KEYS.STUDENT;
  const firstName = profile.name || profile.email.split('@')[0];
  // A random, unreachable hash: Google accounts have no local password, and the
  // rotation flags are cleared so the UI never routes to "create a password".
  const googlePasswordHash = await hashPassword(crypto.randomBytes(48).toString('base64url'));

  const userId = await db.transaction(async (tx) => {
    let id;
    if (existing) {
      id = existing.id;
      await tx.run(
        `UPDATE users
            SET email = ?, full_name = ?, tenant_id = ?, role_id = ?,
                status = 'active', is_first_login = 0, password_changed = 1,
                force_password_reset = 0, failed_login_count = 0, locked_until = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        profile.email, firstName, college.id, role.id, id,
      );
    } else {
      const inserted = await tx.run(
        `INSERT INTO users
           (email, full_name, password_hash, job_title, department, role_id, status,
            tenant_id, is_first_login, password_changed, force_password_reset, permissions_mode)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, 1, 0, 'INHERIT')`,
        profile.email,
        firstName,
        googlePasswordHash,
        isStudent ? 'Student' : 'Campus Staff',
        isStudent ? 'Student Body' : 'Operations',
        role.id,
        college.id,
      );
      id = Number(inserted.lastInsertRowid);
    }

    if (isStudent) await linkStudentRoster(tx, { userId: id, profile, college });
    return id;
  });

  googleLog('success', 'principal provisioned', {
    userId,
    email: profile.email,
    role: roleKey,
    tenantId: college.id,
    action: existing ? 'linked_existing' : 'created',
  });

  const principal = await loadUserForAuth(db, userId);
  if (!principal) {
    googleLog('error', 'principal reload failed', { userId, code: 'GOOGLE_PROVISION_FAILED' });
    throw new AppError(500, 'The Google account could not be loaded.', { code: 'GOOGLE_PROVISION_FAILED' });
  }
  return principal;
}

async function linkStudentRoster(tx, { userId, profile, college }) {
  const linked = await tx.get('SELECT id FROM students WHERE user_id = ? LIMIT 1', userId);
  if (linked) {
    await tx.run(
      'UPDATE students SET full_name = ?, is_claimed = 1, updated_at = NOW() WHERE id = ?',
      profile.name, linked.id,
    );
    return;
  }

  const byEmail = await tx.get(
    `SELECT id, user_id FROM students
      WHERE tenant_id = ? AND LOWER(email) = LOWER(?) ORDER BY id LIMIT 1`,
    college.id, profile.email,
  );
  if (byEmail && (!byEmail.user_id || Number(byEmail.user_id) === Number(userId))) {
    await tx.run(
      'UPDATE students SET user_id = ?, full_name = ?, is_claimed = 1, updated_at = NOW() WHERE id = ?',
      userId, profile.name, byEmail.id,
    );
    return;
  }

  // No registry row existed yet — auto-create one so a student whose email was
  // never manually added still appears in that college's Student Accounts.
  const base = String(profile.email.split('@')[0]).replace(/[^A-Za-z0-9-]/g, '').slice(0, 80) || 'GOOGLE';
  let collegeId = base;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(await tx.get('SELECT id FROM students WHERE college_id = ?', collegeId))) break;
    collegeId = `${base.slice(0, 70)}-${crypto.randomBytes(3).toString('hex')}`;
  }
  await tx.run(
    `INSERT INTO students
       (full_name, college_id, email, rfid_status, card_status, status,
        tenant_id, user_id, is_claimed)
     VALUES (?, ?, ?, 'UNASSIGNED', 'UNASSIGNED', 'ACTIVE', ?, ?, 1)`,
    profile.name, collegeId, profile.email, college.id, userId,
  );
}

export default {
  publicGoogleConfig,
  verifyGoogleCredential,
  emailDomain,
  resolveInstitutionForDomain,
  resolveRoleForGoogleUser,
  provisionGooglePrincipal,
  isStudentEmailPattern,
};
