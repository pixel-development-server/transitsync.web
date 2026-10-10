import express from 'express';

import { requireAuth } from '../middleware/auth.js';
import { requireAnyPermission } from '../middleware/requirePermission.js';
import { hub } from '../services/realtime.js';
import { asyncHandler } from '../lib/http.js';

const router = express.Router();

/**
 * Realtime scan/alert feed over SSE.
 *
 * `requireAnyPermission` here is the WebSocket-equivalent channel guard: a socket
 * is only opened for principals entitled to at least one stream channel, and the
 * hub then filters every individual event by channel permission.
 *
 * `access_token` is accepted as a query parameter because `EventSource` cannot set
 * an Authorization header. The cookie is the primary path.
 */
router.get(
  '/',
  requireAuth,
  requireAnyPermission('attendance:read', 'dashboard:read', 'alerts:read', 'fleet:read'),
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
