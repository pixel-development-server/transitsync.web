import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { hashPassword, PASSWORD_UNSET, generateTemporaryPassword } from '../lib/password.js';
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
import { MODULES, ALL_PERMISSIONS, isValidPermission, ROLE_KEYS, SUPER_ADMIN_LEVEL } from '../db/permissions.js';
import {
  createUserSchema,
  updateUserSchema,
  assignPermissionsSchema,
  userQuerySchema,
  idSchema,
} from '../validation/schemas.js';
import { publicUser } from './auth.routes.js';
import { userDirectoryScope, assertDirectoryRowVisible } from '../lib/tenantScope.js';
import { writeCredentialRecord, userRecord } from '../../credentialStorage.js';

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
 * A role can only be granted when it sits strictly below the actor's level —
 * EXCEPT one case: the platform owner (Level 200) may provision a peer
 * Super Administrator (also Level 200), so the platform can hand its own
 * ownership to a successor. System Administrator (100) and every other role
 * remain un-mintable at or above the caller's seniority.
 */
function assertAssignableRole(actor, role, action = 'assign') {
  const actorLevel = Number(actor.role_level);
  const roleLevel = Number(role.level);
  const peerSuperAdmin =
    actorLevel >= SUPER_ADMIN_LEVEL && roleLevel === SUPER_ADMIN_LEVEL && role.key === ROLE_KEYS.SUPER_ADMIN;
  if (!peerSuperAdmin && actorLevel <= roleLevel) {
    throw forbidden(
      `You cannot ${action} the "${role.name}" role (level ${roleLevel}) at or above your own level (${actorLevel}).`,
      { code: 'LEVEL_LOCKED' },
    );
  }
}

/**
 * Total-stealth guard for the Level 200 Super Administrator.
 *
 * Below level 200 the account, its role definition and its headcount are not
 * merely protected — they do not exist. Every route that resolves a target by
 * id calls this so a campus-level principal hitting `/users/:id` for a Level
 * 200 account gets `404 Not Found` instead of `403`, which would confirm the
 * account's existence. Above 200 the guard is a no-op.
 */
function assertPrincipalCanSee(actor, target) {
  if (Number(actor.role_level) < SUPER_ADMIN_LEVEL && Number(target.role_level) >= SUPER_ADMIN_LEVEL) {
    throw notFound('Staff member');
  }
}

/** Level 200 roles only exist for a Level 200 principal. */
async function visibleRoles(db, actorLevel) {
  const roles = await permissionMatrix(db);
  if (Number(actorLevel) >= SUPER_ADMIN_LEVEL) return roles;
  return roles.filter((role) => Number(role.level) < SUPER_ADMIN_LEVEL);
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
    // The /users console is the Staff Accounts & RBAC surface. Student auth
    // accounts (role `student`) are managed through the Students registry
    // instead, so they are never listed here.
    clauses.push("(r.`key` IS NULL OR r.`key` <> 'student')");
    if (search) {
      clauses.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.job_title LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    if (role && role !== 'all') {
      clauses.push('r.`key` = ?');
      params.push(role);
    }
    if (status && status !== 'all') {
      clauses.push('u.status = ?');
      params.push(status);
    }
    // Campus isolation: a campus principal is pinned to their own tenant and
    // cannot read another college's staff. The platform owner governs the whole
    // account directory and may optionally narrow it to one campus.
    const scope = await userDirectoryScope(db, req.user, req.query, 'u');
    clauses.push(scope.clause);
    params.push(...scope.params);
    // Total-stealth: anyone below Level 200 never even sees that Level 200
    // accounts exist. Applied to both the page query and the total count so the
    // numbers agree.
    if (Number(req.user.role_level) < SUPER_ADMIN_LEVEL) {
      clauses.push('r.level < ?');
      params.push(SUPER_ADMIN_LEVEL);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const orderMap = {
      name: 'u.full_name',
      email: 'u.email',
      created: 'u.id',
      lastLogin: 'u.last_login_at',
    };
    const orderBy = orderMap[req.query.sort] ?? 'u.id';

    const rows = await db.all(
      `SELECT u.id, u.email, u.full_name, u.phone, u.department, u.job_title, u.status,
              u.is_first_login, u.password_changed, u.force_password_reset,
              u.permissions_mode, u.last_login_at, u.created_at, u.tenant_id,
              r.\`key\` AS role_key, r.name AS role_name, r.level AS role_level,
              inst.name AS institution_name,
              (SELECT COUNT(*) FROM login_sessions ls
                WHERE ls.user_id = u.id AND ls.revoked_at IS NULL
                  AND ls.expires_at > NOW()) AS active_sessions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN institutions inst ON inst.id = u.tenant_id
         ${where}
        ORDER BY ${orderBy} ASC, u.id ASC
        LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );

    const total = (await db.get(
      `SELECT COUNT(*) AS n FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN institutions inst ON inst.id = u.tenant_id
         ${where}`,
      ...params,
    )).n;

    const overridesByUser = new Map();
    if (rows.length) {
      const ids = rows.map((row) => row.id);
      for (const row of await db.all(
        `SELECT up.user_id, p.\`key\`, up.effect FROM user_permissions up
           JOIN permissions p ON p.id = up.permission_id
          WHERE up.user_id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )) {
        if (!overridesByUser.has(row.user_id)) overridesByUser.set(row.user_id, []);
        overridesByUser.get(row.user_id).push({ key: row.key, effect: row.effect });
      }
    }

    res.json({
      success: true,
      data: {
        users: await Promise.all(rows.map(async (row) => ({
          ...publicUser({ ...row, permissions: [...await resolvePermissions(db, row)] }),
          activeSessions: row.active_sessions,
          overrides: overridesByUser.get(row.id) ?? [],
        }))),
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
        roles: await visibleRoles(db, req.user.role_level),
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
    const { rows, total } = await listAudit(db, {
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
    const user = await loadUserForAuth(db, Number(req.params.id));
    if (!user) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, user);
    assertDirectoryRowVisible(req.user, user);

    const overrides = await db.all(
      `SELECT p.\`key\`, up.effect, up.granted_at, g.full_name AS granted_by_name
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
         LEFT JOIN users g   ON g.id = up.granted_by
        WHERE up.user_id = ?`,
      user.id,
    );

    const sessions = await db.all(
      `SELECT id, device, ip, created_at, last_seen_at, expires_at, revoked_at
         FROM login_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      user.id,
    );

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
      temporaryPassword, permissionsMode, permissions, forcePasswordChange, tenantId,
    } = req.body;

    if (await db.get('SELECT id FROM users WHERE email = ?', email)) {
      throw conflict('A staff account with that email already exists.');
    }

    const role = await db.get('SELECT * FROM roles WHERE id = ?', roleId);
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

    // Campus isolation on writes. The tenant an account lands in is decided by
    // the server, never the caller:
    //   - a platform Super Administrator account is ALWAYS platform-global
    //     (`tenant_id` NULL) and refuses a campus binding;
    //   - a platform principal creating a campus account must name the campus
    //     (their own tenant is NULL, so there is nothing to inherit);
    //   - a campus principal always lands in their own campus — a client-supplied
    //     `tenantId` is ignored so a campus admin can never place an account in
    //     another college.
    const isPlatformRole = role.key === ROLE_KEYS.SUPER_ADMIN;
    const actorIsPlatform = Number(req.user.role_level) >= SUPER_ADMIN_LEVEL;

    let tenant = null;
    if (isPlatformRole) {
      if (tenantId) {
        throw unprocessable('A platform Super Administrator is not bound to a campus tenant.', [
          { field: 'tenantId', message: 'The Super Administrator role is platform-wide; leave the campus unset.' },
        ]);
      }
      tenant = null;
    } else if (actorIsPlatform) {
      if (!tenantId) {
        throw unprocessable('Choose the campus this account belongs to.', [
          { field: 'tenantId', message: 'Campus staff accounts must be bound to a college.' },
        ]);
      }
      if (!(await db.get('SELECT id FROM institutions WHERE id = ?', tenantId))) {
        throw unprocessable('Unknown college tenant.', [
          { field: 'tenantId', message: 'Pick a valid campus tenant.' },
        ]);
      }
      tenant = tenantId;
    } else {
      tenant = req.user.tenant_id ?? null;
    }

    const userId = await db.transaction(async () => {
      const result = await db.run(
`INSERT INTO users
           (email, full_name, password_hash, phone, job_title, department, role_id,
            status, is_first_login, password_changed, force_password_reset, permissions_mode, tenant_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        email, fullName, passwordHash, phone ?? null, jobTitle ?? null, department ?? null,
        roleId,
        accountStatus,
        isFirstLogin,
        passwordChanged,
        forceReset,
        permissionsMode,
        tenant,
        req.user.id,
      );

      const id = Number(result.lastInsertRowid);
      if (permissionsMode === 'CUSTOM') {
        await setUserPermissions(db, id, permissions, { mode: 'CUSTOM', grantedBy: req.user.id });
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

    const created = await loadUserForAuth(db, userId);
    // Mirror the new account into the plain-text audit export. Identity and
    // provisioning only — the export never sees a password or a hash.
    writeCredentialRecord(userRecord(created, { source: 'user.create' }));

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
    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);

    const { fullName, roleId, status, jobTitle, department, phone } = req.body;
    const isSelf = id === Number(req.user.id);
    // Flattened out of the `if (roleId)` block so the transaction below can
    // reference it without tripping block scoping.
    let grantingSuperAdmin = false;

    // Seniority rule: you may edit staff strictly below your own level, never a
    // System Administrator or a peer at your level. Self-edits pass this guard.
    assertRankAbove(req.user, target, 'edit');

    if (isSelf && status && status !== 'active') {
      throw badRequest('You cannot suspend your own account.');
    }

    if (roleId) {
      const role = await db.get('SELECT * FROM roles WHERE id = ?', roleId);
      if (!role) throw unprocessable('Unknown role.', [{ field: 'roleId', message: 'Pick a valid role.' }]);

      grantingSuperAdmin = role.key === ROLE_KEYS.SUPER_ADMIN;

      if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN && role.key !== ROLE_KEYS.SYSTEM_ADMIN) {
        const remaining = (await db.get(
          `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
            WHERE r.\`key\` = ? AND u.status = 'active' AND u.id <> ?`,
          ROLE_KEYS.SYSTEM_ADMIN, id,
        )).n;
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

    await db.transaction(async () => {
      await db.run(
        `UPDATE users SET
           full_name  = COALESCE(?, full_name),
           role_id    = COALESCE(?, role_id),
           status     = COALESCE(?, status),
           job_title  = COALESCE(?, job_title),
           department = COALESCE(?, department),
           phone      = COALESCE(?, phone),
           updated_at = NOW()
         WHERE id = ?`,
        fullName ?? null, roleId ?? null, status ?? null, jobTitle ?? null, department ?? null, phone ?? null, id,
      );

      // Suspending or re-rolling a role must not leave live sessions behind.
      if (status && status !== 'active') {
        await db.run("UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'account_suspended' WHERE user_id = ? AND revoked_at IS NULL", id);
      }
      if (roleId && roleId !== target.role_id) {
        await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', id);
        await db.run("UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'role_changed' WHERE user_id = ? AND revoked_at IS NULL", id);
      }
      // A Super Administrator is a platform-scope account: promoting one always
      // detaches it from any campus tenant it used to belong to.
      if (grantingSuperAdmin && roleId !== target.role_id) {
        await db.run('UPDATE users SET tenant_id = NULL WHERE id = ?', id);
      }
    });

    recordAudit(fromRequest(req, 'user.update', { entity: 'user', entityId: id, detail: { ...req.body } }));

    const updated = await loadUserForAuth(db, id);
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
    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);
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

    await setUserPermissions(db, id, permissions, { mode: permissionsMode, grantedBy: req.user.id });
    await db.run("UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = ?", id);
    await db.run("UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'permissions_changed' WHERE user_id = ? AND revoked_at IS NULL", id);

    recordAudit(
      fromRequest(req, 'user.permissions_update', {
        entity: 'user',
        entityId: id,
        detail: { permissionsMode, granted: permissions.length, removed: [...effective].filter((key) => !requested.has(key)) },
      }),
    );

    const updated = await loadUserForAuth(db, id);
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
    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);
    assertRankAbove(req.user, target, 'reset permissions for');

    await db.transaction(async () => {
      await db.run('DELETE FROM user_permissions WHERE user_id = ?', id);
      await db.run("UPDATE users SET permissions_mode = 'INHERIT', updated_at = NOW() WHERE id = ?", id);
      await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', id);
    });

    await db.run("UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'permissions_changed' WHERE user_id = ? AND revoked_at IS NULL", id);
    recordAudit(fromRequest(req, 'user.permissions_reset', { entity: 'user', entityId: id }));

    res.json({ success: true, data: { user: publicUser(await loadUserForAuth(db, id)) } });
  }),
);

/**
 * Put an account into the forced-rotation state with a fresh, single-use
 * temporary password: replace the hash, revoke every live session, and arm the
 * gate so the next successful sign-in halts on the "create a new password"
 * screen. Returns the plaintext handover credential.
 *
 * A forced reset REQUIRES a working credential to reach the gate, because the
 * gate sits *after* the password is proven. So both admin reset actions mint a
 * temporary password: without one, a user who has forgotten their password
 * would be locked out entirely rather than prompted to choose a new one.
 */
async function issueTemporaryRotation(db, id, { reason }) {
  const plain = generateTemporaryPassword();
  const passwordHash = await hashPassword(plain);

  await db.transaction(async () => {
    await db.run(
      `UPDATE users SET password_hash = ?, password_changed = 0, is_first_login = 1,
                        force_password_reset = 1, token_version = token_version + 1,
                        updated_at = NOW() WHERE id = ?`,
      passwordHash, id,
    );
    await db.run(
      "UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL",
      reason, id,
    );
  });

  return plain;
}

/**
 * Force the account to rotate its password on next sign-in.
 *
 * Mints a temporary password the administrator hands over out of band. The
 * holder signs in with that credential and is stopped at the rotation gate
 * until they choose a password of their own — no prior password is required,
 * which is the whole point of an administrator-triggered reset.
 */
router.post(
  '/:id/force-password-reset',
  requirePermission('users:edit'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);
    assertRankAbove(req.user, target, 'force a password reset for');
    if (id === Number(req.user.id)) throw badRequest('You cannot force a password reset on your own account.');

    const temporaryPassword = await issueTemporaryRotation(db, id, { reason: 'forced_password_reset' });

    recordAudit(fromRequest(req, 'user.force_password_reset', { entity: 'user', entityId: id }));
    writeCredentialRecord(userRecord(await loadUserForAuth(db, id), { source: 'user.force_password_reset' }));
    res.json({
      success: true,
      data: {
        user: publicUser(await loadUserForAuth(db, id)),
        temporaryPassword,
        notice: 'Share this temporary password securely. It must be changed at first sign-in.',
      },
    });
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
    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);
    assertRankAbove(req.user, target, 'reset the password for');

    const temporaryPassword = await issueTemporaryRotation(db, id, { reason: 'admin_password_reset' });

    recordAudit(fromRequest(req, 'user.reset_password', { entity: 'user', entityId: id }));
    writeCredentialRecord(userRecord(await loadUserForAuth(db, id), { source: 'user.reset_password' }));
    res.status(201).json({
      success: true,
      data: { temporaryPassword, notice: 'Share securely. It must be changed at first sign-in.' },
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

    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);

    if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN) {
      const remaining = (await db.get(
        `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.\`key\` = ? AND u.status = 'active' AND u.id <> ?`,
        ROLE_KEYS.SYSTEM_ADMIN, id,
      )).n;
      if (remaining === 0) throw badRequest('At least one active System Administrator must remain.');
    }

    assertRankAbove(req.user, target, 'delete');

    // Soft-delete keeps audit history and FK integrity intact.
    await db.run(
      `UPDATE users SET status = 'suspended', email = CONCAT(email, '.deleted.', id),
                        token_version = token_version + 1, updated_at = NOW()
        WHERE id = ?`,
      id,
    );
    await db.run("UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'account_deleted' WHERE user_id = ? AND revoked_at IS NULL", id);

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

    const target = await loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');
    assertPrincipalCanSee(req.user, target);
    assertDirectoryRowVisible(req.user, target);

    if (target.role_key === ROLE_KEYS.SYSTEM_ADMIN) {
      const remaining = (await db.get(
        `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.\`key\` = ? AND u.status = 'active' AND u.id <> ?`,
        ROLE_KEYS.SYSTEM_ADMIN, id,
      )).n;
      if (remaining === 0) throw badRequest('At least one active System Administrator must remain.');
    }

    assertRankAbove(req.user, target, 'delete');

    await db.run('DELETE FROM users WHERE id = ?', id);
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
    const roles = await Promise.all(
      (await visibleRoles(db, req.user.role_level)).map(async (role) => {
        const headcount = (await db.get('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND status = ?', role.id, 'active')).n;
        return { ...role, headcount, editable: Number(req.user.role_level) > Number(role.level) };
      }),
    );
    res.json({ success: true, data: { roles, modules: MODULES, permissions: ALL_PERMISSIONS } });
  }),
);

rolesRouter.put(
  '/:key/permissions',
  requirePermission('roles:edit'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const role = await db.get('SELECT * FROM roles WHERE `key` = ?', req.params.key);
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

    await setRolePermissions(db, role.id, req.body.permissions);
    await db.run(
      `UPDATE users SET token_version = token_version + 1
        WHERE role_id = ? AND permissions_mode = 'INHERIT'`,
      role.id,
    );

    recordAudit(
      fromRequest(req, 'role.permissions_update', {
        entity: 'role',
        entityId: role.key,
        detail: { granted: req.body.permissions.length },
      }),
    );

    res.json({ success: true, data: { role: (await permissionMatrix(db)).find((entry) => entry.key === role.key) } });
  }),
);
