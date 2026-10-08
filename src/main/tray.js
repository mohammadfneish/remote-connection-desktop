import { Menu, nativeImage, Tray } from 'electron';

const formatId = (id) => String(id ?? '').replace(/(\d{3})(?=\d)/g, '$1 ');

/**
 * Tray icon, shown the whole time the app runs. It makes a background-running app visible
 * to the person at the computer, shows this device's ID, and — while someone is connected —
 * says so plainly, so a session is never hidden from whoever is sitting there.
 */
export class AppTray {
  constructor({ iconPath, onOpen, onCheckUpdates, onQuit }) {
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16, quality: 'best' });
    this.tray = new Tray(image);
    this.actions = { onOpen, onCheckUpdates, onQuit };
    this.status = { deviceId: null, connectedTo: null, unattended: false };
    this.tray.on('click', () => onOpen());
    this.render();
  }

  update(patch) {
    this.status = { ...this.status, ...patch };
    this.render();
  }

  render() {
    const { deviceId, connectedTo, unattended } = this.status;
    const lines = ['Remote Connection'];
    if (connectedTo) lines.push(`${connectedTo} is connected to this computer`);
    else if (deviceId) lines.push(`ID ${formatId(deviceId)}`);
    this.tray.setToolTip(lines.join('\n'));

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: deviceId ? `Your ID: ${formatId(deviceId)}` : 'Connecting…', enabled: false },
        ...(connectedTo ? [{ label: `● Connected: ${connectedTo}`, enabled: false }] : []),
        { label: unattended ? 'Unattended access: on' : 'Unattended access: off', enabled: false },
        { type: 'separator' },
        { label: 'Open Remote Connection', click: this.actions.onOpen },
        { label: 'Check for updates', click: this.actions.onCheckUpdates },
        { type: 'separator' },
        { label: 'Quit', click: this.actions.onQuit },
      ]),
    );
  }

  destroy() {
    this.tray.destroy();
  }
}
