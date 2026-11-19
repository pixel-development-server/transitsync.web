/**
 * Credential audit export.
 *
 * Writes one human-readable summary per provisioned account into
 * `storage/credentials/` so a developer can audit *who exists and how they were
 * created* straight from the filesystem, without opening the database.
 *
 * SECURITY — this module deliberately never receives, stores or writes a
 * password or a password hash. Sign-in credentials live only as one-way bcrypt
 * hashes inside the application database; copying them into loose text files
 * would widen the blast radius of any filesystem read while adding nothing a
 * developer needs in order to audit accounts. Each record therefore describes
 * *identity and provisioning*, never secrets.
 *
 * Writes are best-effort: a full disk, a locked file or a read-only mount must
 * never break a sign-up, so every failure is caught and downgraded to a single
 * warning line.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { warn } from './logger.js';
import { NPT_TIME_ZONE, parseNptStamp } from './src/lib/time.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/server

/** Where the `.txt` records land. Override with `CREDENTIAL_STORE_DIR`. */
export const CREDENTIAL_STORE_DIR =
  process.env.CREDENTIAL_STORE_DIR || resolve(HERE, '..', 'storage', 'credentials');

/**
 * The export is a development/audit convenience, not part of the security
 * model, so it stays off under the test harness (which creates hundreds of
 * throwaway accounts per run) and can be force-disabled with
 * `CREDENTIAL_STORE=off` on a locked-down host.
 */
function disabled() {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.TS_TEST === '1' ||
    String(process.env.CREDENTIAL_STORE ?? '').toLowerCase() === 'off'
  );
}

const nptFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: NPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Coerce a Date / epoch number / bare NPT SQL string into a Date, or null. */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  return parseNptStamp(value);
}

/**
 * Sortable Nepal-Time stamp: `2026-10-15 14:32:05 NPT`.
 *
 * Assembled from parts rather than delegating to `Intl`'s locale ordering so
 * the field order is stable and `en-GB`'s day-first `DD/MM/YYYY` never leaks in.
 */
export function nptStamp(value = new Date()) {
  const date = toDate(value) ?? new Date();
  if (Number.isNaN(date.getTime())) return '—';
  const parts = Object.fromEntries(
    nptFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} NPT`;
}

/** `ram@iic.edu.np` -> `ram@iic.edu.np` (nothing to do); a path is flattened. */
function fileSafe(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120);
}

/**
 * Stable, one-per-account filename. Email is the sign-in identity and is unique
 * per account; a roster row without an email yet falls back to its college ID.
 */
export function credentialFileName(record = {}) {
  const email = fileSafe(record.email);
  if (email) return `user_${email}.txt`;
  if (record.collegeId) return `student_${fileSafe(record.collegeId)}.txt`;
  return `user_id_${fileSafe(record.userId ?? 'unknown')}.txt`;
}

const LABEL_WIDTH = 14;

function field(label, value) {
  const text =
    value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);
  return ` ${label.padEnd(LABEL_WIDTH)} ${text}`;
}

const RULE = '='.repeat(80);
const SUB = '-'.repeat(80);

function section(title, rows) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  if (present.length === 0) return [];
  return [` ${title}`, ` ${'-'.repeat(title.length)}`, ...rows.map(([label, value]) => field(label, value)), ''];
}

/** Render the record as an aligned, plain-text document. */
export function renderCredentialRecord(record = {}) {
  const portal =
    record.portalType ??
    (String(record.roleKey ?? '').toLowerCase() === 'student' ? 'Rider portal' : 'Staff console');
  const roleName = record.roleName ?? record.roleKey;
  // Drop the raw permission key when it only restates the display name (e.g.
  // "Student"/"student"), so the line reads cleanly rather than echoing itself.
  const roleKey =
    record.roleKey && String(record.roleKey).toLowerCase() !== String(roleName ?? '').toLowerCase()
      ? record.roleKey
      : null;
  const role = roleName ? `${roleName}${roleKey ? ` [${roleKey}]` : ''} (${portal})` : portal;

  const lines = [
    RULE,
    ' TransitSync — Account Audit Record',
    RULE,
    field('File', credentialFileName(record)),
    field('Generated', nptStamp(new Date())),
    field('Source', record.source),
    field('Account ID', record.userId),
    '',
    ...section('IDENTITY', [
      ['Full name', record.fullName],
      ['Email', record.email],
      ['Role', role],
      ['Campus', record.tenantName],
      ['Status', record.status],
    ]),
    ...section('PROVISIONING', [
      ['College ID', record.collegeId],
      ['Bus card', record.busCardStatus],
      ['RFID serial', record.busCardSerial],
      ['Created', record.createdAt ? nptStamp(record.createdAt) : null],
      ['Last updated', record.updatedAt ? nptStamp(record.updatedAt) : null],
      ['Last sign-in', record.lastLoginAt ? nptStamp(record.lastLoginAt) : null],
    ]),
    SUB,
    ' SECURITY',
    SUB,
    ' No password and no password hash is written to this file. Sign-in',
    ' credentials are held only as one-way bcrypt hashes inside the',
    ' application database, and are never exported in plain text.',
    ` Password reset pending : ${record.forcePasswordReset ? 'yes' : 'no'}`,
    '',
  ];

  return lines.join('\n');
}

/**
 * Write (or refresh) the audit record for one account.
 *
 * Idempotent: re-running overwrites the same file, so a record always reflects
 * the account's current state. Returns the absolute path, or `null` when the
 * export is disabled — never throws.
 *
 * @param {object} record identity/provisioning fields (see `renderCredentialRecord`)
 * @returns {string|null}
 */
export function writeCredentialRecord(record = {}) {
  if (disabled()) return null;

  try {
    const target = join(CREDENTIAL_STORE_DIR, credentialFileName(record));
    mkdirSync(CREDENTIAL_STORE_DIR, { recursive: true });
    writeFileSync(target, renderCredentialRecord(record), 'utf8');
    return target;
  } catch (caught) {
    warn(`Credential audit export skipped for ${record.email ?? record.collegeId ?? 'unknown'}: ${caught?.message ?? caught}`);
    return null;
  }
}

/** Map a `users` row (with joined role/tenant names) to an audit record. */
export function userRecord(row = {}, { source = 'user.create' } = {}) {
  return {
    source,
    userId: row.id,
    fullName: row.full_name ?? row.fullName,
    email: row.email,
    roleKey: row.role_key ?? row.roleKey,
    roleName: row.role_name ?? row.roleName,
    portalType: row.portal_type ?? row.portalType,
    tenantName: row.tenant_name ?? row.tenantName ?? row.institution_name,
    status: row.status,
    forcePasswordReset: Boolean(row.force_password_reset),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt,
  };
}

/** Map a `students` row to an audit record (student profile + linked account). */
export function studentRecord(row = {}, { source = 'student.create', userId, tenantName } = {}) {
  return {
    source,
    userId: userId ?? row.user_id,
    fullName: row.full_name ?? row.fullName,
    email: row.email,
    roleKey: 'student',
    roleName: 'Student',
    portalType: 'Rider portal',
    tenantName,
    status: row.status,
    collegeId: row.college_id ?? row.collegeId,
    busCardStatus: row.card_status ?? row.cardStatus,
    busCardSerial: row.rfid_serial ?? row.rfidSerial,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

export default {
  CREDENTIAL_STORE_DIR,
  credentialFileName,
  renderCredentialRecord,
  writeCredentialRecord,
  userRecord,
  studentRecord,
  nptStamp,
};
