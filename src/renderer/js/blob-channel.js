/**
 * Sends and receives arbitrarily large payloads (files, clipboard images) over one
 * RTCDataChannel, one transfer at a time, in chunks with backpressure.
 *
 * Wire format (in order on a reliable, ordered channel):
 *   { t: 'begin', id, size, meta }   JSON text frame
 *   <binary chunk> ...                ArrayBuffer frames for the current transfer
 *   { t: 'end', id }                  sender finished
 *   { t: 'done', id }                 receiver stored it (acknowledgement)
 *   { t: 'cancel', id, reason }       either side aborts
 *
 * Kept free of DOM/Electron APIs so it can be unit-tested with a fake channel.
 */

// Chromium accepts data channel messages up to 256 KiB, and both ends are always our
// Electron app; larger chunks are ~35% faster than 64 KiB ones.
export const CHUNK_SIZE = 256 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

export class TransferCancelled extends Error {
  constructor(reason = 'cancelled') {
    super(reason);
    this.reason = reason;
  }
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class BlobChannel {
  /**
   * @param {RTCDataChannel} channel
   * @param {{ onIncoming?: (begin: {id, size, meta}) => Promise<Sink|null> | Sink | null }} options
   *   onIncoming returns a sink { write(ArrayBuffer), end(), abort(reason) } or null to refuse.
   */
  constructor(channel, { onIncoming } = {}) {
    this.channel = channel;
    this.onIncoming = onIncoming;
    this.queue = [];
    this.sending = null;
    this.awaitingAck = new Map(); // id -> job
    this.incoming = null;
    this.tail = Promise.resolve(); // previous incoming transfer fully stored or aborted
    this.closed = false;

    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.addEventListener('message', (event) => this.onMessage(event.data));
    channel.addEventListener('close', () => this.close('closed'));
  }

  /**
   * Queues `blob` for sending. Returns { id, done: Promise, cancel() }.
   * `done` resolves once the receiver confirmed it, or rejects with TransferCancelled.
   */
  send(blob, meta = {}, { onProgress } = {}) {
    const job = { id: newId(), blob, meta, onProgress, cancelled: null };
    job.done = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    job.done.catch(() => {}); // callers that don't await shouldn't trigger unhandled rejections

    if (this.closed) job.reject(new TransferCancelled('closed'));
    else {
      this.queue.push(job);
      this.pump();
    }
    return { id: job.id, done: job.done, cancel: (reason = 'cancelled') => this.cancel(job.id, reason) };
  }

  /** Cancels an outgoing or incoming transfer by id. */
  cancel(id, reason = 'cancelled') {
    const queued = this.queue.findIndex((j) => j.id === id);
    if (queued >= 0) {
      this.queue.splice(queued, 1)[0].reject(new TransferCancelled(reason));
      return;
    }
    if (this.sending?.id === id) {
      this.sending.cancelled = reason; // the pump loop notices and tells the peer
      return;
    }
    const waiting = this.awaitingAck.get(id);
    if (waiting) {
      this.awaitingAck.delete(id);
      this.sendJson({ t: 'cancel', id, reason });
      waiting.reject(new TransferCancelled(reason));
      return;
    }
    if (this.incoming?.id === id) {
      this.sendJson({ t: 'cancel', id, reason });
      this.abortIncoming(reason);
    }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new TransferCancelled(reason));
    if (this.sending) this.sending.cancelled = reason;
    for (const job of this.awaitingAck.values()) job.reject(new TransferCancelled(reason));
    this.awaitingAck.clear();
    this.abortIncoming(reason);
  }

  // ---------------------------------------------------------------- sending

  async pump() {
    if (this.sending || this.closed) return;
    this.sending = true; // claim the pump before yielding
    await Promise.resolve(); // let send() return its handle before callbacks run
    while (this.queue.length && !this.closed) {
      const job = this.queue.shift();
      this.sending = job;
      try {
        await this.transmit(job);
      } catch (err) {
        job.reject(err instanceof TransferCancelled ? err : new TransferCancelled(err.message || 'failed'));
      }
    }
    this.sending = null;
  }

  async transmit(job) {
    const size = job.blob.size;
    this.sendJson({ t: 'begin', id: job.id, size, meta: job.meta });

    let offset = 0;
    job.onProgress?.(0, size);
    while (offset < size) {
      if (job.cancelled) break;
      const chunk = await job.blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      await this.drain();
      if (job.cancelled) break;
      this.channel.send(chunk);
      offset += chunk.byteLength;
      job.onProgress?.(offset, size);
    }

    if (job.cancelled) {
      if (!this.closed && job.cancelled !== 'remote') this.sendJson({ t: 'cancel', id: job.id, reason: job.cancelled });
      throw new TransferCancelled(job.cancelled === 'remote' ? job.remoteReason : job.cancelled);
    }
    this.awaitingAck.set(job.id, job);
    this.sendJson({ t: 'end', id: job.id });
  }

  /** Waits until the channel's send buffer has room, so big files don't fill memory. */
  drain() {
    if (this.channel.readyState !== 'open') return Promise.reject(new TransferCancelled('closed'));
    if (this.channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done);
        this.channel.removeEventListener('close', done);
        if (this.channel.readyState === 'open') resolve();
        else reject(new TransferCancelled('closed'));
      };
      this.channel.addEventListener('bufferedamountlow', done);
      this.channel.addEventListener('close', done);
    });
  }

  sendJson(msg) {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------- receiving

  onMessage(data) {
    if (typeof data !== 'string') return this.onChunk(data);

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'begin':
        return this.onBegin(msg);
      case 'end':
        return this.onEnd(msg.id);
      case 'done': {
        const job = this.awaitingAck.get(msg.id);
        this.awaitingAck.delete(msg.id);
        return job?.resolve();
      }
      case 'cancel':
        return this.onRemoteCancel(msg.id, msg.reason);
    }
  }

  onBegin({ id, size, meta }) {
    if (this.incoming) this.abortIncoming('superseded');
    const incoming = { id, size: Number(size) || 0, meta: meta ?? {}, received: 0, failed: null };
    incoming.finished = new Promise((resolve) => (incoming.finish = resolve));

    // Sinks run strictly one after another (a later clipboard update must not land before
    // an earlier one), and chunks are chained behind the possibly async sink creation.
    incoming.chain = this.tail
      .then(() => (incoming.failed ? null : this.onIncoming?.({ id, size: incoming.size, meta: incoming.meta })))
      .then((sink) => {
        if (!sink) throw new TransferCancelled(incoming.failed || 'refused');
        incoming.sink = sink;
        return sink;
      });
    incoming.chain.catch((err) => this.failIncoming(incoming, err));
    this.tail = incoming.finished;
    this.incoming = incoming;
  }

  onChunk(buffer) {
    const incoming = this.incoming;
    if (!incoming || incoming.failed) return; // after a cancel, in-flight chunks are dropped
    incoming.received += buffer.byteLength;
    if (incoming.received > incoming.size) return this.failIncoming(incoming, new TransferCancelled('too-large'));
    incoming.chain = incoming.chain.then(async (sink) => {
      if (!incoming.failed) await sink.write(buffer); // skip queued writes once cancelled
      return sink;
    });
    incoming.chain.catch((err) => this.failIncoming(incoming, err));
  }

  onEnd(id) {
    const incoming = this.incoming;
    if (!incoming || incoming.id !== id || incoming.failed) return;
    this.incoming = null;
    if (incoming.received !== incoming.size) return this.failIncoming(incoming, new TransferCancelled('incomplete'));
    incoming.chain
      .then((sink) => sink.end())
      .then(() => {
        this.sendJson({ t: 'done', id });
        incoming.finish();
      })
      .catch((err) => this.failIncoming(incoming, err));
  }

  onRemoteCancel(id, reason = 'cancelled') {
    if (this.sending?.id === id) {
      this.sending.cancelled = 'remote';
      this.sending.remoteReason = reason;
    }
    const waiting = this.awaitingAck.get(id);
    if (waiting) {
      this.awaitingAck.delete(id);
      waiting.reject(new TransferCancelled(reason));
    }
    if (this.incoming?.id === id) this.abortIncoming(reason);
  }

  /** Receiver-side failure: tell the sender and clean up. */
  failIncoming(incoming, err) {
    if (incoming.failed) return;
    incoming.failed = err.reason || err.message || 'failed';
    if (this.incoming === incoming) this.incoming = null;
    this.sendJson({ t: 'cancel', id: incoming.id, reason: incoming.failed });
    this.finishAborted(incoming);
  }

  abortIncoming(reason) {
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = null;
    incoming.failed = reason;
    this.finishAborted(incoming);
  }

  finishAborted(incoming) {
    incoming.chain
      .then((sink) => sink.abort?.(incoming.failed))
      .catch(() => incoming.sink?.abort?.(incoming.failed))
      .finally(() => incoming.finish());
  }
}
