import crypto from 'node:crypto';

// Time-based one-time passwords (RFC 6238 / RFC 4226), used as a second factor on top of
// the unattended-access password. Implemented with Node's crypto so there is no third-party
// dependency in a security-sensitive path.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh base32 secret (160 bits, the RFC-recommended size for SHA-1). */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** HOTP value for a counter (RFC 4226). */
function hotp(key, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** Current TOTP code for a base32 secret. `time` is unix seconds. */
export function totp(secret, { time = Date.now() / 1000, step = STEP, digits = DIGITS } = {}) {
  return hotp(base32Decode(secret), Math.floor(time / step), digits);
}

/**
 * True if `code` is valid now, tolerating ±`window` steps for clock drift.
 * Comparison is length-checked and constant-time per candidate.
 */
export function verifyTotp(secret, code, { time = Date.now() / 1000, step = STEP, digits = DIGITS, window = 1 } = {}) {
  const input = String(code ?? '').replace(/\s/g, '');
  if (!/^\d+$/.test(input) || input.length !== digits) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(time / step);
  let ok = false;
  // Check the whole window (no early return) so timing doesn't reveal which step matched.
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(key, counter + i, digits);
    if (candidate.length === input.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(input))) ok = true;
  }
  return ok;
}

/** otpauth:// URI an authenticator app imports (QR or manual entry). */
export function otpauthUrl({ secret, account, issuer = 'Remote Connection' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
