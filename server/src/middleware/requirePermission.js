import { forbidden, unauthorized } from '../lib/errors.js';
import { hasAllPermissions, hasAnyPermission } from '../services/permissions.js';

/**
 * The single RBAC chokepoint for the whole API.
 *
 *   router.post('/', requirePermission('students:create'), createStudent)
 *
 * All listed permissions must be held. Use `requireAnyPermission` when holding a
 * single one of several is enough.
 */
export function requirePermission(...perms) {
  const needed = perms.flat().filter(Boolean);

  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (hasAllPermissions(req.user, needed)) return next();

    return next(
      forbidden(
        `Your role "${req.user.role_name ?? req.user.role_key ?? 'unknown'}" is missing: ${needed.join(', ')}.`,
        { code: 'PERMISSION_DENIED', required: needed, granted: req.user.permissions ?? [] },
      ),
    );
  };
}

/** At least one of the listed permissions is sufficient. */
export function requireAnyPermission(...perms) {
  const needed = perms.flat().filter(Boolean);
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (hasAnyPermission(req.user, needed)) return next();
    return next(
      forbidden(`Requires one of: ${needed.join(', ')}.`, {
        code: 'PERMISSION_DENIED',
        requiredAny: needed,
      }),
    );
  };
}

/** Every one of the listed permissions is required. */
export const requireAllPermissions = requirePermission;

/** Convenience wrapper used by routes mounted behind `requireAuth`. */
export function requireRole(...roleKeys) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (roleKeys.includes(req.user.role_key)) return next();
    return next(forbidden(`Restricted to role(s): ${roleKeys.join(', ')}.`));
  };
}

/** Restrict a route to the account that owns it, or `users:edit` for staff. */
export function requireSelfOrPermission(paramName, permission) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    const target = Number(req.params[paramName]);
    if (Number(req.user.id) === target) return next();
    if ((req.user.permissions ?? []).includes(permission)) return next();
    return next(forbidden('You may only modify your own account.'));
  };
}

export default { requirePermission, requireAnyPermission, requireAllPermissions, requireRole, requireSelfOrPermission };
