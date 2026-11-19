import { getDb } from '../db/connection.js';
import hub from './realtime.js';
import { formatNpt, toNptStamp } from '../lib/time.js';

/** Alert taxonomy surfaced as colour-coded tags in the console. */
export const ALERT_TYPES = {
  INVALID_CARD: {
    label: 'Invalid Card',
    severity: 'HIGH',
    tag: 'invalid-card',
    description: 'Card is known but blocked, lost, or the holder is not an active student.',
  },
  UNREGISTERED_DEVICE: {
    label: 'Unregistered Device',
    severity: 'CRITICAL',
    tag: 'unregistered-device',
    description: 'RFID serial is not present in the student registry at all.',
  },
  UNAUTHORIZED_ROUTE: {
    label: 'Unauthorized Route',
    severity: 'HIGH',
    tag: 'unauthorized-route',
    description: 'Student tried to board a bus they are not allocated to.',
  },
  EXPIRED_PASS: {
    label: 'Expired Pass',
    severity: 'MEDIUM',
    tag: 'expired-pass',
    description: 'Bus pass validity window does not cover today.',
  },
  CAPACITY_EXCEEDED: {
    label: 'Capacity Exceeded',
    severity: 'MEDIUM',
    tag: 'capacity-exceeded',
    description: 'Live occupancy surpassed the configured seat capacity.',
  },
  SYSTEM: {
    label: 'System Notice',
    severity: 'INFO',
    tag: 'system',
    description: 'Operational notice raised by the platform.',
  },
};

// Every outcome `evaluateTap` can produce. This is the single source of truth
// for the simulator UI, so a new verdict branch must be added here too — it was
// previously missing UNREGISTERED_CARD, making the ghost-card scenario
// unreachable from the interface. EXPIRED was removed with the pass-expiry model.
export const SIMULATOR_OUTCOMES = [
  'VALID',
  'INVALID',
  'UNREGISTERED_BUS',
  'UNREGISTERED_CARD',
];

const todayISO = () => new Date().toISOString().slice(0, 10);

async function raiseAlert(db, { type, title, message, severity, scanEventId, studentId, busId, routeId, metadata, tenantId = null }) {
  const resolvedType = type ?? 'SYSTEM';
  const definition = ALERT_TYPES[resolvedType] ?? ALERT_TYPES.SYSTEM;
  const result = await db.run(
    `INSERT INTO alerts (type, severity, title, message, scan_event_id, student_id, bus_id, route_id, metadata, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    resolvedType,
    severity ?? definition.severity,
    title,
    message,
    scanEventId ?? null,
    studentId ?? null,
    busId ?? null,
    routeId ?? null,
    metadata ? JSON.stringify(metadata) : null,
    tenantId ?? null,
  );

  return db.get(
    `SELECT a.*, s.full_name AS student_name, b.code AS bus_code, r.code AS route_code
       FROM alerts a
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN buses b    ON b.id = a.bus_id
       LEFT JOIN routes r   ON r.id = a.route_id
      WHERE a.id = ?`,
    result.lastInsertRowid,
  );
}

export async function getBusOccupancy(db, busId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM students WHERE onboard_bus_id = ?', busId);
  return row.n;
}

/**
 * Canonical client-facing shape for a scan event.
 *
 * Lives here rather than in a route because a scan is produced in three places —
 * the simulator, the attendance API and the SSE broadcast — and all three must
 * agree, otherwise the live board and the history table disagree on field names.
 */
export function shapeScanEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    rfidSerial: row.rfid_serial,
    studentId: row.student_id,
    // Campus this event belongs to — the SSE fan-out filters on it so one
    // college's live board never shows another college's taps.
    tenantId: row.tenant_id ?? null,
    studentName: row.student_name ?? 'Unknown card',
    collegeId: row.college_id,
    faculty: row.faculty,
    busId: row.bus_id,
    busCode: row.bus_code,
    busName: row.bus_name,
    routeId: row.route_id,
    routeCode: row.route_code,
    routeName: row.route_name,
    direction: row.direction,
    outcome: row.outcome,
    message: row.message,
    latitude: row.latitude,
    longitude: row.longitude,
    gate: row.gate,
    occupancy: row.occupancy_after,
    capacity: row.seat_capacity ?? null,
    utilization:
      row.seat_capacity && row.occupancy_after != null
        ? Math.round((row.occupancy_after / row.seat_capacity) * 100)
        : null,
    scanTime: row.scan_time,
    // Always UTC on the wire; this is the same instant rendered in Nepal Time.
    scanTimeNpt: formatNpt(row.scan_time),
  };
}

/**
 * Core RFID decision engine.
 *
 * Evaluates one card tap against the registry and mutates live occupancy, then
 * writes an immutable `scan_events` row, optionally raises a security alert and
 * fans the result out to entitled SSE subscribers.
 *
 * @returns {{outcome:string, scan:object, student:object|null, bus:object|null,
 *            alert:object|null, occupancy:number, capacity:number}}
 */
export async function processTap(input = {}) {
  const db = getDb();
  const serial = String(input.rfidSerial ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const busId = input.busId ? Number(input.busId) : null;
  const latitude = input.latitude ?? null;
  const longitude = input.longitude ?? null;
  const gate = input.gate ?? null;
  // A hardware relay may forward the reader's own timestamp; when it does, keep
  // that instant (normalised to NPT wall time, the zone the columns store in)
  // instead of the server's receive time.
  const scanTimeNpt = toNptStamp(input.scanTime);

  const bus = busId
    ? await db.get('SELECT b.*, r.code AS route_code, r.name AS route_name FROM buses b LEFT JOIN routes r ON r.id = b.current_route_id WHERE b.id = ?', busId)
    : await db.get("SELECT b.*, r.code AS route_code, r.name AS route_name FROM buses b LEFT JOIN routes r ON r.id = b.current_route_id WHERE b.status = 'ACTIVE' ORDER BY b.id LIMIT 1");

  if (!serial) {
    throw new Error('An RFID serial is required to simulate a tap.');
  }
  if (input.busId && !bus) {
    throw new Error(`Bus #${input.busId} does not exist.`);
  }

  const resolvedBusId = bus?.id ?? null;
  const routeId = bus?.current_route_id ?? null;

  const result = await db.transaction(async () => {
    const student = await db.get("SELECT * FROM students WHERE UPPER(REPLACE(rfid_serial, ' ', '')) = ?", serial) ?? null;
    // Campus ownership of everything written below: the rider's campus first,
    // else the campus that runs the bus the tap happened on, else a
    // campus-neutral (system) event.
    const tenantId = student?.tenant_id ?? bus?.tenant_id ?? null;

    const verdict = evaluateTap({ student, bus, today: todayISO() });

    // A successful tap flips the passenger's live occupancy pointer.
    let occupancyAfter = resolvedBusId ? await getBusOccupancy(db, resolvedBusId) : 0;

    if (verdict.outcome === 'VALID' && resolvedBusId) {
      const boarding = verdict.direction === 'BOARD';
      if (boarding) {
        await db.run("UPDATE students SET onboard_bus_id = ?, onboard_at = NOW(), updated_at = NOW() WHERE id = ?", resolvedBusId, student.id);
      } else {
        await db.run("UPDATE students SET onboard_bus_id = NULL, onboard_at = NULL, updated_at = NOW() WHERE id = ?", student.id);
      }
      occupancyAfter = await getBusOccupancy(db, resolvedBusId);
    }

    const scanResult = await db.run(
      `INSERT INTO scan_events
         (rfid_serial, student_id, bus_id, route_id, direction, outcome, message,
          latitude, longitude, gate, occupancy_after, scan_time, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?)`,
      serial,
      student?.id ?? null,
      resolvedBusId,
      routeId,
      verdict.direction,
      verdict.outcome,
      verdict.message,
      latitude,
      longitude,
      gate,
      occupancyAfter,
      scanTimeNpt,
      tenantId,
    );

    const scan = await db.get(
      `SELECT e.*, s.full_name AS student_name, s.college_id, s.faculty,
              b.code AS bus_code, b.name AS bus_name, b.seat_capacity,
              r.code AS route_code, r.name AS route_name
         FROM scan_events e
         LEFT JOIN students s ON s.id = e.student_id
         LEFT JOIN buses b    ON b.id = e.bus_id
         LEFT JOIN routes r   ON r.id = e.route_id
        WHERE e.id = ?`,
      scanResult.lastInsertRowid,
    );

    // Alerts are reserved for cards whose UID is unknown to the registry. Any
    // other problem (wrong bus, revoked card, suspended student, over-capacity)
    // is a normal activity log entry and never becomes an Unregistered Alert.
    let alert = null;
    if (verdict.outcome === 'UNREGISTERED_CARD' && verdict.alertType) {
      alert = await raiseAlert(db, {
        type: verdict.alertType,
        title: verdict.title,
        message: verdict.message,
        scanEventId: scan.id,
        studentId: null,
        busId: resolvedBusId,
        routeId,
        metadata: { serial, outcome: verdict.outcome, gate },
        tenantId,
      });
    }

    return { verdict, scan, alert, occupancyAfter, student, bus };
  });

  publish(result);
  const alertType = result.alert?.type ?? result.verdict.alertType ?? null;
  return {
    outcome: result.verdict.outcome,
    direction: result.verdict.direction,
    message: result.verdict.message,
    scan: shapeScanEvent(result.scan),
    student: result.student,
    bus: result.bus,
    alert: result.alert,
    alertType,
    // Mirrors /simulator/preview so every simulator surface can colour-code the
    // resulting alert without re-deriving the taxonomy on the client.
    alertLabel: alertType ? ALERT_TYPES[alertType]?.label ?? alertType : null,
    tag: alertType ? ALERT_TYPES[alertType]?.tag ?? 'system' : null,
    occupancy: result.occupancyAfter,
    capacity: result.bus?.seat_capacity ?? null,
    utilization: result.bus?.seat_capacity
      ? Math.round((result.occupancyAfter / result.bus.seat_capacity) * 100)
      : null,
  };
}

/**
 * Pure decision function — no I/O — so the rule set stays unit-testable and the
 * simulator UI can explain *why* a tap was rejected.
 *
 * Only an unknown UID (`UNREGISTERED_CARD`) carries an `alertType`. A card that
 * is registered but presented on the wrong bus, suspended, or revoked is an
 * ordinary activity log entry — not an "Unregistered Alert".
 */
export function evaluateTap({ student, bus }) {
  const base = { direction: 'BOARD', alertType: null, title: null };

  if (!student) {
    return {
      ...base,
      outcome: 'UNREGISTERED_CARD',
      message: 'RFID serial is not registered to any student.',
      title: 'Unregistered device detected',
      // The one and only scan outcome that raises an Unregistered Alert.
      alertType: 'UNREGISTERED_DEVICE',
    };
  }

  const name = student.full_name;
  const cardStatus = student.card_status ?? 'UNASSIGNED';

  if (student.status !== 'ACTIVE') {
    return {
      ...base,
      outcome: 'INVALID',
      message: `${name} is marked ${student.status.toLowerCase()}; access revoked.`,
    };
  }

  if (cardStatus === 'REVOKED') {
    const reason = student.card_revoked_reason ? ` (${student.card_revoked_reason})` : '';
    return {
      ...base,
      outcome: 'INVALID',
      message: `${name}'s bus card has been revoked${reason}.`,
    };
  }

  if (cardStatus === 'UNASSIGNED') {
    return {
      ...base,
      outcome: 'INVALID',
      message: `${name} does not hold an issued bus card.`,
    };
  }

  // Per-student bus allocation (`students.bus_id`) was retired with the roster
  // model; the live pointer is `onboard_bus_id`. A rider may board any bus —
  // except while they are still aboard a *different* one, in which case they
  // must tap off first rather than sit on two occupancy counts at once.
  if (bus && student.onboard_bus_id && Number(student.onboard_bus_id) !== Number(bus.id)) {
    return {
      ...base,
      outcome: 'UNREGISTERED_BUS',
      message: `${name} is still aboard another bus and cannot board ${bus.code}.`,
    };
  }

  // Valid: derive direction from current occupancy state.
  const onBoard = student.onboard_bus_id && Number(student.onboard_bus_id) === Number(bus?.id ?? -1);
  return {
    outcome: 'VALID',
    direction: onBoard ? 'DEBOARD' : 'BOARD',
    message: onBoard ? `${name} tapped off ${bus?.code ?? 'bus'}.` : `${name} boarded ${bus?.code ?? 'bus'}.`,
    alertType: null,
    title: null,
  };
}

/** Fan the verdict out to the realtime hub and refresh fleet occupancy clients. */
function publish({ scan, alert }) {
  // Reuse the canonical shaper: a live SSE frame and the REST scan must be the
  // same object, otherwise the live board and the history table disagree.
  const activity = shapeScanEvent(scan);

  hub.broadcast('scan', 'scan', activity);
  hub.broadcast('activity', 'activity', activity);
  if (scan.bus_id) {
    hub.broadcast('fleet', 'occupancy', {
      busId: scan.bus_id,
      occupancy: scan.occupancy_after,
      capacity: scan.seat_capacity,
      routeCode: scan.route_code,
      studentId: scan.student_id,
      onboard: scan.direction === 'BOARD',
    }, scan.tenant_id ?? null);
  }
  if (alert) {
    hub.broadcast('alert', 'alert', {
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      status: alert.status,
      createdAt: alert.created_at,
      busCode: alert.bus_code ?? null,
      studentName: alert.student_name ?? null,
      tenantId: alert.tenant_id ?? null,
    });
  }
}

/** Raise a manual, operator-authored alert (Settings / fleet / student actions). */
export async function createManualAlert({ type = 'SYSTEM', title, message, severity, busId = null, routeId = null, studentId = null, metadata = null, tenantId = null }) {
  const db = getDb();
  const alert = await db.transaction(async () =>
    raiseAlert(db, { type, title, message, severity, busId, routeId, studentId, metadata, tenantId }),
  );
  hub.broadcast('alert', 'alert', {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    status: alert.status,
    createdAt: alert.created_at,
    tenantId: alert.tenant_id ?? tenantId ?? null,
  });
  return alert;
}

export default { processTap, evaluateTap, createManualAlert, getBusOccupancy, ALERT_TYPES, SIMULATOR_OUTCOMES };
