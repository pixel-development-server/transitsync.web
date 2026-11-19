/**
 * Student bookings — a rider's daily route/bus selection.
 *
 * The rider portal is route-centric: a student picks a route (and optionally a
 * shuttle) for a given Nepali calendar day. Exactly one trip choice may exist
 * per (student, travel_date), so re-booking the same day replaces the earlier
 * selection rather than creating a second row (the table carries a UNIQUE
 * constraint and the write is an upsert).
 *
 * Two very different callers share this router:
 *
 *   - The rider themselves (`POST /`, `GET /mine`, `DELETE /:id`), admitted by
 *     `requireStudent` and always pinned to their own roster row. They hold no
 *     staff permissions, so every payload is addressed to them *personally*.
 *
 *   - Staff (`GET /`) holding `students:read`, who read the whole ledger for
 *     their campus through the usual `operationalTenantScope` guard.
 *
 * Realtime fan-out matters here: a rider's own choice must reach *their* stream
 * only (they are denied every broadcast channel by design), while staff who can
 * list the ledger hear about every change on the `bookings` channel.
 */

import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nptDay } from '../lib/time.js';
import { operationalTenantScope } from '../lib/tenantScope.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth, requireStudent } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { hub } from '../services/realtime.js';
import { createBookingSchema, bookingQuerySchema, idSchema } from '../validation/schemas.js';

const router = express.Router();
router.use(requireAuth);

/**
 * One booking, joined to the two services it selects plus the rider it belongs
 * to. The student join is what lets the staff ledger show a name/roll number
 * without a second query, and what `shapeBooking` reads for `studentName`.
 */
const SELECT_BOOKING = `
  SELECT sb.*,
         r.code AS route_code, r.name AS route_name,
         b.code AS bus_code,  b.name AS bus_name,
         s.full_name AS student_name, s.college_id AS student_college_id
    FROM student_bookings sb
    LEFT JOIN routes   r ON r.id = sb.route_id
    LEFT JOIN buses    b ON b.id = sb.bus_id
    LEFT JOIN students s ON s.id = sb.student_id
`;

/** Resolve the signed-in rider's roster row, or null when none is linked. */
async function findStudentForUser(db, userId) {
  return (await db.get('SELECT * FROM students WHERE user_id = ?', userId)) ?? null;
}

/** camelCase wire shape for a booking row (with its joined labels). */
function shapeBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    travelDate: row.travel_date,
    status: row.status,
    routeId: row.route_id ?? null,
    routeCode: row.route_code ?? null,
    routeName: row.route_name ?? null,
    busId: row.bus_id ?? null,
    busCode: row.bus_code ?? null,
    busName: row.bus_name ?? null,
    studentId: row.student_id,
    studentName: row.student_name ?? null,
    collegeId: row.student_college_id ?? null,
    seatNo: row.seat_no ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Fetch a freshly written booking in its joined, wire-ready form. */
async function loadBooking(db, id) {
  return shapeBooking(await db.get(`${SELECT_BOOKING} WHERE sb.id = ?`, id));
}

// ---------------------------------------------------------------------------
// Book a trip (rider)
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireStudent,
  validate(createBookingSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const student = await findStudentForUser(db, req.user.id);
    if (!student) throw notFound('Student record');

    const { travelDate, routeId, busId, notes } = req.body;

    // Calendar-day guard. `travel_date` is a Nepali calendar day, so "today"
    // must be computed in NPT — comparing against the server's UTC day would
    // let a rider book yesterday's date late in the Kathmandu evening.
    const today = nptDay();
    if (travelDate < today) {
      throw badRequest('You cannot book travel for a past date.', [
        { field: 'travelDate', message: `Choose today (${today}) or a later date.` },
      ]);
    }

    // An optional route must be real, currently operating, and visible to this
    // rider's campus. A tenant-less route is shared and always allowed; a route
    // owned by another campus is reported as not-found so its existence stays
    // unconfirmable across tenants.
    let route = null;
    if (routeId != null) {
      route = await db.get('SELECT * FROM routes WHERE id = ?', routeId);
      if (!route) throw notFound('Route');
      if (!route.is_active) {
        throw badRequest('That route is not currently operating.', [
          { field: 'routeId', message: 'Choose an active route.' },
        ]);
      }
      if (student.tenant_id && route.tenant_id != null && route.tenant_id !== student.tenant_id) {
        throw notFound('Route');
      }
    }

    // An optional bus must exist and be in service; a retired or workshop
    // vehicle is refused so a rider never books a shuttle that will not run.
    let bus = null;
    if (busId != null) {
      bus = await db.get('SELECT * FROM buses WHERE id = ?', busId);
      if (!bus) throw notFound('Bus');
      if (bus.status !== 'ACTIVE') {
        throw badRequest('That bus is not in service.', [
          { field: 'busId', message: 'Choose an active bus.' },
        ]);
      }
    }

    // Distinguish a fresh booking from a same-day re-book purely for the
    // response code and the realtime `action`; the write below is an upsert.
    const existing = await db.get(
      'SELECT id FROM student_bookings WHERE student_id = ? AND travel_date = ?',
      student.id,
      travelDate,
    );

    await db.run(
      `INSERT INTO student_bookings
         (student_id, route_id, bus_id, travel_date, status, notes,
          tenant_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'BOOKED', ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         route_id   = VALUES(route_id),
         bus_id     = VALUES(bus_id),
         status     = 'BOOKED',
         notes      = VALUES(notes),
         updated_at = NOW()`,
      student.id,
      route?.id ?? null,
      bus?.id ?? null,
      travelDate,
      notes ?? null,
      // The booking inherits the rider's campus; created_by records the actor.
      student.tenant_id ?? null,
      req.user.id,
    );

    const row = await db.get(
      `${SELECT_BOOKING} WHERE sb.student_id = ? AND sb.travel_date = ?`,
      student.id,
      travelDate,
    );
    const booking = shapeBooking(row);
    const action = existing ? 'updated' : 'created';

    recordAudit(
      fromRequest(req, action === 'created' ? 'booking.create' : 'booking.update', {
        entity: 'student_booking',
        entityId: booking.id,
        detail: { travelDate, routeId: booking.routeId, busId: booking.busId },
      }),
    );

    // Personal copy to the rider (broadcast channels deny students), then the
    // staff ledger fan-out for anyone entitled to the `bookings` channel.
    hub.sendToUser(student.user_id ?? req.user.id, 'booking_updated', { action, booking });
    hub.broadcast('bookings', 'booking_updated', { action, booking }, student.tenant_id ?? null);

    res.status(existing ? 200 : 201).json({ success: true, data: { booking } });
  }),
);

// ---------------------------------------------------------------------------
// My bookings (rider)
// ---------------------------------------------------------------------------
/**
 * The caller's own bookings, newest travel day first. `?from` / `?to`
 * (`YYYY-MM-DD`) optionally narrow the range; both are bound parameters, so a
 * malformed value simply matches nothing rather than being injectable.
 */
router.get(
  '/mine',
  requireStudent,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const student = await findStudentForUser(db, req.user.id);
    if (!student) throw notFound('Student record');

    const clauses = ['sb.student_id = ?'];
    const params = [student.id];
    if (req.query.from) {
      clauses.push('sb.travel_date >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      clauses.push('sb.travel_date <= ?');
      params.push(req.query.to);
    }

    const rows = await db.all(
      `${SELECT_BOOKING} WHERE ${clauses.join(' AND ')} ORDER BY sb.travel_date DESC, sb.id DESC`,
      ...params,
    );

    res.json({ success: true, data: { bookings: rows.map(shapeBooking) } });
  }),
);

// ---------------------------------------------------------------------------
// Cancel a booking (rider)
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requireStudent,
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const student = await findStudentForUser(db, req.user.id);
    if (!student) throw notFound('Student record');

    const id = Number(req.params.id);
    // Scoping the lookup by student_id means another rider's booking is a
    // 404, not a 403 — the row's existence is never confirmed.
    const existing = await db.get(
      'SELECT * FROM student_bookings WHERE id = ? AND student_id = ?',
      id,
      student.id,
    );
    if (!existing) throw notFound('Booking');

    // Soft cancel: the ledger keeps the history, only the status changes.
    await db.run("UPDATE student_bookings SET status = 'CANCELLED', updated_at = NOW() WHERE id = ?", id);

    const booking = await loadBooking(db, id);

    recordAudit(
      fromRequest(req, 'booking.cancel', {
        entity: 'student_booking',
        entityId: id,
        detail: { travelDate: existing.travel_date },
      }),
    );

    hub.sendToUser(student.user_id ?? req.user.id, 'booking_updated', { action: 'cancelled', booking });
    hub.broadcast('bookings', 'booking_updated', { action: 'cancelled', booking }, student.tenant_id ?? null);

    res.json({ success: true, data: { booking } });
  }),
);

// ---------------------------------------------------------------------------
// Ledger (staff)
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('students:read'),
  validate(bookingQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { date, from, to, status, search } = req.query;
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25 });

    const clauses = [];
    const params = [];
    if (date) {
      clauses.push('sb.travel_date = ?');
      params.push(date);
    }
    if (from) {
      clauses.push('sb.travel_date >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('sb.travel_date <= ?');
      params.push(to);
    }
    if (status && status !== 'all') {
      clauses.push('sb.status = ?');
      params.push(status);
    }
    if (search) {
      const term = `%${search}%`;
      clauses.push('(s.full_name LIKE ? OR s.college_id LIKE ?)');
      params.push(term, term);
    }

    // Campus isolation: campus staff see their own campus's bookings only;
    // platform principals must drill in with `tenantId`. The alias keeps the
    // filter pinned to the booking's own tenant column.
    const scope = await operationalTenantScope(db, req.user, req.query, 'sb');
    clauses.push(scope.clause);
    params.push(...scope.params);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // MySQL requires integer-typed parameters for LIMIT/OFFSET markers and
    // mysql2 binds JS numbers as DOUBLE, so the (validated, integer) pagination
    // values are interpolated instead of bound.
    const rows = await db.all(
      `${SELECT_BOOKING} ${where} ORDER BY sb.travel_date DESC, sb.id DESC LIMIT ${limit} OFFSET ${offset}`,
      ...params,
    );
    const total = (await db.get(
      `SELECT COUNT(*) AS n FROM student_bookings sb LEFT JOIN students s ON s.id = sb.student_id ${where}`,
      ...params,
    )).n;

    res.json({
      success: true,
      data: {
        bookings: rows.map(shapeBooking),
        meta: paginationMeta({ total, limit, page }),
      },
    });
  }),
);

export default router;
