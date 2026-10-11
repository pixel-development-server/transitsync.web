import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { PASSWORD_UNSET } from '../lib/password.js';
import { ROLE_KEYS } from '../db/permissions.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import {
  createStudentSchema,
  updateStudentSchema,
  studentQuerySchema,
  issueCardSchema,
  revokeCardSchema,
  idSchema,
} from '../validation/schemas.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_STUDENT = `
  SELECT s.*,
         r.code AS route_code, r.name AS route_name, r.color AS route_color, r.shift AS route_shift,
         b.code AS bus_code, b.name AS bus_name, b.seat_capacity AS bus_capacity,
         ob.code AS onboard_bus_code
    FROM students s
    LEFT JOIN routes r  ON r.id = s.route_id
    LEFT JOIN buses b   ON b.id = s.bus_id
    LEFT JOIN buses ob  ON ob.id = s.onboard_bus_id
`;

function shape(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    collegeId: row.college_id,
    email: row.email,
    phone: row.phone,
    faculty: row.faculty,
    program: row.program,
    semester: row.semester,
    rfidSerial: row.rfid_serial,
    cardStatus: row.card_status ?? 'UNASSIGNED',
    cardIssuedAt: row.card_issued_at,
    cardRevokedAt: row.card_revoked_at,
    cardRevokedReason: row.card_revoked_reason,
    routeId: row.route_id,
    routeCode: row.route_code,
    routeName: row.route_name,
    routeColor: row.route_color,
    busId: row.bus_id,
    busCode: row.bus_code,
    busName: row.bus_name,
    pickupStop: row.pickup_stop,
    status: row.status,
    onboard: Boolean(row.onboard_bus_id),
    onboardBusId: row.onboard_bus_id,
    onboardBusCode: row.onboard_bus_code,
    onboardAt: row.onboard_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map the camelCase API payload onto database columns. */
function toColumns(body, { partial = false } = {}) {
  const map = {
    fullName: 'full_name',
    collegeId: 'college_id',
    email: 'email',
    phone: 'phone',
    faculty: 'faculty',
    program: 'program',
    semester: 'semester',
    rfidSerial: 'rfid_serial',
    routeId: 'route_id',
    busId: 'bus_id',
    pickupStop: 'pickup_stop',
    status: 'status',
    notes: 'notes',
  };

  const entries = Object.entries(map)
    .filter(([key]) => (partial ? body[key] !== undefined : true))
    .map(([key, column]) => [column, body[key] ?? null]);

  return Object.fromEntries(entries);
}

/**
 * Derive the card-lifecycle columns from a requested status, and mirror the
 * legacy `rfid_status` column so older reports and exports keep working.
 *
 *  - entering ISSUED/ACTIVE stamps `card_issued_at` once
 *  - entering REVOKED stamps `card_revoked_at` + reason
 *  - re-issuing a revoked card clears the revocation markers
 */
function cardColumns({ status, existing = null, reason = null }) {
  const now = sqliteNow();
  const next = { card_status: status, rfid_status: legacyCardStatus(status) };
  const isUsable = status === 'ACTIVE' || status === 'ISSUED';

  if (isUsable && !existing?.card_issued_at) next.card_issued_at = now;
  if (status === 'REVOKED') {
    next.card_revoked_at = existing?.card_revoked_at ?? now;
    next.card_revoked_reason = reason ?? existing?.card_revoked_reason ?? 'cancelled';
  } else if (existing?.card_status === 'REVOKED') {
    next.card_revoked_at = null;
    next.card_revoked_reason = null;
  }
  return next;
}

function legacyCardStatus(status) {
  if (status === 'REVOKED') return 'BLOCKED';
  if (status === 'ACTIVE' || status === 'ISSUED') return 'ACTIVE';
  return 'UNASSIGNED';
}

function sqliteNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Capacity guard: refuse allocations that would overfill a bus. */
function assertBusCapacity(db, busId, { excludeStudentId = null, delta = 1 } = {}) {
  if (!busId) return null;
  const bus = db.prepare('SELECT id, code, seat_capacity FROM buses WHERE id = ?').get(busId);
  if (!bus) return null;

  const assigned = db
    .prepare('SELECT COUNT(*) AS n FROM students WHERE bus_id = ? AND status = ? AND id <> ?')
    .get(busId, 'ACTIVE', excludeStudentId ?? 0).n;

  if (assigned + delta > bus.seat_capacity) {
    throw conflict(`${bus.code} is at capacity (${assigned}/${bus.seat_capacity} seats allocated).`);
  }
  return bus;
}

/**
 * Keep the route/bus pairing consistent. When a bus is picked without an
 * explicit route, the student inherits the bus's current route.
 */
function normaliseAllocation(db, body, { partial = false } = {}) {
  const busId = partial ? (body.busId ?? undefined) : (body.busId ?? null);
  const routeId = partial ? (body.routeId ?? undefined) : (body.routeId ?? null);

  if (busId) {
    const bus = db.prepare('SELECT current_route_id FROM buses WHERE id = ?').get(busId);
    if (!bus) throw badRequest('The selected bus does not exist.');
    if (body.routeId === null || body.routeId === undefined) {
      if (routeId === undefined || routeId === null) return { busId, routeId: bus.current_route_id ?? null };
    }
  }

  return { busId, routeId };
}

/** Persist a card lifecycle change and fetch the fresh row. */
function applyCardState(db, id, existing, { status, reason = null }) {
  const columns = cardColumns({ status, existing, reason });
  db.prepare(
    `UPDATE students SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                         updated_at = datetime('now')
      WHERE id = ?`,
  ).run(...Object.values(columns), id);
  return db.prepare(`${SELECT_STUDENT} WHERE s.id = ?`).get(id);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('students:read'),
  validate(studentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { search, status, cardStatus, busId, routeId, onboard, sort, order } = req.query;
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25 });

    const clauses = [];
    const params = [];
    if (search) {
      const term = `%${search}%`;
      clauses.push('(s.full_name LIKE ? OR s.college_id LIKE ? OR s.email LIKE ? OR s.rfid_serial LIKE ?)');
      params.push(term, term, term, term);
    }
    if (status && status !== 'all') {
      clauses.push('s.status = ?');
      params.push(status);
    }
    if (cardStatus && cardStatus !== 'all') {
      clauses.push('s.card_status = ?');
      params.push(cardStatus);
    }
    if (busId) {
      clauses.push('s.bus_id = ?');
      params.push(busId);
    }
    if (routeId) {
      clauses.push('s.route_id = ?');
      params.push(routeId);
    }
    if (onboard === 'true') clauses.push('s.onboard_bus_id IS NOT NULL');
    if (onboard === 'false') clauses.push('s.onboard_bus_id IS NULL');

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderMap = {
      name: 's.full_name',
      collegeId: 's.college_id',
      created: 's.id',
      onboard: 's.onboard_at',
    };
    const orderBy = orderMap[sort] ?? 's.id';
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    const rows = db
      .prepare(`${SELECT_STUDENT} ${where} ORDER BY ${orderBy} ${direction}, s.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM students s ${where}`).get(...params).n;

    res.json({
      success: true,
      data: {
        students: rows.map(shape),
        meta: paginationMeta({ total, limit, page }),
      },
    });
  }),
);

/** Aggregate counts used to filter chips above the table. */
router.get(
  '/summary',
  requirePermission('students:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN onboard_bus_id IS NOT NULL THEN 1 ELSE 0 END) AS onboard,
           SUM(CASE WHEN card_status = 'UNASSIGNED' THEN 1 ELSE 0 END) AS unassigned,
           SUM(CASE WHEN card_status = 'ISSUED' THEN 1 ELSE 0 END) AS issued,
           SUM(CASE WHEN card_status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_cards,
           SUM(CASE WHEN card_status = 'REVOKED' THEN 1 ELSE 0 END) AS revoked,
           SUM(CASE WHEN bus_id IS NULL AND status = 'ACTIVE' THEN 1 ELSE 0 END) AS unallocated
         FROM students`,
      )
      .get();

    const byFaculty = db
      .prepare(
        `SELECT COALESCE(faculty, 'Unassigned') AS faculty, COUNT(*) AS n
           FROM students GROUP BY faculty ORDER BY n DESC LIMIT 12`,
      )
      .all();

    res.json({ success: true, data: { totals, byFaculty } });
  }),
);

/** Auto-generated RFID serials the simulator can offer as sample cards. */
router.get(
  '/rfid-candidates',
  requirePermission('students:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, full_name, college_id, rfid_serial, card_status, status, bus_id
           FROM students ORDER BY id DESC LIMIT 25`,
      )
      .all();
    res.json({ success: true, data: { cards: rows.map(shape) } });
  }),
);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('students:read'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const row = db.prepare(`${SELECT_STUDENT} WHERE s.id = ?`).get(Number(req.params.id));
    if (!row) throw notFound('Student');

    const scans = db
      .prepare(
        `SELECT e.*, b.code AS bus_code, r.code AS route_code
           FROM scan_events e
           LEFT JOIN buses b ON b.id = e.bus_id
           LEFT JOIN routes r ON r.id = e.route_id
          WHERE e.student_id = ? ORDER BY e.id DESC LIMIT 25`,
      )
      .all(row.id);

    res.json({ success: true, data: { student: shape(row), scans } });
  }),
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('students:create'),
  validate(createStudentSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const body = { ...req.body };

    if (db.prepare('SELECT id FROM students WHERE college_id = ?').get(body.collegeId)) {
      throw conflict(`College ID "${body.collegeId}" is already registered.`);
    }
    if (body.rfidSerial && db.prepare('SELECT id FROM students WHERE UPPER(rfid_serial) = ?').get(body.rfidSerial)) {
      throw conflict(`RFID serial "${body.rfidSerial}" is already bound to another student.`);
    }

    const { busId } = normaliseAllocation(db, body);
    const columns = toColumns(body);
    // A supplied serial implies an active card; an explicit status always wins.
    const requestedCard = body.cardStatus ?? (columns.rfid_serial ? 'ACTIVE' : 'UNASSIGNED');
    const finalColumns = {
      ...columns,
      ...cardColumns({ status: requestedCard, reason: body.cardRevokedReason ?? null }),
      bus_id: columns.bus_id ?? busId ?? null,
    };

    assertBusCapacity(db, finalColumns.bus_id, { delta: 1 });

    const keys = Object.keys(finalColumns);
    const result = db
      .prepare(
        `INSERT INTO students (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      )
      .run(...keys.map((key) => finalColumns[key]));

    recordAudit(fromRequest(req, 'student.create', { entity: 'student', entityId: Number(result.lastInsertRowid), detail: { collegeId: body.collegeId, cardStatus: requestedCard } }));

    const studentId = Number(result.lastInsertRowid);

    // Auto-sync the sign-in account so a staff-added roster row is a real,
    // claimable portal account. The portal authenticates against `users`, so a
    // roster row with an email gets a paired role=student account (status
    // 'invited', password sentinel) that the student activates with a first
    // password via the two-step check-email / student-register claim. If an
    // account already exists for the address — e.g. the row was added after the
    // student had already claimed — it is linked instead of duplicated.
    if (body.email) {
      const studentRole = db.prepare('SELECT id FROM roles WHERE key = ?').get(ROLE_KEYS.STUDENT);
      const existingUser = studentRole
        ? db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(body.email)
        : null;
      if (studentRole) {
        let linkedUserId = existingUser?.id ?? null;
        if (!linkedUserId) {
          const provisioned = db
            .prepare(
              `INSERT INTO users
                 (email, full_name, password_hash, status, role_id, tenant_id,
                  is_first_login, password_changed, force_password_reset, permissions_mode)
               VALUES (?, ?, ?, 'invited', ?, ?, 1, 0, 0, 'INHERIT')`,
            )
            .run(body.email, body.fullName, PASSWORD_UNSET, studentRole.id, req.user.tenant_id ?? null);
          linkedUserId = Number(provisioned.lastInsertRowid);
          recordAudit(fromRequest(req, 'student.invite_sent', {
            entity: 'user',
            entityId: linkedUserId,
            detail: { email: body.email },
          }));
        }
        db.prepare(
          "UPDATE students SET user_id = ?, is_claimed = 1, updated_at = datetime('now') WHERE id = ?",
        ).run(linkedUserId, studentId);
      }
    }

    const row = db.prepare(`${SELECT_STUDENT} WHERE s.id = ?`).get(Number(result.lastInsertRowid));
    res.status(201).json({ success: true, data: { student: shape(row) } });
  }),
);

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('students:edit'),
  validate(idSchema, 'params'),
  validate(updateStudentSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) throw notFound('Student');

    const body = { ...req.body };
    if (body.clearBus) {
      body.busId = null;
      body.routeId = body.routeId ?? null;
    }
    if (body.clearRoute) body.routeId = null;

    if (body.rfidSerial && body.rfidSerial !== existing.rfid_serial) {
      const clash = db.prepare('SELECT id FROM students WHERE UPPER(rfid_serial) = ? AND id <> ?').get(body.rfidSerial, id);
      if (clash) throw conflict(`RFID serial "${body.rfidSerial}" is already bound to another student.`);
    }
    if (body.collegeId && body.collegeId !== existing.college_id) {
      const clash = db.prepare('SELECT id FROM students WHERE college_id = ? AND id <> ?').get(body.collegeId, id);
      if (clash) throw conflict(`College ID "${body.collegeId}" is already registered.`);
    }

    const { busId } = normaliseAllocation(db, body, { partial: true });
    if (busId !== undefined) body.busId = busId;
    const targetBusId = body.busId !== undefined ? body.busId : existing.bus_id;
    if (targetBusId && targetBusId !== existing.bus_id) {
      assertBusCapacity(db, targetBusId, { excludeStudentId: id, delta: 1 });
    }

    const columns = toColumns(body, { partial: true });

    // The card lifecycle carries timestamp side effects, so it is derived
    // separately from the plain column map.
    if (body.cardStatus !== undefined) {
      Object.assign(columns, cardColumns({
        status: body.cardStatus,
        reason: body.cardRevokedReason ?? null,
        existing,
      }));
    }

    if (Object.keys(columns).length === 0) throw badRequest('Nothing to update.');

    db.prepare(
      `UPDATE students SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                           updated_at = datetime('now')
        WHERE id = ?`,
    ).run(...Object.values(columns), id);

    recordAudit(fromRequest(req, 'student.update', { entity: 'student', entityId: id, detail: { fields: Object.keys(columns) } }));

    const row = db.prepare(`${SELECT_STUDENT} WHERE s.id = ?`).get(id);
    res.json({ success: true, data: { student: shape(row) } });
  }),
);

// ---------------------------------------------------------------------------
// Bus card lifecycle (issue / revoke)
// ---------------------------------------------------------------------------
/**
 * Issue a physical card to a student. Cards are handed out by the college once
 * the bus fee is paid and the registration form is submitted, and stay active
 * until the student cancels the bus service.
 */
router.post(
  '/:id/card',
  requirePermission('students:edit'),
  validate(idSchema, 'params'),
  validate(issueCardSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) throw notFound('Student');

    const serial = req.body.rfidSerial.toUpperCase();
    const clash = db
      .prepare('SELECT id FROM students WHERE UPPER(rfid_serial) = ? AND id <> ?')
      .get(serial, id);
    if (clash) throw conflict(`RFID serial "${serial}" is already bound to another student.`);

    const status = req.body.cardStatus ?? 'ACTIVE';
    const columns = { rfid_serial: serial, ...cardColumns({ status, existing }) };

    db.prepare(
      `UPDATE students SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                           updated_at = datetime('now')
        WHERE id = ?`,
    ).run(...Object.values(columns), id);

    recordAudit(fromRequest(req, 'student.card.issue', { entity: 'student', entityId: id, detail: { serial, status } }));
    const row = db.prepare(`${SELECT_STUDENT} WHERE s.id = ?`).get(id);
    res.json({ success: true, data: { student: shape(row) } });
  }),
);

/** Revoke a card — bus service cancelled, or the card was lost/blocked. */
router.post(
  '/:id/card/revoke',
  requirePermission('students:edit'),
  validate(idSchema, 'params'),
  validate(revokeCardSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) throw notFound('Student');
    if (!existing.rfid_serial) throw badRequest('This student does not hold a card.');

    const row = applyCardState(db, id, existing, { status: 'REVOKED', reason: req.body.reason ?? 'cancelled' });
    recordAudit(fromRequest(req, 'student.card.revoke', { entity: 'student', entityId: id, detail: { serial: existing.rfid_serial, reason: req.body.reason ?? 'cancelled' } }));
    res.json({ success: true, data: { student: shape(row) } });
  }),
);

// ---------------------------------------------------------------------------
// Delete (soft — scan history must stay attributable)
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('students:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) throw notFound('Student');

    const card = cardColumns({ status: 'REVOKED', reason: 'withdrawn', existing });
    const assignments = Object.keys(card).map((key) => `${key} = ?`).join(', ');
    db.prepare(
      `UPDATE students SET status = 'WITHDRAWN', onboard_bus_id = NULL, onboard_at = NULL,
                           ${assignments}, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(...Object.values(card), id);

    recordAudit(fromRequest(req, 'student.delete', { entity: 'student', entityId: id, detail: { collegeId: existing.college_id } }));
    res.json({ success: true, data: { message: `${existing.full_name} has been withdrawn and their card revoked.` } });
  }),
);

/** Hard delete for compliance/cleanup. Still requires students:delete. */
router.delete(
  '/:id/purge',
  requirePermission('students:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) throw notFound('Student');

    db.prepare('DELETE FROM students WHERE id = ?').run(id);
    recordAudit(fromRequest(req, 'student.purge', { entity: 'student', entityId: id, detail: { collegeId: existing.college_id } }));
    res.json({ success: true, data: { message: 'Student record permanently removed.' } });
  }),
);

export default router;
