import { ALL_PERMISSIONS } from '../db/permissions.js';

const TRUE = 1;

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
 * `isSuperAdmin` short-circuits everything: the System Administrator always has
 * every permission, even if the catalogue grows after the role was granted.
 */
export function resolvePermissions(db, user) {
  if (!user) return new Set();

  const role = user.role_key
    ? db.prepare('SELECT r.id, r.key, r.level FROM roles r WHERE r.key = ?').get(user.role_key)
    : null;

  if (role?.key === 'system_admin') return new Set(ALL_PERMISSIONS);

  const overrides = db
    .prepare(
      `SELECT p.key, up.effect
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
        WHERE up.user_id = ?`,
    )
    .all(user.id);

  const isCustom = user.permissions_mode === 'CUSTOM';

  // CUSTOM starts empty so only the explicit checklist applies.
  const granted = new Set();
  if (!isCustom && role) {
    for (const row of db
      .prepare(
        `SELECT p.key FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ?`,
      )
      .all(role.id)) {
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
export function loadUserForAuth(db, userId) {
  const user = db
    .prepare(
      `SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?`,
    )
    .get(userId);

  if (!user) return null;
  return { ...user, permissions: [...resolvePermissions(db, user)] };
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
export function setUserPermissions(db, userId, permissions, { mode = 'CUSTOM', grantedBy = null } = {}) {
  const valid = new Set(ALL_PERMISSIONS);
  const cleaned = [...new Set(permissions.filter((key) => valid.has(key)))];

  db.transaction(() => {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
    const ids = new Map(
      db.prepare('SELECT id, key FROM permissions').all().map((row) => [row.key, row.id]),
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO user_permissions (user_id, permission_id, effect, granted_by, granted_at)
       VALUES (?, ?, 'GRANT', ?, datetime('now'))`,
    );
    for (const key of cleaned) {
      const id = ids.get(key);
      if (id) insert.run(userId, id, grantedBy);
    }
    db.prepare('UPDATE users SET permissions_mode = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      mode,
      userId,
    );
  });

  return cleaned;
}

/** Save a role's permission set (role_permissions). */
export function setRolePermissions(db, roleId, permissions) {
  const valid = new Set(ALL_PERMISSIONS);
  const cleaned = [...new Set(permissions.filter((key) => valid.has(key)))];

  db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    const ids = new Map(
      db.prepare('SELECT id, key FROM permissions').all().map((row) => [row.key, row.id]),
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, granted_at)
       VALUES (?, ?, datetime('now'))`,
    );
    for (const key of cleaned) {
      const id = ids.get(key);
      if (id) insert.run(roleId, id);
    }
  });

  return cleaned;
}

export function getRolePermissions(db, roleKey) {
  return db
    .prepare(
      `SELECT p.key FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         JOIN roles r       ON r.id = rp.role_id
        WHERE r.key = ?`,
    )
    .all(roleKey)
    .map((row) => row.key);
}

/** Full matrix for the User Management UI: catalogue + every role's grants. */
export function permissionMatrix(db) {
  const roles = db.prepare('SELECT id, key, name, description, level, is_system FROM roles ORDER BY level DESC').all();
  const grants = new Map();
  for (const row of db
    .prepare(
      `SELECT r.key AS role_key, p.key AS permission_key
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         JOIN roles r       ON r.id = rp.role_id`,
    )
    .all()) {
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
