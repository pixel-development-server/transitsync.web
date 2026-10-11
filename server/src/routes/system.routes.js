/**
 * Public system surface.
 *
 * Mounted BEFORE the authentication gate so the sign-in screen (and any status
 * page) can learn whether the platform — or a specific campus — is in
 * maintenance without holding a session. Only non-sensitive, non-enumerable
 * information is exposed here.
 */

import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler } from '../lib/http.js';
import { getMaintenance, getInstitutionMaintenance, resolveTenantMaintenanceByEmail } from '../services/maintenance.js';

const router = express.Router();

/**
 * GET /api/system/status
 *
 * With no query this reports the platform-wide state:
 *   -> { success: true, data: { isMaintenanceMode: boolean, message: string } }
 *
 * With `?tenant_id=<uuid>` (or `?email=<address>`, which the server resolves to
 * the account's campus) it reports that institution's own state:
 *   -> data: {
 *        isMaintenanceMode: boolean,          // campus OR platform maintenance
 *        message: string,                     // the relevant maintenance copy
 *        institutionName: string,             // the resolved campus name
 *        tenantId: string | null,
 *        global: { isMaintenanceMode, message } // platform-wide state
 *      }
 * A campus is effectively "under maintenance" when either its own switch or
 * the platform-wide switch is on — the sign-in gate blocks under both.
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const global = getMaintenance(db);

    const tenantId = typeof req.query.tenant_id === 'string' && req.query.tenant_id ? req.query.tenant_id : null;
    const email = typeof req.query.email === 'string' && req.query.email ? req.query.email : null;

    let tenant = null;
    if (tenantId) {
      tenant = getInstitutionMaintenance(db, tenantId);
    } else if (email) {
      tenant = resolveTenantMaintenanceByEmail(db, email);
    }

    if (!tenant) {
      res.json({ success: true, data: { ...global, global } });
      return;
    }

    res.json({
      success: true,
      data: {
        isMaintenanceMode: global.isMaintenanceMode || tenant.isMaintenanceMode,
        // Prefer the campus's own notice when the campus itself is in
        // maintenance; otherwise fall back to the platform-wide message.
        message: tenant.isMaintenanceMode ? tenant.message : global.message,
        institutionName: tenant.institutionName,
        tenantId: tenant.tenantId,
        global,
      },
    });
  }),
);

export default router;