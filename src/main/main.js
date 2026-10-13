import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, Notification, safeStorage, screen, session, shell } from 'electron';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { InputInjector } from './input.js';
import { Updater } from './updater.js';
import { ClipboardSync } from './clipboard-sync.js';
import { FileReceiver } from './file-receiver.js';
import { addTrusted, hashPassword, validatePassword, verifyPassword } from './access.js';
import { generateSecret, otpauthUrl, verifyTotp } from './twofa.js';
import { HIDDEN_ARG, setStartAtLogin, startAtLogin } from './autostart.js';
import { AppTray } from './tray.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = require('../../package.json');
const QRCode = require('qrcode');

// Encrypt/decrypt a secret for on-disk storage using the OS keychain when available.
const encryptSecret = (text) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(text).toString('base64')}` : `raw:${Buffer.from(text).toString('base64')}`);
const decryptSecret = (stored) => {
  if (typeof stored !== 'string') return '';
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString();
  return '';
};

// Command line: --profile=<name> --server=<ws url> --connect=<id> --password=<pw> --devtools
const args = Object.fromEntries(
  process.argv
    .map((a) => /^--([\w-]+)(?:=(.*))?$/.exec(a))
    .filter(Boolean)
    .map(([, key, value]) => [key, value ?? true]),
);

// Separate profiles get separate userData, so two instances on one machine get two IDs
// (handy for testing: `npm run desktop` + `npm run desktop:b`).
const profile = args.profile ?? process.env.RC_PROFILE;
if (profile) {
  if (!/^[\w-]{1,32}$/.test(profile)) throw new Error(`invalid profile name: ${profile}`);
  app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()}-${profile}`));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let config = null;
  let input = null;
  let updater = null;
  let clipboardSync = null;
  let files = null;
  let tray = null;
  let quitting = false;
  let shareSourceId = null;
  // When launched at login we open to the tray; the tray icon stays visible either way.
  const startHidden = process.argv.includes(HIDDEN_ARG);

  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.remoteconnection.desktop');
    config = new ConfigStore(app.getPath('userData'), {
      // Set `remoteConnection.defaultServerUrl` in package.json before building installers.
      serverUrl: process.env.RC_SERVER_URL || pkg.remoteConnection?.defaultServerUrl || 'ws://localhost:7070',
      deviceName: os.hostname(),
      deviceId: null,
      recent: [],
      closeToTray: true,
      trusted: [],
    });
    if (typeof args.server === 'string') config.update({ serverUrl: args.server });
    input = new InputInjector();
    clipboardSync = new ClipboardSync({ onChange: (item) => win?.webContents.send('clipboard:changed', item) });
    files = new FileReceiver(path.join(app.getPath('downloads'), 'Remote Connection'));
    updater = new Updater({
      getServerUrl: () => config.get().serverUrl,
      onState: (state) => win?.webContents.send('update:state', state),
      // Packaged builds check automatically; RC_UPDATES=1 enables it in development.
      enabled: app.isPackaged || process.env.RC_UPDATES === '1',
    });

    const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));

    // Fallback capture path (getDisplayMedia): share the source the renderer selected,
    // without showing a picker.
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const source = sources.find((s) => s.id === shareSourceId) ?? sources[0];
      callback(source ? { video: source } : {});
    });

    registerIpc();
    Menu.setApplicationMenu(null);
    tray = new AppTray({
      iconPath: path.join(__dirname, 'icon.png'),
      onOpen: () => showWindow(),
      onCheckUpdates: async () => {
        showWindow();
        const state = await updater.check({ manual: true });
        if (state.status === 'up-to-date') notify(`You're up to date (version ${state.current}).`);
      },
      onQuit: () => app.quit(),
    });
    tray.update({ deviceId: config.get().deviceId, unattended: config.get().unattendedEnabled });
    createWindow();
    updater.start();
  });

  // Don't quit when the window is closed; keep running in the tray so the computer stays
  // reachable. The user quits explicitly from the tray menu.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    updater?.stop();
  });

  function showWindow({ focus = true } = {}) {
    if (!win) createWindow();
    if (win.isMinimized()) win.restore();
    if (focus) {
      win.show();
      win.focus();
    } else if (!win.isVisible()) {
      win.showInactive();
    }
  }

  function notify(body) {
    if (Notification.isSupported()) {
      new Notification({ title: 'Remote Connection', body, icon: path.join(__dirname, 'icon.png') }).show();
    }
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1120,
      height: 740,
      minWidth: 860,
      minHeight: 580,
      title: profile ? `Remote Connection (${profile})` : 'Remote Connection',
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: '#0e1014',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Keep timers and the data channel snappy while hosting from a background window.
        backgroundThrottling: false,
      },
    });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (event, ...legacy) => {
      const message = event.message ?? legacy[1];
      const level = event.level ?? legacy[0];
      if (level === 'error' || level === 3) console.error('[renderer]', message);
      else console.log('[renderer]', message);
    });

    win.once('ready-to-show', () => {
      if (!startHidden) win.show();
    });
    win.on('focus', () => win.flashFrame(false));
    // Closing the window keeps the app in the tray so the computer stays reachable; it only
    // really quits from the tray menu (or when "close to tray" is turned off in Settings).
    win.on('close', (e) => {
      if (quitting || config.internal('closeToTray') === false) return;
      e.preventDefault();
      win.hide();
      if (!config.internal('trayNoticeShown')) {
        config.setInternal({ trayNoticeShown: true });
        notify('Remote Connection is still running in the tray so this computer stays reachable. Right-click the tray icon to quit.');
      }
    });
    win.on('closed', () => {
      win = null;
      input.stop();
      clipboardSync.stop();
      files.cancelAll();
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    if (args.devtools) win.webContents.openDevTools({ mode: 'detach' });
  }

  function registerIpc() {
    const fromWindow = (event) => win && event.sender === win.webContents;

    ipcMain.handle('config:get', () => ({
      ...config.get(),
      platform: process.platform,
      version: app.getVersion(),
      profile: profile ?? null,
      cli: {
        connect: typeof args.connect === 'string' ? args.connect : null,
        password: typeof args.password === 'string' ? args.password : '',
      },
    }));

    ipcMain.handle('config:save', (_e, patch) => {
      const saved = config.update(patch);
      tray?.update({ deviceId: saved.deviceId });
      return saved;
    });

    // ---- background, startup and unattended access.
    // Every one of these is set by the person physically at this computer, in Settings.
    const systemState = () => ({
      startAtLogin: startAtLogin(),
      closeToTray: config.internal('closeToTray') !== false,
      unattendedEnabled: config.get().unattendedEnabled,
      twofaEnabled: Boolean(config.internal('twofa')?.secret),
      trusted: config.internal('trusted') ?? [],
    });
    ipcMain.handle('system:get', () => systemState());
    ipcMain.handle('system:set-start-at-login', (e, on) => {
      if (fromWindow(e)) setStartAtLogin(Boolean(on));
      return systemState();
    });
    ipcMain.handle('system:set-close-to-tray', (e, on) => {
      if (fromWindow(e)) config.setInternal({ closeToTray: Boolean(on) });
      return systemState();
    });

    // Unattended access: a password the local user sets so they can reach their own computer
    // later. Stored only as a salted hash; the renderer never receives it.
    ipcMain.handle('unattended:set', (e, password) => {
      if (!fromWindow(e)) return { error: 'not allowed' };
      const error = validatePassword(password);
      if (error) return { error };
      config.setInternal({ unattended: hashPassword(password) });
      tray?.update({ unattended: true });
      return systemState();
    });
    ipcMain.handle('unattended:disable', (e) => {
      // Turning off the password also turns off its second factor.
      if (fromWindow(e)) config.setInternal({ unattended: null, twofa: null });
      tray?.update({ unattended: false });
      return systemState();
    });

    /**
     * Host-side check of an incoming unattended request. Verifies the password and, when
     * two-factor is enabled, the current authenticator code.
     * @returns { ok, needCode?, badCode? }
     */
    ipcMain.handle('unattended:check', (e, password, code) => {
      if (!fromWindow(e)) return { ok: false };
      if (!verifyPassword(password, config.internal('unattended'))) return { ok: false };
      const secretStored = config.internal('twofa')?.secret;
      if (!secretStored) return { ok: true };
      const secret = decryptSecret(secretStored);
      if (!code) return { ok: false, needCode: true };
      if (secret && verifyTotp(secret, code)) return { ok: true };
      return { ok: false, needCode: true, badCode: true };
    });

    // Two-factor (TOTP) on top of the unattended password. The secret is generated here,
    // shown once as a QR + key for the user's authenticator app, and only persisted after
    // they confirm a valid code.
    let pendingTotpSecret = null;
    ipcMain.handle('twofa:begin', async (e) => {
      if (!fromWindow(e)) return { error: 'not allowed' };
      if (!config.get().unattendedEnabled) return { error: 'Set an unattended password first.' };
      pendingTotpSecret = generateSecret();
      const url = otpauthUrl({ secret: pendingTotpSecret, account: config.get().deviceId ?? 'device' });
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
      return { secret: pendingTotpSecret, qr };
    });
    ipcMain.handle('twofa:enable', (e, code) => {
      if (!fromWindow(e)) return { error: 'not allowed' };
      if (!pendingTotpSecret) return { error: 'Start the setup again.' };
      if (!verifyTotp(pendingTotpSecret, code)) return { error: 'That code is not valid. Check your authenticator app and try again.' };
      config.setInternal({ twofa: { secret: encryptSecret(pendingTotpSecret) } });
      pendingTotpSecret = null;
      return systemState();
    });
    ipcMain.handle('twofa:disable', (e) => {
      if (fromWindow(e)) config.setInternal({ twofa: null });
      pendingTotpSecret = null;
      return systemState();
    });

    // Address book: devices the user saves with a friendly name and, optionally, the remote
    // device's password (encrypted at rest) for one-click connect.
    const publicBook = () =>
      (config.internal('addressBook') ?? []).map((d) => ({ id: d.id, name: d.name, hasPassword: Boolean(d.pw) }));
    ipcMain.handle('addressbook:get', () => publicBook());
    ipcMain.handle('addressbook:save', (e, entry) => {
      if (!fromWindow(e)) return publicBook();
      const id = String(entry?.id ?? '').replace(/\D/g, '');
      if (!/^\d{9}$/.test(id)) return { error: 'Enter a valid 9-digit ID.' };
      const rec = { id, name: String(entry?.name ?? '').slice(0, 64) || `Device ${id}` };
      if (entry?.password) rec.pw = encryptSecret(String(entry.password).slice(0, 128));
      const list = [rec, ...(config.internal('addressBook') ?? []).filter((d) => d.id !== id)].slice(0, 100);
      config.setInternal({ addressBook: list });
      return publicBook();
    });
    ipcMain.handle('addressbook:remove', (e, id) => {
      if (fromWindow(e)) config.setInternal({ addressBook: (config.internal('addressBook') ?? []).filter((d) => d.id !== String(id)) });
      return publicBook();
    });
    // The saved password for an entry, for the renderer to use in the connect request.
    ipcMain.handle('addressbook:password', (e, id) => {
      if (!fromWindow(e)) return '';
      const entry = (config.internal('addressBook') ?? []).find((d) => d.id === String(id));
      return entry?.pw ? decryptSecret(entry.pw) : '';
    });

    // Devices the user chose to trust ("always allow"), so an approved helper isn't
    // re-prompted each time. Removable in Settings.
    ipcMain.handle('trusted:add', (e, device) => {
      if (fromWindow(e)) config.setInternal({ trusted: addTrusted(config.internal('trusted'), device) });
      return systemState();
    });
    ipcMain.handle('trusted:remove', (e, id) => {
      if (fromWindow(e)) config.setInternal({ trusted: (config.internal('trusted') ?? []).filter((d) => d.id !== id) });
      return systemState();
    });

    // Someone connected to this computer. Surface it without covering the desktop — the
    // viewer needs to see and use that screen — so we notify, update the tray, and flash the
    // taskbar instead of raising the window over everything.
    ipcMain.on('session:hosting', (e, info) => {
      if (!fromWindow(e)) return;
      const label = info?.active ? String(info.peer ?? 'Someone').slice(0, 80) : null;
      tray?.update({ connectedTo: label });
      if (label) {
        notify(`${label} is now connected to this computer. Open Remote Connection from the tray to disconnect.`);
        if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
      }
    });

    ipcMain.handle('screen:list', async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const displays = screen.getAllDisplays();
      const primaryId = screen.getPrimaryDisplay().id;
      return sources.map((source, i) => {
        const display = displays.find((d) => String(d.id) === source.display_id) ?? displays[i];
        return {
          sourceId: source.id,
          displayId: display ? String(display.id) : source.display_id,
          name: displays.length > 1 ? `Screen ${i + 1}` : 'Screen',
          primary: display?.id === primaryId,
          width: display ? Math.round(display.size.width * display.scaleFactor) : 1920,
          height: display ? Math.round(display.size.height * display.scaleFactor) : 1080,
        };
      });
    });

    ipcMain.handle('host:share', (_e, sourceId) => {
      shareSourceId = sourceId;
    });
    ipcMain.handle('host:start', (_e, displayId) => input.start(displayId));
    ipcMain.handle('host:set-display', (_e, displayId) => input.setDisplay(displayId));
    ipcMain.handle('host:stop', () => input.stop());
    ipcMain.handle('host:release', () => input.releaseAll());
    ipcMain.handle('input:status', () => input.status());
    ipcMain.on('host:input', (e, event) => fromWindow(e) && input.handle(event));

    ipcMain.on('win:attention', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      if (!win.isFocused()) win.flashFrame(true);
    });
    ipcMain.on('win:fullscreen', (_e, on) => win?.setFullScreen(Boolean(on)));
    ipcMain.on('log', (_e, line) => console.log('[app]', line));

    // Clipboard sync: watched only while a session is active.
    ipcMain.handle('clipboard:watch', (e, on) => {
      if (!fromWindow(e)) return;
      if (on) clipboardSync.start();
      else clipboardSync.stop();
    });
    ipcMain.handle('clipboard:write', (e, item) => fromWindow(e) && clipboardSync.write(item));

    // Incoming files are written to Downloads/Remote Connection.
    ipcMain.handle('files:begin', (e, id, info) => {
      if (!fromWindow(e)) throw new Error('not allowed');
      return files.begin(id, { name: info?.name, size: Number(info?.size) });
    });
    ipcMain.on('files:chunk', (e, id, chunk) => {
      if (!fromWindow(e)) return;
      try {
        files.write(id, chunk);
      } catch (err) {
        console.error('[files] write failed:', err.message);
        files.cancel(id); // the following files:end then fails and the sender is told
      }
    });
    ipcMain.handle('files:end', async (e, id) => {
      if (!fromWindow(e)) throw new Error('not allowed');
      const { name } = await files.end(id);
      return { name };
    });
    ipcMain.handle('files:cancel', (e, id) => fromWindow(e) && files.cancel(id));
    ipcMain.handle('files:reveal', (e, id) => {
      const file = fromWindow(e) && files.pathOf(id);
      if (file) shell.showItemInFolder(file);
    });

    ipcMain.handle('update:get-state', () => updater.state);
    ipcMain.handle('update:check', () => updater.check({ manual: true }));
    ipcMain.handle('update:install', (e) => fromWindow(e) && updater.install());
  }
}
