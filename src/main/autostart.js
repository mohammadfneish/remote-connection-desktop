import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

// When launched at login the app opens straight to the tray instead of popping a window,
// but the tray icon is always shown so the computer's user can see it is running.
export const HIDDEN_ARG = '--hidden';

const linuxEntry = () => path.join(os.homedir(), '.config', 'autostart', 'remote-connection.desktop');

/**
 * Start-at-login, per platform:
 *   Windows / macOS  Electron login items
 *   Linux            ~/.config/autostart entry (freedesktop standard)
 * Microsoft Store builds are managed by Windows itself (Settings > Apps > Startup).
 */
export function startAtLogin() {
  if (process.windowsStore) {
    return { supported: false, enabled: false, reason: 'Manage this in Windows Settings › Apps › Startup.' };
  }
  if (!app.isPackaged) return { supported: false, enabled: false, reason: 'Available in the installed app.' };
  if (process.platform === 'linux') return { supported: true, enabled: fs.existsSync(linuxEntry()) };
  const { openAtLogin } = app.getLoginItemSettings({ args: [HIDDEN_ARG] });
  return { supported: true, enabled: openAtLogin };
}

export function setStartAtLogin(enabled) {
  const status = startAtLogin();
  if (!status.supported) return status;

  if (process.platform === 'linux') {
    const file = linuxEntry();
    if (enabled) {
      // An AppImage must be re-launched through the .AppImage file, not the unpacked binary.
      const exec = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        ['[Desktop Entry]', 'Type=Application', 'Name=Remote Connection', `Exec="${exec}" ${HIDDEN_ARG}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n'),
      );
    } else {
      fs.rmSync(file, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: [HIDDEN_ARG] });
  }
  return startAtLogin();
}
