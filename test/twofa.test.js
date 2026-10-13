import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, generateSecret, otpauthUrl, totp, verifyTotp } from '../src/main/twofa.js';

// RFC 6238 test vectors (SHA-1, seed "12345678901234567890").
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 round-trips arbitrary bytes', () => {
  for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
    assert.equal(base32Decode(base32Encode(Buffer.from(s))).toString(), s);
  }
});

test('totp matches RFC 6238 vectors (last 6 digits)', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [time, expected] of vectors) {
    assert.equal(totp(SECRET, { time }), expected, `t=${time}`);
  }
});

test('verifyTotp accepts the current code and a nearby step, rejects others', () => {
  const time = 1234567890;
  assert.ok(verifyTotp(SECRET, '005924', { time }));
  assert.ok(verifyTotp(SECRET, totp(SECRET, { time: time - 30 }), { time })); // prev step within window
  assert.ok(verifyTotp(SECRET, totp(SECRET, { time: time + 30 }), { time })); // next step within window
  assert.ok(!verifyTotp(SECRET, totp(SECRET, { time: time + 120 }), { time })); // far future step
  assert.ok(!verifyTotp(SECRET, '000000', { time }));
  assert.ok(!verifyTotp(SECRET, '12345', { time })); // wrong length
  assert.ok(!verifyTotp(SECRET, 'abcdef', { time }));
  assert.ok(!verifyTotp(SECRET, '', { time }));
});

test('generateSecret produces a usable base32 secret', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]+$/);
  assert.ok(base32Decode(s).length >= 16);
  const code = totp(s);
  assert.ok(verifyTotp(s, code));
});

test('otpauthUrl is a valid, importable URI', () => {
  const url = otpauthUrl({ secret: SECRET, account: '482913556' });
  assert.match(url, /^otpauth:\/\/totp\//);
  const u = new URL(url);
  assert.equal(u.searchParams.get('secret'), SECRET);
  assert.equal(u.searchParams.get('issuer'), 'Remote Connection');
  assert.equal(u.searchParams.get('digits'), '6');
  assert.equal(u.searchParams.get('period'), '30');
});
