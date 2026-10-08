// Update helpers without Electron dependencies (unit-tested with plain Node).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';

/** The download folder name for this OS, matching the server's /api/updates/<os>. */
export function platformKey(platform = process.platform) {
  return { win32: 'windows', darwin: 'mac', linux: 'linux' }[platform] ?? null;
}

/** wss://host[/…] -> https://host (the signaling server also hosts the website and update API). */
export function httpBaseFromServerUrl(serverUrl) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  return url.origin;
}

/**
 * Numeric dotted-version comparison; a pre-release (1.2.0-rc1) sorts below its release.
 * Same rules as the server and the NovaTech POS update check.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Dev builds (0.0.0-*, *-dev) never report updates. */
export const isDevVersion = (v) => /^0\.0\.0|dev/i.test(String(v));

/**
 * Asks the server for the latest release of this OS.
 * @returns {Promise<object|null>} the release, or null when nothing is published
 */
export async function fetchLatestRelease(httpBase, os, { timeoutMs = 10_000, userAgent } = {}) {
  const res = await fetch(`${httpBase}/api/updates/${os}?t=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache', ...(userAgent ? { 'user-agent': userAgent } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`update server answered HTTP ${res.status}`);
  const release = await res.json();
  if (!release?.version || !release?.url) throw new Error('update server sent an invalid release');
  return release;
}

/** Picks the build that fits this machine (e.g. the arm64 dmg on Apple silicon). */
export function pickAsset(release, { arch = process.arch, preferExt } = {}) {
  const all = [release, ...(release.assets ?? [])].filter((a) => a?.url);
  const byExt = preferExt ? all.filter((a) => (a.file ?? a.url).toLowerCase().endsWith(preferExt)) : all;
  const pool = byExt.length ? byExt : all;
  const archNames = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64', 'amd64'];
  return pool.find((a) => archNames.some((n) => (a.file ?? a.url).toLowerCase().includes(n))) ?? pool[0];
}

/**
 * Downloads `asset.url` to `dest`, verifying the SHA-256 when the manifest has one.
 * The file only appears at `dest` once it is complete and verified.
 */
export async function downloadVerified(asset, dest, { onProgress, signal } = {}) {
  const partial = `${dest}.partial`;
  const res = await fetch(asset.url, { signal });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partial);
  let received = 0;
  let lastReport = 0;

  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && (now - lastReport > 200 || received === total)) {
        lastReport = now;
        onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw err;
  }

  const digest = hash.digest('hex');
  if (asset.sha256 && digest !== asset.sha256.toLowerCase()) {
    fs.rmSync(partial, { force: true });
    throw new Error('downloaded file is corrupted (checksum mismatch)');
  }
  if (asset.size && received !== asset.size) {
    fs.rmSync(partial, { force: true });
    throw new Error(`downloaded file is incomplete (${received} of ${asset.size} bytes)`);
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(partial, dest);
  return { path: dest, sha256: digest, size: received };
}
