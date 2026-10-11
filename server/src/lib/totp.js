import crypto from 'node:crypto';

/**
 * Minimal RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation.
 *
 * Written against node's own `crypto` rather than pulling an npm package: the
 * algorithm is ~40 lines, and the platform deliberately keeps its dependency
 * surface small. Compatible with Google Authenticator, Authy, 1Password,
 * Bitwarden and any other RFC 6238 client (SHA-1, 6 digits, 30-second period).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1;

/** Base32-encode a buffer (no padding — what authenticator apps expect). */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Base32-decode a string, tolerating spaces, dashes and padding. */
export function base32Decode(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit (20-byte) shared secret, base32-encoded. */
export function generateSecret(size = 20) {
  return base32Encode(crypto.randomBytes(size));
}

/** HOTP truncation over the big-endian counter. */
function hotp(secret, counter, digits) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Current time-step counter for the configured period. */
export function counterForTime(now = Date.now(), period = DEFAULT_PERIOD) {
  return Math.floor(now / 1000 / period);
}

/** The code an authenticator app is showing right now. Primarily for tests. */
export function generateCode(secret, { now = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS } = {}) {
  return hotp(secret, counterForTime(now, period), digits);
}

/**
 * Constant-time comparison so a wrong code cannot be recovered by timing.
 * Both sides are equal-length 6-digit strings, so a plain timingSafeEqual works.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify a submitted code, accepting the neighbouring time steps to tolerate
 * clock drift between the server and the user's phone (default ±1 = ±30s).
 */
export function verifyCode(
  secret,
  token,
  { window = DEFAULT_WINDOW, now = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS } = {},
) {
  const submitted = String(token ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(submitted)) return false;
  if (!secret) return false;

  const counter = counterForTime(now, period);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, counter + offset, digits);
    if (safeEqual(expected, submitted)) return true;
  }
  return false;
}

/** `otpauth://` provisioning URI for the QR code / manual entry. */
export function buildOtpAuthUrl({ secret, label, issuer = 'TransitSync' }) {
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD),
  });
  return `otpauth://totp/${encodedLabel}?${params.toString()}`;
}

export default {
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  verifyCode,
  buildOtpAuthUrl,
  counterForTime,
};
