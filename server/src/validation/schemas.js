import { z } from 'zod';

const trimmed = (min = 1, max = 255) => z.string().trim().min(min).max(max);
const optionalText = (max = 500) => z.string().trim().max(max).nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());
const latitude = z.coerce.number().min(-90).max(90).nullable().optional();
const longitude = z.coerce.number().min(-180).max(180).nullable().optional();
const idParam = z.coerce.number().int().positive();

/**
 * Optional campus tenant context accepted on operational reads and writes.
 * Only a platform principal (level >= 200) may exercise it — campus principals
 * are server-scoped to their own campus and this field is ignored for them.
 */
const platformTenantId = z.string().trim().uuid('Unknown college tenant.').optional();

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #RRGGBB colour');

/** Accepts "", null and undefined as "not provided" so empty form fields work. */
const emptyToNull = (schema) =>
  z.preprocess((value) => (value === '' || value === undefined ? null : value), schema.nullable());

/**
 * Inline email hint used on the student portal and the college provisioning
 * forms. Distinct from the generic staff message so a student knows campus
 * email shapes (`student@campus.edu.np`) are the expected format.
 */
const invalidEmailMessage =
  "Please enter a valid email address containing '@' (e.g., student@iic.edu.np)";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  remember: z.boolean().optional().default(false),
});

/** Step 1 of the two-step sign-in: is this a real account, and does it have a password? */
export const checkEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

/** Step 2b: the owner of an invited, passwordless account chooses their password. */
export const setFirstPasswordSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z.string().min(1, 'Password is required'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

/**
 * Portrait of the pre-authorized student sign-in.
 *
 * Step 1 matches a roster row by campus + email. Step 2 lets the pre-authorized
 * student choose their own password, which is what claims the account.
 */
export const studentCheckEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(invalidEmailMessage),
});

export const studentRegisterSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(invalidEmailMessage),
    password: z.string().min(1, 'Password is required'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const setupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(10, 'Use at least 10 characters'),
  confirmPassword: z.string(),
  fullName: trimmed(2, 120),
  institution: trimmed(2, 160),
  phone: optionalText(40),
  // Which master account to create: the Level 200 platform owner (multi-campus)
  // or the Level 100 campus System Administrator (single campus). Defaults to
  // the platform owner, which is the correct first account for a multi-tenant
  // deployment.
  role: z.enum(['super_admin', 'system_admin']).optional().default('super_admin'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(1, 'New password is required'),
    confirmPassword: z.string(),
    revokeOtherSessions: z.boolean().optional().default(true),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'New password must be different from the current one',
    path: ['newPassword'],
  });

export const updateProfileSchema = z.object({
  fullName: trimmed(2, 120).optional(),
  phone: optionalText(40),
  department: optionalText(120),
  jobTitle: optionalText(120),
});

/**
 * Self-service email change. Email is the sign-in identity, so it is guarded by
 * the current password rather than being a free-form profile field.
 */
export const changeEmailSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email('Enter a valid email address'),
  currentPassword: z.string().min(1, 'Password is required'),
});

// ---------------------------------------------------------------------------
// Platform-owner two-factor authentication
// ---------------------------------------------------------------------------
const sixDigitCode = z.string().trim().min(4).max(20);

export const twoFactorSetupSchema = z.object({
  method: z.enum(['TOTP', 'EMAIL']),
});

export const twoFactorEnableSchema = z.object({
  method: z.enum(['TOTP', 'EMAIL']),
  code: sixDigitCode,
});

export const twoFactorVerifySchema = z.object({
  challengeId: z.string().trim().uuid(),
  code: sixDigitCode,
});

export const twoFactorResendSchema = z.object({
  challengeId: z.string().trim().uuid(),
});

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  fullName: trimmed(2, 120),
  roleId: idParam,
  jobTitle: optionalText(120),
  department: optionalText(120),
  phone: optionalText(40),
  // Deliberately unconstrained: a temporary password is a single-use handover
  // credential, not the user's own password, so the complexity policy does not
  // apply. Only a sane upper bound is enforced.
  temporaryPassword: z.string().trim().max(128).optional(),
  permissionsMode: z.enum(['INHERIT', 'CUSTOM']).optional().default('INHERIT'),
  permissions: z.array(z.string()).optional().default([]),
  forcePasswordChange: z.boolean().optional().default(true),
  // Tenant the new account belongs to. Omitted for campus principals, who are
  // constrained to their own campus; a platform principal may place an account
  // anywhere (or leave it platform-global by omitting this).
  tenantId: z.string().trim().uuid('Unknown college tenant.').nullable().optional(),
});

export const updateUserSchema = z.object({
  fullName: trimmed(2, 120).optional(),
  roleId: idParam.optional(),
  status: z.enum(['active', 'suspended', 'invited']).optional(),
  jobTitle: optionalText(120),
  department: optionalText(120),
  phone: optionalText(40),
});

export const assignPermissionsSchema = z.object({
  permissionsMode: z.enum(['INHERIT', 'CUSTOM']).default('CUSTOM'),
  permissions: z.array(z.string()).default([]),
});

export const userQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  search: z.string().trim().max(120).optional(),
  role: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'suspended', 'invited', 'all']).optional(),
  sort: z.enum(['name', 'email', 'created', 'lastLogin']).optional().default('created'),
});

export const rolePermissionsSchema = z.object({
  permissions: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------
const studentBody = {
  fullName: trimmed(2, 120),
  collegeId: trimmed(3, 40).regex(/^[A-Za-z0-9\-_/]+$/, 'Only letters, digits, dashes, slashes and underscores'),
  email: emptyToNull(z.string().trim().toLowerCase().email(invalidEmailMessage)).optional(),
  phone: optionalText(40),
  faculty: optionalText(120),
  program: optionalText(120),
  semester: emptyToNull(z.coerce.number().int().min(1).max(12)).optional(),
  rfidSerial: emptyToNull(
    z.string().trim().toUpperCase().min(4).max(40).regex(/^[A-Z0-9\-]+$/, 'Use letters, digits and dashes only'),
  ).optional(),
  cardStatus: z.enum(['UNASSIGNED', 'ISSUED', 'ACTIVE', 'REVOKED']).optional(),
  cardRevokedReason: optionalText(120),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']).optional().default('ACTIVE'),
  notes: optionalText(1000),
};

export const createStudentSchema = z.object({ ...studentBody, tenantId: platformTenantId });

export const updateStudentSchema = z.object({
  ...Object.fromEntries(Object.entries(studentBody).map(([key, schema]) => [key, schema.optional()])),
});

export const studentQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN', 'all']).optional(),
  cardStatus: z.enum(['UNASSIGNED', 'ISSUED', 'ACTIVE', 'REVOKED', 'all']).optional(),
  onboard: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'collegeId', 'created', 'onboard']).optional().default('created'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  // Platform drill-down: a level >= 200 principal chooses the campus whose
  // registry they are viewing. Ignored for campus principals.
  tenantId: platformTenantId,
});

/** Issue (or re-point) a physical card to a student. */
export const issueCardSchema = z.object({
  rfidSerial: z.string().trim().toUpperCase().min(4).max(40).regex(/^[A-Z0-9\-]+$/, 'Use letters, digits and dashes only'),
  cardStatus: z.enum(['ISSUED', 'ACTIVE']).optional().default('ACTIVE'),
  note: z.string().trim().max(500).optional(),
});

/** Revoke a card — cancellation of the bus service, or a lost/blocked card. */
export const revokeCardSchema = z.object({
  reason: z.enum(['cancelled', 'lost', 'blocked', 'damaged', 'graduated', 'other']).optional().default('cancelled'),
  note: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------
export const busBody = {
  code: trimmed(2, 20).toUpperCase().regex(/^[A-Z0-9\-]+$/, 'Use letters, digits and dashes only'),
  registrationNo: trimmed(3, 30).toUpperCase(),
  name: trimmed(2, 80),
  makeModel: optionalText(120),
  seatCapacity: z.coerce.number().int().min(1, 'At least one seat').max(200),
  driverUserId: emptyToNull(idParam).optional(),
  driverName: optionalText(120),
  driverPhone: optionalText(40),
  driverLicense: optionalText(60),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'RETIRED']).optional().default('ACTIVE'),
  currentRouteId: emptyToNull(idParam).optional(),
  odometerKm: z.coerce.number().int().min(0).max(10_000_000).optional().default(0),
  lastServiceAt: emptyToNull(isoDate).optional(),
};

export const createBusSchema = z.object({ ...busBody, tenantId: platformTenantId });
export const updateBusSchema = z.object(
  Object.fromEntries(Object.entries(busBody).map(([key, schema]) => [key, schema.optional()])),
);

export const routeBody = {
  code: trimmed(2, 20).toUpperCase().regex(/^[A-Z0-9\-]+$/, 'Use letters, digits and dashes only'),
  name: trimmed(2, 100),
  description: optionalText(500),
  startPoint: trimmed(2, 120),
  endPoint: trimmed(2, 120),
  shift: z.enum(['MORNING', 'EVENING', 'BOTH']).optional().default('MORNING'),
  departureTime: hhmm.optional().default('07:00'),
  arrivalTime: hhmm.optional().default('09:00'),
  color: hexColor.optional().default('#38BDF8'),
  isActive: z.coerce.boolean().optional().default(true),
};

export const createRouteSchema = z
  .object({ ...routeBody, tenantId: platformTenantId })
  .refine(
    (data) => data.departureTime < data.arrivalTime,
    { message: 'Arrival time must be after departure time', path: ['arrivalTime'] },
  );

export const updateRouteSchema = z.object(
  Object.fromEntries(Object.entries(routeBody).map(([key, schema]) => [key, schema.optional()])),
);

export const stopSchema = z.object({
  sequence: z.coerce.number().int().min(1).max(200),
  name: trimmed(2, 160),
  scheduledTime: emptyToNull(hhmm).optional(),
  latitude,
  longitude,
});

export const stopsSchema = z.object({ stops: z.array(stopSchema).min(1, 'Add at least one stop').max(80) });

export const fleetQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  routeId: emptyToNull(idParam).optional(),
  // Platform drill-down: a level >= 200 principal chooses the campus whose
  // fleet they are viewing. Ignored for campus principals.
  tenantId: platformTenantId,
});

// ---------------------------------------------------------------------------
// Attendance / reports
// ---------------------------------------------------------------------------
export const attendanceQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  from: emptyToNull(isoDate).optional(),
  to: emptyToNull(isoDate).optional(),
  routeId: emptyToNull(idParam).optional(),
  busId: emptyToNull(idParam).optional(),
  outcome: z.enum(['VALID', 'INVALID', 'EXPIRED', 'UNREGISTERED_BUS', 'UNREGISTERED_CARD', 'all']).optional(),
  direction: z.enum(['BOARD', 'DEBOARD', 'all']).optional(),
  search: z.string().trim().max(120).optional(),
  format: z.enum(['csv', 'pdf', 'json']).optional().default('json'),
  sort: z.enum(['time', 'student', 'bus', 'outcome']).optional().default('time'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const demandQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(14),
  busId: emptyToNull(idParam).optional(),
  routeId: emptyToNull(idParam).optional(),
});

export const alertQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED', 'all']).optional().default('OPEN'),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'all']).optional(),
  type: z.string().trim().max(60).optional(),
  search: z.string().trim().max(120).optional(),
  from: emptyToNull(isoDateTime).optional(),
});

export const resolveAlertSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  status: z.enum(['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional().default('RESOLVED'),
});

// ---------------------------------------------------------------------------
// Simulator & stream
// ---------------------------------------------------------------------------
export const tapSchema = z.object({
  rfidSerial: trimmed(3, 40).toUpperCase(),
  busId: emptyToNull(idParam).optional(),
  latitude,
  longitude,
  gate: optionalText(60),
});

// The outcome travels in the path (`/scenario/:outcome`), not the body, so it is
// deliberately absent here — requiring it in both places made the endpoint
// un-callable. The allowed values come from the scanner service.
export const scenarioSchema = z.object({
  busId: emptyToNull(idParam).optional(),
  latitude,
  longitude,
  gate: optionalText(60),
});

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(60),
});

// ---------------------------------------------------------------------------
// Hardware ingest (Wokwi serial -> HTTP relay)
// ---------------------------------------------------------------------------
// Deliberately permissive: the Uno emits a small, stable shape, but an unknown
// or future field must never break the bridge, so extra keys are preserved and
// only the discriminator is required.
export const deviceEventSchema = z
  .object({
    type: z.string().trim().min(1).max(40),
    uid: z.string().trim().max(80).optional().nullable(),
    payload: z.union([z.string(), z.number(), z.boolean()]).optional().nullable(),
    deviceId: z.string().trim().max(60).optional().nullable(),
    timestamp: z.union([z.string(), z.number()]).optional().nullable(),
    latitude,
    longitude,
  })
  .passthrough();

export const deviceBatchSchema = z.union([
  deviceEventSchema,
  z.array(deviceEventSchema).min(1).max(200),
  z.object({ events: z.array(deviceEventSchema).min(1).max(200) }).passthrough(),
  z.object({ scans: z.array(deviceEventSchema).min(1).max(200) }).passthrough(),
]);

// ---------------------------------------------------------------------------
// Settings & backup
// ---------------------------------------------------------------------------
export const settingsPatchSchema = z.object({
  institutionName: trimmed(2, 160).optional(),
  academicYear: trimmed(4, 30).optional(),
  timezone: trimmed(2, 60).optional(),
  capacityWarningPct: z.coerce.number().int().min(50).max(100).optional(),
  alertRetentionDays: z.coerce.number().int().min(1).max(3650).optional(),
  allowSelfServiceRfid: z.coerce.boolean().optional(),
  maintenanceMode: z.coerce.boolean().optional(),
  maintenanceMessage: trimmed(1, 300).optional(),
});

/**
 * Platform Super Administrator maintenance switch. At least one field must be
 * present so an empty body cannot silently no-op.
 */
export const maintenanceSchema = z
  .object({
    enabled: z.coerce.boolean().optional(),
    message: trimmed(1, 300).optional(),
  })
  .refine((data) => data.enabled !== undefined || data.message !== undefined, {
    message: 'Provide enabled and/or message.',
  });

/**
 * Tenant-scoped maintenance switch (PUT /api/institution/maintenance). A campus
 * System Administrator toggles their OWN institution; the Level 200 Super
 * Administrator may pass `tenantId` to target any campus.
 */
export const institutionMaintenanceSchema = z
  .object({
    enabled: z.coerce.boolean({ invalid_type_error: 'enabled must be a boolean' }),
    message: trimmed(1, 300).optional(),
    tenantId: z.string().trim().uuid('Unknown college tenant.').optional(),
  })
  .refine((data) => data.enabled !== undefined, {
    message: 'Provide enabled.',
  });

// ---------------------------------------------------------------------------
// Multi-tenant college provisioning
// ---------------------------------------------------------------------------
const collegeCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'Use 2–32 lowercase letters, digits or hyphens.');

export const collegeCreateSchema = z.object({
  name: trimmed(2, 160),
  code: collegeCode,
  adminEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
  adminName: trimmed(2, 160).optional(),
});

export const collegeStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

/** At least one field must change — blank edits are refused before SQL. */
export const collegeUpdateSchema = z
  .object({
    name: trimmed(2, 160).optional(),
    code: collegeCode.optional(),
    adminEmail: z.string().trim().toLowerCase().email(invalidEmailMessage).max(200).optional(),
  })
  .refine((data) => data.name || data.code || data.adminEmail, {
    message: 'Provide at least one field to update.',
  });

export const collegeDeleteSchema = z.object({
  purge: z.enum(['true', 'false']).optional().default('false'),
});

export const collegeIdSchema = z.object({ id: z.string().trim().uuid('Unknown college id.') });

// ---------------------------------------------------------------------------
// Shared param schemas
// ---------------------------------------------------------------------------
export const idSchema = z.object({ id: idParam });
export const sessionIdSchema = z.object({ id: z.string().trim().min(8).max(64) });
export const backupFileSchema = z.object({ file: z.string().regex(/^[\w.-]+$/, 'Invalid file name') });

export const schemas = {
  loginSchema,
  checkEmailSchema,
  setFirstPasswordSchema,
  studentCheckEmailSchema,
  studentRegisterSchema,
  setupSchema,
  changePasswordSchema,
  updateProfileSchema,
  changeEmailSchema,
  twoFactorSetupSchema,
  twoFactorEnableSchema,
  twoFactorVerifySchema,
  twoFactorResendSchema,
  twoFactorDisableSchema,
  createUserSchema,
  updateUserSchema,
  assignPermissionsSchema,
  userQuerySchema,
  rolePermissionsSchema,
  createStudentSchema,
  updateStudentSchema,
  studentQuerySchema,
  createBusSchema,
  updateBusSchema,
  createRouteSchema,
  updateRouteSchema,
  stopSchema,
  stopsSchema,
  fleetQuerySchema,
  attendanceQuerySchema,
  demandQuerySchema,
  alertQuerySchema,
  resolveAlertSchema,
  tapSchema,
  scenarioSchema,
  activityQuerySchema,
  deviceEventSchema,
  deviceBatchSchema,
  settingsPatchSchema,
  maintenanceSchema,
  collegeCreateSchema,
  collegeStatusSchema,
  collegeUpdateSchema,
  collegeDeleteSchema,
  collegeIdSchema,
  idSchema,
  sessionIdSchema,
  backupFileSchema,
};

export default schemas;
