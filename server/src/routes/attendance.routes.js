import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { toCsv, timestampedFilename } from '../lib/csv.js';
import { buildReportPdf, OUTCOME_TONES } from '../lib/pdf.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { shapeScanEvent } from '../services/scanner.js';
import { attendanceQuerySchema, demandQuerySchema } from '../validation/schemas.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_SCAN = `
  SELECT e.id, e.rfid_serial, e.student_id, e.bus_id, e.route_id, e.direction, e.outcome,
         e.message, e.latitude, e.longitude, e.gate, e.occupancy_after, e.scan_time,
         s.full_name AS student_name, s.college_id, s.faculty,
         b.code AS bus_code, b.name AS bus_name, b.seat_capacity,
         r.code AS route_code, r.name AS route_name
    FROM scan_events e
    LEFT JOIN students s ON s.id = e.student_id
    LEFT JOIN buses b    ON b.id = e.bus_id
    LEFT JOIN routes r   ON r.id = e.route_id
`;

// Scan rows are shaped by the scanner service so the simulator, the history
// table and the SSE live board cannot drift apart.
const shapeScan = shapeScanEvent;

/** Shared filter compiler for the list view and both export formats. */
function buildFilters(query) {
  const clauses = [];
  const params = [];

  if (query.from) {
    clauses.push('e.scan_time >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    clauses.push('e.scan_time <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  if (query.busId) {
    clauses.push('e.bus_id = ?');
    params.push(query.busId);
  }
  if (query.routeId) {
    clauses.push('e.route_id = ?');
    params.push(query.routeId);
  }
  if (query.outcome && query.outcome !== 'all') {
    clauses.push('e.outcome = ?');
    params.push(query.outcome);
  }
  if (query.direction && query.direction !== 'all') {
    clauses.push('e.direction = ?');
    params.push(query.direction);
  }
  if (query.search) {
    const term = `%${query.search}%`;
    clauses.push('(e.rfid_serial LIKE ? OR s.full_name LIKE ? OR s.college_id LIKE ? OR b.code LIKE ? OR r.code LIKE ?)');
    params.push(term, term, term, term, term);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const SORT_MAP = {
  time: 'e.scan_time',
  student: 's.full_name',
  bus: 'b.code',
  outcome: 'e.outcome',
};

// ---------------------------------------------------------------------------
// Scan log
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('attendance:read'),
  validate(attendanceQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { where, params } = buildFilters(req.query);
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 1000 });

    const direction = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const orderBy = SORT_MAP[req.query.sort] ?? 'e.scan_time';

    const rows = db
      .prepare(`${SELECT_SCAN} ${where} ORDER BY ${orderBy} ${direction}, e.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM scan_events e LEFT JOIN students s ON s.id = e.student_id LEFT JOIN buses b ON b.id = e.bus_id LEFT JOIN routes r ON r.id = e.route_id ${where}`)
      .get(...params).n;

    const counts = db
      .prepare(
        `SELECT e.outcome, COUNT(*) AS n FROM scan_events e
           LEFT JOIN students s ON s.id = e.student_id
           LEFT JOIN buses b ON b.id = e.bus_id
           LEFT JOIN routes r ON r.id = e.route_id
         ${where} GROUP BY e.outcome`,
      )
      .all(...params)
      .reduce((acc, row) => ({ ...acc, [row.outcome]: row.n }), {});

    res.json({
      success: true,
      data: {
        scans: rows.map(shapeScan),
        meta: paginationMeta({ total, limit, page }),
        counts,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Seat-demand analytics for resource planning
// ---------------------------------------------------------------------------
router.get(
  '/demand',
  requirePermission('attendance:read'),
  validate(demandQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const days = req.query.days ?? 14;

    const clauses = [];
    const params = [];
    if (req.query.busId) {
      clauses.push('e.bus_id = ?');
      params.push(req.query.busId);
    }
    if (req.query.routeId) {
      clauses.push('e.route_id = ?');
      params.push(req.query.routeId);
    }
    const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const daily = db
      .prepare(
        `SELECT date(e.scan_time) AS day,
                SUM(CASE WHEN e.direction = 'BOARD' THEN 1 ELSE 0 END) AS boards,
                SUM(CASE WHEN e.direction = 'DEBOARD' THEN 1 ELSE 0 END) AS alights,
                COUNT(*) AS total,
                MAX(e.occupancy_after) AS peak
           FROM scan_events e
          WHERE e.outcome = 'VALID' AND date(e.scan_time) >= date('now', ?)
            ${where}
          GROUP BY day ORDER BY day`,
      )
      .all(`-${days} days`, ...params);

    const byBus = db
      .prepare(
        `SELECT b.id AS bus_id, b.code AS bus_code, b.name AS bus_name, b.seat_capacity,
                COUNT(CASE WHEN e.direction = 'BOARD' THEN 1 END) AS boards,
                MAX(e.occupancy_after) AS peak,
                ROUND(AVG(CASE WHEN e.direction = 'BOARD' THEN 1 END), 1) AS avg_daily_boards
           FROM scan_events e JOIN buses b ON b.id = e.bus_id
          WHERE e.outcome = 'VALID' AND date(e.scan_time) >= date('now', ?)
            ${where}
          GROUP BY b.id ORDER BY boards DESC`,
      )
      .all(`-${days} days`, ...params);

    const byRoute = db
      .prepare(
        `SELECT r.id AS route_id, r.code AS route_code, r.name AS route_name, r.color,
                COUNT(CASE WHEN e.direction = 'BOARD' THEN 1 END) AS boards,
                MAX(e.occupancy_after) AS peak
           FROM scan_events e JOIN routes r ON r.id = e.route_id
          WHERE e.outcome = 'VALID' AND date(e.scan_time) >= date('now', ?)
            ${where}
          GROUP BY r.id ORDER BY boards DESC LIMIT 12`,
      )
      .all(`-${days} days`, ...params);

    const hourOfDay = db
      .prepare(
        `SELECT strftime('%H', e.scan_time) AS hour,
                SUM(CASE WHEN e.direction = 'BOARD' THEN 1 ELSE 0 END) AS boards,
                COUNT(*) AS total
           FROM scan_events e
          WHERE e.outcome = 'VALID' AND date(e.scan_time) >= date('now', ?)
            ${where}
          GROUP BY hour ORDER BY hour`,
      )
      .all(`-${days} days`, ...params);

    const totalCapacity = db.prepare("SELECT COALESCE(SUM(seat_capacity), 0) AS n FROM buses WHERE status = 'ACTIVE'").get().n;
    const peakOverall = daily.reduce((max, row) => Math.max(max, row.peak ?? 0), 0);

    res.json({
      success: true,
      data: {
        range: { days, from: new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
        daily: daily.map((row) => ({
          day: row.day,
          label: row.day ? new Date(`${row.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '',
          boards: row.boards ?? 0,
          alights: row.alights ?? 0,
          total: row.total ?? 0,
          peak: row.peak ?? 0,
          utilization: totalCapacity ? Math.round(((row.peak ?? 0) / totalCapacity) * 100) : 0,
        })),
        byBus: byBus.map((row) => ({
          busId: row.bus_id,
          code: row.bus_code,
          name: row.bus_name,
          capacity: row.seat_capacity,
          boards: row.boards ?? 0,
          peak: row.peak ?? 0,
          avgDailyBoards: row.avg_daily_boards ?? 0,
          utilization: row.seat_capacity ? Math.round(((row.peak ?? 0) / row.seat_capacity) * 100) : 0,
        })),
        byRoute: byRoute.map((row) => ({
          routeId: row.route_id,
          code: row.route_code,
          name: row.route_name,
          color: row.color,
          boards: row.boards ?? 0,
          peak: row.peak ?? 0,
        })),
        hourOfDay: hourOfDay.map((row) => ({ hour: row.hour, boards: row.boards ?? 0, total: row.total ?? 0 })),
        totals: {
          activeCapacity: totalCapacity,
          peakOccupancy: peakOverall,
          peakUtilization: totalCapacity ? Math.round((peakOverall / totalCapacity) * 100) : 0,
        },
      },
    });
  }),
);

/** Headline counters for the attendance page header. */
router.get(
  '/summary',
  requirePermission('attendance:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const today = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'VALID' THEN 1 ELSE 0 END) AS valid,
                SUM(CASE WHEN outcome <> 'VALID' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN direction = 'BOARD' THEN 1 ELSE 0 END) AS boards
           FROM scan_events WHERE date(scan_time) = date('now')`,
      )
      .get();

    const week = db
      .prepare(
        `SELECT date(scan_time) AS day, COUNT(*) AS total
           FROM scan_events WHERE scan_time >= datetime('now', '-6 days')
          GROUP BY day ORDER BY day`,
      )
      .all();

    const topStudents = db
      .prepare(
        `SELECT s.id, s.full_name, s.college_id, COUNT(*) AS trips
           FROM scan_events e JOIN students s ON s.id = e.student_id
          WHERE e.outcome = 'VALID' AND e.scan_time >= datetime('now', '-29 days')
          GROUP BY s.id ORDER BY trips DESC LIMIT 10`,
      )
      .all();

    res.json({
      success: true,
      data: {
        today,
        week: week.map((row) => ({ day: row.day, total: row.total })),
        topStudents: topStudents.map((row) => ({ id: row.id, fullName: row.full_name, collegeId: row.college_id, trips: row.trips })),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Exports — gated behind attendance:export
// ---------------------------------------------------------------------------
const EXPORT_COLUMNS = [
  { key: 'scan_time', label: 'Timestamp', format: (value) => String(value ?? '').replace('T', ' ').slice(0, 19) },
  { key: 'student_name', label: 'Student', format: (value) => value ?? 'Unknown card' },
  { key: 'college_id', label: 'College ID', format: (value) => value ?? '—' },
  { key: 'rfid_serial', label: 'RFID Serial' },
  { key: 'direction', label: 'Direction' },
  { key: 'outcome', label: 'Outcome', tone: (value) => OUTCOME_TONES[value] ?? '#0F172A' },
  { key: 'bus_code', label: 'Bus', format: (value) => value ?? '—' },
  { key: 'route_code', label: 'Route', format: (value) => value ?? '—' },
  { key: 'occupancy_after', label: 'Occupancy', format: (value) => (value == null ? '—' : value) },
  { key: 'gate', label: 'Gate', format: (value) => value ?? '—' },
  { key: 'latitude', label: 'Lat', format: (value) => (value == null ? '—' : Number(value).toFixed(5)) },
  { key: 'longitude', label: 'Lng', format: (value) => (value == null ? '—' : Number(value).toFixed(5)) },
  { key: 'message', label: 'Detail', format: (value) => value ?? '' },
];

function fetchExportRows(db, query, limit = 5000) {
  const { where, params } = buildFilters(query);
  return db
    .prepare(`${SELECT_SCAN} ${where} ORDER BY e.scan_time DESC LIMIT ?`)
    .all(...params, limit);
}

router.get(
  '/export',
  requirePermission('attendance:export'),
  validate(attendanceQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const format = req.query.format ?? 'csv';
    const rows = fetchExportRows(db, req.query);
    const shaped = rows.map(shapeScan);

    const institution =
      db.prepare("SELECT value FROM system_meta WHERE key = 'institution_name'").get()?.value ?? 'TransitSync';

    recordAudit(
      fromRequest(req, 'attendance.export', {
        entity: 'scan_events',
        detail: { format, rows: shaped.length, filters: req.query },
      }),
    );

    const label = req.query.from && req.query.to ? `${req.query.from}_to_${req.query.to}` : 'all-dates';

    if (format === 'csv') {
      const csv = toCsv(
        EXPORT_COLUMNS.map((column) => ({
          key: column.key,
          label: column.label,
          format: column.format,
        })),
        shaped,
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${timestampedFilename(`transitsync-attendance-${label}`, 'csv')}"`);
      return res.send(csv);
    }

    if (format === 'pdf') {
      const rejected = shaped.filter((row) => row.outcome !== 'VALID').length;
      const buffer = await buildReportPdf({
        institution,
        title: 'RFID Attendance & Scan Log Report',
        subtitle: `Filters — ${describeFilters(req.query)}`,
        summary: [
          { label: 'Total scans', value: shaped.length },
          { label: 'Accepted', value: shaped.length - rejected },
          { label: 'Rejected', value: rejected },
          { label: 'Unique students', value: new Set(shaped.map((row) => row.studentId).filter(Boolean)).size },
        ],
        columns: EXPORT_COLUMNS,
        rows: shaped,
        footerNote: `${institution} — Confidential attendance export generated by TransitSync.`,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${timestampedFilename(`transitsync-attendance-${label}`, 'pdf')}"`);
      return res.send(buffer);
    }

    return res.json({ success: true, data: { scans: shaped, count: shaped.length } });
  }),
);

function describeFilters(query) {
  const parts = [];
  if (query.from || query.to) parts.push(`dates ${query.from ?? 'start'} to ${query.to ?? 'today'}`);
  if (query.busId) parts.push(`bus #${query.busId}`);
  if (query.routeId) parts.push(`route #${query.routeId}`);
  if (query.outcome && query.outcome !== 'all') parts.push(`outcome ${query.outcome}`);
  if (query.direction && query.direction !== 'all') parts.push(`direction ${query.direction}`);
  return parts.length ? parts.join(', ') : 'no filters (full log)';
}

export default router;
