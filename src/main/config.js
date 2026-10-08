import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

const EDITABLE = ['serverUrl', 'deviceName', 'deviceId', 'deviceToken', 'recent'];

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

  get() {
    const { deviceTokenEnc, ...rest } = this.data;
    let deviceToken = rest.deviceToken ?? null;
    if (deviceTokenEnc) {
      try {
        deviceToken = safeStorage.decryptString(Buffer.from(deviceTokenEnc, 'base64'));
      } catch {
        deviceToken = null; // keychain changed; the server will issue a new ID
      }
    }
    return { ...rest, deviceToken };
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}
