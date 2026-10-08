import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTrusted, hashPassword, validatePassword, verifyPassword } from '../src/main/access.js';

test('unattended passwords are stored as salted hashes and verified', () => {
  const record = hashPassword('correct horse 42');
  assert.equal(record.algo, 'scrypt');
  assert.ok(!JSON.stringify(record).includes('correct horse')); // plaintext never stored
  assert.ok(verifyPassword('correct horse 42', record));
  assert.ok(!verifyPassword('correct horse 43', record));
  assert.ok(!verifyPassword('', record));
  assert.ok(!verifyPassword('correct horse 42', null));
  // same password hashed twice -> different salt and hash
  assert.notEqual(hashPassword('correct horse 42').hash, record.hash);
});

test('weak unattended passwords are refused', () => {
  assert.match(validatePassword('short'), /at least 8/);
  assert.match(validatePassword('aaaaaaaaaa'), /too easy/);
  assert.match(validatePassword('12345678901'), /too easy/);
  assert.match(validatePassword('Password123'), /too easy/);
  assert.equal(validatePassword('blue-river-71'), null);
});

test('trusted devices are validated and de-duplicated', () => {
  let list = addTrusted([], { id: '123 456 789', name: 'Office PC' });
  list = addTrusted(list, { id: '987654321', name: 'Laptop' });
  list = addTrusted(list, { id: '123456789', name: 'Office PC (renamed)' });
  assert.deepEqual(
    list.map((d) => [d.id, d.name]),
    [['123456789', 'Office PC (renamed)'], ['987654321', 'Laptop']],
  );
  assert.throws(() => addTrusted(list, { id: '12' }), /invalid device id/);
});
