import { getDb } from '../db/connection.js';
import hub from './realtime.js';
import { nptDay, formatNpt, toUtcSqlite } from '../lib/time.js';

/**
 * Visitor button roll-up.
 *
 * The Wokwi reader's green button is a head-count, not an attendance event: a
 * press increments a counter bucketed by bus, route and **Nepal** calendar day.
 * The `scope_key` materialises those three fields so the upsert works even when
 * a press arrives without a resolvable bus (NULL ids never collide in SQL).
 */
export function recordVisitorPress({ busId = null, routeId = null, deviceId = null, at = null } = {}) {
  const db = getDb();
  const occurredAt = toUtcSqlite(at);
  const day = nptDay(occurredAt ?? new Date());
  const scopeKey = `${busId ?? 0}:${routeId ?? 0}:${day}`;

  const row = db.transaction(() => {
    db.prepare(
      `INSERT INTO visitor_counts (scope_key, bus_id, route_id, device_id, day, count, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, 1,
               COALESCE(?, datetime('now')),
               COALESCE(?, datetime('now')))
       ON CONFLICT(scope_key) DO UPDATE SET
         count      = count + 1,
         device_id  = COALESCE(excluded.device_id, visitor_counts.device_id),
         last_at    = COALESCE(excluded.last_at, datetime('now')),
         updated_at = datetime('now')`,
    ).run(scopeKey, busId, routeId, deviceId, day, occurredAt, occurredAt);

    return db
      .prepare(
        `SELECT v.*, b.code AS bus_code, b.name AS bus_name, r.code AS route_code, r.name AS route_name
           FROM visitor_counts v
           LEFT JOIN buses b  ON b.id = v.bus_id
           LEFT JOIN routes r ON r.id = v.route_id
          WHERE v.scope_key = ?`,
      )
      .get(scopeKey);
  });

  const shaped = shapeVisitorCount(row);
  hub.broadcast('visitor', 'visitor', shaped);
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

/** Current visitor total for a Nepal calendar day (defaults to today). */
export function getVisitorTotal(day = nptDay()) {
  const db = getDb();
  return db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM visitor_counts WHERE day = ?')
    .get(day).total;
}

export default { recordVisitorPress, shapeVisitorCount, getVisitorTotal };
