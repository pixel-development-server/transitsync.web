/**
 * Maintenance mode — global AND per-institution.
 *
 * Global maintenance is stored as two rows in the existing `settings` key/value
 * table rather than a dedicated table, because the Settings page already owns
 * and edits that store (`maintenance_mode` has been a stored-but-inert setting
 * since the first release).
 *
 * Per-institution maintenance lives on the `institutions` row itself
 * (`is_maintenance_mode` / `maintenance_message`, added by migration 008) so a
 * single campus can enter a maintenance window without taking the whole
 * multi-tenant platform down.
 *
 * While GLOBAL maintenance is engaged:
 *   - every sign-in for a campus account (role level 1–100) is refused with 503;
 *   - the Level 200 Super Administrator may still authenticate to turn it off.
 *
 * While an INSTITUTION's maintenance is engaged:
 *   - only users whose `tenant_id` matches that campus are refused with 503 —
 *     other institutions are completely unaffected;
 *   - the campus's own Level 100 System Administrator is exempt (so they can
 *     manage settings and turn it off), as is the Level 200 Super Administrator.
 */

import { getDb } from '../db/connection.js';
import { SUPER_ADMIN_LEVEL } from '../db/permissions.js';
import { conflict, notFound, badRequest } from '../lib/errors.js';

export const MAINTENANCE_MODE_KEY = 'maintenance_mode';
export const MAINTENANCE_MESSAGE_KEY = 'maintenance_message';
export const DEFAULT_MAINTENANCE_MESSAGE = 'Server is currently under maintenance. Please try again later.';
export const DEFAULT_INSTITUTION_MAINTENANCE_MESSAGE = 'This campus transport system is currently under maintenance.';
/**
 * The canonical HTTP 503 body a campus user receives when their OWN institution
 * is under maintenance. Distinct from `maintenance_message`, which is the
 * free-text *notice* a campus System Administrator can customise (surfaced by
 * `GET /api/system/status?tenant_id=` and the sign-in banner).
 */
export const TENANT_MAINTENANCE_REJECTION = 'Your campus transport server is under maintenance. Please try again later.';

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

// ---------------------------------------------------------------------------
// Per-institution (tenant-scoped) maintenance
// ---------------------------------------------------------------------------

/**
 * Read one campus's maintenance state. Returns null when the tenant does not
 * exist, has been purged, or the institutions table is absent (pre-005 DB).
 */
export function getInstitutionMaintenance(db, tenantId) {
  if (!tenantId) return null;
  let institution;
  try {
    institution = db
      .prepare(
        `SELECT id, name, is_maintenance_mode, maintenance_message
           FROM institutions WHERE id = ?`,
      )
      .get(String(tenantId));
  } catch {
    return null;
  }
  if (!institution) return null;

  return {
    tenantId: institution.id,
    institutionName: institution.name,
    isMaintenanceMode: Boolean(Number(institution.is_maintenance_mode)),
    message: institution.maintenance_message || DEFAULT_INSTITUTION_MAINTENANCE_MESSAGE,
  };
}

/**
 * Resolve the campus maintenance state for a *submitted email* before the
 * account itself is verified: look the address up on the staff `users` table
 * and, failing that, the pre-authorized `students` roster. Returns null when
 * the address belongs to no known tenant (including the cross-tenant Super
 * Administrator, who has no campus).
 */
export function resolveTenantMaintenanceByEmail(db, email) {
  if (!email) return null;
  const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)').get(String(email));
  if (user?.tenant_id) return getInstitutionMaintenance(db, user.tenant_id);

  const student = db.prepare('SELECT tenant_id FROM students WHERE LOWER(email) = LOWER(?)').get(String(email));
  if (student?.tenant_id) return getInstitutionMaintenance(db, student.tenant_id);

  return null;
}

/**
 * True when `user` may keep working even though their own campus is in
 * maintenance: the Level 200 platform owner (cross-tenant, can manage every
 * campus) or the Level 100 System Administrator of THAT campus.
 */
export function isExemptFromInstitutionMaintenance(user, maintenance) {
  if (!user || !maintenance) return true;
  if (Number(user.role_level) >= SUPER_ADMIN_LEVEL) return true;
  return user.role_key === 'system_admin' && user.tenant_id === maintenance.tenantId;
}

/**
 * The HTTP 503 body a campus user receives during their institution's
 * maintenance window. Prefers the campus's own customised `maintenance_message`
 * (set from Settings → System Control), falling back to the canonical rejection
 * text when the notice is still the untouched default.
 */
export function institutionMaintenanceRejection(maintenance) {
  const custom = maintenance?.message?.trim();
  if (custom && custom !== DEFAULT_INSTITUTION_MAINTENANCE_MESSAGE) return custom;
  return TENANT_MAINTENANCE_REJECTION;
}

/**
 * Persist a campus's maintenance state and return the fresh value.
 * `tenantId` must resolve to a live (non-purged) institution. The route layer
 * owns auditing; this service only touches the institutions row.
 */
export function setInstitutionMaintenance(db, { tenantId, enabled, message } = {}) {
  if (!tenantId) throw badRequest('No campus context for maintenance mode. This account is not attached to an institution.');

  const institution = db.prepare('SELECT id, deleted_at FROM institutions WHERE id = ?').get(String(tenantId));
  if (!institution || institution.deleted_at) throw notFound('Campus');

  const nextEnabled = enabled === undefined ? false : Boolean(enabled);
  const nextMessage =
    message === undefined || message === null || String(message).trim() === ''
      ? DEFAULT_INSTITUTION_MAINTENANCE_MESSAGE
      : String(message);

  db.prepare(
    `UPDATE institutions
        SET is_maintenance_mode = ?,
            maintenance_message = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(Number(nextEnabled), nextMessage, institution.id);

  return getInstitutionMaintenance(db, institution.id);
}

export default {
  getMaintenance,
  setMaintenance,
  hasSuperAdmin,
  assertMaintenanceSwitchable,
  getInstitutionMaintenance,
  resolveTenantMaintenanceByEmail,
  isExemptFromInstitutionMaintenance,
  institutionMaintenanceRejection,
  setInstitutionMaintenance,
};
