#!/usr/bin/env node
/**
 * Post-deploy gate for the primary server.
 *
 * 1. Polls /api/health until the API answers AND its MySQL/MariaDB check is up.
 *    (The health route already runs `SELECT 1`, so a green result proves both
 *    the Node process and the database are reachable.)
 * 2. Optionally asserts whether the Google OAuth metadata route is mounted:
 *      --expect-google-route     200 (primary, full-feature build)
 *      --expect-no-google-route  404 (Google-free deployment)
 *
 * Usage:
 *   node scripts/verify-deploy.mjs http://127.0.0.1:3100/api/health 120000 \
 *     --expect-google-route
 *
 * Exit code is the contract: 0 = ready, 1 = failed.
 */

const [healthUrl = 'http://127.0.0.1:3100/api/health', budgetArg = '120000', ...flags] =
  process.argv.slice(2);

const budgetMs = Number.parseInt(budgetArg, 10) || 120_000;
const expectGoogle = flags.includes('--expect-google-route');
const expectNoGoogle = flags.includes('--expect-no-google-route');
const attemptTimeoutMs = 4_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error page — handled by the caller */
  }
  return { status: response.status, body };
}

async function waitForHealth() {
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const { status, body } = await getJson(healthUrl);
      const database = body?.data?.database;
      if (status === 200 && body?.success === true && database === 'up') {
        process.stdout.write(
          `health OK after ${attempt} attempt(s): status=${body.data.status} ` +
            `database=${database} uptime=${body.data.uptimeSeconds}s\n`,
        );
        return true;
      }
      lastStatus = `HTTP ${status}, success=${body?.success}, database=${database}`;
    } catch (error) {
      lastStatus = error?.message || String(error);
    }
    await sleep(1_000);
  }
  process.stderr.write(`health FAILED after ${budgetMs}ms (${attempt} attempts): ${lastStatus}\n`);
  return false;
}

async function checkGoogleRoute() {
  if (!expectGoogle && !expectNoGoogle) return true;
  const url = new URL('/api/auth/google/config', healthUrl).toString();
  try {
    const { status, body } = await getJson(url);
    if (expectGoogle) {
      const ok = status === 200 && body?.success === true;
      process.stdout.write(`google config route: HTTP ${status} (expected mounted) ${ok ? 'OK' : 'FAILED'}\n`);
      return ok;
    }
    const ok = status === 404;
    process.stdout.write(`google config route: HTTP ${status} (expected 404) ${ok ? 'OK' : 'FAILED'}\n`);
    return ok;
  } catch (error) {
    process.stderr.write(`google config route check failed: ${error?.message || error}\n`);
    return false;
  }
}

const healthOk = await waitForHealth();
const routeOk = healthOk && (await checkGoogleRoute());
process.exitCode = healthOk && routeOk ? 0 : 1;
