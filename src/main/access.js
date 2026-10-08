import crypto from 'node:crypto';

// scrypt parameters: ~50-100 ms per check, which makes guessing slow even if someone
// copied the config file off the machine.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;

/** Checks a new unattended-access password; returns an error message, or null if it's fine. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 128) return 'Use at most 128 characters.';
  if (/^(.)\1*$/.test(password) || /^(?:0123456789|1234567890|password|qwerty)/i.test(password)) {
    return 'That password is too easy to guess.';
  }
  return null;
}

/** Salted scrypt hash of a password; only this record is ever stored on disk. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return { algo: 'scrypt', N, r: R, p: P, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** Constant-time comparison of a candidate password against a stored record. */
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || !password || record?.algo !== 'scrypt') return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'base64'), expected.length, {
    N: record.N,
    r: record.r,
    p: record.p,
    maxmem: MAX_MEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Adds a device the local user explicitly chose to trust ("always allow this device"),
 * de-duplicated and capped. Stored so an approved helper doesn't have to be re-approved
 * every time; the user can remove any entry in Settings.
 */
export function addTrusted(list = [], { id, name }) {
  const cleanId = String(id ?? '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(cleanId)) throw new Error('invalid device id');
  const entry = { id: cleanId, name: String(name ?? '').slice(0, 64), addedAt: new Date().toISOString() };
  return [entry, ...list.filter((d) => d.id !== cleanId)].slice(0, 50);
}
