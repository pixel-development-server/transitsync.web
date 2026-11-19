/**
 * Diagnostics for the Google Identity Services flow.
 *
 * GIS hands our page an ID-token from a Google-owned iframe; when anything in
 * that handshake breaks, the browser usually only prints an opaque Google error
 * and the login form sits there looking untouched. These logs make every stage
 * observable in the browser console in development and in the deployed console.
 * Set `VITE_DEBUG_GOOGLE=false` at build time to silence them.
 *
 * The ID token and the TransitSync JWT are deliberately NEVER logged — only
 * their presence/length and the routing fields needed to diagnose a failure.
 */

const ENABLED = String(import.meta.env.VITE_DEBUG_GOOGLE || 'true').toLowerCase() !== 'false';

/** Structured, low-noise diagnostic line. */
export function googleLog(event, fields = {}) {
  if (!ENABLED) return;
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
  // console.info is visible with the default browser console filter; debug is not.
  // eslint-disable-next-line no-console
  console.info(`[GoogleAuth] ${event}${detail ? ` ${detail}` : ''}`);
}

/** Same as googleLog, but promoted to console.error so it stands out. */
export function googleError(event, error) {
  if (!ENABLED) return;
  const fields = error instanceof Error
    ? { name: error.name, code: error.code, status: error.status, message: error.message }
    : { value: String(error) };
  // eslint-disable-next-line no-console
  console.error('[GoogleAuth]', event, fields);
}
