import { getDb } from '../db/connection.js';
import hub from './realtime.js';
import { nptDay, formatNpt, toNptStamp } from '../lib/time.js';

/**
 * Visitor button roll-up.
 *
 * The Wokwi reader's green button is a head-count, not an attendance event: a
 * press increments a counter bucketed by bus, route and **Nepal** calendar day.
 * The `scope_key` materialises those three fields so the upsert works even when
 * a press arrives without a resolvable bus (NULL ids never collide in SQL).
 */
export async function recordVisitorPress({ busId = null, routeId = null, deviceId = null, at = null } = {}) {
  const db = getDb();
  const occurredAt = toNptStamp(at);
  const day = nptDay(occurredAt ?? new Date());
  const scopeKey = `${busId ?? 0}:${routeId ?? 0}:${day}`;

  const row = await db.transaction(async () => {
    await db.run(
      `INSERT INTO visitor_counts (scope_key, bus_id, route_id, device_id, day, count, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, 1,
               COALESCE(?, NOW()),
               COALESCE(?, NOW()))
       ON DUPLICATE KEY UPDATE
         count      = count + 1,
         device_id  = COALESCE(VALUES(device_id), visitor_counts.device_id),
         last_at    = COALESCE(VALUES(last_at), NOW()),
         updated_at = NOW()`,
      scopeKey, busId, routeId, deviceId, day, occurredAt, occurredAt,
    );

    return db.get(
      `SELECT v.*, b.code AS bus_code, b.name AS bus_name, b.tenant_id AS bus_tenant_id,
              r.code AS route_code, r.name AS route_name
         FROM visitor_counts v
         LEFT JOIN buses b  ON b.id = v.bus_id
         LEFT JOIN routes r ON r.id = v.route_id
        WHERE v.scope_key = ?`,
      scopeKey,
    );
  });

  const shaped = shapeVisitorCount(row);
  // Visitor counts are anonymous, but they still name a campus's bus — fan the
  // tick out to that campus only (NULL bus → campus-neutral system event).
  hub.broadcast('visitor', 'visitor', shaped, row?.bus_tenant_id ?? null);
  return shaped;
}

/** Canonical client-facing shape for a visitor counter row. */
export function shapeVisitorCount(row) {
  if (!row) return null;
  return {
    id: row.id,
    busId: row.bus_id,
    busCode: row.bus_code ?? null,
    busName: row.bus_name ?? null,
    routeId: row.route_id,
    routeCode: row.route_code ?? null,
    routeName: row.route_name ?? null,
    deviceId: row.device_id ?? null,
    day: row.day,
    count: row.count,
    firstAt: row.first_at,
    lastAt: row.last_at,
    // Same instant as `lastAt`, rendered in Nepal Time for the live feed.
    lastAtNpt: formatNpt(row.last_at),
  };
}

/**
 * Current visitor total for a Nepal calendar day (defaults to today).
 *
 * `visitor_counts` has no tenant column of its own — visitors are anonymous
 * headcounts tied to a bus — so an optional `scope` (from
 * `operationalTenantScope(db, actor, query, 'b')`) narrows the total through a
 * bus join. Without it the total stays platform-wide.
 */
export async function getVisitorTotal(day = nptDay(), scope = null) {
  const db = getDb();
  if (!scope) {
    const row = await db.get(
      'SELECT COALESCE(SUM(count), 0) AS total FROM visitor_counts WHERE day = ?',
      day,
    );
    return row.total;
  }
  const row = await db.get(
    `SELECT COALESCE(SUM(v.count), 0) AS total
       FROM visitor_counts v
       JOIN buses b ON b.id = v.bus_id
      WHERE v.day = ? AND ${scope.clause}`,
    day,
    ...scope.params,
  );
  return row.total;
}

export default { recordVisitorPress, shapeVisitorCount, getVisitorTotal };
