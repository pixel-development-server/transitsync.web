/**
 * Institution (college) tenancy helpers.
 *
 * A single default institution is created by migration 005 and every legacy
 * row is attached to it. New rows created by the current single-campus
 * deployment are stamped with the same id so the dataset stays coherent until
 * row-level tenant scoping (the deferred phase) assigns each caller's tenant.
 */

export const DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111';

export const DEFAULT_INSTITUTION = {
  id: DEFAULT_TENANT_ID,
  name: 'Itahari International College',
  code: 'iic',
  status: 'ACTIVE',
};

/** Campus-scoped tables that carry a `tenant_id` (fixed list — no user input). */
export const TENANT_TABLES = ['users', 'students', 'buses', 'routes', 'scan_events', 'alerts'];

/**
 * Stamp the default tenant onto any unowned rows. `users` is stamped from every
 * campus role; the platform-level Super Administrator is deliberately excluded
 * (it is not a campus account).
 */
export function stampDefaultTenant(db) {
  for (const table of TENANT_TABLES) {
    if (table === 'users') {
      db.prepare(
        `UPDATE users SET tenant_id = ?
          WHERE tenant_id IS NULL
            AND role_id <> (SELECT id FROM roles WHERE key = 'super_admin')`,
      ).run(DEFAULT_TENANT_ID);
    } else {
      db.prepare(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`).run(DEFAULT_TENANT_ID);
    }
  }
}

export default { DEFAULT_TENANT_ID, DEFAULT_INSTITUTION, TENANT_TABLES, stampDefaultTenant };
