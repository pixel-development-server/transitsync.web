import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { PASSWORD_UNSET } from '../lib/password.js';
import { toCsv, parseCsv, timestampedFilename } from '../lib/csv.js';
import { operationalTenantScope, resolveOperationalTenant, assertCampusRowVisible } from '../lib/tenantScope.js';
import { ROLE_KEYS } from '../db/permissions.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { hub } from '../services/realtime.js';
import { writeCredentialRecord, studentRecord } from '../../credentialStorage.js';
import { nowNptStamp } from '../lib/time.js';
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
         ob.code AS onboard_bus_code
    FROM students s
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
    routeId: null,
    routeCode: null,
    routeName: null,
    routeColor: null,
    busId: null,
    busCode: null,
    busName: null,
    pickupStop: null,
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
    status: 'status',
    notes: 'notes',
  };

  const entries = Object.entries(map)
    .filter(([key]) => (partial ? body[key] !== undefined : true))
    .map(([key, column]) => [column, body[key] ?? null]);

  return Object.fromEntries(entries);
}

/**
 * Build the `WHERE` fragment (and its bound params) shared by the list and
 * export surfaces, so a download always mirrors exactly what the caller sees on
 * screen. `operationalTenantScope` is folded in here too, which is what keeps an
 * export from leaking another campus's roster.
 */
async function buildStudentFilters(db, req) {
  const { search, status, cardStatus, onboard } = req.query;
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

  if (onboard === 'true') clauses.push('s.onboard_bus_id IS NOT NULL');
  if (onboard === 'false') clauses.push('s.onboard_bus_id IS NULL');

  const scope = await operationalTenantScope(db, req.user, req.query, 's');
  clauses.push(scope.clause);
  params.push(...scope.params);

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
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
  const now = nowNptStamp();
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

/** Persist a card lifecycle change and fetch the fresh row. */
async function applyCardState(db, id, existing, { status, reason = null }) {
  const columns = cardColumns({ status, existing, reason });
  await db.run(
    `UPDATE students SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                         updated_at = NOW()
      WHERE id = ?`,
    ...Object.values(columns),
    id,
  );
  return db.get(`${SELECT_STUDENT} WHERE s.id = ?`, id);
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
    const { sort, order } = req.query;
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25 });

    // Campus isolation: campus staff see their own campus, platform principals
    // only what they explicitly drill into via `tenantId`. An un-scoped platform
    // principal gets an empty page rather than a cross-campus dump.
    const isSuperAdmin = Number(req.user?.role_level ?? req.user?.roleLevel ?? 0) >= 200;
    const tenantIdQuery =
      req.query?.tenantId ?? req.query?.tenant_id ?? req.query?.tenantID ?? null;
    if (isSuperAdmin && !tenantIdQuery) {
      res.json({
        success: true,
        data: { students: [], meta: paginationMeta({ total: 0, limit, page }) },
      });
      return;
    }

    const { where, params } = await buildStudentFilters(db, req);

    const orderMap = {
      name: 's.full_name',
      collegeId: 's.college_id',
      created: 's.id',
      onboard: 's.onboard_at',
    };
    const orderBy = orderMap[sort] ?? 's.id';
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    // MySQL requires integer-typed parameters for LIMIT/OFFSET markers and
    // mysql2 binds JS numbers as DOUBLE, so the (validated, integer) pagination
    // values are interpolated instead of bound.
    const rows = await db.all(
      `${SELECT_STUDENT} ${where} ORDER BY ${orderBy} ${direction}, s.id DESC LIMIT ${limit} OFFSET ${offset}`,
      ...params,
    );

    const total = (await db.get(`SELECT COUNT(*) AS n FROM students s ${where}`, ...params)).n;

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
    const isSuperAdmin = Number(req.user?.role_level ?? req.user?.roleLevel ?? 0) >= 200;
    const tenantIdQuery =
      req.query?.tenantId ?? req.query?.tenant_id ?? req.query?.tenantID ?? null;
    if (isSuperAdmin && !tenantIdQuery) {
      res.json({
        success: true,
        data: {
          totals: {
            total: 0,
            active: 0,
            onboard: 0,
            unassigned: 0,
            issued: 0,
            active_cards: 0,
            revoked: 0,
            unallocated: 0,
          },
          byFaculty: [],
        },
      });
      return;
    }
    const scope = await operationalTenantScope(db, req.user, req.query);
    const totals = await db.get(
      // Buses attach to routes now, not to individual students, so the old
      // `students.bus_id` column no longer exists and nothing is allocated
      // per-student. Keep the metric at 0 for shape compatibility.
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN onboard_bus_id IS NOT NULL THEN 1 ELSE 0 END) AS onboard,
         SUM(CASE WHEN card_status = 'UNASSIGNED' THEN 1 ELSE 0 END) AS unassigned,
         SUM(CASE WHEN card_status = 'ISSUED' THEN 1 ELSE 0 END) AS issued,
         SUM(CASE WHEN card_status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_cards,
         SUM(CASE WHEN card_status = 'REVOKED' THEN 1 ELSE 0 END) AS revoked,
         0 AS unallocated
       FROM students WHERE ${scope.clause}`,
      ...scope.params,
    );

    const byFaculty = await db.all(
      `SELECT COALESCE(faculty, 'Unassigned') AS faculty, COUNT(*) AS n
         FROM students WHERE ${scope.clause} GROUP BY faculty ORDER BY n DESC LIMIT 12`,
      ...scope.params,
    );

    res.json({ success: true, data: { totals, byFaculty } });
  }),
);

/** Auto-generated RFID serials the simulator can offer as sample cards. */
router.get(
  '/rfid-candidates',
  requirePermission('students:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await operationalTenantScope(db, req.user, req.query);
    const rows = await db.all(
      `SELECT id, full_name, college_id, rfid_serial, card_status, status
         FROM students WHERE ${scope.clause} ORDER BY id DESC LIMIT 25`,
      ...scope.params,
    );
    res.json({ success: true, data: { cards: rows.map(shape) } });
  }),
);

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------
/** Roster columns, keyed to the camelCase row shape `shape()` produces. */
const STUDENT_EXPORT_COLUMNS = [
  { key: 'fullName', label: 'Full Name' },
  { key: 'collegeId', label: 'College ID' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'faculty', label: 'Faculty' },
  { key: 'program', label: 'Program' },
  { key: 'semester', label: 'Semester' },
  { key: 'rfidSerial', label: 'RFID Serial' },
  { key: 'cardStatus', label: 'Card Status' },
  { key: 'status', label: 'Status' },
  { key: 'notes', label: 'Notes' },
];

// A hard ceiling on a single export so a very large tenant cannot exhaust
// memory or hold a database read open for an unbounded time.
const EXPORT_ROW_LIMIT = 10000;

/**
 * Download the caller's visible roster as CSV, honouring the same filters as
 * the list surface (and the same tenant scope). Declared before `/:id` so the
 * literal path is not swallowed by the id route.
 */
router.get(
  '/export',
  requirePermission('students:read'),
  validate(studentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { where, params } = await buildStudentFilters(db, req);

    // Bound LIMIT params fail under mysql2's binary protocol (numbers are sent
    // as DOUBLE; MySQL requires integers there) — EXPORT_ROW_LIMIT is a constant.
    const rows = (await db.all(`${SELECT_STUDENT} ${where} ORDER BY s.id DESC LIMIT ${EXPORT_ROW_LIMIT}`, ...params)).map(shape);

    recordAudit(
      fromRequest(req, 'student.export', {
        entity: 'students',
        detail: { rows: rows.length, filters: req.query },
      }),
    );

    const csv = toCsv(STUDENT_EXPORT_COLUMNS, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${timestampedFilename('transitsync-students', 'csv')}"`,
    );
    res.send(csv);
  }),
);

/**
 * Header aliases accepted on import. Our own export writes human labels
 * ("Full Name"), while API callers naturally send the camelCase field names —
 * accept both (plus snake_case and a few friendly synonyms) so an exported file
 * round-trips without the user editing the header row first.
 */
const IMPORT_ALIASES = {
  fullname: 'fullName',
  'full name': 'fullName',
  full_name: 'fullName',
  name: 'fullName',
  collegeid: 'collegeId',
  'college id': 'collegeId',
  college_id: 'collegeId',
  'roll no': 'collegeId',
  rollno: 'collegeId',
  email: 'email',
  phone: 'phone',
  mobile: 'phone',
  faculty: 'faculty',
  program: 'program',
  programme: 'program',
  semester: 'semester',
  sem: 'semester',
  rfidserial: 'rfidSerial',
  'rfid serial': 'rfidSerial',
  rfid_serial: 'rfidSerial',
  rfid: 'rfidSerial',
  'card uid': 'rfidSerial',
  cardstatus: 'cardStatus',
  'card status': 'cardStatus',
  card_status: 'cardStatus',
  status: 'status',
  notes: 'notes',
  note: 'notes',
};

/** The mutable columns an import is allowed to write, keyed by field name. */
const IMPORT_FIELD_MAP = {
  fullName: 'full_name',
  email: 'email',
  phone: 'phone',
  faculty: 'faculty',
  program: 'program',
  semester: 'semester',
  rfidSerial: 'rfid_serial',
  status: 'status',
  notes: 'notes',
};

const STUDENT_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']);

/** Trim a cell to a string, or `null` when it is blank. */
function importText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Semester must be an integer 1–12; anything else is stored as NULL. */
function importSemester(value) {
  const text = importText(value);
  if (text === null) return null;
  const number = Number.parseInt(text, 10);
  return Number.isInteger(number) && number >= 1 && number <= 12 ? number : null;
}

/** Only the four lifecycle states are accepted; blank/invalid falls back. */
function importStatus(value, fallback = 'ACTIVE') {
  const text = importText(value);
  if (text === null) return fallback;
  const upper = text.toUpperCase();
  return STUDENT_STATUSES.has(upper) ? upper : fallback;
}

/** Normalise a card UID the same way the create/edit routes do. */
function importSerial(value) {
  const text = importText(value);
  return text ? text.toUpperCase() : null;
}

/** Translate a parsed CSV record's headers onto canonical field names. */
function normalizeImportRow(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[IMPORT_ALIASES[key.toLowerCase()] ?? key] = value;
  }
  return out;
}

/**
 * Bulk create/update students from CSV, keyed on `college_id`.
 *
 * Accepts either a JSON body `{ csv: "..." }` (what the console sends) or a raw
 * `text/csv` / `text/plain` upload — hence the route-scoped `express.text`
 * parser below, since the global parsers only handle JSON and form bodies.
 * Bad rows are reported and skipped rather than aborting the whole file, so a
 * single typo does not force the operator to fix and re-upload everything.
 */
router.post(
  '/import',
  requirePermission('students:create'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const db = getDb();

    // JSON `{ csv }`, or the raw text body itself. `req.body` is a string for a
    // text/csv upload and an object for the JSON path.
    const meta = req.body && typeof req.body === 'object' ? req.body : {};
    const csvText = typeof meta.csv === 'string' ? meta.csv : typeof req.body === 'string' ? req.body : '';
    if (!csvText.trim()) throw badRequest('Provide CSV content in the request body.');

    const rows = parseCsv(csvText);

    const tenantId = meta.tenantId ?? req.query?.tenantId ?? null;

    // Campus principals can only ever touch their own campus, and a platform
    // principal must name one. Resolving up front — rather than per row — means
    // an unscoped platform import fails with a single clear 422 instead of a
    // page of per-row errors, and the existence check below is scoped the same
    // way so an import can never update another campus's student by guessing a
    // college ID.
    const scope = await operationalTenantScope(db, req.user, { tenantId });
    const insertTenant = rows.length ? await resolveOperationalTenant(db, req.user, { tenantId }) : null;

    let created = 0;
    let updated = 0;
    const errors = [];

    for (const [index, raw] of rows.entries()) {
      // +1 skips the header row, +1 makes the line number 1-based — matching the
      // line the operator sees in a spreadsheet or text editor.
      const rowNumber = index + 2;
      const row = normalizeImportRow(raw);

      const fullName = importText(row.fullName);
      const collegeId = importText(row.collegeId);
      if (!fullName) {
        errors.push({ row: rowNumber, message: 'Missing full name.' });
        continue;
      }
      if (!collegeId) {
        errors.push({ row: rowNumber, message: 'Missing college ID.' });
        continue;
      }

      // Only columns actually present in the row are written. A header the file
      // omits therefore leaves the existing value untouched on update instead of
      // silently nulling it out.
      const columns = {};
      for (const [field, column] of Object.entries(IMPORT_FIELD_MAP)) {
        if (!(field in row)) continue;
        if (field === 'fullName') columns[column] = fullName;
        else if (field === 'semester') columns[column] = importSemester(row.semester);
        else if (field === 'status') columns[column] = importStatus(row.status);
        else if (field === 'rfidSerial') columns[column] = importSerial(row.rfidSerial);
        else columns[column] = importText(row[field]);
      }

      // A UNIQUE-constraint clash (e.g. an RFID already bound to another row)
      // must fail only this row, not the whole import.
      try {
        const existing = await db.get(
          `SELECT id FROM students WHERE college_id = ? AND ${scope.clause}`,
          collegeId,
          ...scope.params,
        );

        if (existing) {
          const keys = Object.keys(columns);
          if (keys.length > 0) {
            await db.run(
              `UPDATE students SET ${keys.map((key) => `${key} = ?`).join(', ')},
                                   updated_at = NOW()
                WHERE id = ?`,
              ...keys.map((key) => columns[key]),
              existing.id,
            );
          }
          updated += 1;
        } else {
          const insertColumns = {
            college_id: collegeId,
            ...columns,
            tenant_id: insertTenant,
          };
          const keys = Object.keys(insertColumns);
          await db.run(
            `INSERT INTO students (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            ...keys.map((key) => insertColumns[key]),
          );
          created += 1;
        }
      } catch (caught) {
        errors.push({ row: rowNumber, message: caught?.message ?? 'Row could not be saved.' });
      }
    }

    const skipped = errors.length;

    recordAudit(
      fromRequest(req, 'student.import', {
        entity: 'students',
        detail: { created, updated, skipped, errors: errors.length },
      }),
    );

    // Let every other open registry refresh without a manual reload.
    hub.broadcast('students', 'student_updated', { action: 'import', created, updated });

    res.json({ success: true, data: { created, updated, skipped, errors } });
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
    const row = await db.get(`${SELECT_STUDENT} WHERE s.id = ?`, Number(req.params.id));
    if (!row) throw notFound('Student');
    assertCampusRowVisible(req.user, row, 'Student');

    const scans = await db.all(
      `SELECT e.*, b.code AS bus_code, r.code AS route_code
         FROM scan_events e
         LEFT JOIN buses b ON b.id = e.bus_id
         LEFT JOIN routes r ON r.id = e.route_id
        WHERE e.student_id = ? ORDER BY e.id DESC LIMIT 25`,
      row.id,
    );

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

    if (await db.get('SELECT id FROM students WHERE college_id = ?', body.collegeId)) {
      throw conflict(`College ID "${body.collegeId}" is already registered.`);
    }
    if (body.rfidSerial && (await db.get('SELECT id FROM students WHERE UPPER(rfid_serial) = ?', body.rfidSerial))) {
      throw conflict(`RFID serial "${body.rfidSerial}" is already bound to another student.`);
    }

    const columns = toColumns(body);
    const requestedCard = body.cardStatus ?? (columns.rfid_serial ? 'ACTIVE' : 'UNASSIGNED');
    const tenant = await resolveOperationalTenant(db, req.user, body);
    const finalColumns = {
      ...columns,
      ...cardColumns({ status: requestedCard, reason: body.cardRevokedReason ?? null }),
      tenant_id: tenant,
    };

    const keys = Object.keys(finalColumns);
    const result = await db.run(
      `INSERT INTO students (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      ...keys.map((key) => finalColumns[key]),
    );

    recordAudit(fromRequest(req, 'student.create', { entity: 'student', entityId: Number(result.lastInsertRowid), detail: { collegeId: body.collegeId, cardStatus: requestedCard } }));

    const studentId = Number(result.lastInsertRowid);

    // Auto-sync the sign-in account so a staff-added roster row is a real,
    // claimable portal account. The portal authenticates against `users`, so a
    // roster row with an email gets a paired role=student account (status
    // 'invited', password sentinel) that the student activates with a first
    // password via the two-step check-email / student-register claim. If an
    // account already exists for the address — e.g. the row was added after the
    // student had already claimed — it is linked instead of duplicated.
    let linkedUserId = null;
    if (body.email) {
      const studentRole = await db.get('SELECT id FROM roles WHERE `key` = ?', ROLE_KEYS.STUDENT);
      const existingUser = studentRole
        ? await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', body.email)
        : null;
      if (studentRole) {
        linkedUserId = existingUser?.id ?? null;
        if (!linkedUserId) {
          const provisioned = await db.run(
            `INSERT INTO users
               (email, full_name, password_hash, status, role_id, tenant_id,
                is_first_login, password_changed, force_password_reset, permissions_mode)
             VALUES (?, ?, ?, 'invited', ?, ?, 1, 0, 0, 'INHERIT')`,
            body.email,
            body.fullName,
            PASSWORD_UNSET,
            studentRole.id,
            tenant,
          );
          linkedUserId = Number(provisioned.lastInsertRowid);
          recordAudit(fromRequest(req, 'student.invite_sent', {
            entity: 'user',
            entityId: linkedUserId,
            detail: { email: body.email },
          }));
        }
        await db.run(
          "UPDATE students SET user_id = ?, updated_at = NOW() WHERE id = ?",
          linkedUserId,
          studentId,
        );
      }
    }

    const row = await db.get(`${SELECT_STUDENT} WHERE s.id = ?`, Number(result.lastInsertRowid));
    const student = shape(row);

    // Mirror the roster row (and its paired account) into the plain-text audit
    // export. `row` is the raw `s.*` shape, so it carries college ID and card
    // fields; the campus name is resolved from the tenant we just wrote.
    const campusName = tenant
      ? (await db.get('SELECT name FROM institutions WHERE id = ?', tenant))?.name ?? null
      : null;
    writeCredentialRecord(
      studentRecord(row, {
        source: 'student.create',
        userId: linkedUserId ?? row.user_id ?? null,
        tenantName: campusName,
      }),
    );

    // Fan the new record out so every other open registry refreshes live —
    // only to the campus that owns the student (see hub tenant filtering).
    hub.broadcast('students', 'student_updated', { action: 'created', student }, row.tenant_id ?? null);
    res.status(201).json({ success: true, data: { student } });
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
    const existing = await db.get('SELECT * FROM students WHERE id = ?', id);
    if (!existing) throw notFound('Student');
    assertCampusRowVisible(req.user, existing, 'Student');

    const body = { ...req.body };
    if (body.rfidSerial && body.rfidSerial !== existing.rfid_serial) {
      const clash = await db.get('SELECT id FROM students WHERE UPPER(rfid_serial) = ? AND id <> ?', body.rfidSerial, id);
      if (clash) throw conflict(`RFID serial "${body.rfidSerial}" is already bound to another student.`);
    }
    if (body.collegeId && body.collegeId !== existing.college_id) {
      const clash = await db.get('SELECT id FROM students WHERE college_id = ? AND id <> ?', body.collegeId, id);
      if (clash) throw conflict(`College ID "${body.collegeId}" is already registered.`);
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

    await db.run(
      `UPDATE students SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                           updated_at = NOW()
        WHERE id = ?`,
      ...Object.values(columns),
      id,
    );

    recordAudit(fromRequest(req, 'student.update', { entity: 'student', entityId: id, detail: { fields: Object.keys(columns) } }));

    const row = await db.get(`${SELECT_STUDENT} WHERE s.id = ?`, id);
    const student = shape(row);
    hub.broadcast('students', 'student_updated', { action: 'updated', student }, row.tenant_id ?? null);
    res.json({ success: true, data: { student } });
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
    const existing = await db.get('SELECT * FROM students WHERE id = ?', id);
    if (!existing) throw notFound('Student');
    assertCampusRowVisible(req.user, existing, 'Student');

    const serial = req.body.rfidSerial.toUpperCase();
    const clash = await db.get(
      'SELECT id FROM students WHERE UPPER(rfid_serial) = ? AND id <> ?',
      serial,
      id,
    );
    if (clash) throw conflict(`RFID serial "${serial}" is already bound to another student.`);

    const status = req.body.cardStatus ?? 'ACTIVE';
    const columns = { rfid_serial: serial, ...cardColumns({ status, existing }) };

    await db.run(
      `UPDATE students SET ${Object.keys(columns).map((key) => `${key} = ?`).join(', ')},
                           updated_at = NOW()
        WHERE id = ?`,
      ...Object.values(columns),
      id,
    );

    recordAudit(fromRequest(req, 'student.card.issue', { entity: 'student', entityId: id, detail: { serial, status } }));
    const row = await db.get(`${SELECT_STUDENT} WHERE s.id = ?`, id);
    // Card lifecycle rides on the same `students` channel as the roster: a card
    // issue changes the row every open registry table is already watching.
    hub.broadcast('students', 'student_updated', { action: 'card.issued', student: shape(row) }, row.tenant_id ?? null);
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
    const existing = await db.get('SELECT * FROM students WHERE id = ?', id);
    if (!existing) throw notFound('Student');
    assertCampusRowVisible(req.user, existing, 'Student');
    if (!existing.rfid_serial) throw badRequest('This student does not hold a card.');

    const row = await applyCardState(db, id, existing, { status: 'REVOKED', reason: req.body.reason ?? 'cancelled' });
    recordAudit(fromRequest(req, 'student.card.revoke', { entity: 'student', entityId: id, detail: { serial: existing.rfid_serial, reason: req.body.reason ?? 'cancelled' } }));
    hub.broadcast('students', 'student_updated', { action: 'card.revoked', student: shape(row) }, row.tenant_id ?? existing.tenant_id ?? null);
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
    const existing = await db.get('SELECT * FROM students WHERE id = ?', id);
    if (!existing) throw notFound('Student');
    assertCampusRowVisible(req.user, existing, 'Student');

    const card = cardColumns({ status: 'REVOKED', reason: 'withdrawn', existing });
    const assignments = Object.keys(card).map((key) => `${key} = ?`).join(', ');
    await db.run(
      `UPDATE students SET status = 'WITHDRAWN', onboard_bus_id = NULL, onboard_at = NULL,
                           ${assignments}, updated_at = NOW()
        WHERE id = ?`,
      ...Object.values(card),
      id,
    );

    recordAudit(fromRequest(req, 'student.delete', { entity: 'student', entityId: id, detail: { collegeId: existing.college_id } }));
    hub.broadcast('students', 'student_updated', { action: 'deleted', id }, existing.tenant_id ?? null);
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
    const existing = await db.get('SELECT * FROM students WHERE id = ?', id);
    if (!existing) throw notFound('Student');
    assertCampusRowVisible(req.user, existing, 'Student');

    const cleaned = await db.transaction(async () => {
      // Scan history survives for analytics, but attribution must not point at
      // a record that no longer exists (mirrors the FK's ON DELETE SET NULL,
      // done explicitly so the counts are reportable and the order guaranteed).
      const scans = await db.run('UPDATE scan_events SET student_id = NULL WHERE student_id = ?', id);
      const detachedAlerts = await db.run('UPDATE alerts SET student_id = NULL WHERE student_id = ?', id);
      // Bus passes / trip bookings belong to the roster row — remove them
      // outright (the FK would cascade; made explicit for the reportable count).
      const bookings = await db.run('DELETE FROM student_bookings WHERE student_id = ?', id);
      // The roster row itself — must go before the linked portal login, because
      // students.user_id is ON DELETE RESTRICT toward users.
      const removed = await db.run('DELETE FROM students WHERE id = ?', id);
      if (!removed.changes) throw notFound('Student');

      // Linked portal account: only ever a student-role login, and only now
      // that no roster row references it.
      let accountRemoved = false;
      if (existing.user_id) {
        const linked = await db.get(
          `SELECT u.id FROM users u
             JOIN roles r ON r.id = u.role_id
            WHERE u.id = ? AND r.\`key\` = 'student'`,
          existing.user_id,
        );
        if (linked) {
          const deletedUser = await db.run('DELETE FROM users WHERE id = ?', linked.id);
          accountRemoved = Number(deletedUser.changes ?? 0) > 0;
        }
      }

      return {
        bookings: Number(bookings.changes ?? 0),
        scanEventsDetached: Number(scans.changes ?? 0),
        alertsDetached: Number(detachedAlerts.changes ?? 0),
        accountRemoved,
      };
    });

    recordAudit(fromRequest(req, 'student.purge', {
      entity: 'student',
      entityId: id,
      detail: { collegeId: existing.college_id, ...cleaned },
    }));
    hub.broadcast('students', 'student_updated', { action: 'purged', id }, existing.tenant_id ?? null);
    res.json({
      success: true,
      data: {
        message: cleaned.accountRemoved
          ? `${existing.full_name} was permanently purged, along with their bus bookings and portal login.`
          : `${existing.full_name} was permanently purged, along with their bus bookings.`,
        removed: cleaned,
      },
    });
  }),
);

export default router;
