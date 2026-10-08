import { BlobChannel } from './blob-channel.js';
import { Emitter } from './util.js';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PROGRESS_EVERY_MS = 150;

const REASON_TEXT = {
  cancelled: 'Cancelled',
  refused: 'Not accepted by the other side',
  closed: 'Connection closed',
  superseded: 'Interrupted',
  incomplete: 'Transfer incomplete',
};

/**
 * Clipboard sync and file transfer for one session, over two extra data channels
 * ('clipboard' and 'files') so big transfers never delay mouse/keyboard input.
 * Both peers run the same code, so everything works in both directions.
 *
 * Emits 'transfer' with a snapshot { key, id, direction: 'in'|'out', name, size, done,
 * status: 'active'|'done'|'cancelled'|'failed', message?, canReveal } on every change.
 */
export class SessionShare extends Emitter {
  constructor({ canReceiveFiles = () => true } = {}) {
    super();
    this.canReceiveFiles = canReceiveFiles;
    this.clipboardEnabled = true;
    this.clip = null;
    this.files = null;
    this.channels = {};
    this.lastClipboardSend = null;
    this.transfers = new Map();
  }

  /** Called with each RTCDataChannel; picks up the ones this class owns. */
  attach(channel) {
    if (channel.label === 'clipboard') {
      this.channels.clipboard = channel;
      this.clip = new BlobChannel(channel, { onIncoming: (begin) => this.incomingClipboard(begin) });
    } else if (channel.label === 'files') {
      this.channels.files = channel;
      this.files = new BlobChannel(channel, { onIncoming: (begin) => this.incomingFile(begin) });
    } else {
      return false;
    }
    channel.addEventListener('open', () => this.emit('ready'));
    return true;
  }

  get filesReady() {
    return this.channels.files?.readyState === 'open';
  }

  close() {
    this.clip?.close('closed');
    this.files?.close('closed');
  }

  // ---------------------------------------------------------------- clipboard

  setClipboardEnabled(on) {
    this.clipboardEnabled = Boolean(on);
  }

  /** Local clipboard changed: send it, replacing any clipboard still in flight. */
  localClipboard(item) {
    if (!this.clipboardEnabled || this.channels.clipboard?.readyState !== 'open') return;
    this.lastClipboardSend?.cancel('superseded');
    const blob = item.kind === 'text' ? new Blob([item.text]) : new Blob([item.png], { type: 'image/png' });
    this.lastClipboardSend = this.clip.send(blob, { kind: item.kind });
  }

  incomingClipboard({ size, meta }) {
    if (!this.clipboardEnabled) return null;
    if (meta.kind === 'text' ? size > MAX_TEXT_BYTES : meta.kind !== 'image' || size > MAX_IMAGE_BYTES) return null;
    const parts = [];
    return {
      write: (buffer) => parts.push(buffer),
      end: async () => {
        const blob = new Blob(parts);
        if (meta.kind === 'text') await window.rc.clipboard.write({ kind: 'text', text: await blob.text() });
        else await window.rc.clipboard.write({ kind: 'image', png: new Uint8Array(await blob.arrayBuffer()) });
        this.emit('clipboard-received', meta.kind);
      },
      abort: () => (parts.length = 0),
    };
  }

  // ---------------------------------------------------------------- files

  /** Sends files (File objects from a picker or drag & drop). */
  sendFiles(files) {
    if (!this.files || !this.filesReady) return false;
    for (const file of files) {
      const transfer = this.track({ direction: 'out', name: file.name, size: file.size });
      const handle = this.files.send(file, { kind: 'file', name: file.name, mime: file.type }, {
        onProgress: (sent) => this.progress(transfer, sent),
      });
      transfer.id = handle.id;
      transfer.cancel = () => {
        transfer.cancelledHere = true;
        handle.cancel('cancelled');
      };
      handle.done
        .then(() => this.finish(transfer, 'done'))
        .catch((err) => this.finish(transfer, err.reason === 'cancelled' && transfer.cancelledHere ? 'cancelled' : 'failed', err.reason));
    }
    return true;
  }

  async incomingFile({ id, size, meta }) {
    if (meta.kind !== 'file' || !this.canReceiveFiles()) return null;
    const { name } = await window.rc.files.begin(id, { name: meta.name, size });
    const transfer = this.track({ id, direction: 'in', name, size });
    transfer.cancel = () => {
      transfer.cancelledHere = true;
      this.files.cancel(id, 'cancelled');
    };
    let received = 0;
    return {
      write: (buffer) => {
        window.rc.files.chunk(id, buffer);
        received += buffer.byteLength;
        this.progress(transfer, received);
      },
      end: async () => {
        await window.rc.files.end(id);
        transfer.canReveal = true;
        this.finish(transfer, 'done');
      },
      abort: (reason) => {
        window.rc.files.cancel(id);
        this.finish(transfer, transfer.cancelledHere ? 'cancelled' : 'failed', reason);
      },
    };
  }

  cancelTransfer(key) {
    this.transfers.get(key)?.cancel?.();
  }

  // ---------------------------------------------------------------- bookkeeping

  track({ id = null, direction, name, size }) {
    const transfer = { key: `${direction}:${Math.random().toString(36).slice(2)}`, id, direction, name, size, done: 0, status: 'active', lastEmit: 0 };
    this.transfers.set(transfer.key, transfer);
    this.publish(transfer);
    return transfer;
  }

  progress(transfer, done) {
    transfer.done = done;
    const now = Date.now();
    if (now - transfer.lastEmit >= PROGRESS_EVERY_MS || done === transfer.size) {
      transfer.lastEmit = now;
      this.publish(transfer);
    }
  }

  finish(transfer, status, reason) {
    if (transfer.status !== 'active') return;
    transfer.status = status;
    if (status === 'done') transfer.done = transfer.size;
    else if (status !== 'cancelled') transfer.message = REASON_TEXT[reason] ?? reason ?? 'Failed';
    this.publish(transfer);
    this.transfers.delete(transfer.key);
  }

  publish(t) {
    this.emit('transfer', {
      key: t.key,
      id: t.id,
      direction: t.direction,
      name: t.name,
      size: t.size,
      done: t.done,
      status: t.status,
      message: t.message,
      canReveal: Boolean(t.canReveal),
    });
  }
}
