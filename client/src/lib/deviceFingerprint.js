/**
 * Stable per-browser device fingerprint for "Remember Me" device recognition.
 *
 * The value is deliberately *not* a tracking identifier. It is composed from
 * coarse, non-identifying browser signals (user agent, platform, language,
 * screen size, timezone offset and CPU thread count) mixed with a random salt
 * minted once and kept in localStorage. The salt makes the id unique to a
 * browser install without fingerprinting the person behind it, while keeping the
 * id stable across visits so the same device is recognised — and can be listed
 * and revoked on its own.
 *
 * Every read/write of localStorage is wrapped in try/catch: a blocked store
 * (private mode, storage partitioning, a hardened browser) degrades gracefully
 * to an uncached, still-valid value rather than throwing during sign-in.
 */

const SALT_KEY = 'transitsync.device.salt';
const ID_KEY = 'transitsync.device.id';

/** FNV-1a (32-bit). Tiny, synchronous and collision-resistant enough for a UI id. */
function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // FNV prime multiply, kept in the unsigned 32-bit range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function readStore(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked store only means the id is not cached; it is still returned.
  }
}

/** Random salt for the fingerprint, falling back when crypto is unavailable. */
function randomSalt() {
  try {
    const bytes = new Uint8Array(16);
    const crypto = window.crypto ?? globalThis.crypto;
    if (crypto?.getRandomValues) {
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fall through to the timestamp fallback below.
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

/** The coarse signals that make up the fingerprint payload. */
function deviceSignals() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const scr = typeof screen !== 'undefined' ? screen : {};
  return [
    nav.userAgent ?? '',
    nav.userAgentData?.platform ?? '',
    nav.language ?? '',
    `${scr.width ?? 0}x${scr.height ?? 0}`,
    String(new Date().getTimezoneOffset()),
    String(nav.hardwareConcurrency ?? 0),
  ].join('|');
}

/** A human-friendly "Browser on Platform" label for the device list. */
export function getDeviceLabel() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = String(nav.userAgent ?? '');

  const browser =
    /edg\//i.test(ua) ? 'Edge'
    : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari'
    : 'Browser';

  const platform =
    nav.userAgentData?.platform
    || (/windows/i.test(ua) ? 'Windows'
      : /mac os x|macintosh/i.test(ua) ? 'macOS'
      : /android/i.test(ua) ? 'Android'
      : /iphone|ipad|ios/i.test(ua) ? 'iOS'
      : /linux/i.test(ua) ? 'Linux'
      : 'Unknown OS');

  return `${browser} on ${platform}`;
}

/** A stable `fp_<hex>` identifier for this browser, cached once computed. */
export function getDeviceFingerprint() {
  const cached = readStore(ID_KEY);
  if (cached && /^fp_[0-9a-f]+$/.test(cached)) return cached;

  let salt = readStore(SALT_KEY);
  if (!salt) {
    salt = randomSalt();
    writeStore(SALT_KEY, salt);
  }

  const id = `fp_${fnv1a(`${salt}|${deviceSignals()}`)}`;
  writeStore(ID_KEY, id);
  return id;
}

export default { getDeviceFingerprint, getDeviceLabel };
