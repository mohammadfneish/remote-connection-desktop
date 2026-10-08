import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  downloadVerified,
  fetchLatestRelease,
  httpBaseFromServerUrl,
  isDevVersion,
  pickAsset,
  platformKey,
} from '../src/main/update-check.js';

const payload = crypto.randomBytes(300_000);
const sha = crypto.createHash('sha256').update(payload).digest('hex');
let server;
let base;
let dir;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/updates/windows')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version: '0.3.0', url: `${base}/file.exe`, sha256: sha, size: payload.length }));
    }
    if (req.url === '/file.exe') {
      res.writeHead(200, { 'content-length': payload.length });
      return res.end(payload);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-update-'));
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('version comparison matches the server rules', () => {
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc2', '1.0.0-rc1'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(isDevVersion('0.0.0-dev.abc'));
  assert.ok(!isDevVersion('0.2.0'));
});

test('server URL and platform mapping', () => {
  assert.equal(httpBaseFromServerUrl('wss://rdc.novatechsai.com'), 'https://rdc.novatechsai.com');
  assert.equal(httpBaseFromServerUrl('ws://localhost:7070/'), 'http://localhost:7070');
  assert.equal(platformKey('win32'), 'windows');
  assert.equal(platformKey('darwin'), 'mac');
  assert.equal(platformKey('linux'), 'linux');
});

test('pickAsset chooses the build for this architecture and format', () => {
  const release = {
    file: 'RemoteConnection-0.3.0-arm64.dmg',
    url: 'https://cdn/arm64.dmg',
    assets: [
      { file: 'RemoteConnection-0.3.0-arm64.dmg', url: 'https://cdn/arm64.dmg' },
      { file: 'RemoteConnection-0.3.0-x64.dmg', url: 'https://cdn/x64.dmg' },
    ],
  };
  assert.equal(pickAsset(release, { arch: 'x64', preferExt: '.dmg' }).url, 'https://cdn/x64.dmg');
  assert.equal(pickAsset(release, { arch: 'arm64', preferExt: '.dmg' }).url, 'https://cdn/arm64.dmg');

  const linux = {
    file: 'RemoteConnection-0.3.0-x86_64.AppImage',
    url: 'https://cdn/app.AppImage',
    assets: [{ file: 'RemoteConnection-0.3.0-amd64.deb', url: 'https://cdn/app.deb' }],
  };
  assert.equal(pickAsset(linux, { arch: 'x64', preferExt: '.deb' }).url, 'https://cdn/app.deb');
  assert.equal(pickAsset(linux, { arch: 'x64', preferExt: '.appimage' }).url, 'https://cdn/app.AppImage');
});

test('fetchLatestRelease returns the release, or null when none is published', async () => {
  const release = await fetchLatestRelease(base, 'windows');
  assert.equal(release.version, '0.3.0');
  assert.equal(await fetchLatestRelease(base, 'linux'), null);
});

test('downloadVerified writes the file only when the checksum matches', async () => {
  const progress = [];
  const dest = path.join(dir, 'ok.exe');
  const result = await downloadVerified({ url: `${base}/file.exe`, sha256: sha, size: payload.length }, dest, {
    onProgress: (p) => progress.push(p.percent),
  });
  assert.equal(result.sha256, sha);
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.equal(progress.at(-1), 100);

  const bad = path.join(dir, 'bad.exe');
  await assert.rejects(downloadVerified({ url: `${base}/file.exe`, sha256: 'ab'.repeat(32) }, bad), /checksum mismatch/);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(`${bad}.partial`), false);

  const short = path.join(dir, 'short.exe');
  await assert.rejects(downloadVerified({ url: `${base}/file.exe`, size: payload.length + 1 }, short), /incomplete/);
  assert.equal(fs.existsSync(short), false);

  await assert.rejects(downloadVerified({ url: `${base}/missing.exe` }, path.join(dir, 'x')), /HTTP 404/);
});
