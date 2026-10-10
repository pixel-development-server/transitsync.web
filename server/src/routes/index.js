import express from 'express';

import { authenticate, requirePasswordRotated } from '../middleware/auth.js';
import authRoutes from './auth.routes.js';
import userRoutes, { rolesRouter } from './users.routes.js';
import studentRoutes from './students.routes.js';
import { busesRouter, routesRouter } from './fleet.routes.js';
import attendanceRoutes from './attendance.routes.js';
import alertRoutes from './alerts.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import simulatorRoutes from './simulator.routes.js';
import scanRoutes from './scans.routes.js';
import streamRoutes from './stream.routes.js';
import settingsRoutes from './settings.routes.js';
import { getDb } from '../db/connection.js';
import { hub } from '../services/realtime.js';

const router = express.Router();

/** Liveness + build info. Public by design so it can sit behind a load balancer. */
router.get('/health', (req, res) => {
  const db = getDb();
  let database = 'down';
  try {
    db.prepare('SELECT 1').get();
    database = 'up';
  } catch {
    database = 'down';
  }
  res.json({
    success: database === 'up',
    data: {
      status: database === 'up' ? 'healthy' : 'degraded',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      database,
      streamClients: hub.clients.size,
      timestamp: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// Bootstrap surface. Deliberately mounted OUTSIDE the forced-rotation gate so a
// staff member awaiting their first password change can still sign in and rotate.
// ---------------------------------------------------------------------------
router.use('/auth', authRoutes);

// Hardware ingest. Mounted outside the session gate on purpose: the Wokwi relay
// is a local process with no user session. It carries its own shared-secret
// guard (see scans.routes.js) instead of the JWT/RBAC chain.
router.use('/scans', scanRoutes);

// ---------------------------------------------------------------------------
// Everything else requires a valid session, then a rotated password.
//
// `authenticate` must run first: it is what verifies the JWT, checks the
// backing session row, honours `token_version` revocations and rejects
// suspended accounts. `requirePasswordRotated` only inspects `req.user`, so
// mounting it alone would reject every request with a bare 401.
// ---------------------------------------------------------------------------
router.use(authenticate);
router.use(requirePasswordRotated);

router.use('/users', userRoutes);
router.use('/roles', rolesRouter);
router.use('/students', studentRoutes);
router.use('/buses', busesRouter);
router.use('/routes', routesRouter);
router.use('/attendance', attendanceRoutes);
router.use('/alerts', alertRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/simulator', simulatorRoutes);
router.use('/stream', streamRoutes);
// Settings are mounted under both /settings (what the console calls) and the
// legacy /system path, so either base keeps working.
router.use('/settings', settingsRoutes);
router.use('/system', settingsRoutes);

export default router;
