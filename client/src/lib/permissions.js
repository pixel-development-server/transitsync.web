/**
 * Permission-catalogue helpers.
 *
 * The API describes the catalogue as modules that each carry an `actions`
 * array (see `server/src/db/permissions.js`). A module's full permission keys
 * are therefore `${module.key}:${action.action}`, mirroring the server's
 * `ALL_PERMISSIONS`.
 *
 * Do NOT read `module.permissions` directly: the API never sends it, so a
 * module would yield an empty key list — the grid then renders "0/0" with no
 * checkboxes to tick and the module toggle becomes a silent no-op.
 *
 * Pure and side-effect-free; keep it that way.
 */
export function modulePermissionKeys(module) {
  if (Array.isArray(module?.actions)) {
    return module.actions.map((action) => `${module.key}:${action.action}`);
  }
  // Tolerate a pre-computed `permissions` array if a future API provides one.
  return module?.permissions ?? [];
}

export default { modulePermissionKeys };
