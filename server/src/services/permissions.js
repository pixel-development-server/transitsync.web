import { ALL_PERMISSIONS } from '../db/permissions.js';

/**
 * Effective permissions for one user.
 *
 * Resolution depends on `users.permissions_mode`:
 *
 *   INHERIT  — start from the role's grants. A `user_permissions` row with
 *              effect DENY then removes a grant and GRANT adds an extra one.
 *              This is the default and what an admin sees as "use my role".
 *
 *   CUSTOM   — the role is ignored entirely and `user_permissions` *is* the
 *              permission set. This backs the checkbox grid, where an admin
 *              ticks exactly the boxes the individual should have. Because the
 *              grid shows the live effective set, "replace" semantics are what
 *              makes un-ticking a box actually revoke the permission.
 *
 * `isSuperAdmin` short-circuits everything: the Super Administrator (Level 200)
 * and System Administrator (Level 100) always hold every permission, even if
 * the catalogue grows after the role was granted.
 */
export async function resolvePermissions(db, user) {
  if (!user) return new Set();

  const role = user.role_key
    ? await db.get('SELECT r.id, r.key, r.level FROM roles r WHERE r.key = ?', user.role_key)
    : null;

  if (role?.key === 'system_admin' || role?.key === 'super_admin') {
    return new Set(ALL_PERMISSIONS);
  }

  const overrides = await db.all(
    `SELECT p.key, up.effect
       FROM user_permissions up
       JOIN permissions p ON p.id = up.permission_id
      WHERE up.user_id = ?`,
    user.id,
  );

  const isCustom = user.permissions_mode === 'CUSTOM';

  // CUSTOM starts empty so only the explicit checklist applies.
  const granted = new Set();
  if (!isCustom && role) {
    for (const row of await db.all(
      `SELECT p.key FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ?`,
      role.id,
    )) {
      granted.add(row.key);
    }
  }

  for (const override of overrides) {
    if (override.effect === 'DENY') granted.delete(override.key);
    else granted.add(override.key);
  }

  return granted;
}

/** Load a user row plus everything needed for permission resolution. */
export async function loadUserForAuth(db, userId) {
  const user = await db.get(
    `SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level,
            i.name AS institution_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN institutions i ON i.id = u.tenant_id
      WHERE u.id = ?`,
    userId,
  );

  if (!user) return null;
  return { ...user, permissions: [...await resolvePermissions(db, user)] };
}

export function hasPermission(user, permission) {
  if (!user?.permissions) return false;
  return user.permissions.includes(permission);
}

export function hasAllPermissions(user, permissions = []) {
  return permissions.every((permission) => hasPermission(user, permission));
}

export function hasAnyPermission(user, permissions = []) {
  return permissions.some((permission) => hasPermission(user, permission));
}

/**
 * Derive the flag that drives the forced-password-change experience.
 * True when the account has never rotated off its bootstrap credential, or an
 * administrator has explicitly demanded another rotation.
 */
export function requiresPasswordChange(user) {
  if (!user) return false;
  return Boolean(user.is_first_login) || !user.password_changed || Boolean(user.force_password_reset);
}

/** Replace a user's explicit overrides with a new set. */
export async function setUserPermissions(db, userId, permissions, { mode = 'CUSTOM', grantedBy = null } = {}) {
  const valid = new Set(ALL_PERMISSIONS);
  const cleaned = [...new Set(permissions.filter((key) => valid.has(key)))];

  await db.transaction(async () => {
    await db.run('DELETE FROM user_permissions WHERE user_id = ?', userId);
    const ids = new Map(
      (await db.all('SELECT id, `key` FROM permissions')).map((row) => [row.key, row.id]),
    );
    for (const key of cleaned) {
      const id = ids.get(key);
      if (id) {
        await db.run(
          `REPLACE INTO user_permissions (user_id, permission_id, effect, granted_by, granted_at)
           VALUES (?, ?, 'GRANT', ?, NOW())`,
          userId, id, grantedBy,
        );
      }
    }
    await db.run('UPDATE users SET permissions_mode = ?, updated_at = NOW() WHERE id = ?', mode, userId);
  });

  return cleaned;
}

/** Save a role's permission set (role_permissions). */
export async function setRolePermissions(db, roleId, permissions) {
  const valid = new Set(ALL_PERMISSIONS);
  const cleaned = [...new Set(permissions.filter((key) => valid.has(key)))];

  await db.transaction(async () => {
    await db.run('DELETE FROM role_permissions WHERE role_id = ?', roleId);
    const ids = new Map(
      (await db.all('SELECT id, `key` FROM permissions')).map((row) => [row.key, row.id]),
    );
    for (const key of cleaned) {
      const id = ids.get(key);
      if (id) {
        await db.run(
          `INSERT IGNORE INTO role_permissions (role_id, permission_id, granted_at)
           VALUES (?, ?, NOW())`,
          roleId, id,
        );
      }
    }
  });

  return cleaned;
}

export async function getRolePermissions(db, roleKey) {
  const rows = await db.all(
    `SELECT p.key FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r       ON r.id = rp.role_id
      WHERE r.key = ?`,
    roleKey,
  );
  return rows.map((row) => row.key);
}

/** Full matrix for the User Management UI: catalogue + every role's grants. */
export async function permissionMatrix(db) {
  const roles = await db.all('SELECT id, `key`, name, description, level, is_system FROM roles ORDER BY level DESC');
  const grants = new Map();
  for (const row of await db.all(
    `SELECT r.key AS role_key, p.key AS permission_key
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r       ON r.id = rp.role_id`,
  )) {
    if (!grants.has(row.role_key)) grants.set(row.role_key, new Set());
    grants.get(row.role_key).add(row.permission_key);
  }

  return roles.map((role) => ({
    ...role,
    permissions: [...(grants.get(role.key) ?? [])],
  }));
}

export default {
  resolvePermissions,
  loadUserForAuth,
  hasPermission,
  hasAllPermissions,
  hasAnyPermission,
  requiresPasswordChange,
  setUserPermissions,
  setRolePermissions,
  getRolePermissions,
  permissionMatrix,
};
