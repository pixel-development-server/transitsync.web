import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashPassword, generateTemporaryPassword } from '../lib/password.js';
import { requireAuth, requireSystemAdmin } from '../middleware/auth.js';
import { recordAudit, fromRequest, listAudit } from '../services/audit.js';
import { loadUserForAuth } from '../services/permissions.js';
import { toCsv, timestampedFilename } from '../lib/csv.js';
import { idSchema } from '../validation/schemas.js';

const router = express.Router();

/**
 * Master panel — exclusive to the Level 100 System Administrator.
 *
 * Every route here is a *System Control* facility:
 *   1. /audit/export + /audit/purge  — archive & flush the audit trail
 *   2. /lockdown                     — global emergency lockout switch
 *   3. /sessions/revoke              — revoke sessions (per-user or every role)
 *   4. /users/:id/reset-password     — password reset override with no seniority cap
 *
 * `requireSystemAdmin` is the real gate; the `system:*` permission keys exist in
 * the catalogue for visibility but can never be granted in a way that opens
 * these routes, because the role check happens regardless of grants.
 */
router.use(requireAuth, requireSystemAdmin);

const LOCKDOWN_KEY = 'system.lockdown';

function readLockdown() {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(LOCKDOWN_KEY);
  if (!row?.value) {
    return { locked: false, message: null, by: null, at: null };
  }
  try {
    return { locked: false, ...JSON.parse(row.value) };
  } catch {
    return { locked: false, message: null, by: null, at: null };
  }
}

// ---------------------------------------------------------------------------
// 1. Audit trail archive & purge
// ---------------------------------------------------------------------------

/** Archive the full audit trail as a downloadable RFC-4180 CSV snapshot. */
router.get('/audit/export', asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = listAudit(db, { limit: 100000, offset: 0 });

  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'created_at', label: 'Timestamp' },
    { key: 'actor_email', label: 'Actor email' },
    { key: 'user_name', label: 'Actor name' },
    { key: 'action', label: 'Action' },
    { key: 'entity', label: 'Entity' },
    { key: 'entity_id', label: 'Entity ID' },
    { key: 'detail', label: 'Details', format: (value) => value ?? '' },
    { key: 'ip', label: 'IP' },
    { key: 'status', label: 'Status' },
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${timestampedFilename('audit-archive', 'csv')}"`);
  res.send(toCsv(columns, rows));

  recordAudit(fromRequest(req, 'audit.export', { entity: 'audit' }));
}));

/** Flush audit rows older than `olderThanDays` (default 30; 0 clears the log). */
router.post('/audit/purge', asyncHandler(async (req, res) => {
  const db = getDb();
  const days = req.body?.olderThanDays == null ? 30 : Number(req.body.olderThanDays);
  if (!Number.isFinite(days) || days < 0) {
    throw badRequest('olderThanDays must be a non-negative number of days.', [
      { field: 'olderThanDays', message: 'Must be a non-negative number of days.' },
    ]);
  }

  const statement = db.prepare(
    days === 0 ? 'DELETE FROM audit_logs' : "DELETE FROM audit_logs WHERE created_at < datetime('now', ?)",
  );
  const purged = (days === 0 ? statement.run() : statement.run(`-${days} days`)).changes;

  // Recorded after the delete so this very entry survives the flush.
  recordAudit(fromRequest(req, 'audit.purge', { entity: 'audit', detail: { olderThanDays: days, purged } }));
  res.json({
    success: true,
    data: {
      purged,
      message: `${purged} audit entr${purged === 1 ? 'y' : 'ies'} archived and removed.`,
    },
  });
}));

// ---------------------------------------------------------------------------
// 2. Global emergency lockout
// ---------------------------------------------------------------------------

/** Current lockout state (safe for the System Admin console). */
router.get('/lockdown', asyncHandler(async (req, res) => {
  res.json({ success: true, data: readLockdown() });
}));

/** Engage or clear the global lockout. Non-admin sessions freeze while engaged. */
router.post('/lockdown', asyncHandler(async (req, res) => {
  const db = getDb();
  const locked = Boolean(req.body?.locked);
  const message =
    typeof req.body?.message === 'string' && req.body.message.trim()
      ? req.body.message.trim().slice(0, 280)
      : null;

  const state = { locked, message, by: req.user.email, at: new Date().toISOString() };
  db.prepare(
    `INSERT INTO settings (key, value, label, group_name, value_type, updated_at)
     VALUES (?, ?, 'Global emergency lockout', 'system', 'json', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, label = excluded.label, group_name = excluded.group_name,
       value_type = excluded.value_type, updated_at = datetime('now')`,
  ).run(LOCKDOWN_KEY, JSON.stringify(state));

  recordAudit(
    fromRequest(req, locked ? 'system.lockdown' : 'system.lockdown_clear', { entity: 'system' }),
  );
  res.json({ success: true, data: state });
}));

// ---------------------------------------------------------------------------
// 3. Session & password override
// ---------------------------------------------------------------------------

/**
 * Revoke sessions — one named staff member, or every active session across all
 * roles (the caller's own session is preserved so the admin stays signed in).
 */
router.post('/sessions/revoke', asyncHandler(async (req, res) => {
  const db = getDb();
  const userId = req.body?.userId == null ? null : Number(req.body.userId);
  const all = Boolean(req.body?.all);

  let revoked;
  if (userId != null) {
    if (!loadUserForAuth(db, userId)) throw notFound('Staff member');
    revoked = db
      .prepare(
        "UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL",
      )
      .run('session_override_admin', userId).changes;
  } else if (all) {
    revoked = db
      .prepare(
        "UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = ? WHERE user_id <> ? AND revoked_at IS NULL",
      )
      .run('session_override_all', req.user.id).changes;
  } else {
    throw badRequest('Pass either a userId, or all: true.', [
      { field: 'body', message: 'Provide userId or all.' },
    ]);
  }

  recordAudit(fromRequest(req, 'sessions.revoke', { entity: 'sessions', detail: { userId, all, revoked } }));
  res.json({ success: true, data: { revoked, message: `${revoked} active session${revoked === 1 ? '' : 's'} revoked.` } });
}));

/**
 * Master password reset: a fresh temporary credential for ANY staff account,
 * with no seniority cap. The normal reset routes refuse targets at or above the
 * caller's level; this override exists precisely to cover those cases.
 */
router.post(
  '/users/:id/reset-password',
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = loadUserForAuth(db, id);
    if (!target) throw notFound('Staff member');

    const plain = generateTemporaryPassword();
    const passwordHash = await hashPassword(plain);

    db.transaction(() => {
      db.prepare(
        `UPDATE users SET password_hash = ?, password_changed = 0, is_first_login = 1,
                          force_password_reset = 1, token_version = token_version + 1,
                          updated_at = datetime('now') WHERE id = ?`,
      ).run(passwordHash, id);
      db.prepare(
        "UPDATE login_sessions SET revoked_at = datetime('now'), revoked_reason = 'admin_password_override' WHERE user_id = ? AND revoked_at IS NULL",
      ).run(id);
    });

    recordAudit(fromRequest(req, 'user.reset_override', { entity: 'user', entityId: id, detail: { email: target.email } }));
    res.status(201).json({
      success: true,
      data: {
        temporaryPassword: plain,
        notice: 'Master-reset credential. Share securely — it must be changed at first sign-in.',
      },
    });
  }),
);

export default router;