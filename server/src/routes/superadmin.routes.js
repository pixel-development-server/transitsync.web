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
import {
  listColleges,
  provisionCollege,
  setCollegeStatus,
  platformOverview,
} from '../services/colleges.js';
import {
  maintenanceSchema,
  collegeCreateSchema,
  collegeStatusSchema,
  collegeIdSchema,
} from '../validation/schemas.js';

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

// ---------------------------------------------------------------------------
// Colleges (tenants)
// ---------------------------------------------------------------------------

/** GET /api/super-admin/colleges — every campus with admin + headcounts. */
router.get(
  '/colleges',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: { colleges: listColleges(getDb()) } });
  }),
);

/**
 * POST /api/super-admin/colleges — register a campus and its Level 100
 * System Administrator. Returns the one-time handover credential (no mail
 * server is configured in this deployment).
 */
router.post(
  '/colleges',
  validate(collegeCreateSchema),
  asyncHandler(async (req, res) => {
    const { name, code, adminEmail, adminName } = req.body;
    const result = await provisionCollege(getDb(), { name, code, adminEmail, adminName }, req.user.id);

    recordAudit(
      fromRequest(req, 'platform.college.create', {
        entity: 'institution',
        entityId: result.college.id,
        detail: { name, code, adminEmail },
      }),
    );

    res.status(201).json({ success: true, data: result });
  }),
);

/** PATCH /api/super-admin/colleges/:id — suspend or restore a campus. */
router.patch(
  '/colleges/:id',
  validate(collegeIdSchema, 'params'),
  validate(collegeStatusSchema),
  asyncHandler(async (req, res) => {
    const college = setCollegeStatus(getDb(), req.params.id, req.body.status);
    recordAudit(
      fromRequest(req, 'platform.college.status', {
        entity: 'institution',
        entityId: college.id,
        detail: { status: college.status },
      }),
    );
    res.json({ success: true, data: { college } });
  }),
);

/** GET /api/super-admin/overview — platform-wide figures for the health panel. */
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: { ...platformOverview(getDb()), maintenance: getMaintenance() },
    });
  }),
);

export default router;
