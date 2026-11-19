/**
 * One-shot live verification of the multi-tenant isolation contract, using the
 * same *reversible* credential swap as verify-student-accounts.mjs:
 *
 *   1. back up the campus-admin and platform-owner password hashes
 *   2. install known temporary hashes
 *   3. log both users in over the public origin
 *   4. assert the dashboard/alert/student surfaces are campus-scoped
 *   5. restore the original hashes and revoke the sessions it minted
 *
 * Everything the script creates (a probe alert, a probe student) is deleted
 * again before it exits.
 *
 * Run from server/:  node scripts/verify-tenancy.mjs
 * Exits non-zero (after restoring) if any step fails.
 */
import bcrypt from 'bcryptjs';
import { pool, closeDb } from '../db.js';

const ORIGIN = process.env.VERIFY_ORIGIN || 'https://transitsync.me';
const CAMPUS_EMAIL = 'admin@iic.edu.np'; // system_admin (L100), bound to one campus
const PLATFORM_EMAIL = 'dev@admin.me'; // super_admin (L200), tenant NULL
const CAMPUS_PASSWORD = 'VerifyTmp!2026c';
const PLATFORM_PASSWORD = 'VerifyTmp!2026p';

let failures = 0;
const ok = (msg) => process.stdout.write(`  ok  ${msg}\n`);
const fail = (msg) => {
  failures += 1;
  process.stderr.write(`  FAIL ${msg}\n`);
};

const json = async (path, opts = {}) => {
  const response = await fetch(`${ORIGIN}${path}`, {
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

const backups = [];
const sessions = [];

async function installTempPassword(email, password) {
  const [[user]] = await pool.query('SELECT id, password_hash FROM users WHERE email = ?', [email]);
  if (!user) throw new Error(`${email} not found`);
  backups.push({ email, hash: user.password_hash });
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
    bcrypt.hashSync(password, 10),
    user.id,
  ]);
  return user.id;
}

async function login(email, password) {
  const result = await json('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, portalType: 'staff' }),
  });
  if (result.status !== 200 || !result.body?.data?.token) {
    throw new Error(`login ${email} -> ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
  }
  if (result.body.data.sessionId) sessions.push(result.body.data.sessionId);
  return result.body.data.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const ids = (rows) => rows.map((row) => row.id).sort((a, b) => a - b);

let probeAlertId = null;
let probeStudentId = null;
let campusToken = null;

try {
  await installTempPassword(CAMPUS_EMAIL, CAMPUS_PASSWORD);
  await installTempPassword(PLATFORM_EMAIL, PLATFORM_PASSWORD);
  process.stdout.write(`[1] temporary hashes installed for both principals\n`);

  campusToken = await login(CAMPUS_EMAIL, CAMPUS_PASSWORD);
  const platformToken = await login(PLATFORM_EMAIL, PLATFORM_PASSWORD);
  process.stdout.write(`[2] logins ok (campus + platform)\n`);

  // ---- Ground truth from the live database ---------------------------------
  const [[campusUser]] = await pool.query(
    'SELECT id, tenant_id FROM users WHERE email = ? AND tenant_id IS NOT NULL',
    [CAMPUS_EMAIL],
  );
  if (!campusUser?.tenant_id) throw new Error(`${CAMPUS_EMAIL} has no campus tenant`);
  const tenant = campusUser.tenant_id;

  const [[studentCount]] = await pool.query(
    'SELECT COUNT(*) AS n FROM students WHERE tenant_id <=> ?',
    [tenant],
  );
  const [campusBuses] = await pool.query('SELECT id FROM buses WHERE tenant_id <=> ?', [tenant]);
  const expectedBuses = ids(campusBuses);
  process.stdout.write(
    `[3] campus ${tenant}: ${studentCount.n} students, ${expectedBuses.length} buses\n`,
  );

  // ---- Dashboard: campus-scoped, platform drills in ------------------------
  const campusDash = await json('/api/dashboard', { headers: auth(campusToken) });
  if (campusDash.status !== 200) throw new Error(`campus dashboard -> ${campusDash.status}`);
  const kpis = campusDash.body?.data?.kpis ?? {};
  const fleet = campusDash.body?.data?.fleet ?? [];
  if (Number(kpis.students?.total) === Number(studentCount.n)) {
    ok(`campus dashboard students.total = ${kpis.students.total}`);
  } else {
    fail(`campus dashboard students.total = ${kpis.students?.total}, expected ${studentCount.n}`);
  }
  if (JSON.stringify(ids(fleet)) === JSON.stringify(expectedBuses)) {
    ok(`campus dashboard fleet = its own ${fleet.length} buses`);
  } else {
    fail(`campus dashboard fleet ids ${JSON.stringify(ids(fleet))} != ${JSON.stringify(expectedBuses)}`);
  }
  if (Number(kpis.utilization?.percent ?? 0) <= 100) {
    ok(`capacity utilisation within bounds (${kpis.utilization?.percent}%)`);
  } else {
    fail(`capacity utilisation ${kpis.utilization?.percent}% exceeds 100%`);
  }

  const bareDash = await json('/api/dashboard', { headers: auth(platformToken) });
  if (bareDash.status !== 200) throw new Error(`platform dashboard -> ${bareDash.status}`);
  if (Number(bareDash.body?.data?.kpis?.students?.total) === 0 && (bareDash.body?.data?.fleet ?? []).length === 0) {
    ok('platform dashboard without ?tenantId= is empty');
  } else {
    fail(
      `platform bare dashboard leaked: students=${bareDash.body?.data?.kpis?.students?.total} fleet=${(bareDash.body?.data?.fleet ?? []).length}`,
    );
  }

  const drilledDash = await json(`/api/dashboard?tenantId=${encodeURIComponent(tenant)}`, {
    headers: auth(platformToken),
  });
  if (drilledDash.status !== 200) throw new Error(`platform drill-in dashboard -> ${drilledDash.status}`);
  const drilledFleet = drilledDash.body?.data?.fleet ?? [];
  if (Number(drilledDash.body?.data?.kpis?.students?.total) === Number(studentCount.n)) {
    ok(`platform drill-in matches the campus roster (${studentCount.n})`);
  } else {
    fail(`platform drill-in students.total=${drilledDash.body?.data?.kpis?.students?.total}, expected ${studentCount.n}`);
  }
  if (JSON.stringify(ids(drilledFleet)) === JSON.stringify(expectedBuses)) {
    ok(`platform drill-in fleet = ${drilledFleet.length} campus buses`);
  } else {
    fail(`platform drill-in fleet ${JSON.stringify(ids(drilledFleet))} != ${JSON.stringify(expectedBuses)}`);
  }

  // ---- Alerts: a campus notice stays on that campus ------------------------
  const stamp = Date.now();
  const created = await json('/api/alerts', {
    method: 'POST',
    headers: auth(campusToken),
    body: JSON.stringify({
      title: `Live tenancy probe ${stamp}`,
      message: 'Created and removed by scripts/verify-tenancy.mjs.',
      severity: 'LOW',
    }),
  });
  if (created.status !== 201) throw new Error(`probe alert -> ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
  probeAlertId = created.body.data.alert.id;

  const campusAlerts = await json('/api/alerts?limit=100', { headers: auth(campusToken) });
  const campusAlertIds = (campusAlerts.body?.data?.alerts ?? []).map((row) => row.id);
  campusAlertIds.includes(probeAlertId)
    ? ok(`campus alert list includes its own probe (id ${probeAlertId})`)
    : fail('campus alert list is missing its own probe');

  const bareAlerts = await json('/api/alerts?limit=100', { headers: auth(platformToken) });
  const bareIds = (bareAlerts.body?.data?.alerts ?? []).map((row) => row.id);
  bareIds.includes(probeAlertId)
    ? fail('platform bare alert list leaked the campus probe')
    : ok('platform bare alert list hides the campus probe');

  const drilledAlerts = await json(`/api/alerts?limit=100&tenantId=${encodeURIComponent(tenant)}`, {
    headers: auth(platformToken),
  });
  const drilledIds = (drilledAlerts.body?.data?.alerts ?? []).map((row) => row.id);
  drilledIds.includes(probeAlertId)
    ? ok('platform drill-in alert list includes the probe')
    : fail('platform drill-in alert list is missing the probe');

  // ---- Purge: creates, removes its own rows, reports what it cleaned ------
  const studentCreated = await json('/api/students', {
    method: 'POST',
    headers: auth(campusToken),
    body: JSON.stringify({
      fullName: `Live Purge Probe ${stamp}`,
      collegeId: `ZZPROBE${stamp}`,
      email: `probe-${stamp}@example.invalid`,
      faculty: 'Verification',
      program: 'Probe',
      semester: 1,
    }),
  });
  if (studentCreated.status !== 201) {
    throw new Error(`probe student -> ${studentCreated.status}: ${JSON.stringify(studentCreated.body).slice(0, 300)}`);
  }
  probeStudentId = studentCreated.body.data.student.id;

  const purged = await json(`/api/students/${probeStudentId}/purge`, {
    method: 'DELETE',
    headers: auth(campusToken),
  });
  if (purged.status === 200 && purged.body?.data?.removed) {
    ok(`probe student purged (removed=${JSON.stringify(purged.body.data.removed)})`);
  } else {
    fail(`probe student purge -> ${purged.status}: ${JSON.stringify(purged.body).slice(0, 300)}`);
  }

  const goneCheck = await json(`/api/students/${studentCreated.body.data.student.id}`, {
    headers: auth(campusToken),
  });
  goneCheck.status === 404
    ? ok('purged student now reports not-found')
    : fail(`purged student still readable (GET -> ${goneCheck.status})`);
  probeStudentId = null; // purge succeeded or the finally block retries it
} catch (error) {
  fail(error.message);
} finally {
  if (probeAlertId && campusToken) {
    const removed = await json(`/api/alerts/${probeAlertId}`, {
      method: 'DELETE',
      headers: auth(campusToken),
    }).catch(() => ({ status: 0 }));
    if (removed.status === 200) probeAlertId = null;
  }
  if (probeStudentId && campusToken) {
    await json(`/api/students/${probeStudentId}/purge`, {
      method: 'DELETE',
      headers: auth(campusToken),
    }).catch(() => null);
  }
  for (const { email, hash } of backups) {
    await pool.execute('UPDATE users SET password_hash = ? WHERE email = ?', [hash, email]);
    process.stdout.write(`[4] original hash restored for ${email}\n`);
  }
  for (const sessionId of sessions) {
    await pool.execute('DELETE FROM login_sessions WHERE id = ?', [sessionId]);
    process.stdout.write(`[5] session ${sessionId} revoked\n`);
  }
  await closeDb();
  process.stdout.write(failures === 0 ? 'TENANCY VERIFY OK\n' : `TENANCY VERIFY FAILED (${failures})\n`);
  if (failures > 0) process.exitCode = 1;
}
