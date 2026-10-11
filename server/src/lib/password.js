import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config/env.js';

const SALT_ROUNDS = 12;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Handover credential for an invited account (first-time user or a newly
 * provisioned campus administrator).
 *
 * Deliberately simple: a temporary password is exempt from the user-facing
 * complexity policy (the holder is forced to set their own password at first
 * sign-in), so we favour a short, unambiguous string that is easy to read aloud
 * or retype. The alphabet omits i/l/o/0/1 to avoid transcription mistakes.
 */
export function generateTemporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let password = '';
  for (let i = 0; i < bytes.length; i += 1) {
    password += alphabet[bytes[i] % alphabet.length];
  }
  return password;
}

export async function verifyPassword(plain, hash) {
  // Guard first: a passwordless account stores a sentinel (see PASSWORD_UNSET),
  // and bcrypt must never be handed a non-bcrypt digest.
  if (!isPasswordSet(hash)) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Sentinel stored in `users.password_hash` for an account an administrator has
 * created but whose owner has not chosen a password yet (the first-time-user
 * flow). Every real hash is a bcrypt string beginning `$2`, so the sentinel can
 * never match and `isPasswordSet` is a reliable "has a password" test.
 *
 * A sentinel is used rather than a nullable column because SQLite cannot drop
 * NOT NULL in place, and rebuilding `users` — which half the schema references
 * by foreign key — is not a migration to run unattended on a live database.
 */
export const PASSWORD_UNSET = '!unset';

export function isPasswordSet(hash) {
  return typeof hash === 'string' && hash.startsWith('$2');
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', '12345678', '123456789', 'qwerty123', 'letmein',
  'admin123', 'administrator', 'transitsync', 'welcome123', 'iloveyou',
]);

/**
 * Password policy used for both the forced first-login rotation and any
 * subsequent change. Returns `{ valid, errors, score }` so the UI can show
 * live feedback while the server stays authoritative.
 */
export function checkPasswordPolicy(plain, { email, fullName } = {}) {
  const errors = [];
  const value = String(plain ?? '');
  const minLength = config.password.minLength;

  if (value.length < minLength) errors.push(`Must be at least ${minLength} characters.`);
  if (value.length > 128) errors.push('Must be 128 characters or fewer.');
  if (!/[a-z]/.test(value)) errors.push('Must include a lowercase letter.');
  if (!/[A-Z]/.test(value)) errors.push('Must include an uppercase letter.');
  if (!/\d/.test(value)) errors.push('Must include a number.');
  if (!/[^A-Za-z0-9]/.test(value)) errors.push('Must include a symbol.');
  if (/(.)\1{3,}/.test(value)) errors.push('Must not repeat the same character 4+ times.');

  const lowered = value.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) errors.push('This password is too common.');

  const localPart = String(email || '').split('@')[0];
  if (localPart && localPart.length >= 3 && lowered.includes(localPart.toLowerCase())) {
    errors.push('Password must not contain your email address.');
  }
  if (fullName) {
    const nameParts = String(fullName).toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
    if (nameParts.some((part) => lowered.includes(part))) {
      errors.push('Password must not contain your name.');
    }
  }

  return { valid: errors.length === 0, errors, score: scorePassword(value) };
}

const LABELS = [
  { min: 0, label: 'Very weak' },
  { min: 1, label: 'Weak' },
  { min: 2, label: 'Fair' },
  { min: 3, label: 'Good' },
  { min: 4, label: 'Strong' },
];

export function scorePassword(plain) {
  const value = String(plain ?? '');
  if (!value) return { score: 0, label: 'Empty', percent: 0 };

  let points = 0;
  if (value.length >= 8) points += 1;
  if (value.length >= 12) points += 1;
  if (value.length >= 16) points += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points += 1;
  if (/\d/.test(value)) points += 1;
  if (/[^A-Za-z0-9]/.test(value)) points += 1;
  if (new Set(value).size >= 10) points += 1;

  const score = Math.min(points, 4);
  return {
    score,
    label: LABELS[score].label,
    percent: Math.round(((score + 1) / 5) * 100),
  };
}

export default { hashPassword, verifyPassword, checkPasswordPolicy, scorePassword };
