import express from 'express';
import crypto from 'node:crypto';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { hashPassword, PASSWORD_UNSET } from '../lib/password.js';
import { badRequest, conflict, notFound, unprocessable, forbidden } from '../lib/errors.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest, listAudit } from '../services/audit.js';
import {
  loadUserForAuth,
  resolvePermissions,
  setUserPermissions,
  setRolePermissions,
  permissionMatrix,
  requiresPasswordChange,
} from '../services/permissions.js';
import { MODULES, ALL_PERMISSIONS, isValidPermission, ROLE_KEYS } from '../db/permissions.js';
import {
  createUserSchema,
  updateUserSchema,
  assignPermissionsSchema,
  userQuerySchema,
  idSchema,
} from '../validation/schemas.js';
import { publicUser } from './auth.routes.js';

const router = express.Router();

// Every route in this module needs an authenticated principal.
router.use(requireAuth);

/** Reject permission keys that are not in the catalogue before they reach SQL. */
function assertKnownPermissions(permissions = []) {
  const unknown = permissions.filter((key) => !isValidPermission(key));
  if (unknown.length) {
    throw unprocessable('Unknown permission key(s).', unknown.map((key) => ({ field: 'permissions', message: `${key} is not a valid permission.` })));
  }
}

/**
 * Single-use handover credential.
 *
 * Deliberately simple: a temporary password is exempt from the user-facing
 * complexity policy (the holder is forced to set their own password at first
 * sign-in), so we favour a short, unambiguous string that is easy to read aloud
 * or retype. The alphabet omits i/l/o/0/1 to avoid transcription mistakes.
 */
export function generateTemporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let password = '';
  for (let i = 0; i < bytes.length; i += 1) {
    password += alphabet[bytes[i] % alphabet.length];
  }
  return password;
}

/**
 * Seniority guard for account management: a principal may only modify staff
 * strictly below their own level, and may never touch a peer or a System
 * Administrator (level 100). Self-edits of one's own profile stay allowed —
 * role/status changes on self are guarded separately by the routes.
 */
function assertRankAbove(actor, target, action = 'modify') {
  if (actor.id === target.id) return;
  if (Number(actor.role_level) <= Number(target.role_level)) {
    throw forbidden(
      `You cannot ${action} ${target.role_name ?? `user level ${target.role_level}`} at or above your own ` +
        `seniority (your level ${actor.role_level} vs. their level ${target.role_level}).`,
      { code: 'LEVEL_LOCKED' },
    );
  }
}

/**
 * A role can only be granted when it sits strictly below the actor's level.
 * This is what keeps the System Administrator role (100) immutable and stops
 * every other level from handing it out.
 */
function assertAssignableRole(actor, role, action = 'assign') {
  if (Number(actor.role_level) <= Number(role.level)) {
    throw forbidden(
      `You cannot ${action} the "${role.name}" role (level ${role.level}) at or above your own level (${actor.role_level}).`,
      { code: 'LEVEL_LOCKED' },
    );
  }
}

// ---------------------------------------------------------------------------
// List staff
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('users:read'),
  validate(userQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { search, role, status } = req.query;
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25 });

    const clauses = [];
    const params = [];
    if (search) {
      clauses.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.job_title LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    if (role && role !== 'all') {
      clauses.push('r.key = ?');
      params.push(role);
    }
    if (status && status !== 'all') {
      clauses.push('u.status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const orderMap = {
      name: 'u.full_name',
      email: 'u.email',
      created: 'u.id',
      lastLogin: 'u.last_login_at',
    };
    const orderBy = orderMap[req.query.sort] ?? 'u.id';

    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.full_name, u.phone, u.department, u.job_title, u.status,
                u.is_first_login, u.password_changed, u.force_password_reset,
                u.permissions_mode, u.last_login_at, u.created_at,
                r.key AS role_key, r.name AS role_name, r.level AS role_level,
                (SELECT COUNT(*) FROM login_sessions ls
                  WHERE ls.user_id = u.id AND ls.revoked_at IS NULL
                    AND ls.expires_at > datetime('now')) AS active_sessions
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
           ${where}
          ORDER BY ${orderBy} ASC, u.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM users u LEFT JOIN roles r ON r.id = u.role_id ${where}`)
      .get(...params).n;

    const overridesByUser = new Map();
    if (rows.length) {
      const ids = rows.map((row) => row.id);
      for (const row of db
        .prepare(
          `SELECT up.user_id, p.key, up.effect FROM user_permissions up
             JOIN permissions p ON p.id = up.permission_id
            WHERE up.user_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids)) {
        if (!overridesByUser.has(row.user_id)) overridesByUser.set(row.user_id, []);
        overridesByUser.get(row.user_id).push({ key: row.key, effect: row.effect });
      }
    }

    res.json({
      success: true,
      data: {
        users: rows.map((row) => ({
          ...publicUser({ ...row, permissions: [...resolvePermissions(db, row)] }),
          activeSessions: row.active_sessions,
          overrides: overridesByUser.get(row.id) ?? [],
        })),
        meta: paginationMeta({ total, limit, page }),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Catalogue + role matrix — drives the permission grid in the UI
// ---------------------------------------------------------------------------
router.get(
  '/matrix',
  requirePermission('users:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    res.json({
      success: true,
      data: {
        modules: MODULES,
        permissions: ALL_PERMISSIONS,
        roles: permissionMatrix(db),
      },
    });
  }),
);

router.get(
  '/audit',
  requirePermission('users:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { limit = 50, offset = 0 } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const { rows, total } = listAudit(db, {
      limit,
      offset,
      userId: req.query.userId ? Number(req.query.userId) : null,
      action: req.query.action ?? null,
    });
    res.json({
      success: true,
      data: {
        entries: rows.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null })),
        meta: paginationMeta({ total, limit, page: Math.floor(offset / limit) + 1 }),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Single staff member
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('users:read'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = loadUserForAuth(db, Number(req.params.id));
    if (!user) throw notFound('Staff member');

    const overrides = db
      .prepare(
        `SELECT p.key, up.effect, up.granted_at, g.full_name AS granted_by_name
           FROM user_permissions up
           JOIN permissions p ON p.id = up.permission_id
           LEFT JOIN users g   ON g.id = up.granted_by
          WHERE up.user_id = ?`,
      )
      .all(user.id);

    const sessions = db
      .prepare(
        `SELECT id, device, ip, created_at, last_seen_at, expires_at, revoked_at
           FROM login_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      )
      .all(user.id);

    res.json({
      success: true,
      data: {
        user: publicUser(user),
        overrides,
        sessions,
        effectivePermissions: user.permissions,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Create / invite staff
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('users:create'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const {
      email, fullName, roleId, jobTitle, department, phone,
      temporaryPassword, permissionsMode, permissions, forcePasswordChange,
    } = req.body;

    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      throw conflict('A staff account with that email already exists.');
    }

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) throw unprocessable('Unknown role.', [{ field: 'roleId', message: 'Pick a valid role.' }]);

    // No user may mint a role at or above their own seniority — this keeps the
    // System Administrator role immutable to every other level.
    assertAssignableRole(req.user, role);

    if (role.key === ROLE_KEYS.SYSTEM_ADMIN && !req.user.permissions.includes('users:assign_permissions')) {
      throw forbidden('Only an administrator with users:assign_permissions may create another System Administrator.');
    }

    assertKnownPermissions(permissions);

    // Two ways to invite a staff member:
    //
    //  * An explicit temporary password creates a usable login. It is exempt
    //    from the complexity policy (a single-use handover credential) and the
    //    holder is rotated to their own password at first sign-in unless the
    //    admin vouches for it with `forcePasswordChange: false`.
    //  * Leaving the field blank creates a passwordless `invited` account. Its
    //    owner claims it through the first-time setup step of the two-step
    //    sign-in (`/auth/set-first-password`), choosing their own password.
    const issuedPassword = temporaryPassword?.trim() || null;
    const passwordHash = issuedPassword ? await hashPassword(issuedPassword) : PASSWORD_UNSET;
    const accountStatus = issuedPassword ? 'active' : 'invited';
    const isFirstLogin = issuedPassword ? (forcePasswordChange ? 1 : 0) : 1;
    const passwordChanged = issuedPassword ? (forcePasswordChange ? 0 : 1) : 0;
    const forceReset = issuedPassword ? (forcePasswordChange ? 1 : 0) : 0;

    const userId = db.transaction(() => {
      const result = db
        .prepare(
`INSERT INTO users
           (email, full_name, password_hash, phone, job_title, department, role_id,
            status, is_first_login, password_changed, force_password_reset, permissions_mode, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .run(
          email, fullName, passwordHash, phone ?? null, jobTitle ?? null, department ?? null,
          roleId,
          accountStatus,
          isFirstLogin,
          passwordChanged,
          forceReset,
          permissionsMode,
          req.user.id,
        );

      const id = Number(result.lastInsertRowid);
      if (permissionsMode === 'CUSTOM') {
        setUserPermissions(db, id, permissions, { mode: 'CUSTOM', grantedBy: req.user.id });
      }
      return id;
    });

    recordAudit(
      fromRequest(req, 'user.create', {
        entity: 'user',
        entityId: userId,
        detail: { email, role: role.key, permissionsMode },
      }),
    );

    const created = loadUserForAuth(db, userId);
    res.status(201).json({
      success: true,
      data: {
        user: publicUser(created),
        // Shown once so the admin can hand the credentials over out of band.
        temporaryPassword: issuedPassword,
        mustSetPassword: !issuedPassword,
        notice: issuedPassword
          ? 'Share this temporary password securely. The holder must change it at first sign-in.'
          : 'No password was set. This staff member will choose their own password on first sign-in.',
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Update profile / role / status
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('users:edit'),
  validate(idSchema, 'params'),
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');

    const { fullName, roleId, status, jobTitle, department, phone } = req.body;
    const isSelf = id === Number(req.user.id);

    // Seniority rule: you may edit staff strictly below your own level, never a
    // System Administrator or a peer at your level. Self-edits pass this guard.
    assertRankAbove(req.user, target, 'edit');

    if (isSelf && status && status !== 'active') {
      throw badRequest('You cannot suspend your own account.');
    }

    if (roleId) {
      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
      if (!role) throw unprocessable('Unknown role.', [{ field: 'roleId', message: 'Pick a valid role.' }]);

      if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN && role.key !== ROLE_KEYS.SYSTEM_ADMIN) {
        const remaining = db
          .prepare(
            `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
              WHERE r.key = ? AND u.status = 'active' AND u.id <> ?`,
          )
          .get(ROLE_KEYS.SYSTEM_ADMIN, id).n;
        if (remaining === 0) {
          throw badRequest('At least one active System Administrator must remain.');
        }
      }
      if (role.key === ROLE_KEYS.SYSTEM_ADMIN && !req.user.permissions.includes('users:assign_permissions')) {
        throw forbidden('Granting the System Administrator role requires users:assign_permissions.');
      }
      if (roleId !== target.role_id) {
        assertAssignableRole(req.user, role, 'grant');
      }
    }

    db.transaction(() => {
      db.prepare(
        `UPDATE users SET
           full_name  = COALESCE(?, full_name),
           role_id    = COALESCE(?, role_id),
           status     = COALESCE(?, status),
           job_title  = COALESCE(?, job_title),
           department = COALESCE(?, department),
           phone      = COALESCE(?, phone),
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(fullName ?? null, roleId ?? null, status ?? null, jobTitle ?? null, department ?? null, phone ?? null, id);

      // Suspending or re-rolling a role must not leave live sessions behind.
      if (status && status !== 'active') {
        db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'account_suspended' WHERE user_id = ? AND revoked_at IS NULL").run(id);
      }
      if (roleId && roleId !== target.role_id) {
        db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
        db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'role_changed' WHERE user_id = ? AND revoked_at IS NULL").run(id);
      }
    });

    recordAudit(fromRequest(req, 'user.update', { entity: 'user', entityId: id, detail: { ...req.body } }));

    const updated = loadUserForAuth(db, id);
    res.json({ success: true, data: { user: publicUser(updated) } });
  }),
);

// ---------------------------------------------------------------------------
// Per-user permission assignment (the CRUD matrix)
// ---------------------------------------------------------------------------
router.put(
  '/:id/permissions',
  requirePermission('users:assign_permissions'),
  validate(idSchema, 'params'),
  validate(assignPermissionsSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertRankAbove(req.user, target, 'change permissions for');

    const { permissionsMode, permissions } = req.body;
    assertKnownPermissions(permissions);

    const effective = new Set(target.permissions);
    const requested = new Set(permissions);

    // Never let an admin lock themselves — or every admin — out of User Management.
    if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN) {
      const losingCritical = ['users:read', 'users:edit', 'users:assign_permissions']
        .filter((key) => effective.has(key) && !requested.has(key));
      if (losingCritical.length) {
        throw badRequest(
          `A System Administrator cannot be stripped of: ${losingCritical.join(', ')}.`,
        );
      }
    }

    setUserPermissions(db, id, permissions, { mode: permissionsMode, grantedBy: req.user.id });
    db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'permissions_changed' WHERE user_id = ? AND revoked_at IS NULL").run(id);

    recordAudit(
      fromRequest(req, 'user.permissions_update', {
        entity: 'user',
        entityId: id,
        detail: { permissionsMode, granted: permissions.length, removed: [...effective].filter((key) => !requested.has(key)) },
      }),
    );

    const updated = loadUserForAuth(db, id);
    res.json({
      success: true,
      data: {
        user: publicUser(updated),
        overrides: permissions,
        effectivePermissions: updated.permissions,
      },
    });
  }),
);

/** Drop all overrides and fall back to role grants. */
router.delete(
  '/:id/permissions',
  requirePermission('users:assign_permissions'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertRankAbove(req.user, target, 'reset permissions for');

    db.transaction(() => {
      db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
      db.prepare("UPDATE users SET permissions_mode = 'INHERIT', updated_at = datetime('now') WHERE id = ?").run(id);
      db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
    });

    db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'permissions_changed' WHERE user_id = ? AND revoked_at IS NULL").run(id);
    recordAudit(fromRequest(req, 'user.permissions_reset', { entity: 'user', entityId: id }));

    res.json({ success: true, data: { user: publicUser(loadUserForAuth(db, id)) } });
  }),
);

/** Force the account to rotate its password on next sign-in. */
router.post(
  '/:id/force-password-reset',
  requirePermission('users:edit'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertRankAbove(req.user, target, 'force a password reset for');
    if (id === Number(req.user.id)) throw badRequest('You cannot force a password reset on your own account.');

    db.prepare("UPDATE users SET force_password_reset = 1, password_changed = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'forced_password_reset' WHERE user_id = ? AND revoked_at IS NULL").run(id);

    recordAudit(fromRequest(req, 'user.force_password_reset', { entity: 'user', entityId: id }));
    res.json({ success: true, data: { user: publicUser(loadUserForAuth(db, id)) } });
  }),
);

/** Admin-issued one-time password (single-use, complexity-exempt). */
router.post(
  '/:id/reset-password',
  requirePermission('users:edit'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertRankAbove(req.user, target, 'reset the password for');

    const plain = generateTemporaryPassword();
    const passwordHash = await hashPassword(plain);

    db.transaction(() => {
      db.prepare(
        `UPDATE users SET password_hash = ?, password_changed = 0, is_first_login = 1,
                          force_password_reset = 1, token_version = token_version + 1,
                          updated_at = datetime('now') WHERE id = ?`,
      ).run(passwordHash, id);
      db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'admin_password_reset' WHERE user_id = ? AND revoked_at IS NULL").run(id);
    });

    recordAudit(fromRequest(req, 'user.reset_password', { entity: 'user', entityId: id }));
    res.status(201).json({
      success: true,
      data: { temporaryPassword: plain, notice: 'Share securely. It must be changed at first sign-in.' },
    });
  }),
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('users:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (id === Number(req.user.id)) throw badRequest('You cannot delete your own account.');

    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');

    if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN) {
      const remaining = db
        .prepare(
          `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
            WHERE r.key = ? AND u.status = 'active' AND u.id <> ?`,
        )
        .get(ROLE_KEYS.SYSTEM_ADMIN, id).n;
      if (remaining === 0) throw badRequest('At least one active System Administrator must remain.');
    }

    assertRankAbove(req.user, target, 'delete');

    // Soft-delete keeps audit history and FK integrity intact.
    db.prepare(
      `UPDATE users SET status = 'suspended', email = email || '.deleted.' || id,
                        token_version = token_version + 1, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(id);
    db.prepare("UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'account_deleted' WHERE user_id = ? AND revoked_at IS NULL").run(id);

    recordAudit(fromRequest(req, 'user.delete', { entity: 'user', entityId: id, detail: { email: target.email } }));
    res.json({ success: true, data: { message: `${target.full_name} has been removed.` } });
  }),
);

/**
 * Hard delete a staff account.
 *
 * The soft delete above is right for a live account: it frees the email for
 * reuse while keeping historical rows attributable. But an account that is
 * *already suspended* has nothing left to disable, and repeatedly soft-deleting
 * one merely stacks `.deleted.<id>` suffixes. This route removes it for good.
 *
 * Integrity is safe: `user_permissions` and `login_sessions` cascade away, every
 * other reference (`created_by`, `driver_user_id`, alert handlers, …) is
 * `ON DELETE SET NULL`, and audit rows retain their denormalised `actor_email`.
 * The last-active-Administrator and self-deletion guards mirror the soft delete.
 */
router.delete(
  '/:id/purge',
  requirePermission('users:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (id === Number(req.user.id)) throw badRequest('You cannot delete your own account.');

    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');

    if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN) {
      const remaining = db
        .prepare(
          `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
            WHERE r.key = ? AND u.status = 'active' AND u.id <> ?`,
        )
        .get(ROLE_KEYS.SYSTEM_ADMIN, id).n;
      if (remaining === 0) throw badRequest('At least one active System Administrator must remain.');
    }

    assertRankAbove(req.user, target, 'delete');

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    recordAudit(fromRequest(req, 'user.purge', { entity: 'user', entityId: id, detail: { email: target.email } }));
    res.json({ success: true, data: { message: `${target.full_name} has been permanently deleted.` } });
  }),
);

export default router;

// ---------------------------------------------------------------------------
// Roles live in their own router but share this file's guards.
// ---------------------------------------------------------------------------
export const rolesRouter = express.Router();

rolesRouter.use(requireAuth);

rolesRouter.get(
  '/',
  requirePermission('roles:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const roles = permissionMatrix(db).map((role) => {
      const headcount = db
        .prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND status = ?')
        .get(role.id, 'active').n;
      return { ...role, headcount, editable: Number(req.user.role_level) > Number(role.level) };
    });
    res.json({ success: true, data: { roles, modules: MODULES, permissions: ALL_PERMISSIONS } });
  }),
);

rolesRouter.put(
  '/:key/permissions',
  requirePermission('roles:edit'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(req.params.key);
    if (!role) throw notFound('Role');
    assertKnownPermissions(req.body?.permissions);

    if (role.key === ROLE_KEYS.SYSTEM_ADMIN) {
      throw badRequest('The System Administrator role always holds every permission and cannot be edited.');
    }

    // Seniority rule: a role at or above the caller's level is untouchable.
    // Combined with the guard above this makes the System Administrator role
    // immutable to every level in the system.
    if (Number(req.user.role_level) <= Number(role.level)) {
      throw forbidden('You can only edit roles below your own seniority level.', { code: 'LEVEL_LOCKED' });
    }

    setRolePermissions(db, role.id, req.body.permissions);
    db.prepare(
      `UPDATE users SET token_version = token_version + 1
        WHERE role_id = ? AND permissions_mode = 'INHERIT'`,
    ).run(role.id);

    recordAudit(
      fromRequest(req, 'role.permissions_update', {
        entity: 'role',
        entityId: role.key,
        detail: { granted: req.body.permissions.length },
      }),
    );

    res.json({ success: true, data: { role: permissionMatrix(db).find((entry) => entry.key === role.key) } });
  }),
);
