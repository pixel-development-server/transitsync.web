/**
 * Platform Super Administrator (Level 200) surface.
 *
 * Reserved exclusively for the platform owner: college provisioning, tenant
 * suspension and the global maintenance switch. Mounted behind the standard
 * session gate, then `requireSuperAdmin`.
 */

import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { getMaintenance, setMaintenance } from '../services/maintenance.js';
import { maintenanceSchema } from '../validation/schemas.js';

const router = express.Router();

router.use(requireSuperAdmin);

/** GET /api/super-admin/maintenance — current global maintenance state. */
router.get(
  '/maintenance',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: getMaintenance() });
  }),
);

/**
 * PATCH /api/super-admin/maintenance — engage / disengage maintenance, and edit
 * the message shown to locked-out users.
 */
router.patch(
  '/maintenance',
  validate(maintenanceSchema),
  asyncHandler(async (req, res) => {
    const { enabled, message } = req.body;
    const state = setMaintenance(getDb(), { enabled, message, updatedBy: req.user.id });
    recordAudit(
      fromRequest(req, 'platform.maintenance', { entity: 'system', detail: { ...state } }),
    );
    res.json({ success: true, data: state });
  }),
);

export default router;
