import crypto from 'node:crypto';
import { clipboard, ClipboardItem } from 'electron';

const POLL_MS = 800;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const hash = (data) => crypto.createHash('sha1').update(data).digest('hex');

/**
 * Watches the local clipboard while a session is active (there is no change event, so it
 * polls) and applies clipboard content received from the remote side.
 *
 * Only changes made *after* watching starts are reported, so whatever was copied before the
 * session is never sent. Text wins over images, because apps like Excel put both on the
 * clipboard and the text is what people expect to paste.
 *
 * Electron 44's clipboard API is asynchronous (W3C style), so polls and writes run through
 * one queue: a remote write can never interleave with a poll and be echoed back.
 */
export class ClipboardSync {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.timer = null;
    this.last = null;
    this.queue = Promise.resolve();
  }

  get watching() {
    return Boolean(this.timer);
  }

  serial(task) {
    const run = this.queue.then(task);
    this.queue = run.catch((err) => console.warn('[clipboard]', err.message));
    return run;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.serial(() => this.poll()), POLL_MS);
    // Baseline first: the queue guarantees no poll runs before it.
    return this.serial(async () => {
      this.last = (await this.snapshot()).sig;
    });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Current clipboard content and a fingerprint of it. */
  async snapshot() {
    const text = await clipboard.readText();
    if (text) return { sig: `text:${hash(text)}`, item: { kind: 'text', text } };

    for (const entry of await clipboard.read()) {
      if (!entry.types.includes('image/png')) continue;
      const png = Buffer.from(await (await entry.getType('image/png')).arrayBuffer());
      if (png.length) return { sig: `image:${hash(png)}`, item: { kind: 'image', png } };
    }
    return { sig: 'empty', item: null };
  }

  async poll() {
    if (!this.timer) return;
    const { sig, item } = await this.snapshot();
    if (sig === this.last) return;
    this.last = sig;
    if (!item) return;
    if (item.kind === 'text' && Buffer.byteLength(item.text) > MAX_TEXT_BYTES) return;
    if (item.kind === 'image' && item.png.length > MAX_IMAGE_BYTES) return;
    this.onChange(item);
  }

  /** Puts remote content on the local clipboard without echoing it back. */
  write(item) {
    return this.serial(async () => {
      if (item?.kind === 'text' && typeof item.text === 'string') {
        if (Buffer.byteLength(item.text) > MAX_TEXT_BYTES) return false;
        await clipboard.writeText(item.text);
      } else if (item?.kind === 'image' && item.png?.length) {
        if (item.png.length > MAX_IMAGE_BYTES) return false;
        const blob = new Blob([Buffer.from(item.png)], { type: 'image/png' });
        await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } else {
        return false;
      }
      this.last = (await this.snapshot()).sig;
      return true;
    });
  }
}
