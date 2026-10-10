import crypto from 'node:crypto';
import express from 'express';

import config from '../config/env.js';
import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { processTap } from '../services/scanner.js';
import { recordVisitorPress } from '../services/visitors.js';
import { deviceBatchSchema } from '../validation/schemas.js';

/**
 * Hardware ingest.
 *
 * The Wokwi Arduino Uno has no network stack, so a local relay process reads its
 * serial output and forwards each JSON line here. This route is therefore
 * mounted OUTSIDE the JWT/RBAC chain (see routes/index.js) and guarded by a
 * shared token instead — a device cannot hold a user session.
 *
 * Every accepted event still flows through the exact same `processTap` engine
 * the simulator uses, so a hardware tap produces the same scan row, alert and
 * SSE broadcast as a simulated one.
 *
 * Body shape (single object, array, `{ events: [...] }` or `{ scans: [...] }`):
 *   { "type": "CARD_TAP",       "uid": "11 22 33 44", "deviceId": "BUS-01" }
 *   { "type": "VISITOR_BUTTON", "payload": "CLICK",    "deviceId": "BUS-01" }
 */
const router = express.Router();

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function relayGuard(req, res, next) {
  const expected = config.relay.token;

  if (expected) {
    const presented = req.get('x-relay-token') || req.query.token || '';
    return safeEqual(presented, expected) ? next() : next(forbidden('Invalid relay token.'));
  }

  // No token configured: accept only the local machine, and never in production,
  // so an exposed deployment fails closed instead of accepting anonymous taps.
  if (!config.isProduction && isLoopback(req)) return next();
  return next(forbidden('Scan relay is not configured. Set RELAY_TOKEN in server/.env.'));
}

/** Map a reader `deviceId` (e.g. `BUS-01`) to a bus row. */
function findBus(deviceId) {
  if (!deviceId) return null;
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT b.*, r.code AS route_code, r.name AS route_name
           FROM buses b
           LEFT JOIN routes r ON r.id = b.current_route_id
          WHERE UPPER(b.code) = UPPER(?)`,
      )
      .get(String(deviceId).trim()) ?? null
  );
}

function handleEvent(event) {
  const type = String(event?.type ?? '').trim().toUpperCase();
  const deviceId = event?.deviceId ? String(event.deviceId).trim() : null;
  const at = event?.timestamp ?? event?.ts ?? null;
  const bus = findBus(deviceId);

  if (type === 'CARD_TAP') {
    const uid = event?.uid ?? (typeof event?.payload === 'string' ? event.payload : null);
    if (!uid) throw badRequest('CARD_TAP requires a `uid`.');

    const result = processTap({
      rfidSerial: uid,
      busId: bus?.id ?? null,
      gate: deviceId ?? null,
      latitude: event?.latitude ?? null,
      longitude: event?.longitude ?? null,
      // Preserve the reader's own timestamp when supplied; otherwise the engine
      // stamps `datetime('now')`. Storage stays UTC, NPT is attached for display.
      scanTime: at,
    });

    return {
      type,
      deviceId,
      busCode: bus?.code ?? null,
      uid: String(uid).trim().toUpperCase().replace(/\s+/g, ''),
      outcome: result.outcome,
      attendance: result.outcome === 'VALID' ? 'APPROVED' : 'LOGGED',
      alertType: result.alertType,
      scanTime: result.scan?.scanTime ?? null,
      scanTimeNpt: result.scan?.scanTimeNpt ?? null,
      scan: result.scan,
    };
  }

  if (type === 'VISITOR_BUTTON') {
    const visitor = recordVisitorPress({
      busId: bus?.id ?? null,
      routeId: bus?.current_route_id ?? null,
      deviceId,
      at,
    });
    return { type, deviceId, busCode: bus?.code ?? null, visitor };
  }

  throw badRequest(`Unsupported event type: ${type || '(missing)'}`);
}

router.post(
  '/sync',
  relayGuard,
  validate(deviceBatchSchema),
  asyncHandler(async (req, res) => {
    const body = req.body;
    const events = Array.isArray(body)
      ? body
      : Array.isArray(body?.events)
        ? body.events
        : Array.isArray(body?.scans)
          ? body.scans
          : [body];

    const results = [];
    let processed = 0;
    let rejected = 0;

    // One bad event must never poison the rest of a burst.
    for (const event of events) {
      try {
        results.push({ ok: true, ...handleEvent(event) });
        processed += 1;
      } catch (error) {
        rejected += 1;
        results.push({
          ok: false,
          type: event?.type ?? null,
          deviceId: event?.deviceId ?? null,
          error: error.message,
        });
      }
    }

    res.status(processed === 0 && rejected > 0 ? 422 : 200).json({
      success: rejected === 0,
      data: { received: events.length, processed, rejected, results },
    });
  }),
);

export default router;
