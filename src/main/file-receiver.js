import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[\w-]{1,64}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME = 180;

/** Turns a name sent by the remote side into a safe file name (never a path). */
export function safeFileName(name) {
  let base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!base) base = 'file';
  const ext = path.extname(base).slice(0, 20);
  let stem = base.slice(0, base.length - ext.length) || 'file';
  if (RESERVED.test(stem)) stem = `_${stem}`;
  return stem.slice(0, MAX_NAME - ext.length) + ext;
}

/**
 * Writes incoming files into one folder (e.g. Downloads/Remote Connection). Data goes to a
 * hidden `.part` file that is renamed only when complete, and names never overwrite
 * existing files ("report (1).pdf").
 */
export class FileReceiver {
  constructor(dir) {
    this.dir = dir;
    this.active = new Map(); // id -> { stream, partial, final, size, written, error }
    this.completed = new Map(); // id -> final path (for "show in folder")
  }

  begin(id, { name, size }) {
    if (!ID_RE.test(String(id)) || this.active.has(id)) throw new Error('invalid transfer id');
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid size');

    fs.mkdirSync(this.dir, { recursive: true });
    const final = this.uniquePath(safeFileName(name));
    const partial = path.join(this.dir, `.${path.basename(final)}.${id}.part`);
    const stream = fs.createWriteStream(partial, { flags: 'wx' });
    const transfer = { stream, partial, final, size, written: 0, error: null };
    stream.on('error', (err) => (transfer.error = err));
    this.active.set(id, transfer);
    return { name: path.basename(final) };
  }

  write(id, chunk) {
    const t = this.active.get(id);
    if (!t) return;
    if (t.error) throw t.error;
    const buffer = Buffer.from(chunk);
    t.written += buffer.length;
    if (t.written > t.size) throw new Error('more data than announced');
    t.stream.write(buffer);
  }

  async end(id) {
    const t = this.active.get(id);
    if (!t) throw new Error('unknown transfer');
    this.active.delete(id);
    try {
      await new Promise((resolve, reject) => {
        t.stream.once('error', reject);
        t.stream.end(resolve);
      });
      if (t.error) throw t.error;
      if (t.written !== t.size) throw new Error(`incomplete file (${t.written} of ${t.size} bytes)`);
      // The name may have been taken while we were receiving.
      const final = fs.existsSync(t.final) ? this.uniquePath(path.basename(t.final)) : t.final;
      fs.renameSync(t.partial, final);
      this.completed.set(id, final);
      return { path: final, name: path.basename(final) };
    } catch (err) {
      fs.rmSync(t.partial, { force: true });
      throw err;
    }
  }

  cancel(id) {
    const t = this.active.get(id);
    if (!t) return;
    this.active.delete(id);
    t.stream.destroy();
    t.stream.once('close', () => fs.rmSync(t.partial, { force: true }));
    fs.rm(t.partial, { force: true }, () => {});
  }

  cancelAll() {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }

  pathOf(id) {
    return this.completed.get(id) ?? null;
  }

  uniquePath(name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const taken = new Set([...this.active.values()].map((t) => t.final.toLowerCase()));
    for (let n = 0; ; n++) {
      const candidate = path.join(this.dir, n ? `${stem} (${n})${ext}` : name);
      if (!fs.existsSync(candidate) && !taken.has(candidate.toLowerCase())) return candidate;
    }
  }
}
