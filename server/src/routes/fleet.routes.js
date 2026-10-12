import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { operationalTenantScope, resolveOperationalTenant, assertCampusRowVisible } from '../lib/tenantScope.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { getBusOccupancy } from '../services/scanner.js';
import hub from '../services/realtime.js';
import {
  createBusSchema,
  updateBusSchema,
  createRouteSchema,
  updateRouteSchema,
  stopsSchema,
  fleetQuerySchema,
  idSchema,
} from '../validation/schemas.js';

export const busesRouter = express.Router();
export const routesRouter = express.Router();

busesRouter.use(requireAuth);
routesRouter.use(requireAuth);

const BUS_COLUMNS = {
  code: 'code',
  registrationNo: 'registration_no',
  name: 'name',
  makeModel: 'make_model',
  seatCapacity: 'seat_capacity',
  driverUserId: 'driver_user_id',
  driverName: 'driver_name',
  driverPhone: 'driver_phone',
  driverLicense: 'driver_license',
  status: 'status',
  currentRouteId: 'current_route_id',
  odometerKm: 'odometer_km',
  lastServiceAt: 'last_service_at',
};

const ROUTE_COLUMNS = {
  code: 'code',
  name: 'name',
  description: 'description',
  startPoint: 'start_point',
  endPoint: 'end_point',
  shift: 'shift',
  departureTime: 'departure_time',
  arrivalTime: 'arrival_time',
  color: 'color',
  isActive: 'is_active',
};

function toColumns(body, map, { partial = false } = {}) {
  const entries = Object.entries(map)
    .filter(([key]) => (partial ? body[key] !== undefined : true))
    .map(([key, column]) => [column, body[key] ?? null]);
  return Object.fromEntries(entries);
}

function shapeBus(row) {
  const occupancy = row.occupancy ?? 0;
  return {
    id: row.id,
    code: row.code,
    registrationNo: row.registration_no,
    name: row.name,
    makeModel: row.make_model,
    seatCapacity: row.seat_capacity,
    driverUserId: row.driver_user_id,
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    driverLicense: row.driver_license,
    status: row.status,
    currentRouteId: row.current_route_id,
    routeCode: row.route_code ?? null,
    routeName: row.route_name ?? null,
    routeColor: row.route_color ?? null,
    routeShift: row.route_shift ?? null,
    departureTime: row.departure_time ?? null,
    arrivalTime: row.arrival_time ?? null,
    odometerKm: row.odometer_km,
    lastServiceAt: row.last_service_at,
    occupancy,
    assignedStudents: row.assigned_students ?? 0,
    utilization: row.seat_capacity ? Math.round((occupancy / row.seat_capacity) * 100) : 0,
    allocationPct: row.seat_capacity ? Math.round(((row.assigned_students ?? 0) / row.seat_capacity) * 100) : 0,
    onboard: occupancy > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeRoute(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    startPoint: row.start_point,
    endPoint: row.end_point,
    shift: row.shift,
    departureTime: row.departure_time,
    arrivalTime: row.arrival_time,
    color: row.color,
    isActive: Boolean(row.is_active),
    stopCount: row.stop_count ?? 0,
    busCount: row.bus_count ?? 0,
    studentCount: row.student_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ===========================================================================
// Buses
// ===========================================================================
busesRouter.get(
  '/',
  requirePermission('fleet:read'),
  validate(fleetQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { search, status, routeId } = req.query;

    const clauses = [];
    const params = [];
    if (search) {
      const term = `%${search}%`;
      clauses.push('(b.code LIKE ? OR b.name LIKE ? OR b.registration_no LIKE ? OR b.driver_name LIKE ?)');
      params.push(term, term, term, term);
    }
    if (status && status !== 'all') {
      clauses.push('b.status = ?');
      params.push(status);
    }
    if (routeId) {
      clauses.push('b.current_route_id = ?');
      params.push(routeId);
    }
    // Campus isolation: campus staff see their own campus, platform principals
    // only what they explicitly drill into via `tenantId`. The summary queries
    // read unaliased tables, so they get an unaliased scope of their own.
    const scope = operationalTenantScope(db, req.user, req.query, 'b');
    const scopeFlat = operationalTenantScope(db, req.user, req.query);
    clauses.push(scope.clause);
    params.push(...scope.params);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT b.*, r.code AS route_code, r.name AS route_name, r.color AS route_color,
                r.shift AS route_shift, r.departure_time, r.arrival_time,
                (SELECT COUNT(*) FROM students s WHERE s.onboard_bus_id = b.id) AS occupancy,
                0 AS assigned_students
           FROM buses b
           LEFT JOIN routes r ON r.id = b.current_route_id
           ${where}
          ORDER BY b.code ASC`,
      )
      .all(...params);

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS maintenance,
                SUM(seat_capacity) AS capacity
           FROM buses WHERE ${scopeFlat.clause}`,
      )
      .get(...scopeFlat.params);

    const onboard = db
      .prepare(`SELECT COUNT(*) AS n FROM students WHERE onboard_bus_id IS NOT NULL AND ${scopeFlat.clause}`)
      .get(...scopeFlat.params).n;

    res.json({
      success: true,
      data: {
        buses: rows.map(shapeBus),
        summary: {
          ...totals,
          onboard,
          utilization: totals.capacity ? Math.round((onboard / totals.capacity) * 100) : 0,
        },
      },
    });
  }),
);

busesRouter.get(
  '/:id',
  requirePermission('fleet:read'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db
      .prepare(
        `SELECT b.*, r.code AS route_code, r.name AS route_name, r.color AS route_color,
                r.shift AS route_shift, r.departure_time, r.arrival_time,
                (SELECT COUNT(*) FROM students s WHERE s.onboard_bus_id = b.id) AS occupancy,
                0 AS assigned_students
           FROM buses b LEFT JOIN routes r ON r.id = b.current_route_id
          WHERE b.id = ?`,
      )
      .get(id);
    if (!row) throw notFound('Bus');
    assertCampusRowVisible(req.user, row, 'Bus');

    const roster = db
      .prepare(
        `SELECT id, full_name, college_id, rfid_serial, onboard_at
           FROM students WHERE onboard_bus_id = ? ORDER BY onboard_at IS NULL, full_name LIMIT 100`,
      )
      .all(id);

    res.json({ success: true, data: { bus: shapeBus(row), roster } });
  }),
);

busesRouter.post(
  '/',
  requirePermission('fleet:create'),
  validate(createBusSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const body = { ...req.body };
    if (body.currentRouteId) {
      const route = db.prepare('SELECT id FROM routes WHERE id = ?').get(body.currentRouteId);
      if (!route) throw unprocessable('Unknown route.', [{ field: 'currentRouteId', message: 'Pick a valid route.' }]);
    }

    const dupCode = db.prepare('SELECT id FROM buses WHERE code = ?').get(body.code);
    if (dupCode) {
      throw conflict(`A bus with the code "${body.code}" already exists.`, [
        { field: 'code', message: `A bus with the code "${body.code}" already exists.` },
      ]);
    }
    const dupReg = body.registrationNo
      ? db.prepare('SELECT id FROM buses WHERE registration_no = ?').get(body.registrationNo)
      : null;
    if (dupReg) {
      throw conflict('A bus with this registration number already exists.', [
        { field: 'registrationNo', message: `"${body.registrationNo}" is already registered to another bus.` },
      ]);
    }

    const columns = { ...toColumns(body, BUS_COLUMNS), tenant_id: resolveOperationalTenant(db, req.user, body) };
    const keys = Object.keys(columns);
    const result = db
      .prepare(`INSERT INTO buses (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((key) => columns[key]));

    recordAudit(fromRequest(req, 'bus.create', { entity: 'bus', entityId: Number(result.lastInsertRowid), detail: { code: body.code } }));

    const row = db
      .prepare(
        `SELECT b.*, r.code AS route_code, r.name AS route_name FROM buses b
           LEFT JOIN routes r ON r.id = b.current_route_id WHERE b.id = ?`,
      )
      .get(Number(result.lastInsertRowid));

    res.status(201).json({ success: true, data: { bus: shapeBus({ ...row, occupancy: 0, assigned_students: 0 }) } });
  }),
);

busesRouter.patch(
  '/:id',
  requirePermission('fleet:edit'),
  validate(idSchema, 'params'),
  validate(updateBusSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM buses WHERE id = ?').get(id);
    if (!existing) throw notFound('Bus');
    assertCampusRowVisible(req.user, existing, 'Bus');

    const body = { ...req.body };
    if (body.currentRouteId) {
      const route = db.prepare('SELECT id FROM routes WHERE id = ?').get(body.currentRouteId);
      if (!route) throw unprocessable('Unknown route.', [{ field: 'currentRouteId', message: 'Pick a valid route.' }]);
    }

    if (body.code !== undefined) {
      const dup = db.prepare('SELECT id FROM buses WHERE code = ? AND id <> ?').get(body.code, id);
      if (dup) {
        throw conflict(`A bus with the code "${body.code}" already exists.`, [
          { field: 'code', message: `A bus with the code "${body.code}" already exists.` },
        ]);
      }
    }
    if (body.registrationNo !== undefined) {
      const dup = db.prepare('SELECT id FROM buses WHERE registration_no = ? AND id <> ?').get(body.registrationNo, id);
      if (dup) {
        throw conflict('A bus with this registration number already exists.', [
          { field: 'registrationNo', message: `"${body.registrationNo}" is already registered to another bus.` },
        ]);
      }
    }

    const columns = toColumns(body, BUS_COLUMNS, { partial: true });
    if (Object.keys(columns).length === 0) throw badRequest('Nothing to update.');

    if (body.seatCapacity !== undefined) {
      const assigned = 0;
      if (body.seatCapacity < assigned) {
        throw conflict(
          `${assigned} students are allocated to ${existing.code}; seat capacity cannot drop below that.`,
        );
      }
    }

    db.prepare(
      `UPDATE buses SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                        updated_at = datetime('now') WHERE id = ?`,
    ).run(...Object.values(columns), id);

    recordAudit(fromRequest(req, 'bus.update', { entity: 'bus', entityId: id, detail: { fields: Object.keys(columns) } }));

    const row = db
      .prepare(
        `SELECT b.*, r.code AS route_code, r.name AS route_name, r.color AS route_color,
                r.shift AS route_shift, r.departure_time, r.arrival_time,
                (SELECT COUNT(*) FROM students s WHERE s.onboard_bus_id = b.id) AS occupancy,
                0 AS assigned_students
           FROM buses b LEFT JOIN routes r ON r.id = b.current_route_id WHERE b.id = ?`,
      )
      .get(id);

    hub.broadcast('fleet', 'fleet:update', { busId: id, code: row.code, occupancy: row.occupancy, capacity: row.seat_capacity });
    res.json({ success: true, data: { bus: shapeBus(row) } });
  }),
);

busesRouter.delete(
  '/:id',
  requirePermission('fleet:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(id);
    if (!bus) throw notFound('Bus');
    assertCampusRowVisible(req.user, bus, 'Bus');

    const allocated = 0;
    if (allocated > 0) {
      throw conflict(
        `${bus.code} still has ${allocated} active student(s) allocated. Reassign them before deleting it.`,
      );
    }

    db.prepare('DELETE FROM buses WHERE id = ?').run(id);
    recordAudit(fromRequest(req, 'bus.delete', { entity: 'bus', entityId: id, detail: { code: bus.code } }));
    res.json({ success: true, data: { message: `${bus.code} removed from the fleet.` } });
  }),
);

// ===========================================================================
// Routes
// ===========================================================================
routesRouter.get(
  '/',
  requirePermission('fleet:read'),
  validate(fleetQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { search, status } = req.query;

    const clauses = [];
    const params = [];
    if (search) {
      const term = `%${search}%`;
      clauses.push('(r.code LIKE ? OR r.name LIKE ? OR r.start_point LIKE ? OR r.end_point LIKE ?)');
      params.push(term, term, term, term);
    }
    if (status && status !== 'all') {
      clauses.push('r.is_active = ?');
      params.push(status === 'active' ? 1 : 0);
    }
    // Campus isolation: campus staff see their own campus, platform principals
    // only what they explicitly drill into via `tenantId`.
    const scope = operationalTenantScope(db, req.user, req.query, 'r');
    clauses.push(scope.clause);
    params.push(...scope.params);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count,
                (SELECT COUNT(*) FROM buses b WHERE b.current_route_id = r.id) AS bus_count,
                0 AS student_count
           FROM routes r ${where}
          ORDER BY r.code ASC`,
      )
      .all(...params);

    res.json({ success: true, data: { routes: rows.map(shapeRoute) } });
  }),
);

routesRouter.get(
  '/:id',
  requirePermission('fleet:read'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count,
                (SELECT COUNT(*) FROM buses b WHERE b.current_route_id = r.id) AS bus_count,
                0 AS student_count
           FROM routes r WHERE r.id = ?`,
      )
      .get(Number(req.params.id));
    if (!row) throw notFound('Route');
    assertCampusRowVisible(req.user, row, 'Route');

    const stops = db
      .prepare('SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence')
      .all(row.id);
    const buses = db
      .prepare(
        `SELECT b.id, b.code, b.name, b.seat_capacity, b.status,
                (SELECT COUNT(*) FROM students s WHERE s.onboard_bus_id = b.id) AS occupancy
           FROM buses b WHERE b.current_route_id = ? ORDER BY b.code`,
      )
      .all(row.id);

    res.json({
      success: true,
      data: {
        route: shapeRoute(row),
        stops: stops.map((stop) => ({
          id: stop.id,
          sequence: stop.sequence,
          name: stop.name,
          scheduledTime: stop.scheduled_time,
          latitude: stop.latitude,
          longitude: stop.longitude,
        })),
        buses: buses.map((bus) => ({
          id: bus.id,
          code: bus.code,
          name: bus.name,
          seatCapacity: bus.seat_capacity,
          status: bus.status,
          occupancy: bus.occupancy,
          utilization: bus.seat_capacity ? Math.round((bus.occupancy / bus.seat_capacity) * 100) : 0,
        })),
      },
    });
  }),
);

routesRouter.post(
  '/',
  requirePermission('fleet:create'),
  validate(createRouteSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const body = req.body;
    const dupCode = db.prepare('SELECT id FROM routes WHERE code = ?').get(body.code);
    if (dupCode) {
      throw conflict('A route with this code already exists.', [
        { field: 'code', message: `"${body.code}" is already in use by another route.` },
      ]);
    }
    const dupName = db.prepare('SELECT id FROM routes WHERE name = ?').get(body.name);
    if (dupName) {
      throw conflict('A route with this name already exists.', [
        { field: 'name', message: `"${body.name}" is already in use by another route.` },
      ]);
    }

    const columns = { ...toColumns(body, ROUTE_COLUMNS), tenant_id: resolveOperationalTenant(db, req.user, body) };
    const keys = Object.keys(columns);
    const result = db
      .prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((key) => columns[key]));

    recordAudit(fromRequest(req, 'route.create', { entity: 'route', entityId: Number(result.lastInsertRowid), detail: { code: req.body.code } }));

    const row = db.prepare('SELECT r.*, 0 AS stop_count, 0 AS bus_count, 0 AS student_count FROM routes r WHERE r.id = ?').get(Number(result.lastInsertRowid));
    res.status(201).json({ success: true, data: { route: shapeRoute(row) } });
  }),
);

routesRouter.patch(
  '/:id',
  requirePermission('fleet:edit'),
  validate(idSchema, 'params'),
  validate(updateRouteSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
    if (!existing) throw notFound('Route');
    assertCampusRowVisible(req.user, existing, 'Route');

    const body = req.body;
    if (body.code !== undefined) {
      const dup = db.prepare('SELECT id FROM routes WHERE code = ? AND id <> ?').get(body.code, id);
      if (dup) {
        throw conflict('A route with this code already exists.', [
          { field: 'code', message: `"${body.code}" is already in use by another route.` },
        ]);
      }
    }
    if (body.name !== undefined) {
      const dup = db.prepare('SELECT id FROM routes WHERE name = ? AND id <> ?').get(body.name, id);
      if (dup) {
        throw conflict('A route with this name already exists.', [
          { field: 'name', message: `"${body.name}" is already in use by another route.` },
        ]);
      }
    }

    const columns = toColumns(body, ROUTE_COLUMNS, { partial: true });
    if (Object.keys(columns).length === 0) throw badRequest('Nothing to update.');

    db.prepare(
      `UPDATE routes SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                        updated_at = datetime('now') WHERE id = ?`,
    ).run(...Object.values(columns), id);

    recordAudit(fromRequest(req, 'route.update', { entity: 'route', entityId: id, detail: { fields: Object.keys(columns) } }));

    const row = db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count,
                (SELECT COUNT(*) FROM buses b WHERE b.current_route_id = r.id) AS bus_count,
                0 AS student_count
           FROM routes r WHERE r.id = ?`,
      )
      .get(id);

    res.json({ success: true, data: { route: shapeRoute(row) } });
  }),
);

routesRouter.delete(
  '/:id',
  requirePermission('fleet:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
    if (!route) throw notFound('Route');
    assertCampusRowVisible(req.user, route, 'Route');

    const buses = db.prepare('SELECT COUNT(*) AS n FROM buses WHERE current_route_id = ?').get(id).n;
    if (buses > 0) {
      throw conflict(`${route.code} is still referenced by ${buses} bus(es).`);
    }

    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    recordAudit(fromRequest(req, 'route.delete', { entity: 'route', entityId: id, detail: { code: route.code } }));
    res.json({ success: true, data: { message: `${route.code} removed.` } });
  }),
);

/** Replace the whole stop list — the editor sends the ordered array. */
routesRouter.put(
  '/:id/stops',
  requirePermission('fleet:edit'),
  validate(idSchema, 'params'),
  validate(stopsSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const routeId = Number(req.params.id);
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
    if (!route) throw notFound('Route');
    assertCampusRowVisible(req.user, route, 'Route');

    const sequences = req.body.stops.map((stop) => stop.sequence);
    if (new Set(sequences).size !== sequences.length) {
      throw unprocessable('Stop sequence numbers must be unique.', [{ field: 'stops', message: 'Duplicate stop sequence numbers.' }]);
    }

    db.transaction(() => {
      db.prepare('DELETE FROM route_stops WHERE route_id = ?').run(routeId);
      const insert = db.prepare(
        `INSERT INTO route_stops (route_id, sequence, name, scheduled_time, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const stop of [...req.body.stops].sort((a, b) => a.sequence - b.sequence)) {
        insert.run(routeId, stop.sequence, stop.name, stop.scheduledTime ?? null, stop.latitude ?? null, stop.longitude ?? null);
      }
    });

    recordAudit(fromRequest(req, 'route.stops_update', { entity: 'route', entityId: routeId, detail: { count: req.body.stops.length } }));

    const stops = db.prepare('SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence').all(routeId);
    res.json({
      success: true,
      data: {
        stops: stops.map((stop) => ({
          id: stop.id,
          sequence: stop.sequence,
          name: stop.name,
          scheduledTime: stop.scheduled_time,
          latitude: stop.latitude,
          longitude: stop.longitude,
        })),
      },
    });
  }),
);

export default { busesRouter, routesRouter };
