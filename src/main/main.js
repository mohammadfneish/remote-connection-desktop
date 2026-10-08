import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, screen, session } from 'electron';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { InputInjector } from './input.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = createRequire(import.meta.url)('../../package.json');

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
  let shareSourceId = null;

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.remoteconnection.desktop');
    config = new ConfigStore(app.getPath('userData'), {
      // Set `remoteConnection.defaultServerUrl` in package.json before building installers.
      serverUrl: process.env.RC_SERVER_URL || pkg.remoteConnection?.defaultServerUrl || 'ws://localhost:7070',
      deviceName: os.hostname(),
      deviceId: null,
      recent: [],
    });
    if (typeof args.server === 'string') config.update({ serverUrl: args.server });
    input = new InputInjector();

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
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

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

    win.once('ready-to-show', () => win.show());
    win.on('focus', () => win.flashFrame(false));
    win.on('closed', () => {
      win = null;
      input.stop();
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

    ipcMain.handle('config:save', (_e, patch) => config.update(patch));

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
  }
}
