/**
 * Blocks until the TransitSync API answers its health check.
 *
 * Used by start-transitsync.bat. Two things this avoids that a shell-level poll
 * gets wrong on Windows:
 *
 *   1. `localhost` resolves to ::1 first on many machines, but the server binds
 *      0.0.0.0 (IPv4 only). Probing the literal 127.0.0.1 skips a doomed IPv6
 *      attempt and the connection timeout that comes with it.
 *   2. PowerShell's Invoke-WebRequest needs well over two seconds per call on
 *      Windows PowerShell 5.1, so a `-TimeoutSec 2` poll can fail forever even
 *      against a healthy server. Node's fetch answers in milliseconds.
 *
 * Exit code is the contract: 0 = healthy, 1 = gave up. Note that it sets
 * `process.exitCode` and returns rather than calling `process.exit()`, which
 * would abort with 0xC0000409 whenever a stdout write was still buffered.
 */

const url = process.argv[2] ?? 'http://127.0.0.1:8080/api/health';
const budgetMs = Number(process.argv[3] ?? 45_000);
// Never let one hung request eat the whole budget.
const attemptTimeoutMs = Math.max(1_000, Math.min(5_000, Math.round(budgetMs / 20)));

const deadline = Date.now() + budgetMs;
let attempts = 0;
let ready = false;

while (Date.now() < deadline) {
  attempts += 1;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not listening yet, or not ready yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (ready) {
  process.stdout.write(`ready after ${attempts} attempt(s)\n`);
  process.exitCode = 0;
} else {
  process.stderr.write(`gave up on ${url} after ${budgetMs}ms (${attempts} attempts)\n`);
  process.exitCode = 1;
}