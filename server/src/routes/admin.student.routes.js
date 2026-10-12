import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { hashPassword, generateTemporaryPassword } from '../lib/password.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { idSchema } from '../validation/schemas.js';
import { operationalTenantScope } from '../lib/tenantScope.js';
import { PASSWORD_UNSET } from '../lib/password.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_USER = `
  SELECT
    u.id, u.email, u.full_name, u.status, u.role_id, u.tenant_id,
    u.is_first_login, u.password_changed, u.force_password_reset,
    u.last_login_at, u.login_count, u.failed_login_attempts, u.locked_until,
    u.created_at, u.updated_at,
    u.job_title, u.department, u.phone,
    r.key AS role_key, r.name AS role_name, r.level AS role_level,
    inst.code AS institution_code, inst.name AS institution_name
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN institutions inst ON inst.id = u.tenant_id
`;

function toUserShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    roleId: row.role_id,
    roleKey: row.role_key,
    roleName: row.role_name,
    roleLevel: row.role_level,
    tenantId: row.tenant_id,
    institutionCode: row.institution_code,
    institutionName: row.institution_name,
    isFirstLogin: Boolean(row.is_first_login),
    passwordChanged: Boolean(row.password_changed),
    forcePasswordReset: Boolean(row.force_password_reset),
    lastLoginAt: row.last_login_at,
    loginCount: row.login_count,
    failedLoginAttempts: row.failed_login_attempts,
    lockedUntil: row.locked_until,
    jobTitle: row.job_title,
    department: row.department,
    phone: row.phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  '/student-accounts',
  requirePermission('users:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { page, limit, offset } = parsePagination(req.query, { pageSize: 50 });
    const search = (req.query.search || '').trim();

    const clauses = ["r.key = 'student'"];
    const params = [];

    if (search) {
      clauses.push('(' + ['u.email', 'u.full_name', 'u.phone'].map((c) => `LOWER(${c}) LIKE ?`).join(' OR ') + ')');
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q);
    }

    const scope = operationalTenantScope(db, req.user, req.query, 'u');
    clauses.push(scope.clause);
    params.push(...scope.params);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderBy = 'u.created_at DESC, u.id DESC';

    const rows = db
      .prepare(`${SELECT_USER} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users u LEFT JOIN roles r ON r.id = u.role_id ${where}`).get(...params).n;

    res.json({
      success: true,
      data: {
        users: rows.map(toUserShape),
        meta: paginationMeta({ total, limit, page }),
      },
    });
  }),
);

router.post(
  '/student-accounts/:id/reset-password',
  requirePermission('users:edit'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(id);
    if (!user) throw notFound('User');
    if (user.role_key !== 'student') throw badRequest('Only student accounts can be reset here.');

    const temp = generateTemporaryPassword();
    const hash = hashPassword(temp);

    db.prepare(
      `UPDATE users
       SET password_hash = ?,
           status = 'invited',
           is_first_login = 1,
           password_changed = 0,
           force_password_reset = 0,
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(hash, id);

    recordAudit(fromRequest(req, 'admin.student.reset_password', { entity: 'user', entityId: id, detail: { email: user.email } }));
    res.json({ success: true, data: { temporaryPassword: temp, message: 'Student password reset successfully.' } });
  }),
);

router.delete(
  '/student-accounts/:id',
  requirePermission('users:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(id);
    if (!user) throw notFound('User');
    if (user.role_key !== 'student') throw badRequest('Only student accounts can be deleted here.');

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    recordAudit(fromRequest(req, 'admin.student.delete', { entity: 'user', entityId: id, detail: { email: user.email } }));
    res.json({ success: true, data: { message: 'Student account removed.' } });
  }),
);

export default router;
