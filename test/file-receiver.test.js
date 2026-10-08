import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileReceiver, safeFileName } from '../src/main/file-receiver.js';

let dir;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-files-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const visible = () => fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();

test('remote file names cannot escape the folder or use reserved names', () => {
  assert.equal(safeFileName('report.pdf'), 'report.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(safeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('...'), 'file');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName(' .hidden '), 'hidden');
  assert.ok(safeFileName(`${'x'.repeat(500)}.zip`).length <= 180);
  assert.ok(safeFileName(`${'x'.repeat(500)}.zip`).endsWith('.zip'));
});

test('a file is written, then renamed into place only when complete', async () => {
  const r = new FileReceiver(dir);
  const { name } = r.begin('t1', { name: 'notes.txt', size: 11 });
  assert.equal(name, 'notes.txt');
  r.write('t1', new TextEncoder().encode('hello ').buffer);
  assert.deepEqual(visible(), []); // only the hidden .part file exists so far
  r.write('t1', new TextEncoder().encode('world').buffer);
  const result = await r.end('t1');
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'hello world');
  assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
  assert.equal(r.pathOf('t1'), result.path);
});

test('existing files are never overwritten', async () => {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original');
  const r = new FileReceiver(dir);
  assert.equal(r.begin('x1', { name: 'a.txt', size: 1 }).name, 'a (1).txt');
  assert.equal(r.begin('x2', { name: 'a.txt', size: 1 }).name, 'a (2).txt'); // concurrent transfer
  r.write('x1', new Uint8Array([65]).buffer);
  r.write('x2', new Uint8Array([66]).buffer);
  await r.end('x1');
  await r.end('x2');
  assert.deepEqual(visible(), ['a (1).txt', 'a (2).txt', 'a.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'original');
});

test('cancel and incomplete transfers leave nothing behind', async () => {
  const r = new FileReceiver(dir);
  r.begin('c1', { name: 'big.iso', size: 100 });
  r.write('c1', new Uint8Array(10).buffer);
  r.cancel('c1');

  r.begin('c2', { name: 'short.bin', size: 100 });
  r.write('c2', new Uint8Array(10).buffer);
  await assert.rejects(r.end('c2'), /incomplete/);

  r.begin('c3', { name: 'over.bin', size: 2 });
  assert.throws(() => r.write('c3', new Uint8Array(3).buffer), /more data/);
  r.cancel('c3');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('invalid ids and sizes are rejected', () => {
  const r = new FileReceiver(dir);
  assert.throws(() => r.begin('../x', { name: 'a', size: 1 }), /invalid transfer id/);
  assert.throws(() => r.begin('ok', { name: 'a', size: -1 }), /invalid size/);
  assert.throws(() => r.begin('ok2', { name: 'a', size: 1.5 }), /invalid size/);
});
