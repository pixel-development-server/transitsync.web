/**
 * Thin fetch wrapper around the TransitSync API.
 *
 * Two behaviours are worth calling out:
 *
 *  1. Errors are normalised. The server answers with
 *     `{ success:false, error:{ code, message, details[] } }`, so callers get an
 *     `ApiError` carrying `code`, `status` and per-field `details`. That lets
 *     forms map a Zod `details` entry straight onto the offending input instead
 *     of showing one opaque banner.
 *
 *  2. The token is sent as a Bearer header *and* kept in an httpOnly cookie by
 *     the server. The header covers ordinary REST calls; the cookie is what lets
 *     `EventSource` authenticate the SSE stream, since that API cannot set
 *     headers.
 */

const TOKEN_KEY = 'transitsync.token';

/**
 * Origin of the TransitSync API.
 *
 * Empty means "same origin" — the default, where the Node server serves both
 * the panel and the API. Set `VITE_API_URL` (e.g. `https://api.transitsync.me`)
 * at build time when the panel is hosted separately from the backend, such as
 * on GitHub Pages: every REST call and the SSE stream are then prefixed with it.
 */
export const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

/** True when the API lives on a different origin than the panel. */
const CROSS_ORIGIN = API_ORIGIN !== '';

export class ApiError extends Error {
  constructor({ code, message, details = [], status = 0 }) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** `{ field, message }[]` → `{ field: message }` for form display. */
  get fieldErrors() {
    const out = {};
    for (const detail of this.details) {
      if (detail?.field && !out[detail.field]) out[detail.field] = detail.message;
    }
    return out;
  }
}

/** Thrown when the session is gone; the app reacts by returning to login. */
export class SessionExpiredError extends ApiError {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super({ code: 'SESSION_EXPIRED', message, status: 401 });
    this.name = 'SessionExpiredError';
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the httpOnly cookie still carries the session */
  }
}

function buildQuery(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

let onUnauthorized = null;
/** Registered once by the auth provider so any layer can force a re-login. */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function request(method, path, { body, params, signal, raw = false, headers } = {}) {
  const token = getToken();
  const init = {
    method,
    // Send cookies so the server can maintain the httpOnly session cookie used
    // by the SSE stream and by browsers that block the Authorization header.
    // Cross-origin deployments need 'include'; same-origin is left as-is so a
    // bare Origin header never unintentionally turns a request into CORS.
    credentials: CROSS_ORIGIN ? 'include' : 'same-origin',
    signal,
    headers: { Accept: raw ? '*/*' : 'application/json', ...headers },
  };

  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_ORIGIN}/api${path}${buildQuery(params)}`, init);
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError({
      code: 'NETWORK_UNAVAILABLE',
      message: 'Cannot reach the TransitSync server. Check your connection.',
      status: 0,
    });
  }

  if (raw) {
    if (!response.ok) {
      throw await toError(response);
    }
    return response;
  }

  // 204 and empty bodies (DELETE, logout) are legitimate successes.
  if (response.status === 204) return { success: true, data: null };

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok || payload?.success === false) {
    throw toErrorFromPayload(payload, response.status);
  }

  return payload ?? { success: true, data: null };
}

async function toError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body */
  }
  return toErrorFromPayload(payload, response.status);
}

function toErrorFromPayload(payload, status) {
  const error = payload?.error ?? {};
  const code = error.code ?? 'UNKNOWN';
  const message = error.message ?? defaultMessage(status);

  if (status === 401 || code === 'NO_TOKEN' || code === 'INVALID_TOKEN' || code === 'SESSION_REVOKED') {
    const err = new SessionExpiredError(
      code === 'SESSION_REVOKED'
        ? error.message || 'This session was revoked.'
        : message,
    );
    err.code = code;
    // Surface to the auth provider, but only for genuinely dead sessions —
    // a wrong password on the login form must NOT trigger a global logout.
    if (code !== 'INVALID_CREDENTIALS') onUnauthorized?.(err);
    return err;
  }

  return new ApiError({ code, message, details: error.details ?? [], status });
}

function defaultMessage(status) {
  if (status === 403) return 'You do not have permission to perform this action.';
  if (status === 404) return 'That record no longer exists.';
  if (status === 409) return 'That change conflicts with the current data.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The server hit an unexpected error.';
  return `Request failed (HTTP ${status}).`;
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  del: (path, options) => request('DELETE', path, options),

  /** Returns the raw Response so callers can stream a CSV/PDF to a Blob. */
  raw: (path, params, options) => request('GET', path, { ...options, params, raw: true }),
};

/**
 * Trigger a browser download for an authenticated endpoint.
 *
 * Fetching via XHR (rather than a plain <a href>) is required because the
 * session lives in a Bearer header/localStorage as well as a cookie — and it
 * lets a failed export surface the API's error message instead of downloading
 * an HTML error page.
 */
export async function download(path, params, fallbackName) {
  const response = await api.raw(path, params);
  const blob = await response.blob();

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  const filename = match?.[1] || fallbackName;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick; revoking synchronously cancels the download in
  // some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}