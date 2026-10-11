/**
 * Public system surface.
 *
 * Mounted BEFORE the authentication gate so the sign-in screen (and any status
 * page) can learn whether the platform is in maintenance without holding a
 * session. Only non-sensitive, non-enumerable information is exposed here.
 */

import express from 'express';

import { asyncHandler } from '../lib/http.js';
import { getMaintenance } from '../services/maintenance.js';

const router = express.Router();

/**
 * GET /api/system/status
 * -> { success: true, data: { isMaintenanceMode: boolean, message: string } }
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: getMaintenance() });
  }),
);

export default router;
