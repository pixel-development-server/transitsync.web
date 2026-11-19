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
 * campus. `alias` prefixes the column (e.g. `'s'` → `(s.tenant_id <=> ?)`).
 *
 * Uses the null-safe `<=>` operator so a NULL tenant value matches NULL rows
 * directly — no `IS NULL` special-casing needed.
 */
export async function operationalTenantScope(db, actor, query = {}, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const actorLevel = Number(actor?.role_level ?? actor?.roleLevel ?? 0);
  const tenantId = query?.tenantId ?? null;

  // Campus principal: strictly their own campus, always.
  if (actorLevel < SUPER_ADMIN_LEVEL) {
    return { clause: `(${prefix}tenant_id <=> ?)`, params: [actor.tenant_id ?? null] };
  }

  // Platform principal without a campus context: only platform-level governance
  // exists here, so campus registries are empty until a campus is chosen.
  if (!tenantId) {
    return { clause: '1 = 0', params: [] };
  }

  if (!(await db.get('SELECT id FROM institutions WHERE id = ?', tenantId))) {
    throw unprocessable('Unknown college tenant.', [
      { field: 'tenantId', message: 'Pick a valid campus tenant.' },
    ]);
  }
  return { clause: `(${prefix}tenant_id = ?)`, params: [tenantId] };
}

/**
 * Scope for EVENT rows (`scan_events`, `alerts`).
 *
 * Events follow the same campus rule as the registries, plus one allowance: a
 * campus-neutral SYSTEM row (no tenant, no student, no bus and no route
 * attached) belongs to no institution, carries no college's records, and stays
 * visible to every campus. A platform principal still gets nothing until they
 * drill into a campus — exactly like `operationalTenantScope`.
 *
 * Both tables expose the same four linkage columns, so one fragment works for
 * either, aliased or not.
 */
export async function operationalEventScope(db, actor, query = {}, alias = '') {
  const base = await operationalTenantScope(db, actor, query, alias);
  if (base.clause === '1 = 0') return base;
  const prefix = alias ? `${alias}.` : '';
  return {
    clause: `((${prefix}tenant_id <=> ?) OR (${prefix}tenant_id IS NULL AND ${prefix}student_id IS NULL AND ${prefix}bus_id IS NULL AND ${prefix}route_id IS NULL))`,
    params: base.params,
  };
}

/**
 * Row-level guard mirroring {@link operationalEventScope} for single-event
 * reads and mutations: a campus principal may touch its own campus's events
 * plus campus-neutral system rows (anything else reports as not-found); a
 * platform principal may open any specific event directly.
 */
export function assertEventRowVisible(actor, row, resource = 'Event') {
  if (!row) return;
  const campusNeutral =
    (row.tenant_id ?? null) === null &&
    (row.student_id ?? null) === null &&
    (row.bus_id ?? null) === null &&
    (row.route_id ?? null) === null;
  if (campusNeutral) return;
  assertCampusRowVisible(actor, row, resource);
}

/**
 * Tenant stamped onto a NEW campus-scoped record.
 *
 * Campus principals inherit their own campus. A platform principal may only
 * write inside an explicitly chosen campus — never "at large" — so their write
 * must carry a valid `tenantId` in the body.
 */
export async function resolveOperationalTenant(db, actor, body = {}) {
  if (Number(actor?.role_level ?? actor?.roleLevel ?? 0) >= SUPER_ADMIN_LEVEL) {
    const tenantId = body?.tenantId ?? null;
    if (!tenantId) {
      throw unprocessable('Choose the campus this record belongs to.', [
        { field: 'tenantId', message: 'Pick a campus tenant for this record.' },
      ]);
    }
    if (!(await db.get('SELECT id FROM institutions WHERE id = ?', tenantId))) {
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

/**
 * Scope for the ACCOUNT directory (`/api/users`) — deliberately different from
 * {@link operationalTenantScope}, which guards campus DATA registries.
 *
 * The directory is a governance surface:
 *   - A campus principal is pinned to their own campus so User Management can
 *     never enumerate another college's staff. Platform-global (NULL-tenant)
 *     rows stay visible here; they are all level-200 accounts, which the role
 *     stealth in the route removes before the response is sent.
 *   - A platform principal sees the whole directory (they manage it). An
 *     optional `tenantId` narrows the view to a single campus.
 */
export async function userDirectoryScope(db, actor, query = {}, alias = 'u') {
  const prefix = alias ? `${alias}.` : '';
  const actorLevel = Number(actor?.role_level ?? actor?.roleLevel ?? 0);
  const tenantId = query?.tenantId ?? null;

  if (actorLevel < SUPER_ADMIN_LEVEL) {
    return {
      clause: `(${prefix}tenant_id <=> ? OR ${prefix}tenant_id IS NULL)`,
      params: [actor.tenant_id ?? null],
    };
  }
  if (!tenantId) return { clause: '1 = 1', params: [] };
  if (!(await db.get('SELECT id FROM institutions WHERE id = ?', tenantId))) {
    throw unprocessable('Unknown college tenant.', [
      { field: 'tenantId', message: 'Pick a valid campus tenant.' },
    ]);
  }
  return { clause: `(${prefix}tenant_id = ?)`, params: [tenantId] };
}

/** Row-level companion to {@link userDirectoryScope} for single-account routes. */
export function assertDirectoryRowVisible(actor, row, resource = 'Account') {
  if (!row) return;
  if (Number(actor?.role_level ?? actor?.roleLevel ?? 0) >= SUPER_ADMIN_LEVEL) return;
  const tenant = row.tenant_id ?? null;
  if (tenant !== null && tenant !== (actor.tenant_id ?? null)) throw notFound(resource);
}

export default {
  operationalTenantScope,
  operationalEventScope,
  resolveOperationalTenant,
  assertCampusRowVisible,
  assertEventRowVisible,
  userDirectoryScope,
  assertDirectoryRowVisible,
};
