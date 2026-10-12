import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { ALERT_TYPES } from '../services/scanner.js';
import { getVisitorTotal } from '../services/visitors.js';
import { nptDay } from '../lib/time.js';
import { hub } from '../services/realtime.js';
import { activityQuerySchema } from '../validation/schemas.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Everything the executive dashboard needs in a single round trip, so the KPI
 * cards, fleet monitor, activity feed and alert panel can never disagree with
 * each other. Guarded by `dashboard:read` — attendants get all four.
 */
router.get(
  '/',
  requirePermission('dashboard:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();

    // ---- KPI 1 & 2: students + fleet capacity -----------------------------
    const students = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN onboard_bus_id IS NOT NULL THEN 1 ELSE 0 END) AS onboard,
                0 AS unallocated,
                SUM(CASE WHEN card_status = 'UNASSIGNED' THEN 1 ELSE 0 END) AS withoutCard,
                SUM(CASE WHEN card_status = 'ACTIVE' THEN 1 ELSE 0 END) AS activeCards,
                SUM(CASE WHEN card_status = 'REVOKED' THEN 1 ELSE 0 END) AS revokedCards
           FROM students`,
      )
      .get();

    const fleet = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS maintenance,
                SUM(CASE WHEN status = 'RETIRED' THEN 1 ELSE 0 END) AS retired,
                COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN seat_capacity ELSE 0 END), 0) AS activeCapacity
           FROM buses`,
      )
      .get();

    // ---- KPI 3: open security alerts --------------------------------------
    const alerts = db
      .prepare(
        `SELECT COUNT(*) AS open,
                SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
                SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) AS high,
                SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END) AS medium
           FROM alerts WHERE status IN ('OPEN', 'ACKNOWLEDGED')`,
      )
      .get();

    const last24h = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE created_at >= datetime('now', '-1 day')").get().n;

    // ---- KPI 4: live capacity utilisation ---------------------------------
    const onboard = students.onboard ?? 0;
    const activeCapacity = fleet.activeCapacity ?? 0;

    // ---- Today's movement --------------------------------------------------
    const today = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN direction = 'BOARD' THEN 1 ELSE 0 END) AS boards,
                SUM(CASE WHEN direction = 'DEBOARD' THEN 1 ELSE 0 END) AS alights,
                SUM(CASE WHEN outcome <> 'VALID' THEN 1 ELSE 0 END) AS rejected
           FROM scan_events WHERE date(scan_time) = date('now')`,
      )
      .get();

    // ---- Active fleet monitor ----------------------------------------------
    const visitorDay = nptDay();
    const fleetMonitor = db
      .prepare(
        `SELECT b.id, b.code, b.name, b.status, b.seat_capacity, b.current_route_id,
                r.code AS route_code, r.name AS route_name, r.color AS route_color,
                r.shift AS route_shift, r.departure_time, r.arrival_time,
                b.driver_name, b.driver_phone,
                (SELECT COUNT(*) FROM students s WHERE s.onboard_bus_id = b.id) AS occupancy,
                0 AS allocated,
                (SELECT COALESCE(SUM(v.count), 0) FROM visitor_counts v
                  WHERE v.bus_id = b.id AND v.day = ?) AS visitors
           FROM buses b LEFT JOIN routes r ON r.id = b.current_route_id
          ORDER BY b.code`,
      )
      .all(visitorDay)
      .map((bus) => {
        const occupancy = bus.occupancy ?? 0;
        return {
          id: bus.id,
          code: bus.code,
          name: bus.name,
          status: bus.status,
          seatCapacity: bus.seat_capacity,
          occupancy,
          allocated: bus.allocated ?? 0,
          visitors: bus.visitors ?? 0,
          utilization: bus.seat_capacity ? Math.round((occupancy / bus.seat_capacity) * 100) : 0,
          driverName: bus.driver_name,
          driverPhone: bus.driver_phone,
          route: bus.current_route_id
            ? {
                id: bus.current_route_id,
                code: bus.route_code,
                name: bus.route_name,
                color: bus.route_color,
                shift: bus.route_shift,
                departureTime: bus.departure_time,
                arrivalTime: bus.arrival_time,
              }
            : null,
        };
      });

    // ---- Activity feed (bootstrap snapshot; SSE takes over) ----------------
    const activity = db
      .prepare(
        `SELECT e.id, e.rfid_serial, e.student_id, e.direction, e.outcome, e.message,
                e.scan_time, e.latitude, e.longitude, e.gate, e.occupancy_after,
                s.full_name AS student_name, s.college_id,
                b.code AS bus_code, b.seat_capacity, r.code AS route_code
           FROM scan_events e
           LEFT JOIN students s ON s.id = e.student_id
           LEFT JOIN buses b    ON b.id = e.bus_id
           LEFT JOIN routes r   ON r.id = e.route_id
          ORDER BY e.id DESC LIMIT 40`,
      )
      .all()
      .map(mapActivity);

    // ---- Alert panel -------------------------------------------------------
    const recentAlerts = db
      .prepare(
        `SELECT a.id, a.type, a.severity, a.title, a.message, a.status, a.created_at,
                b.code AS bus_code, s.full_name AS student_name
           FROM alerts a
           LEFT JOIN buses b    ON b.id = a.bus_id
           LEFT JOIN students s ON s.id = a.student_id
          WHERE a.status IN ('OPEN', 'ACKNOWLEDGED')
          ORDER BY CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                                   WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,
                   a.id DESC
          LIMIT 12`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        type: row.type,
        typeLabel: ALERT_TYPES[row.type]?.label ?? row.type,
        tag: ALERT_TYPES[row.type]?.tag ?? 'system',
        severity: row.severity,
        title: row.title,
        message: row.message,
        status: row.status,
        busCode: row.bus_code,
        studentName: row.student_name,
        createdAt: row.created_at,
      }));

    // ---- 7-day movement for the sparkline ---------------------------------
    const trend = db
      .prepare(
        `SELECT date(scan_time) AS day,
                SUM(CASE WHEN direction = 'BOARD' THEN 1 ELSE 0 END) AS boards,
                SUM(CASE WHEN direction = 'DEBOARD' THEN 1 ELSE 0 END) AS alights,
                SUM(CASE WHEN outcome <> 'VALID' THEN 1 ELSE 0 END) AS rejected
           FROM scan_events WHERE scan_time >= datetime('now', '-6 days')
          GROUP BY day ORDER BY day`,
      )
      .all();

    res.json({
      success: true,
      data: {
        kpis: {
          students: {
            total: students.total ?? 0,
            active: students.active ?? 0,
            onboard: onboard,
            unallocated: students.unallocated ?? 0,
            withoutCard: students.withoutCard ?? 0,
            activeCards: students.activeCards ?? 0,
            revokedCards: students.revokedCards ?? 0,
          },
          fleet: {
            total: fleet.total ?? 0,
            active: fleet.active ?? 0,
            maintenance: fleet.maintenance ?? 0,
            retired: fleet.retired ?? 0,
            activeCapacity,
          },
          alerts: {
            open: alerts.open ?? 0,
            critical: alerts.critical ?? 0,
            high: alerts.high ?? 0,
            medium: alerts.medium ?? 0,
            last24h,
          },
          utilization: {
            onboard,
            capacity: activeCapacity,
            percent: activeCapacity ? Math.round((onboard / activeCapacity) * 100) : 0,
          },
          visitors: {
            today: getVisitorTotal(visitorDay),
          },
          today,
        },
        fleet: fleetMonitor,
        activity,
        alerts: recentAlerts,
        trend: trend.map((row) => ({
          day: row.day,
          label: row.day ? new Date(`${row.day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) : '',
          boards: row.boards ?? 0,
          alights: row.alights ?? 0,
          rejected: row.rejected ?? 0,
        })),
        realtime: hub.stats(),
        generatedAt: new Date().toISOString(),
      },
    });
  }),
);

function mapActivity(row) {
  return {
    id: row.id,
    rfidSerial: row.rfid_serial,
    studentId: row.student_id,
    studentName: row.student_name ?? 'Unknown card',
    collegeId: row.college_id,
    direction: row.direction,
    outcome: row.outcome,
    message: row.message,
    busCode: row.bus_code,
    routeCode: row.route_code,
    gate: row.gate,
    latitude: row.latitude,
    longitude: row.longitude,
    occupancy: row.occupancy_after,
    capacity: row.seat_capacity,
    scanTime: row.scan_time,
  };
}

/** Tail of the scan log — the Activity Feed polls this on mount, then SSE. */
router.get(
  '/activity',
  requirePermission('dashboard:read'),
  validate(activityQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT e.id, e.rfid_serial, e.student_id, e.direction, e.outcome, e.message,
                e.scan_time, e.latitude, e.longitude, e.gate, e.occupancy_after,
                s.full_name AS student_name, s.college_id,
                b.code AS bus_code, b.seat_capacity, r.code AS route_code
           FROM scan_events e
           LEFT JOIN students s ON s.id = e.student_id
           LEFT JOIN buses b    ON b.id = e.bus_id
           LEFT JOIN routes r   ON r.id = e.route_id
          ORDER BY e.id DESC LIMIT ?`,
      )
      .all(req.query.limit ?? 60);

    res.json({ success: true, data: { activity: rows.map(mapActivity) } });
  }),
);

export default router;
