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
];

/** Flat list of every route the user is allowed to reach. */
export function allowedRoutes(can) {
  return NAV_SECTIONS.flatMap((section) =>
    section.items.filter((item) => !item.permission || can(item.permission)).map((item) => item.to),
  );
}