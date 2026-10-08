export class Emitter {
  #handlers = new Map();

  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.#handlers.get(type)?.delete(handler);
  }

  emit(type, ...args) {
    for (const handler of this.#handlers.get(type) ?? []) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`handler for "${type}" failed`, err);
      }
    }
  }
}

export const formatId = (id) =>
  String(id ?? '')
    .replace(/\D/g, '')
    .replace(/(\d{3})(?=\d)/g, '$1 ');

/** Easy-to-read random password (no 0/O, 1/l/I). */
export function randomPassword(length = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const out = [];
  const bytes = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    // Rejection sampling keeps the distribution uniform.
    if (bytes[0] < 256 - (256 % alphabet.length)) out.push(alphabet[bytes[0] % alphabet.length]);
  }
  return out.join('');
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const REASONS = {
  'invalid-id': 'That ID is not valid. IDs have 9 digits.',
  self: "You can't connect to this device itself.",
  offline: 'The remote device is offline.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
  busy: 'The remote device is busy with another session.',
  rejected: 'The remote side declined the request.',
  'wrong-password': 'Wrong password.',
  locked: 'Too many wrong passwords. The remote device is temporarily locked.',
  timeout: 'The remote side did not answer in time.',
  'peer-offline': 'The remote device disconnected.',
  'connection-failed': 'Could not establish a connection. The network may require a TURN relay.',
  'capture-failed': 'The remote device could not share its screen.',
  'server-offline': 'Lost connection to the server.',
  unavailable: 'The remote device is not available.',
};

export const reasonText = (reason) => REASONS[reason] ?? 'The session ended.';
