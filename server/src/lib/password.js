import bcrypt from 'bcryptjs';
import config from '../config/env.js';

const SALT_ROUNDS = 12;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
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
