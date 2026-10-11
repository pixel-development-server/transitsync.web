/** Errors that are safe to serialise straight to the client. */
export class AppError extends Error {
  constructor(status, message, { code, details, expose = true } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || defaultCode(status);
    this.details = details;
    this.expose = expose;
  }
}

function defaultCode(status) {
  const map = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE',
    423: 'ACCOUNT_LOCKED',
    429: 'RATE_LIMITED',
  };
  return map[status] || 'INTERNAL_ERROR';
}

export const badRequest = (message, details) => new AppError(400, message, { code: 'BAD_REQUEST', details });
export const unauthorized = (message = 'Authentication required.', code) =>
  new AppError(401, message, { code: code || 'UNAUTHENTICATED' });
export const forbidden = (message = 'You do not have permission to perform this action.', options) => {
  const { code, ...details } = options && typeof options === 'object' ? options : {};
  return new AppError(403, message, {
    code: code || 'FORBIDDEN',
    details: Object.keys(details).length ? details : null,
  });
};
export const notFound = (resource = 'Resource') => new AppError(404, `${resource} not found.`, { code: 'NOT_FOUND' });
export const conflict = (message, details) => new AppError(409, message, { code: 'CONFLICT', details });
export const unprocessable = (message, details) => new AppError(422, message, { code: 'VALIDATION_FAILED', details });
export const accountLocked = (message) => new AppError(423, message, { code: 'ACCOUNT_LOCKED' });

/**
 * Raised while the System Administrator has engaged the Global Emergency
 * Lockout. Every non-admin session is frozen until the switch is cleared.
 */
export const serviceLocked = (message = 'The TransitSync system is under maintenance. Please try again later.') =>
  new AppError(503, message, { code: 'SYSTEM_LOCKDOWN' });

/**
 * The forced first-login rotation gate. It gets its own top-level code so a
 * client can branch on it without having to reach into `details` — the UI needs
 * to route to the change-password screen rather than show a generic 403.
 */
export const passwordChangeRequired = (message = 'You must change your password before continuing.') =>
  new AppError(403, message, {
    code: 'PASSWORD_CHANGE_REQUIRED',
    details: { mustChangePassword: true },
  });

/** Thrown by requirePermission when a session lacks a grant. */
export const permissionDenied = (permission, required) =>
  new AppError(403, `Missing required permission: ${permission}`, {
    code: 'PERMISSION_DENIED',
    details: { permission, required: required ?? null },
  });

export default AppError;
