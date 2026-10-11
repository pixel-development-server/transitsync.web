/**
 * Global maintenance mode.
 *
 * Stored as two rows in the existing `settings` key/value table rather than a
 * dedicated table, because the Settings page already owns and edits that store
 * (`maintenance_mode` has been a stored-but-inert setting since the first
 * release). This module is the single reader/writer so the login gate, the
 * public status endpoint and the Super Admin toggle all agree.
 *
 * While engaged:
 *   - every sign-in for a campus account (role level 1–100) is refused with 503;
 *   - the Level 200 Super Administrator may still authenticate to turn it off.
 */

import { getDb } from '../db/connection.js';
import { conflict } from '../lib/errors.js';

export const MAINTENANCE_MODE_KEY = 'maintenance_mode';
export const MAINTENANCE_MESSAGE_KEY = 'maintenance_message';
export const DEFAULT_MAINTENANCE_MESSAGE = 'Server is currently under maintenance. Please try again later.';

/** Read the current maintenance state. Never throws (settings may pre-date 005). */
export function getMaintenance(db = getDb()) {
  let isMaintenanceMode = false;
  let message = DEFAULT_MAINTENANCE_MESSAGE;

  try {
    const rows = db
      .prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
      .all(MAINTENANCE_MODE_KEY, MAINTENANCE_MESSAGE_KEY);
    for (const row of rows) {
      if (row.key === MAINTENANCE_MODE_KEY) isMaintenanceMode = String(row.value) === 'true';
      if (row.key === MAINTENANCE_MESSAGE_KEY && row.value) message = String(row.value);
    }
  } catch {
    /* settings table absent — treat as no maintenance */
  }

  return { isMaintenanceMode, message };
}

/** True once a Level 200 Super Administrator account exists. */
export function hasSuperAdmin(db = getDb()) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = 'super_admin'`,
    )
    .get();
  return row.n > 0;
}

/**
 * Safety interlock. Enabling maintenance with no Super Administrator configured
 * would lock out every campus account with nobody able to turn it back off, so
 * this refuses the transition instead.
 */
export function assertMaintenanceSwitchable(db, enabling) {
  if (enabling && !hasSuperAdmin(db)) {
    throw conflict(
      'Cannot enable maintenance mode: no Super Administrator exists to disable it again. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD first.',
    );
  }
}

/** Persist any subset of the maintenance state and return the fresh value. */
export function setMaintenance(db, { enabled, message, updatedBy = null } = {}) {
  if (enabled !== undefined) assertMaintenanceSwitchable(db, Boolean(enabled));

  const upsert = db.prepare(
    `INSERT INTO settings (key, value, label, group_name, value_type, updated_by, updated_at)
     VALUES (?, ?, ?, 'operations', ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  );

  if (enabled !== undefined) {
    upsert.run(MAINTENANCE_MODE_KEY, String(Boolean(enabled)), 'Maintenance mode', 'boolean', updatedBy);
  }
  if (message !== undefined && message !== null) {
    upsert.run(MAINTENANCE_MESSAGE_KEY, String(message), 'Maintenance message', 'string', updatedBy);
  }

  return getMaintenance(db);
}

export default { getMaintenance, setMaintenance, hasSuperAdmin, assertMaintenanceSwitchable };
