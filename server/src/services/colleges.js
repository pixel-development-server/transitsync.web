/**
 * Multi-tenant college (institution) provisioning.
 *
 * Everything a Level 200 Super Administrator does from the PLATFORM MASTER
 * panel funnels through here: listing campuses with their admin and headcounts,
 * provisioning a new campus together with its Level 100 System Administrator,
 * and suspending/restoring a campus.
 *
 * The default campus (`iic`) is created by migration 005; this module treats it
 * exactly like any other row.
 */

import crypto from 'node:crypto';

import { getDb } from '../db/connection.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { ROLE_KEYS } from '../db/permissions.js';
import { hashPassword, generateTemporaryPassword } from '../lib/password.js';

/** Columns that describe a campus for the master panel table. */
const COLLEGE_SELECT = `
  SELECT i.id, i.name, i.code, i.status, i.created_at, i.updated_at,
         (SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.tenant_id = i.id AND r.key = '${ROLE_KEYS.SYSTEM_ADMIN}'
            ORDER BY u.id LIMIT 1)                                  AS admin_email,
         (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.tenant_id = i.id AND r.key = '${ROLE_KEYS.SYSTEM_ADMIN}') AS admin_count,
         (SELECT COUNT(*) FROM students s WHERE s.tenant_id = i.id)  AS student_count,
         (SELECT COUNT(*) FROM buses   b WHERE b.tenant_id = i.id)   AS bus_count,
         (SELECT COUNT(*) FROM routes  rt WHERE rt.tenant_id = i.id) AS route_count
    FROM institutions i`;

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    adminEmail: row.admin_email ?? null,
    adminCount: row.admin_count ?? 0,
    studentCount: row.student_count ?? 0,
    busCount: row.bus_count ?? 0,
    routeCount: row.route_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every campus, oldest first, with its administrator and headcounts. */
export function listColleges(db = getDb()) {
  const rows = db.prepare(`${COLLEGE_SELECT} ORDER BY i.created_at ASC, i.name ASC`).all();
  return rows.map(shape);
}

export function getCollege(db, id) {
  return shape(db.prepare(`${COLLEGE_SELECT} WHERE i.id = ?`).get(id));
}

/**
 * Create a campus and its Level 100 System Administrator.
 *
 * The administrator starts `active` with a one-time handover password and a
 * forced first-login rotation (`is_first_login` / `password_changed` /
 * `force_password_reset`), so the credential the Super Administrator copies out
 * of the panel is never the long-term one. The plaintext password is returned
 * exactly once — this deployment has no mail server.
 */
export async function provisionCollege(db, { name, code, adminEmail, adminName }, actorId = null) {
  if (db.prepare('SELECT id FROM institutions WHERE code = ?').get(code)) {
    throw conflict(`A college with the code "${code}" already exists.`);
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail)) {
    throw conflict('A user with that administrator email already exists.');
  }

  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(ROLE_KEYS.SYSTEM_ADMIN);
  if (!role) throw unprocessable('The System Administrator role is not installed.');

  const tenantId = crypto.randomUUID();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const adminUserId = db.transaction(() => {
    db.prepare(
      `INSERT INTO institutions (id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')`,
    ).run(tenantId, name, code);

    const result = db
      .prepare(
        `INSERT INTO users
           (email, full_name, password_hash, job_title, department, role_id, status,
            tenant_id, is_first_login, password_changed, force_password_reset, permissions_mode, created_by)
         VALUES (?, ?, ?, 'Campus Administrator', 'Administration', ?, 'active', ?, 1, 0, 1, 'INHERIT', ?)`,
      )
      .run(adminEmail, adminName || `${name} Administrator`, passwordHash, role.id, tenantId, actorId);

    return Number(result.lastInsertRowid);
  });

  return {
    college: getCollege(db, tenantId),
    admin: { id: adminUserId, email: adminEmail, userId: adminUserId },
    credentials: {
      email: adminEmail,
      temporaryPassword,
      mustReset: true,
      notice: 'No mail server is configured. Hand these credentials to the campus administrator securely; they must set their own password at first sign-in.',
    },
  };
}

/** Suspend or restore a campus. */
export function setCollegeStatus(db, id, status) {
  const existing = db.prepare('SELECT id FROM institutions WHERE id = ?').get(id);
  if (!existing) throw notFound('College');
  db.prepare("UPDATE institutions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  return getCollege(db, id);
}

/** Aggregate figures for the System Health panel. */
export function platformOverview(db = getDb()) {
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;

  const colleges = listColleges(db);

  return {
    colleges: {
      total: colleges.length,
      active: colleges.filter((c) => c.status === 'ACTIVE').length,
      suspended: colleges.filter((c) => c.status === 'SUSPENDED').length,
    },
    users: {
      total: count('SELECT COUNT(*) AS n FROM users'),
      byRole: db
        .prepare(
          `SELECT r.key, r.name, r.level, COUNT(u.id) AS count
             FROM roles r LEFT JOIN users u ON u.role_id = r.id
            GROUP BY r.id ORDER BY r.level DESC`,
        )
        .all()
        .map((row) => ({ ...row })),
    },
    students: count('SELECT COUNT(*) AS n FROM students'),
    buses: count('SELECT COUNT(*) AS n FROM buses'),
    routes: count('SELECT COUNT(*) AS n FROM routes'),
  };
}

export default { listColleges, getCollege, provisionCollege, setCollegeStatus, platformOverview };
