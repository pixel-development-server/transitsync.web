import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { conflict, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { operationalEventScope, assertEventRowVisible, assertCampusRowVisible } from '../lib/tenantScope.js';
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

    // Campus isolation: own-campus events plus campus-neutral system rows;
    // a platform principal must drill in with `?tenantId=`.
    const scope = await operationalEventScope(db, req.user, req.query, 'a');
    const clauses = [scope.clause];
    const params = [...scope.params];
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

    // mysql2 prepared statements reject number-typed LIMIT/OFFSET params (ER_WRONG_ARGUMENTS).
    const rows = await db.all(`${SELECT_ALERT} ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, Number(limit), Number(offset));
    const total = (await db.get(`SELECT COUNT(*) AS n FROM alerts a LEFT JOIN students s ON s.id = a.student_id LEFT JOIN buses b ON b.id = a.bus_id ${where}`, ...params)).n;

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
    // Same campus rule as the list so the KPI chips always agree with it.
    const scope = await operationalEventScope(db, req.user, req.query);
    const scopeClause = `WHERE ${scope.clause}`;
    const byStatus = (await db.all(`SELECT status, COUNT(*) AS n FROM alerts ${scopeClause} GROUP BY status`, ...scope.params))
      .reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {});
    const bySeverity = (await db.all(`SELECT severity, COUNT(*) AS n FROM alerts WHERE status IN ('OPEN','ACKNOWLEDGED') AND ${scope.clause} GROUP BY severity`, ...scope.params))
      .reduce((acc, row) => ({ ...acc, [row.severity]: row.n }), {});
    const byType = (await db.all(`SELECT type, COUNT(*) AS n FROM alerts WHERE status IN ('OPEN','ACKNOWLEDGED') AND ${scope.clause} GROUP BY type`, ...scope.params))
      .reduce((acc, row) => ({ ...acc, [row.type]: row.n }), {});
    const last24h = (await db.get(`SELECT COUNT(*) AS n FROM alerts WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) AND ${scope.clause}`, ...scope.params)).n;

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
    const row = await db.get(`${SELECT_ALERT} WHERE a.id = ?`, Number(req.params.id));
    if (!row) throw notFound('Alert');
    assertEventRowVisible(req.user, row, 'Alert');
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
    const row = await db.get('SELECT * FROM alerts WHERE id = ?', id);
    if (!row) throw notFound('Alert');
    assertEventRowVisible(req.user, row, 'Alert');

    await db.run(
      `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?,
                         acknowledged_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      req.user.id, id,
    );

    recordAudit(fromRequest(req, 'alert.acknowledge', { entity: 'alert', entityId: id }));
    const updated = await db.get(`${SELECT_ALERT} WHERE a.id = ?`, id);
    hub.broadcast('alert', 'alert:update', { id, status: 'ACKNOWLEDGED' }, updated.tenant_id ?? null);
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
    // Scope the UPDATE itself: a campus principal can only ever clear rows it
    // can see (own campus + system), and an un-scoped platform principal with
    // no campus context clears nothing — the registry contract, on writes.
    const scope = await operationalEventScope(db, req.user, req.query);

    const result = await db.run(
      `UPDATE alerts SET status = ?, resolved_by = ?, resolved_at = NOW(),
                         resolution_note = ?, acknowledged_by = COALESCE(acknowledged_by, ?),
                         acknowledged_at = COALESCE(acknowledged_at, NOW()),
                         updated_at = NOW()
        WHERE id IN (${placeholders}) AND ${scope.clause}`,
      status, req.user.id, note ?? 'Bulk cleared from console', req.user.id, ...ids, ...scope.params,
    );

    recordAudit(fromRequest(req, 'alert.bulk_resolve', { entity: 'alert', detail: { count: result.changes, status } }));
    hub.broadcast('alert', 'alert:bulk', { ids, status, count: result.changes }, req.user.tenant_id ?? null);
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
    const row = await db.get('SELECT * FROM alerts WHERE id = ?', id);
    if (!row) throw notFound('Alert');
    assertEventRowVisible(req.user, row, 'Alert');

    const status = req.body.status ?? 'RESOLVED';

    await db.run(
      `UPDATE alerts SET status = ?, resolved_by = ?, resolved_at = NOW(),
                         resolution_note = ?, acknowledged_by = COALESCE(acknowledged_by, ?),
                         acknowledged_at = COALESCE(acknowledged_at, NOW()),
                         updated_at = NOW()
        WHERE id = ?`,
      status, req.user.id, req.body.note ?? null, req.user.id, id,
    );

    recordAudit(fromRequest(req, 'alert.resolve', { entity: 'alert', entityId: id, detail: { status, note: req.body.note ?? null } }));
    const updated = await db.get(`${SELECT_ALERT} WHERE a.id = ?`, id);
    hub.broadcast('alert', 'alert:update', { id, status }, updated.tenant_id ?? null);
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
    const alert = await db.get('SELECT * FROM alerts WHERE id = ?', id);
    if (!alert) throw notFound('Alert');
    assertEventRowVisible(req.user, alert, 'Alert');

    const metadata = alert.metadata ? JSON.parse(alert.metadata) : {};
    const serial = String(metadata.serial ?? '').trim().toUpperCase();
    if (!serial) throw notFound('The tapped serial on this alert');

    const student = await db.get('SELECT * FROM students WHERE id = ?', Number(req.body.studentId));
    if (!student) throw notFound('Student');
    // A campus operator may only ever bind their own campus's roster row —
    // otherwise attaching a foreign student would leak their name into this
    // campus's alert feed.
    assertCampusRowVisible(req.user, student, 'Student');

    const clash = await db.get(
      'SELECT id, full_name FROM students WHERE UPPER(rfid_serial) = ? AND id <> ?',
      serial, student.id,
    );
    if (clash) throw conflict(`RFID serial "${serial}" is already bound to ${clash.full_name}.`);

    await db.transaction(async () => {
      await db.run(
        `UPDATE students SET rfid_serial = ?, card_status = 'ACTIVE', rfid_status = 'ACTIVE',
                             card_issued_at = COALESCE(card_issued_at, NOW()),
                             card_revoked_at = NULL, card_revoked_reason = NULL, updated_at = NOW()
          WHERE id = ?`,
        serial, student.id,
      );

      await db.run(
        `UPDATE alerts SET status = 'RESOLVED', resolved_by = ?, resolved_at = NOW(),
                           resolution_note = ?, student_id = ?,
                           tenant_id = COALESCE(tenant_id, ?),
                           acknowledged_by = COALESCE(acknowledged_by, ?),
                           acknowledged_at = COALESCE(acknowledged_at, NOW()),
                           updated_at = NOW()
          WHERE id = ?`,
        req.user.id, `Card registered to ${student.full_name}`, student.id,
        student.tenant_id ?? null, req.user.id, id,
      );
    });

    recordAudit(fromRequest(req, 'alert.register_card', { entity: 'alert', entityId: id, detail: { serial, studentId: student.id } }));
    const updated = await db.get(`${SELECT_ALERT} WHERE a.id = ?`, id);
    hub.broadcast('alert', 'alert:update', { id, status: 'RESOLVED' }, updated.tenant_id ?? null);
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
    const db = getDb();
    // Campus ownership: the referenced bus/route decides it (and must be
    // visible to the caller), else the author's own campus. A platform
    // principal without a campus reference raises a campus-neutral system row.
    let tenantId = null;
    if (req.body.busId) {
      const bus = await db.get('SELECT * FROM buses WHERE id = ?', req.body.busId);
      if (!bus) throw notFound('Bus');
      assertCampusRowVisible(req.user, bus, 'Bus');
      tenantId = bus.tenant_id ?? null;
    } else if (req.body.routeId) {
      const route = await db.get('SELECT * FROM routes WHERE id = ?', req.body.routeId);
      if (!route) throw notFound('Route');
      assertCampusRowVisible(req.user, route, 'Route');
      tenantId = route.tenant_id ?? null;
    }
    if (tenantId == null) tenantId = req.user.tenant_id ?? null;

    const alert = await createManualAlert({ type: 'SYSTEM', ...req.body, tenantId });
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
    const row = await db.get('SELECT * FROM alerts WHERE id = ?', id);
    if (!row) throw notFound('Alert');
    assertEventRowVisible(req.user, row, 'Alert');

    await db.run('DELETE FROM alerts WHERE id = ?', id);
    recordAudit(fromRequest(req, 'alert.delete', { entity: 'alert', entityId: id }));
    hub.broadcast('alert', 'alert:delete', { id }, row.tenant_id ?? null);
    res.json({ success: true, data: { message: 'Alert removed.' } });
  }),
);

export default router;
