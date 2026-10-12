import { notFound, unprocessable } from './errors.js';
import { SUPER_ADMIN_LEVEL } from '../db/permissions.js';

/**
 * Multi-tenant scoping for campus-scoped operational registries
 * (students, buses, routes).
 *
 * The model is deliberately asymmetric:
 *
 *   - A campus principal (level < 200) is ALWAYS locked to their own campus.
 *     A `tenantId` sent by the client — in a query or a write body — is
 *     ignored: the server decides the scope, never the caller. This is what
 *     stops a campus account from reading or writing another college's rows.
 *
 *   - A platform principal (level >= 200) governs the platform, not any one
 *     campus. Their registries return NOTHING until they explicitly drill into
 *     a campus with a tenant context (`?tenantId=` on reads, `tenantId` in the
 *     body of a write). All campus data stays out of their default views.
 */

/**
 * Build the `WHERE` fragment that pins a list query to the caller's allowed
 * campus. `alias` prefixes the column (e.g. `'s'` → `(s.tenant_id IS ?)`).
 *
 * Uses the SQLite `IS` operator so a NULL tenant value matches NULL rows
 * directly — no `IS NULL` special-casing needed.
 */
export function operationalTenantScope(db, actor, query = {}, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const actorLevel = Number(actor?.role_level ?? actor?.roleLevel ?? 0);
  const tenantId = query?.tenantId ?? null;

  // Campus principal: strictly their own campus, always.
  if (actorLevel < SUPER_ADMIN_LEVEL) {
    return { clause: `(${prefix}tenant_id IS ?)`, params: [actor.tenant_id ?? null] };
  }

  // Platform principal without a campus context: only platform-level governance
  // exists here, so campus registries are empty until a campus is chosen.
  if (!tenantId) {
    return { clause: '1 = 0', params: [] };
  }

  if (!db.prepare('SELECT id FROM institutions WHERE id = ?').get(tenantId)) {
    throw unprocessable('Unknown college tenant.', [
      { field: 'tenantId', message: 'Pick a valid campus tenant.' },
    ]);
  }
  return { clause: `(${prefix}tenant_id = ?)`, params: [tenantId] };
}

/**
 * Tenant stamped onto a NEW campus-scoped record.
 *
 * Campus principals inherit their own campus. A platform principal may only
 * write inside an explicitly chosen campus — never "at large" — so their write
 * must carry a valid `tenantId` in the body.
 */
export function resolveOperationalTenant(db, actor, body = {}) {
  if (Number(actor?.role_level ?? actor?.roleLevel ?? 0) >= SUPER_ADMIN_LEVEL) {
    const tenantId = body?.tenantId ?? null;
    if (!tenantId) {
      throw unprocessable('Choose the campus this record belongs to.', [
        { field: 'tenantId', message: 'Pick a campus tenant for this record.' },
      ]);
    }
    if (!db.prepare('SELECT id FROM institutions WHERE id = ?').get(tenantId)) {
      throw unprocessable('Unknown college tenant.', [
        { field: 'tenantId', message: 'Pick a valid campus tenant.' },
      ]);
    }
    return tenantId;
  }
  return actor.tenant_id ?? null;
}

/**
 * Row-level guard for single-record reads and writes: a campus principal may
 * only ever touch rows stamped with their own campus. A cross-campus attempt is
 * reported as not-found so the existence of foreign rows stays unconfirmable.
 * Platform principals may access any specific record directly (that is the
 * drill-down); the list surfaces are what require the tenant context.
 */
export function assertCampusRowVisible(actor, row, resource = 'Record') {
  if (!row) return;
  if (
    Number(actor?.role_level ?? actor?.roleLevel ?? 0) < SUPER_ADMIN_LEVEL &&
    (row.tenant_id ?? null) !== (actor.tenant_id ?? null)
  ) {
    throw notFound(resource);
  }
}

export default { operationalTenantScope, resolveOperationalTenant, assertCampusRowVisible };