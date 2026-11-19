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
         (SELECT GROUP_CONCAT(d.domain ORDER BY d.domain SEPARATOR ',')
            FROM institution_email_domains d WHERE d.institution_id = i.id) AS email_domains,
          (SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.tenant_id = i.id AND r.\`key\` = '${ROLE_KEYS.SYSTEM_ADMIN}'
            ORDER BY u.id LIMIT 1)                                  AS admin_email,
         (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.tenant_id = i.id AND r.\`key\` = '${ROLE_KEYS.SYSTEM_ADMIN}') AS admin_count,
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
    emailDomains: row.email_domains ? row.email_domains.split(',').filter(Boolean) : [],
    adminEmail: row.admin_email ?? null,
    adminCount: row.admin_count ?? 0,
    studentCount: row.student_count ?? 0,
    busCount: row.bus_count ?? 0,
    routeCount: row.route_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Domain part of an email address, lower-cased. */
function domainOf(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  return at >= 0 && at < value.length - 1 ? value.slice(at + 1) : '';
}

/** De-duplicate and normalise a list of institutional domains. */
function normaliseDomains(list = []) {
  return [...new Set(list.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

/** A domain may belong to only one campus — fail before writing anything. */
async function assertDomainsFree(db, domains, institutionId = null) {
  for (const domain of domains) {
    const owner = await db.get('SELECT institution_id FROM institution_email_domains WHERE domain = ?', domain);
    if (owner && owner.institution_id !== institutionId) {
      throw conflict(`The email domain @${domain} is already assigned to another college.`);
    }
  }
}

async function replaceDomains(db, institutionId, domains) {
  await db.run('DELETE FROM institution_email_domains WHERE institution_id = ?', institutionId);
  for (const domain of domains) {
    await db.run(
      'INSERT IGNORE INTO institution_email_domains (domain, institution_id) VALUES (?, ?)',
      domain, institutionId,
    );
  }
}

/** Every live campus, oldest first, with its administrator and headcounts. Tombstoned campuses are hidden. */
export async function listColleges(db = getDb()) {
  const rows = await db.all(
    `${COLLEGE_SELECT} WHERE i.deleted_at IS NULL ORDER BY i.created_at ASC, i.name ASC`,
  );
  return rows.map(shape);
}

export async function getCollege(db, id) {
  return shape(await db.get(`${COLLEGE_SELECT} WHERE i.id = ?`, id));
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
export async function provisionCollege(db, { name, code, adminEmail, adminName, emailDomains }, actorId = null) {
  if (await db.get('SELECT id FROM institutions WHERE code = ?', code)) {
    throw conflict(`A college with the code "${code}" already exists.`);
  }
  if (await db.get('SELECT id FROM users WHERE email = ?', adminEmail)) {
    throw conflict('A user with that administrator email already exists.');
  }

  // The administrator's own domain is always authorised — it is how existing
  // campuses were identified before the domain registry existed.
  const domains = normaliseDomains([...(emailDomains || []), domainOf(adminEmail)]);
  await assertDomainsFree(db, domains);

  const role = await db.get('SELECT id FROM roles WHERE `key` = ?', ROLE_KEYS.SYSTEM_ADMIN);
  if (!role) throw unprocessable('The System Administrator role is not installed.');

  const tenantId = crypto.randomUUID();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const adminUserId = await db.transaction(async () => {
    await db.run(
      `INSERT INTO institutions (id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')`,
      tenantId, name, code,
    );
    for (const domain of domains) {
      await db.run(
        'INSERT IGNORE INTO institution_email_domains (domain, institution_id) VALUES (?, ?)',
        domain, tenantId,
      );
    }

    const result = await db.run(
      `INSERT INTO users
         (email, full_name, password_hash, job_title, department, role_id, status,
          tenant_id, is_first_login, password_changed, force_password_reset, permissions_mode, created_by)
       VALUES (?, ?, ?, 'Campus Administrator', 'Administration', ?, 'active', ?, 1, 0, 1, 'INHERIT', ?)`,
      adminEmail, adminName || `${name} Administrator`, passwordHash, role.id, tenantId, actorId,
    );

    return Number(result.lastInsertRowid);
  });

  return {
    college: await getCollege(db, tenantId),
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
export async function setCollegeStatus(db, id, status) {
  const existing = await db.get('SELECT id FROM institutions WHERE id = ?', id);
  if (!existing) throw notFound('College');
  await db.run('UPDATE institutions SET status = ?, updated_at = NOW() WHERE id = ?', status, id);
  return await getCollege(db, id);
}

/**
 * Edit a campus: rename it, re-slug its code, or re-point the administrative
 * email shown in the master panel. Because the "administration email" is the
 * primary System Administrator's login, changing it rewrites that user's email
 * (with the usual uniqueness check) inside the same transaction.
 */
export async function updateCollege(db, id, { name, code, adminEmail, emailDomains } = {}) {
  const existing = await db.get('SELECT * FROM institutions WHERE id = ?', id);
  if (!existing) throw notFound('College');

  const hasDomainEdit = emailDomains !== undefined;
  const adminDomain = adminEmail ? domainOf(adminEmail) : '';
  const domains = hasDomainEdit
    ? normaliseDomains([...emailDomains, ...(adminDomain ? [adminDomain] : [])])
    : [];
  if (hasDomainEdit) await assertDomainsFree(db, domains, id);
  else if (adminDomain) await assertDomainsFree(db, [adminDomain], id);

  // Uniqueness against the live set, only when the value actually changes.
  if (code && code !== existing.code) {
    if (await db.get('SELECT id FROM institutions WHERE code = ? AND id <> ?', code, id)) {
      throw conflict(`A college with the code "${code}" already exists.`);
    }
  }

  let adminId = null;
  if (adminEmail) {
    const admin = await db.get(
      `SELECT u.id, u.email FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = ? AND r.\`key\` = ? ORDER BY u.id LIMIT 1`,
      id, ROLE_KEYS.SYSTEM_ADMIN,
    );
    if (admin && admin.email.toLowerCase() !== adminEmail.toLowerCase()) {
      if (await db.get('SELECT id FROM users WHERE email = ? AND id <> ?', adminEmail, admin.id)) {
        throw conflict('A user with that administrator email already exists.');
      }
      adminId = admin.id;
    }
  }

  await db.transaction(async () => {
    if (name || code) {
      await db.run(
        `UPDATE institutions
            SET name = COALESCE(NULLIF(?, ''), name),
                code = COALESCE(NULLIF(?, ''), code),
                updated_at = NOW()
          WHERE id = ?`,
        name ?? null, code ?? null, id,
      );
    }
    if (adminId) {
      await db.run('UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?', adminEmail, adminId);
    }
    if (hasDomainEdit) {
      await replaceDomains(db, id, domains);
    } else if (adminDomain) {
      await db.run(
        'INSERT IGNORE INTO institution_email_domains (domain, institution_id) VALUES (?, ?)',
        adminDomain, id,
      );
    }
  });

  return await getCollege(db, id);
}

/**
 * Remove a campus.
 *
 * The default is a tombstone that keeps every row attributable:
 *   - the college gains `deleted_at` and disappears from every list,
 *   - its staff are suspended with `token_version` bumped (killing any live
 *     JWT) and every session revoked,
 *   - its students are moved to WITHDRAWN.
 * Fleet assets and scan history are retained for audit.
 *
 * `purge: true` hard-deletes the institution and its tenant-scoped rows
 * (users, students, buses, routes) instead; operational alert/scan rows are
 * unlinked (`tenant_id` → NULL) rather than destroyed.
 */
export async function deleteCollege(db, id, { purge = false } = {}) {
  const existing = await db.get('SELECT * FROM institutions WHERE id = ?', id);
  if (!existing) throw notFound('College');

  if (purge) {
    await db.transaction(async () => {
      await db.run('DELETE FROM students WHERE tenant_id = ?', id);
      await db.run('DELETE FROM buses WHERE tenant_id = ?', id);
      await db.run('DELETE FROM routes WHERE tenant_id = ?', id);
      await db.run('DELETE FROM users WHERE tenant_id = ?', id);
      await db.run('UPDATE alerts      SET tenant_id = NULL WHERE tenant_id = ?', id);
      await db.run('UPDATE scan_events SET tenant_id = NULL WHERE tenant_id = ?', id);
      await db.run('DELETE FROM institutions WHERE id = ?', id);
    });
    return { id, name: existing.name, code: existing.code, deleted: true, purge: true };
  }

  await db.transaction(async () => {
    await db.run(
      "UPDATE institutions SET status = 'SUSPENDED', deleted_at = NOW(), updated_at = NOW() WHERE id = ?",
      id,
    );
    await db.run(
      "UPDATE users SET status = 'suspended', token_version = token_version + 1, updated_at = NOW() WHERE tenant_id = ?",
      id,
    );
    await db.run(
      `UPDATE login_sessions SET revoked_at = NOW(), revoked_reason = 'tenant_deleted'
        WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?) AND revoked_at IS NULL`,
      id,
    );
    await db.run(
      "UPDATE students SET status = 'WITHDRAWN', updated_at = NOW() WHERE tenant_id = ? AND status = 'ACTIVE'",
      id,
    );
  });

  return { ...(await getCollege(db, id)), deleted: true };
}

/** Aggregate figures for the System Health panel. */
export async function platformOverview(db = getDb()) {
  const count = async (sql, ...params) => (await db.get(sql, ...params)).n;

  const colleges = await listColleges(db);

  return {
    colleges: {
      total: colleges.length,
      active: colleges.filter((c) => c.status === 'ACTIVE').length,
      suspended: colleges.filter((c) => c.status === 'SUSPENDED').length,
    },
    users: {
      total: await count('SELECT COUNT(*) AS n FROM users'),
      byRole: (
        await db.all(
          `SELECT r.\`key\`, r.name, r.level, COUNT(u.id) AS count
             FROM roles r LEFT JOIN users u ON u.role_id = r.id
            GROUP BY r.id ORDER BY r.level DESC`,
        )
      ).map((row) => ({ ...row })),
    },
    students: await count('SELECT COUNT(*) AS n FROM students'),
    buses: await count('SELECT COUNT(*) AS n FROM buses'),
    routes: await count('SELECT COUNT(*) AS n FROM routes'),
  };
}

export default { listColleges, getCollege, provisionCollege, setCollegeStatus, updateCollege, deleteCollege, platformOverview };
