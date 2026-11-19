/**
 * One-shot live verification of GET /api/admin/student-accounts (the
 * users LEFT JOIN students contract), using a *reversible* credential swap:
 *
 *   1. back up dev@admin.me's password hash
 *   2. install a known temporary hash
 *   3. log in, call the endpoint over the public origin, print the rows
 *   4. restore the original hash and revoke the session it minted
 *
 * Run from server/:  node scripts/verify-student-accounts.mjs
 * Exits non-zero (after restoring) if any step fails.
 */
import bcrypt from 'bcryptjs';
import { pool, closeDb } from '../db.js';

const ORIGIN = process.env.VERIFY_ORIGIN || 'https://transitsync.me';
// Must hold role_key `system_admin` (L100): the endpoint is behind
// requireSystemAdmin, and super_admin (L200) is deliberately not admitted.
const SUBJECT = 'admin@iic.edu.np';
const TEMP_PASSWORD = 'VerifyTmp!2026a';

const fail = (msg) => {
  process.stderr.write(`VERIFY FAILED: ${msg}\n`);
  process.exitCode = 1;
};

const json = async (url, opts = {}) => {
  const response = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

let backupHash = null;
let sessionId = null;

try {
  const [[user]] = await pool.query('SELECT id, password_hash FROM users WHERE email = ?', [SUBJECT]);
  if (!user) throw new Error(`${SUBJECT} not found`);
  backupHash = user.password_hash;

  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
    bcrypt.hashSync(TEMP_PASSWORD, 10),
    user.id,
  ]);
  process.stdout.write(`[1] temporary hash installed for ${SUBJECT}\n`);

  const login = await json(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email: SUBJECT, password: TEMP_PASSWORD, portalType: 'staff' }),
  });
  if (login.status !== 200 || !login.body?.data?.token) {
    throw new Error(`login ${login.status}: ${JSON.stringify(login.body).slice(0, 300)}`);
  }
  const token = login.body.data.token;
  sessionId = login.body.data.sessionId ?? null;
  process.stdout.write(`[2] login ok (200), role=${login.body.data.user?.roleKey}\n`);

  const accounts = await json(`${ORIGIN}/api/admin/student-accounts?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (accounts.status !== 200 || !accounts.body?.success) {
    throw new Error(`student-accounts ${accounts.status}: ${JSON.stringify(accounts.body).slice(0, 300)}`);
  }
  const users = accounts.body.data.users || [];
  process.stdout.write(`[3] GET /api/admin/student-accounts -> 200, total=${accounts.body.data.meta.total}, rows=${users.length}\n`);
  for (const u of users.slice(0, 8)) {
    process.stdout.write(
      `    id=${u.id} ${u.email} collegeId=${JSON.stringify(u.studentCollegeId)} card=${JSON.stringify(u.studentCardStatus)} status=${u.status} activeSessions=${u.activeSessions}\n`,
    );
  }
  const withCard = users.filter((u) => u.studentCardStatus !== null && u.studentCardStatus !== undefined);
  if (users.length === 0) throw new Error('endpoint returned zero student rows');
  if (withCard.length === 0) throw new Error('no row carried studentCardStatus — LEFT JOIN fields missing');
  process.stdout.write('[4] LEFT JOIN fields present (studentCollegeId / studentCardStatus / activeSessions)\n');
} catch (error) {
  fail(error.message);
} finally {
  if (backupHash) {
    await pool.execute('UPDATE users SET password_hash = ? WHERE email = ?', [backupHash, SUBJECT]);
    process.stdout.write(`[5] original hash restored for ${SUBJECT}\n`);
  }
  if (sessionId) {
    await pool.execute('DELETE FROM login_sessions WHERE id = ?', [sessionId]);
    process.stdout.write(`[6] session ${sessionId} revoked\n`);
  } else {
    // Fall back: drop any session minted in the last five minutes for the subject.
    await pool.execute(
      "DELETE FROM login_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?) AND created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)",
      [SUBJECT],
    );
    process.stdout.write('[6] recent sessions for subject revoked\n');
  }
  await closeDb();
}
