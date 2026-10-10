-- ===========================================================================
-- TransitSync 002 — granular RBAC
--
-- Adds role definitions, the permission catalogue, role→permission grants and
-- per-user overrides. Also evolves `users` with the credential-lifecycle flags
-- required for forced first-login password rotation:
--
--   is_first_login        true until the account completes its first login
--   password_changed      false until the owner sets a non-bootstrap password
--   force_password_reset  admin-triggered hard reset, cleared on next rotation
--   permissions_mode      INHERIT (use role grants) or CUSTOM (use overrides)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT,
  level        INTEGER NOT NULL DEFAULT 0,
  is_system    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Catalogue of every permission the platform understands (`module:action`).
CREATE TABLE IF NOT EXISTS permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL UNIQUE,
  module        TEXT    NOT NULL,
  module_label  TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_permissions_module ON permissions(module);

-- Which permissions a role grants.
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, permission_id)
);

-- Per-user deviation from the role. `effect = 'DENY'` is an explicit revocation
-- (useful for "attendant, but hide Students").
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect        TEXT    NOT NULL DEFAULT 'GRANT' CHECK (effect IN ('GRANT', 'DENY')),
  granted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- users table evolution
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN is_first_login        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN password_changed      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN force_password_reset  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN permissions_mode      TEXT    NOT NULL DEFAULT 'INHERIT'
  CHECK (permissions_mode IN ('INHERIT', 'CUSTOM'));
ALTER TABLE users ADD COLUMN last_password_change  TEXT;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
