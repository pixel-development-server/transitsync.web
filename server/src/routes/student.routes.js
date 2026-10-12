/**
 * Student self-service portal (read-only).
 *
 * Every route here is scoped to the *signed-in* student: there is no id in the
 * path, so a rider can only ever read their own record. Mounted behind
 * `requireStudent`, which admits the Level 1 `student` role and nothing else.
 */

import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { requireAuth, requireStudent } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth, requireStudent);

/** Compact descriptor for the bus a rider is currently assigned or aboard. */
function busView(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    registrationNo: row.registration_no,
    makeModel: row.make_model ?? null,
    seatCapacity: row.seat_capacity ?? null,
    status: row.status ?? null,
    driverName: row.driver_name ?? null,
    driverPhone: row.driver_phone ?? null,
  };
}

/**
 * Derive the live badge from two sources: the roster's `onboard_*` columns
 * (authoritative while the rider is on a bus) and the most recent RFID scan.
 */
function liveStatus(db, student) {
  const onboard = student.onboard_bus_id
    ? db.prepare('SELECT * FROM buses WHERE id = ?').get(student.onboard_bus_id)
    : null;

  const lastScan = db
    .prepare(
      `SELECT e.scan_time, e.direction, e.outcome, e.message, e.gate,
              e.bus_id, b.code AS bus_code, b.name AS bus_name
         FROM scan_events e LEFT JOIN buses b ON b.id = e.bus_id
        WHERE e.student_id = ?
        ORDER BY e.scan_time DESC, e.id DESC LIMIT 1`,
    )
    .get(student.id);

  if (onboard) {
    return {
      state: 'ON_BOARD',
      label: `On board ${onboard.code ?? onboard.name}`,
      tone: 'good',
      since: student.onboard_at ?? null,
      bus: busView(onboard),
      lastScan: scanView(lastScan),
    };
  }

  const boarded = String(lastScan?.direction ?? '').toUpperCase() === 'BOARD';
  if (lastScan) {
    return {
      state: boarded ? 'BOARDED' : 'OFF_BOARD',
      label: boarded ? 'Boarded this shift' : 'Stepped off',
      tone: boarded ? 'info' : 'neutral',
      since: lastScan.scan_time,
      bus: null,
      lastScan: scanView(lastScan),
    };
  }

  return { state: 'IDLE', label: 'No scans yet', tone: 'neutral', since: null, bus: null, lastScan: null };
}

/** Compact descriptor for the most recent RFID scan. */
function scanView(row) {
  if (!row) return null;
  return {
    at: row.scan_time,
    direction: row.direction,
    outcome: row.outcome,
    message: row.message ?? null,
    gate: row.gate ?? null,
    busCode: row.bus_code ?? null,
    busName: row.bus_name ?? null,
  };
}

/** GET /api/student/me — the signed-in rider's route, bus and live state. */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const db = getDb();

    const student = db
      .prepare(
        `SELECT s.*, i.name AS college_name, i.code AS college_code
           FROM students s LEFT JOIN institutions i ON i.id = s.tenant_id
          WHERE s.user_id = ?`,
      )
      .get(req.user.id);

    if (!student) {
      throw notFound('Student record');
    }

    const route = student.route_id
      ? db
          .prepare(
            `SELECT id, code, name, description, start_point, end_point, shift,
                    departure_time, arrival_time, color, is_active, tenant_id
               FROM routes WHERE id = ?`,
          )
          .get(student.route_id)
      : null;

    const stops = route
      ? db
          .prepare(
            'SELECT name, sequence, scheduled_time FROM route_stops WHERE route_id = ? ORDER BY sequence',
          )
          .all(route.id)
      : [];

    // Prefer the explicitly assigned bus; otherwise fall back to whichever bus is
    // currently running the rider's route.
    const bus = route
      ? db
          .prepare(
            "SELECT * FROM buses WHERE current_route_id = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1",
          )
          .get(route.id)
      : null;

    const pass =
      student.bus_pass_no || student.card_status
        ? {
            number: student.bus_pass_no ?? null,
            validFrom: student.pass_valid_from ?? null,
            validTo: student.pass_valid_to ?? null,
            cardStatus: student.card_status ?? null,
            cardIssuedAt: student.card_issued_at ?? null,
          }
        : null;

    res.json({
      success: true,
      data: {
        student: {
          id: student.id,
          studentCode: student.bus_pass_no ?? `STU-${String(student.id).padStart(4, '0')}`,
          fullName: student.full_name,
          email: student.email ?? req.user.email,
          phone: student.phone ?? null,
          faculty: student.faculty ?? null,
          program: student.program ?? null,
          semester: student.semester ?? null,
          status: student.status,
          pickupStop: null,
        },
        college: student.tenant_id
          ? { name: student.college_name ?? null, code: student.college_code ?? null }
          : null,
        route: route
          ? {
              id: route.id,
              code: route.code,
              name: route.name,
              description: route.description ?? null,
              startPoint: route.start_point,
              endPoint: route.end_point,
              shift: route.shift,
              departureTime: route.departure_time,
              arrivalTime: route.arrival_time,
              color: route.color ?? null,
              isActive: Boolean(route.is_active),
              stops: stops.map((stop) => ({
                name: stop.name,
                sequence: stop.sequence,
                scheduledTime: stop.scheduled_time ?? null,
              })),
            }
          : null,
        bus: busView(bus),
        pass,
        live: liveStatus(db, student),
      },
    });
  }),
);

/**
 * GET /api/student/routes — live, read-only schedule board.
 *
 * The portal is route-centric: students browse every active route and the bus
 * currently running it, so staff never have to assign a student to a route by
 * hand. Scoped to the rider's own campus when the roster row carries a tenant;
 * otherwise the shared (tenant-less) route set is shown.
 */
router.get(
  '/routes',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const me = db.prepare('SELECT id, tenant_id FROM students WHERE user_id = ?').get(req.user.id);
    const tenant = me?.tenant_id ?? null;

    const rows = db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count,
                (SELECT COUNT(*) FROM buses b WHERE b.current_route_id = r.id AND b.status = 'ACTIVE') AS bus_count
           FROM routes r
          WHERE r.is_active = 1
            AND (? IS NULL OR r.tenant_id IS NULL OR r.tenant_id = ?)
          ORDER BY r.code ASC`,
      )
      .all(tenant, tenant);

    const routes = rows.map((row) => {
      const stops = db
        .prepare('SELECT name, sequence, scheduled_time FROM route_stops WHERE route_id = ? ORDER BY sequence')
        .all(row.id);
      const buses = db
        .prepare(
          `SELECT b.id, b.code, b.name, b.registration_no, b.seat_capacity, b.status,
                  b.driver_name, b.driver_phone,
                  (SELECT COUNT(*) FROM students s
                    WHERE s.onboard_bus_id = b.id AND s.status = 'ACTIVE') AS occupancy
             FROM buses b
            WHERE b.current_route_id = ? AND b.status = 'ACTIVE'
            ORDER BY b.code ASC`,
        )
        .all(row.id);

      return {
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description ?? null,
        startPoint: row.start_point,
        endPoint: row.end_point,
        shift: row.shift,
        departureTime: row.departure_time,
        arrivalTime: row.arrival_time,
        color: row.color ?? null,
        stopCount: row.stop_count,
        isMine: Boolean(me?.route_id && me.route_id === row.id),
        stops: stops.map((stop) => ({
          name: stop.name,
          sequence: stop.sequence,
          scheduledTime: stop.scheduled_time ?? null,
        })),
        buses: buses.map((bus) => {
          const capacity = Number(bus.seat_capacity ?? 0);
          const occupancy = Number(bus.occupancy ?? 0);
          return {
            id: bus.id,
            code: bus.code,
            name: bus.name,
            registrationNo: bus.registration_no,
            seatCapacity: capacity,
            status: bus.status,
            driverName: bus.driver_name ?? null,
            driverPhone: bus.driver_phone ?? null,
            occupancy,
            utilization: capacity > 0 ? Math.round((occupancy / capacity) * 100) : 0,
            onBoard: occupancy > 0,
          };
        }),
      };
    });

    res.json({ success: true, data: { routes } });
  }),
);

export default router;
