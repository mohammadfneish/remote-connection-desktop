import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  compareVersions,
  downloadVerified,
  fetchLatestRelease,
  httpBaseFromServerUrl,
  isDevVersion,
  pickAsset,
  platformKey,
} from './update-check.js';

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Checks the server's /api/updates/<os> (fed by latest.json on the CDN, like NovaTech POS)
 * and installs new versions on request:
 *   Windows       download + verify the NSIS installer, run it silently, relaunch
 *   Linux AppImage download + verify, swap the AppImage file in place, relaunch
 *   macOS / other  open the matching download in the browser (unsigned apps can't self-update)
 *
 * State pushed to the UI via onState():
 *   { status: 'idle'|'checking'|'up-to-date'|'available'|'downloading'|'installing'|'error',
 *     current, release?, progress?, error?, canInstall, checkedAt? }
 */
export class Updater {
  constructor({ getServerUrl, onState, enabled = app.isPackaged }) {
    this.getServerUrl = getServerUrl;
    this.onState = onState;
    this.enabled = enabled && !isDevVersion(app.getVersion());
    this.os = platformKey();
    this.timer = null;
    this.state = { status: 'idle', current: app.getVersion(), canInstall: this.canInstall() };
  }

  canInstall() {
    return process.platform === 'win32' || Boolean(process.env.APPIMAGE);
  }

  start() {
    if (!this.enabled || !this.os) return;
    this.timer = setTimeout(() => {
      this.check();
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  async check({ manual = false } = {}) {
    if (!this.os) return this.state;
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    if (!this.enabled && !manual) return this.state;

    this.set({ status: 'checking', error: undefined });
    try {
      const release = await fetchLatestRelease(httpBaseFromServerUrl(this.getServerUrl()), this.os, {
        userAgent: `RemoteConnection/${app.getVersion()} (${process.platform}; ${process.arch})`,
      });
      const newer = release && !isDevVersion(app.getVersion()) && compareVersions(release.version, app.getVersion()) > 0;
      this.set({ status: newer ? 'available' : 'up-to-date', release: newer ? release : undefined, checkedAt: new Date().toISOString() });
      if (newer) console.log(`[update] ${release.version} available (current ${app.getVersion()})`);
    } catch (err) {
      console.warn('[update] check failed:', err.message);
      // Background failures stay silent; only a manual check reports them.
      this.set(manual ? { status: 'error', error: `Couldn't check for updates: ${err.message}` } : { status: 'idle' });
    }
    return this.state;
  }

  async install() {
    const release = this.state.release;
    if (!release || this.state.status === 'downloading' || this.state.status === 'installing') return;

    if (!this.canInstall()) {
      const preferExt = process.platform === 'darwin' ? '.dmg' : '.deb';
      await shell.openExternal(pickAsset(release, { preferExt }).url);
      return;
    }

    try {
      if (process.platform === 'win32') await this.installWindows(release);
      else await this.installAppImage(release);
    } catch (err) {
      console.error('[update] install failed:', err);
      this.set({ status: 'error', error: `Update failed: ${err.message}` });
    }
  }

  async download(asset, dest) {
    if (!asset.sha256) throw new Error('the release has no checksum; download it from the website instead');
    this.set({ status: 'downloading', progress: { percent: 0 } });
    await downloadVerified(asset, dest, { onProgress: (progress) => this.set({ progress }) });
  }

  async installWindows(release) {
    const asset = pickAsset(release, { preferExt: '.exe' });
    const dir = path.join(app.getPath('temp'), 'RemoteConnection-update');
    fs.mkdirSync(dir, { recursive: true });
    const installer = path.join(dir, path.basename(asset.file ?? 'setup.exe'));
    await this.download(asset, installer);

    this.set({ status: 'installing' });
    // electron-builder NSIS: /S = silent, --updated = upgrade in place, --force-run = start
    // the app again when done. The installer closes this instance itself.
    spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 500);
  }

  async installAppImage(release) {
    const target = process.env.APPIMAGE;
    const asset = pickAsset(release, { preferExt: '.appimage' });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.update`);
    await this.download(asset, temp);

    this.set({ status: 'installing' });
    fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, target); // atomic on the same filesystem; the running image stays mapped
    app.relaunch({ execPath: target, args: process.argv.slice(1) });
    app.exit(0);
  }
}
