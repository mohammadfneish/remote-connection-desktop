import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

// Fields the UI may change through config:save. Security-sensitive fields (the unattended
// password hash, trusted devices, tray preferences) are only changed by dedicated
// main-process handlers, never directly by the renderer.
const EDITABLE = ['serverUrl', 'deviceName', 'deviceId', 'deviceToken', 'recent'];
const INTERNAL = ['unattended', 'twofa', 'trusted', 'addressBook', 'closeToTray', 'trayNoticeShown'];

/**
 * Small JSON settings file in the profile's userData directory. The device token
 * (proof of ownership of our ID) is encrypted with the OS keychain when available.
 */
export class ConfigStore {
  constructor(dir, defaults) {
    this.file = path.join(dir, 'config.json');
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run or unreadable file: start from defaults
    }
    this.data = { ...defaults, ...saved };
  }

  /** What the UI may see: never the token ciphertext nor the unattended password hash. */
  get() {
    const { deviceTokenEnc, unattended, ...rest } = this.data;
    let deviceToken = rest.deviceToken ?? null;
    if (deviceTokenEnc) {
      try {
        deviceToken = safeStorage.decryptString(Buffer.from(deviceTokenEnc, 'base64'));
      } catch {
        deviceToken = null; // keychain changed; the server will issue a new ID
      }
    }
    // Only whether an unattended password exists, not the hash itself.
    return { ...rest, deviceToken, unattendedEnabled: Boolean(unattended?.hash) };
  }

  /** Reads a main-process-only field (never sent to the renderer). */
  internal(key) {
    return this.data[key];
  }

  /** Writes main-process-only fields, from trusted main-process code only. */
  setInternal(patch = {}) {
    for (const key of INTERNAL) if (key in patch) this.data[key] = patch[key];
    this.save();
    return this.get();
  }

  update(patch = {}) {
    for (const key of EDITABLE) {
      if (!(key in patch)) continue;
      if (key === 'deviceToken') {
        delete this.data.deviceToken;
        delete this.data.deviceTokenEnc;
        if (!patch.deviceToken) continue;
        if (safeStorage.isEncryptionAvailable()) {
          this.data.deviceTokenEnc = safeStorage.encryptString(patch.deviceToken).toString('base64');
        } else {
          this.data.deviceToken = patch.deviceToken;
        }
      } else {
        this.data[key] = patch[key];
      }
    }
    this.save();
    return this.get();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
