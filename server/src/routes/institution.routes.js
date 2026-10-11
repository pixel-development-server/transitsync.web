/**
 * Institution (tenant) surface.
 *
 * Holds the tenant-scoped maintenance switch. A campus System Administrator
 * (Level 100) toggles maintenance for their OWN institution only, so a
 * maintenance window at one college never touches the rest of the platform.
 * The Level 200 Super Administrator may also target any campus by passing
 * `tenantId` (it cannot, however, set a message for a campus it manages).
 *
 * Mounted behind the standard session + rotation gates; the route re-checks
 * the actor is a campus System Administrator or the platform owner.
 */

import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { forbidden } from '../lib/errors.js';
import { SUPER_ADMIN_LEVEL } from '../db/permissions.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { setInstitutionMaintenance } from '../services/maintenance.js';
import { institutionMaintenanceSchema } from '../validation/schemas.js';

const router = express.Router();

/**
 * PUT /api/institution/maintenance
 * body: { enabled: boolean, message?: string, tenantId?: uuid (Super Admin only) }
 *
 * Toggles `institutions.is_maintenance_mode` for the requester's campus. When
 * engaged, ONLY that campus's users are refused sign-in / frozen with a 503 —
 * every other institution keeps working. The campus's own System Administrator
 * (who is calling this) stays exempt so maintenance can always be turned off.
 */
router.put(
  '/maintenance',
  validate(institutionMaintenanceSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const isPlatformOwner = Number(req.user.role_level) >= SUPER_ADMIN_LEVEL;
    const isCampusAdmin = req.user.role_key === 'system_admin';

    if (!isPlatformOwner && !isCampusAdmin) {
      throw forbidden('Only a campus System Administrator can manage maintenance mode.', {
        code: 'SYSTEM_ADMIN_ONLY',
      });
    }

    // A campus admin always acts on their own tenant. Only the platform owner
    // may name a different campus (used by the platform console).
    const tenantId = isPlatformOwner && req.body.tenantId ? req.body.tenantId : req.user.tenant_id;
    if (!isPlatformOwner && !req.user.tenant_id) {
      throw forbidden('This account is not attached to a campus.', { code: 'NO_TENANT' });
    }

    const state = setInstitutionMaintenance(db, {
      tenantId,
      enabled: req.body.enabled,
      message: req.body.message,
    });

    recordAudit(
      fromRequest(req, 'institution.maintenance', {
        entity: 'institution',
        entityId: state.tenantId,
        detail: { enabled: state.isMaintenanceMode, message: state.message },
      }),
    );

    res.json({ success: true, data: state });
  }),
);

export default router;