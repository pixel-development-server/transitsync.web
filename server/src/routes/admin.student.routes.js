import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate, parsePagination, paginationMeta } from '../lib/http.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { hashPassword, generateTemporaryPassword } from '../lib/password.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { idSchema } from '../validation/schemas.js';
import { operationalTenantScope, assertCampusRowVisible } from '../lib/tenantScope.js';
import { PASSWORD_UNSET } from '../lib/password.js';
import { writeCredentialRecord, userRecord } from '../../credentialStorage.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_USER = `
  SELECT
    u.id, u.email, u.full_name, u.status, u.role_id, u.tenant_id,
    u.is_first_login, u.password_changed, u.force_password_reset,
    u.last_login_at, u.last_login_ip, u.failed_login_count, u.locked_until,
    u.created_at, u.updated_at,
    u.job_title, u.department, u.phone,
    r.\`key\` AS role_key, r.name AS role_name, r.level AS role_level,
    inst.code AS institution_code, inst.name AS institution_name,
    s.id AS student_id, s.college_id AS student_college_id, s.rfid_serial AS student_rfid_serial,
    s.bus_pass_no AS student_bus_pass_no, s.card_status AS student_card_status,
    (SELECT COUNT(*) FROM login_sessions ls
      WHERE ls.user_id = u.id AND ls.revoked_at IS NULL
        AND ls.expires_at > NOW()) AS active_sessions
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN institutions inst ON inst.id = u.tenant_id
  -- A roster row is OPTIONAL. Any account whose role is 'student' must show up
  -- here the moment it can sign in, whether or not it has been linked into the
  -- students table yet -- so this is a LEFT JOIN, never an inner one, and the
  -- caller is filtered on the role alone.
  --
  -- The subquery pins the join to AT MOST ONE roster row per account, preferring
  -- the explicit user_id link and falling back to an email match. The plain
  -- s.user_id = u.id OR LOWER(s.email) = LOWER(u.email) form repeats the whole
  -- account once per matching row (an unlinked CSV import plus a linked row for
  -- the same student), which duplicated the row on screen and made the page
  -- count disagree with the COUNT(*) beside it.
  LEFT JOIN students s ON s.id = (
    SELECT s2.id FROM students s2
    WHERE s2.user_id = u.id
       OR (s2.email IS NOT NULL AND LOWER(s2.email) = LOWER(u.email))
    ORDER BY (s2.user_id = u.id) DESC, s2.user_id IS NULL, s2.id
    LIMIT 1
  )
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
    lastLoginIp: row.last_login_ip,
    failedLoginCount: row.failed_login_count,
    activeSessions: row.active_sessions,
    // Roster profile pulled in by the LEFT JOIN. Null until the account is
    // linked into `students` -- the account is listed either way, so the Console
    // can show it the moment the rider can sign in.
    studentId: row.student_id ?? null,
    studentCollegeId: row.student_college_id ?? null,
    studentRfidSerial: row.student_rfid_serial ?? null,
    studentBusPassNo: row.student_bus_pass_no ?? null,
    studentCardStatus: row.student_card_status ?? null,
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

    const clauses = ["r.`key` = 'student'"];
    const params = [];

    if (search) {
      clauses.push('(' + ['u.email', 'u.full_name', 'u.phone'].map((c) => `LOWER(${c}) LIKE ?`).join(' OR ') + ')');
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q);
    }

    const scope = await operationalTenantScope(db, req.user, req.query, 'u');
    clauses.push(scope.clause);
    params.push(...scope.params);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderBy = 'u.created_at DESC, u.id DESC';

    // MySQL requires integer-typed parameters for LIMIT/OFFSET markers and
    // mysql2 binds JS numbers as DOUBLE, so the (validated, integer) pagination
    // values are interpolated instead of bound.
    const rows = await db.all(
      `${SELECT_USER} ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
      ...params,
    );
    const total = (await db.get(`SELECT COUNT(*) AS n FROM users u LEFT JOIN roles r ON r.id = u.role_id ${where}`, ...params)).n;

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
    const user = await db.get(`${SELECT_USER} WHERE u.id = ?`, id);
    if (!user) throw notFound('User');
    assertCampusRowVisible(req.user, user);
    if (user.role_key !== 'student') throw badRequest('Only student accounts can be reset here.');

    const temporaryPassword = generateTemporaryPassword();
    const hash = await hashPassword(temporaryPassword);

    // `status` must stay `active`: sign-in refuses any account that is not
    // active, so parking a reset account at `invited` locked the holder out
    // entirely. The rotation gate — not a status downgrade — is what forces the
    // new password, and it needs a working credential to be reached.
    await db.transaction(async () => {
      await db.run(
        `UPDATE users
         SET password_hash = ?,
             status = 'active',
             is_first_login = 1,
             password_changed = 0,
             force_password_reset = 1,
             token_version = token_version + 1,
             failed_login_count = 0,
             locked_until = NULL,
             updated_at = NOW()
         WHERE id = ?`,
        hash,
        id,
      );
      await db.run(
        "UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'student_password_reset' WHERE user_id = ? AND revoked_at IS NULL",
        id,
      );
    });

    recordAudit(fromRequest(req, 'admin.student.reset_password', { entity: 'user', entityId: id, detail: { email: user.email } }));
    writeCredentialRecord(
      userRecord(
        { ...user, status: 'active', force_password_reset: 1 },
        { source: 'admin.student.reset_password' },
      ),
    );
    res.json({
      success: true,
      data: {
        temporaryPassword,
        message: 'Student password reset. Sign in with the temporary password and choose a new one.',
      },
    });
  }),
);

router.delete(
  '/student-accounts/:id',
  requirePermission('users:delete'),
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = await db.get(`${SELECT_USER} WHERE u.id = ?`, id);
    if (!user) throw notFound('User');
    assertCampusRowVisible(req.user, user);
    if (user.role_key !== 'student') throw badRequest('Only student accounts can be deleted here.');

    await db.run('DELETE FROM users WHERE id = ?', id);
    recordAudit(fromRequest(req, 'admin.student.delete', { entity: 'user', entityId: id, detail: { email: user.email } }));
    res.json({ success: true, data: { message: 'Student account removed.' } });
  }),
);

export default router;
