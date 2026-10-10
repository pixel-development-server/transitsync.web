import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { conflict, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { ALERT_TYPES, createManualAlert } from '../services/scanner.js';
import hub from '../services/realtime.js';
import { alertQuerySchema, resolveAlertSchema, idSchema } from '../validation/schemas.js';
import { z } from 'zod';

const router = express.Router();
router.use(requireAuth);

const SELECT_ALERT = `
  SELECT a.*,
         s.full_name AS student_name, s.college_id,
         b.code AS bus_code, b.name AS bus_name,
         r.code AS route_code, r.name AS route_name,
         ack.full_name AS acknowledged_by_name,
         res.full_name AS resolved_by_name
    FROM alerts a
    LEFT JOIN students s ON s.id = a.student_id
    LEFT JOIN buses b    ON b.id = a.bus_id
    LEFT JOIN routes r   ON r.id = a.route_id
    LEFT JOIN users ack  ON ack.id = a.acknowledged_by
    LEFT JOIN users res  ON res.id = a.resolved_by
`;

function shapeAlert(row) {
  return {
    id: row.id,
    type: row.type,
    typeLabel: ALERT_TYPES[row.type]?.label ?? row.type,
    tag: ALERT_TYPES[row.type]?.tag ?? 'system',
    severity: row.severity,
    title: row.title,
    message: row.message,
    status: row.status,
    studentId: row.student_id,
    studentName: row.student_name,
    collegeId: row.college_id,
    busId: row.bus_id,
    busCode: row.bus_code,
    routeId: row.route_id,
    routeCode: row.route_code,
    scanEventId: row.scan_event_id,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedByName: row.acknowledged_by_name,
    acknowledgedAt: row.acknowledged_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  };
}

router.get(
  '/',
  requirePermission('alerts:read'),
  validate(alertQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { status, severity, type, search, from } = req.query;
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25 });

    const clauses = [];
    const params = [];
    if (status && status !== 'all') {
      clauses.push('a.status = ?');
      params.push(status);
    }
    if (severity && severity !== 'all') {
      clauses.push('a.severity = ?');
      params.push(severity);
    }
    if (type) {
      clauses.push('a.type = ?');
      params.push(type);
    }
    if (from) {
      clauses.push('a.created_at >= ?');
      params.push(from);
    }
    if (search) {
      const term = `%${search}%`;
      clauses.push('(a.title LIKE ? OR a.message LIKE ? OR s.full_name LIKE ? OR b.code LIKE ?)');
      params.push(term, term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db.prepare(`${SELECT_ALERT} ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM alerts a LEFT JOIN students s ON s.id = a.student_id LEFT JOIN buses b ON b.id = a.bus_id ${where}`).get(...params).n;

    res.json({
      success: true,
      data: { alerts: rows.map(shapeAlert), meta: paginationMeta({ total, limit, page }) },
    });
  }),
);

/** Counts by status + severity, used for the KPI chips. */
router.get(
  '/stats',
  requirePermission('alerts:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM alerts GROUP BY status').all()
      .reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {});
    const bySeverity = db
      .prepare("SELECT severity, COUNT(*) AS n FROM alerts WHERE status IN ('OPEN','ACKNOWLEDGED') GROUP BY severity")
      .all()
      .reduce((acc, row) => ({ ...acc, [row.severity]: row.n }), {});
    const byType = db
      .prepare("SELECT type, COUNT(*) AS n FROM alerts WHERE status IN ('OPEN','ACKNOWLEDGED') GROUP BY type")
      .all()
      .reduce((acc, row) => ({ ...acc, [row.type]: row.n }), {});
    const last24h = db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE created_at >= datetime('now', '-1 day')")
      .get().n;

    res.json({
      success: true,
      data: {
        byStatus,
        bySeverity,
        byType,
        open: byStatus.OPEN ?? 0,
        openTotal: Object.entries(bySeverity).reduce((sum, [, n]) => sum + n, 0),
        last24h,
        types: Object.entries(ALERT_TYPES).map(([key, value]) => ({ key, ...value })),
      },
    });
  }),
);

router.get(
  '/:id',
  requirePermission('alerts:read'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const row = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(Number(req.params.id));
    if (!row) throw notFound('Alert');
    res.json({ success: true, data: { alert: shapeAlert(row) } });
  }),
);

/** Acknowledge — the first half of the resolution workflow. */
router.post(
  '/:id/acknowledge',
  requirePermission('alerts:resolve'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    if (!row) throw notFound('Alert');

    db.prepare(
      `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?,
                         acknowledged_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
    ).run(req.user.id, id);

    recordAudit(fromRequest(req, 'alert.acknowledge', { entity: 'alert', entityId: id }));
    const updated = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(id);
    hub.broadcast('alert', 'alert:update', { id, status: 'ACKNOWLEDGED' });
    res.json({ success: true, data: { alert: shapeAlert(updated) } });
  }),
);

const bulkSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1, 'Select at least one alert').max(200),
  status: z.enum(['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).default('RESOLVED'),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Bulk clear — the "Clear all open alerts" workflow from the dashboard.
 *
 * Registered BEFORE `/:id/resolve`: Express matches in registration order, so
 * declaring it afterwards let the parameterised route swallow this path, parse
 * "bulk" as the alert id and fail with a NaN validation error.
 */
router.post(
  '/bulk/resolve',
  requirePermission('alerts:resolve'),
  validate(bulkSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { ids, status, note } = req.body;
    const placeholders = ids.map(() => '?').join(',');

    const result = db
      .prepare(
        `UPDATE alerts SET status = ?, resolved_by = ?, resolved_at = datetime('now'),
                           resolution_note = ?, acknowledged_by = COALESCE(acknowledged_by, ?),
                           acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
                           updated_at = datetime('now')
          WHERE id IN (${placeholders})`,
      )
      .run(status, req.user.id, note ?? 'Bulk cleared from console', req.user.id, ...ids);

    recordAudit(fromRequest(req, 'alert.bulk_resolve', { entity: 'alert', detail: { count: result.changes, status } }));
    hub.broadcast('alert', 'alert:bulk', { ids, status, count: result.changes });
    res.json({ success: true, data: { updated: result.changes, status } });
  }),
);

/** Resolve / dismiss with a note. */
router.post(
  '/:id/resolve',
  requirePermission('alerts:resolve'),
  validate(idSchema, 'params'),
  validate(resolveAlertSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    if (!row) throw notFound('Alert');

    const status = req.body.status ?? 'RESOLVED';

    db.prepare(
      `UPDATE alerts SET status = ?, resolved_by = ?, resolved_at = datetime('now'),
                         resolution_note = ?, acknowledged_by = COALESCE(acknowledged_by, ?),
                         acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
                         updated_at = datetime('now')
        WHERE id = ?`,
    ).run(status, req.user.id, req.body.note ?? null, req.user.id, id);

    recordAudit(fromRequest(req, 'alert.resolve', { entity: 'alert', entityId: id, detail: { status, note: req.body.note ?? null } }));
    const updated = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(id);
    hub.broadcast('alert', 'alert:update', { id, status });
    res.json({ success: true, data: { alert: shapeAlert(updated) } });
  }),
);

/**
 * Register the unknown UID carried by an Unregistered Alert to a student. This
 * is the primary quick action: an operator matches the tapped card to a record
 * as soon as the student enrols, and the alert is resolved in the same step.
 */
router.post(
  '/:id/register-card',
  requirePermission('students:edit'),
  validate(idSchema, 'params'),
  validate(z.object({ studentId: z.coerce.number().int().positive() })),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    if (!alert) throw notFound('Alert');

    const metadata = alert.metadata ? JSON.parse(alert.metadata) : {};
    const serial = String(metadata.serial ?? '').trim().toUpperCase();
    if (!serial) throw notFound('The tapped serial on this alert');

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(req.body.studentId));
    if (!student) throw notFound('Student');

    const clash = db
      .prepare('SELECT id, full_name FROM students WHERE UPPER(rfid_serial) = ? AND id <> ?')
      .get(serial, student.id);
    if (clash) throw conflict(`RFID serial "${serial}" is already bound to ${clash.full_name}.`);

    db.transaction(() => {
      db.prepare(
        `UPDATE students SET rfid_serial = ?, card_status = 'ACTIVE', rfid_status = 'ACTIVE',
                             card_issued_at = COALESCE(card_issued_at, datetime('now')),
                             card_revoked_at = NULL, card_revoked_reason = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(serial, student.id);

      db.prepare(
        `UPDATE alerts SET status = 'RESOLVED', resolved_by = ?, resolved_at = datetime('now'),
                           resolution_note = ?, student_id = ?,
                           acknowledged_by = COALESCE(acknowledged_by, ?),
                           acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
                           updated_at = datetime('now')
          WHERE id = ?`,
      ).run(req.user.id, `Card registered to ${student.full_name}`, student.id, req.user.id, id);
    });

    recordAudit(fromRequest(req, 'alert.register_card', { entity: 'alert', entityId: id, detail: { serial, studentId: student.id } }));
    const updated = db.prepare(`${SELECT_ALERT} WHERE a.id = ?`).get(id);
    hub.broadcast('alert', 'alert:update', { id, status: 'RESOLVED' });
    res.json({ success: true, data: { alert: shapeAlert(updated), studentId: student.id, rfidSerial: serial } });
  }),
);

/** Operator-raised notice, e.g. from Settings or a fleet maintenance flag. */
router.post(
  '/',
  requirePermission('alerts:resolve'),
  validate(
    z.object({
      title: z.string().trim().min(3).max(160),
      message: z.string().trim().min(3).max(1000),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional().default('INFO'),
      busId: z.coerce.number().int().positive().nullable().optional(),
      routeId: z.coerce.number().int().positive().nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const alert = createManualAlert({ type: 'SYSTEM', ...req.body });
    recordAudit(fromRequest(req, 'alert.create', { entity: 'alert', entityId: alert.id }));
    res.status(201).json({ success: true, data: { alert: shapeAlert(alert) } });
  }),
);

router.delete(
  '/:id',
  requirePermission('alerts:resolve'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM alerts WHERE id = ?').get(id)) throw notFound('Alert');

    db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
    recordAudit(fromRequest(req, 'alert.delete', { entity: 'alert', entityId: id }));
    hub.broadcast('alert', 'alert:delete', { id });
    res.json({ success: true, data: { message: 'Alert removed.' } });
  }),
);

export default router;
