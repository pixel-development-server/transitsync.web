import express from 'express';

import { requireAuth } from '../middleware/auth.js';
import { requireAnyPermission } from '../middleware/requirePermission.js';
import { hasAnyPermission } from '../services/permissions.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { hub } from '../services/realtime.js';
import { asyncHandler } from '../lib/http.js';

const router = express.Router();

/** Read entitlements that entitle a principal to a fan-out stream. */
const STREAM_PERMISSIONS = [
  'attendance:read',
  'dashboard:read',
  'alerts:read',
  'fleet:read',
  'students:read',
];

/**
 * Open the stream for anyone entitled to at least one channel — staff by
 * permission, riders by role.
 *
 * A Level 1 `student` holds an intentionally empty permission set (see
 * `ROLE_DEFAULTS.student`), so a pure permission gate would answer 403 to every
 * portal tab. Admitting them stays safe because `hub.canReceive` denies a
 * student *every* broadcast channel: the only frames a rider can ever receive
 * are the personal ones pushed through `hub.sendToUser`, which are addressed by
 * user id and never carry another student's rows.
 *
 * `requireAnyPermission` still guards `/status` — it exposes aggregate channel
 * counts and therefore remains a staff facility.
 */
function requireStreamAccess(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role_key === 'student') return next();
  if (hasAnyPermission(req.user, STREAM_PERMISSIONS)) return next();
  return next(
    forbidden('Your account is not entitled to a realtime stream.', {
      code: 'STREAM_FORBIDDEN',
    }),
  );
}

/**
 * Realtime scan/alert feed over SSE.
 *
 * `requireStreamAccess` here is the WebSocket-equivalent channel guard: a socket
 * is only opened for principals entitled to at least one stream channel (or, for
 * a rider, for their own personally-addressed events), and the hub then filters
 * every individual event by channel permission.
 *
 * `access_token` is accepted as a query parameter because `EventSource` cannot set
 * an Authorization header. The cookie is the primary path.
 */
router.get(
  '/',
  requireAuth,
  requireStreamAccess,
  asyncHandler(async (req, res) => {
    // Proxies must not buffer this or events arrive in bursts.
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const id = hub.subscribe(req, res, req.user);
    process.stdout.write(`[stream] ${req.user.email} subscribed (${id}) — ${hub.clients.size} client(s)\n`);
  }),
);

/** Connection diagnostics shown in the dashboard's "live" indicator. */
router.get(
  '/status',
  requireAuth,
  requireAnyPermission('attendance:read', 'dashboard:read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: hub.stats() });
  }),
);

export default router;
