/**
 * Navigation model.
 *
 * `permission` is a hint the shell uses to hide links the signed-in user cannot
 * use. Hiding is a courtesy, not a control — the API enforces the same
 * permissions, so a hand-typed URL still gets a 403 from the server.
 *
 * `icon` holds an Icon.jsx *name* (a key of its PATHS map) rather than a
 * component, so the sidebar can size it without importing the icon set.
 */

export const NAV_SECTIONS = [
  {
    label: 'Operations',
    items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', permission: 'dashboard:read', end: true },
      { to: '/live', label: 'Live Monitor', icon: 'activity', permission: 'dashboard:read' },
    ],
  },
  {
    label: 'Records',
    items: [
      { to: '/students', label: 'Students', icon: 'students', permission: 'students:read' },
      { to: '/alerts', label: 'Alerts', icon: 'alerts', permission: 'alerts:read', badge: 'alerts' },
    ],
  },
  {
    label: 'Fleet',
    items: [{ to: '/fleet', label: 'Buses & Routes', icon: 'bus', permission: 'fleet:read' }],
  },
  {
    label: 'Administration',
    items: [
      { to: '/users', label: 'Users', icon: 'users', permission: 'users:read' },
      { to: '/roles', label: 'Roles & Permissions', icon: 'roles', permission: 'roles:read' },
      { to: '/settings', label: 'Settings', icon: 'settings', permission: 'settings:read' },
    ],
  },
  {
    // Level 200 only. Gated on the role itself (`superAdmin`) rather than a
    // permission, because the System Administrator holds every permission and
    // must NOT see the platform surface.
    label: 'Platform Master',
    items: [
      { to: '/super-admin/colleges', label: 'College Management', icon: 'building', superAdmin: true },
      { to: '/super-admin/system', label: 'Global System & Maintenance', icon: 'platform', superAdmin: true },
    ],
  },
];

/** True when a nav item is reachable for the given permission probe + role level. */
export function canSeeNavItem(item, { can, roleLevel = 0 } = {}) {
  if (item.superAdmin) return Number(roleLevel) >= 200;
  return !item.permission || can(item.permission);
}

/** Flat list of every route the user is allowed to reach. */
export function allowedRoutes(can, roleLevel = 0) {
  return NAV_SECTIONS.flatMap((section) =>
    section.items.filter((item) => canSeeNavItem(item, { can, roleLevel })).map((item) => item.to),
  );
}