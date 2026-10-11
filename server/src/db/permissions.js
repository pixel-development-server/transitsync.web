/**
 * Single source of truth for the RBAC permission matrix.
 *
 * A permission key is always `<module>:<action>`. The catalogue below drives:
 *   - the `permissions` table rows created by migrations,
 *   - the middleware guards (`requirePermission('students:edit')`),
 *   - the category/feature checkbox grid rendered in the User Management UI.
 *
 * Adding a module or action here is enough for it to appear everywhere.
 */

export const MODULES = [
  {
    key: 'dashboard',
    label: 'Dashboard & Live Monitor',
    description: 'KPI cards, active fleet monitor, live scan feed and occupancy.',
    actions: [{ action: 'read', label: 'Read' }],
  },
  {
    key: 'students',
    label: 'Students Module',
    description: 'Student records, college ID mapping, RFID serial and pass validity.',
    actions: [
      { action: 'create', label: 'Create' },
      { action: 'read', label: 'Read' },
      { action: 'edit', label: 'Edit' },
      { action: 'delete', label: 'Delete' },
    ],
  },
  {
    key: 'fleet',
    label: 'Fleet & Routes Module',
    description: 'Buses, seat capacity, driver assignments, route stops and schedules.',
    actions: [
      { action: 'create', label: 'Create' },
      { action: 'read', label: 'Read' },
      { action: 'edit', label: 'Edit' },
      { action: 'delete', label: 'Delete' },
    ],
  },
  {
    key: 'attendance',
    label: 'Attendance & Logs Module',
    description: 'Scan history, seat-demand analytics and report exports.',
    actions: [
      { action: 'read', label: 'Read' },
      { action: 'export', label: 'Export CSV/PDF' },
    ],
  },
  {
    key: 'alerts',
    label: 'Security Alerts Module',
    description: 'Flagged scans, unauthorized access attempts and resolution workflow.',
    actions: [
      { action: 'read', label: 'Read' },
      { action: 'resolve', label: 'Resolve Alerts' },
    ],
  },
  {
    key: 'simulator',
    label: 'RFID Simulator',
    description: 'Virtual card-tap testing bench for the live reader fleet.',
    actions: [{ action: 'scan', label: 'Simulate Tap' }],
  },
  {
    key: 'users',
    label: 'User Access Management',
    description: 'Staff accounts, roles, invitations and per-user permission overrides.',
    actions: [
      { action: 'create', label: 'Create' },
      { action: 'read', label: 'Read' },
      { action: 'edit', label: 'Edit' },
      { action: 'delete', label: 'Delete' },
      { action: 'assign_permissions', label: 'Assign Permissions' },
    ],
  },
  {
    key: 'roles',
    label: 'Roles & Permission Sets',
    description: 'Permission sets attached to the built-in system roles.',
    actions: [
      { action: 'read', label: 'Read' },
      { action: 'edit', label: 'Edit' },
    ],
  },
  {
    key: 'settings',
    label: 'System Configuration',
    description: 'Institution profile, pass policies and operational thresholds.',
    actions: [
      { action: 'read', label: 'Read' },
      { action: 'edit', label: 'Edit' },
    ],
  },
  {
    key: 'backup',
    label: 'Database Backup',
    description: 'Trigger and download SQLite snapshots of the operational database.',
    actions: [{ action: 'create', label: 'Create Backup' }],
  },
  {
    key: 'system',
    label: 'System Control',
    description:
      'Master facilities reserved for the System Administrator: audit log archive/flush, the global emergency lockout and full session/password override.',
    actions: [
      { action: 'lockdown', label: 'Emergency Lockout' },
      { action: 'audit_purge', label: 'Purge Audit Logs' },
      { action: 'session_override', label: 'Session & Password Override' },
    ],
  },
];

/** Flat list of every permission key, e.g. `students:edit`. */
export const ALL_PERMISSIONS = MODULES.flatMap((module) =>
  module.actions.map((action) => `${module.key}:${action.action}`),
);

/** Every permission key with a human label — used for seeding and UI display. */
export const PERMISSION_INDEX = MODULES.flatMap((module) =>
  module.actions.map((action) => ({
    key: `${module.key}:${action.action}`,
    module: module.key,
    module_label: module.label,
    action: action.action,
    label: `${module.label} · ${action.label}`,
  })),
);

export const ROLE_KEYS = {
  SUPER_ADMIN: 'super_admin',
  SYSTEM_ADMIN: 'system_admin',
  ADMIN: 'admin',
  TRANSPORT_STAFF: 'transport_staff',
  ATTENDANT: 'attendant',
  STUDENT: 'student',
};

/**
 * The platform-owner level. Everything at or above this level is a Super
 * Administrator; the maintenance gate in `/auth/login` treats it as the sole
 * bypass, and the Super Admin panel is gated on the same threshold.
 */
export const SUPER_ADMIN_LEVEL = 200;

/**
 * Default permission sets for the system roles.
 * `system_admin` intentionally receives everything and is re-synced on every seed.
 */
export const ROLE_DEFAULTS = {
  [ROLE_KEYS.SUPER_ADMIN]: {
    label: 'Super Administrator',
    description:
      'Platform owner above every campus. The only role that can provision or suspend colleges and toggle global maintenance mode. Holds the full catalogue for platform-wide oversight.',
    level: SUPER_ADMIN_LEVEL,
    permissions: ALL_PERMISSIONS,
  },
  [ROLE_KEYS.SYSTEM_ADMIN]: {
    label: 'System Administrator',
    description:
      'Full system control: configuration, staff accounts, permission assignment, database backups and every operational module.',
    level: 100,
    permissions: ALL_PERMISSIONS,
  },
  [ROLE_KEYS.ADMIN]: {
    label: 'Administrator',
    description:
      'Broad campus management across staff, students, fleets and logs. Below the System Administrator: cannot modify System Administrator accounts, role definitions or the master System Control facilities.',
    level: 90,
    permissions: ALL_PERMISSIONS.filter(
      (key) => key !== 'roles:edit' && !key.startsWith('system:'),
    ),
  },
  [ROLE_KEYS.TRANSPORT_STAFF]: {
    label: 'Resource & Transport Staff',
    description:
      'Runs the service day to day: bus and route management, student profile allocation, capacity planning, alert handling and reporting.',
    level: 50,
    permissions: [
      'dashboard:read',
      'students:create',
      'students:read',
      'students:edit',
      'fleet:create',
      'fleet:read',
      'fleet:edit',
      'attendance:read',
      'attendance:export',
      'alerts:read',
      'alerts:resolve',
      'simulator:scan',
      'settings:read',
    ],
  },
  [ROLE_KEYS.ATTENDANT]: {
    label: 'Bus Attendant (Read-Only)',
    description:
      'On-board view only: follows live scan feeds, occupancy and alert banners. No management or editing rights.',
    level: 10,
    // Buses, routes and stops are one operational module, so `fleet:read` is
    // what opens route visibility. There are no separate `routes:*` keys.
    permissions: [
      'dashboard:read',
      'students:read',
      'fleet:read',
      'attendance:read',
      'alerts:read',
    ],
  },
  [ROLE_KEYS.STUDENT]: {
    label: 'Student (Read-Only)',
    description:
      'Rider account. The holder sees only their own route, bus, driver and live status in the read-only Student Portal — never the operations console.',
    level: 1,
    // Deliberately empty: the Student Portal is gated on the role itself, not on
    // a console permission, so a student can never reach an administrative view.
    permissions: [],
  },
};

/** Permission groups that grant visibility of a navigation area. */
export const NAV_PERMISSION = {
  dashboard: 'dashboard:read',
  students: 'students:read',
  fleet: 'fleet:read',
  routes: 'fleet:read',
  attendance: 'attendance:read',
  alerts: 'alerts:read',
  users: 'users:read',
  roles: 'roles:read',
  settings: 'settings:read',
  profile: null,
};

export function isValidPermission(key) {
  return ALL_PERMISSIONS.includes(key);
}

export function permissionKey(moduleKey, action) {
  return `${moduleKey}:${action}`;
}

export default {
  MODULES,
  ALL_PERMISSIONS,
  PERMISSION_INDEX,
  ROLE_KEYS,
  ROLE_DEFAULTS,
  NAV_PERMISSION,
  isValidPermission,
  permissionKey,
};
