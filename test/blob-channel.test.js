import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BlobChannel, CHUNK_SIZE, TransferCancelled } from '../src/renderer/js/blob-channel.js';

/** In-memory RTCDataChannel pair with a simulated send buffer (bufferedAmount). */
class FakeChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.maxBuffered = 0;
    this.peer = null;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('channel closed');
    const size = typeof data === 'string' ? data.length : data.byteLength;
    const copy = typeof data === 'string' ? data : data.slice(0);
    this.bufferedAmount += size;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    setImmediate(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event('bufferedamountlow'));
      }
      if (this.peer.readyState !== 'open') return;
      const event = new Event('message');
      event.data = copy;
      this.peer.dispatchEvent(event);
    });
  }

  close() {
    for (const ch of [this, this.peer]) {
      if (ch.readyState === 'closed') continue;
      ch.readyState = 'closed';
      ch.dispatchEvent(new Event('close'));
    }
  }
}

function pair() {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Sink that collects bytes in memory, optionally slowly. */
function memorySink({ delayMs = 0 } = {}) {
  const sink = {
    parts: [],
    ended: false,
    aborted: null,
    async write(buffer) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      sink.parts.push(Buffer.from(buffer));
    },
    async end() {
      sink.ended = true;
    },
    abort(reason) {
      sink.aborted = reason;
    },
    bytes: () => Buffer.concat(sink.parts),
  };
  return sink;
}

const randomBlob = (size) => {
  const bytes = crypto.randomBytes(size);
  return { blob: new Blob([bytes]), bytes };
};

test('a large payload arrives intact with progress and an acknowledgement', async () => {
  const [a, b] = pair();
  const sinks = [];
  const sender = new BlobChannel(a);
  new BlobChannel(b, {
    onIncoming: async (begin) => {
      assert.deepEqual(begin.meta, { kind: 'file', name: 'video.mp4' });
      const sink = memorySink();
      sinks.push(sink);
      return sink;
    },
  });

  const { blob, bytes } = randomBlob(10 * CHUNK_SIZE + 123);
  const progress = [];
  await sender.send(blob, { kind: 'file', name: 'video.mp4' }, { onProgress: (sent, total) => progress.push([sent, total]) }).done;

  assert.equal(sinks.length, 1);
  assert.ok(sinks[0].ended);
  assert.ok(sinks[0].bytes().equals(bytes));
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
});

test('queued transfers arrive in order, even with a slow sink', async () => {
  const [a, b] = pair();
  const received = [];
  const sender = new BlobChannel(a);
  new BlobChannel(b, {
    onIncoming: (begin) => {
      const sink = memorySink({ delayMs: 1 });
      const end = sink.end;
      sink.end = async () => {
        await end();
        received.push([begin.meta.n, sink.bytes()]);
      };
      return sink;
    },
  });

  const payloads = [randomBlob(3 * CHUNK_SIZE), randomBlob(10), randomBlob(0), randomBlob(CHUNK_SIZE + 1)];
  await Promise.all(payloads.map((p, n) => sender.send(p.blob, { n }).done));
  assert.deepEqual(received.map(([n]) => n), [0, 1, 2, 3]);
  received.forEach(([n, bytes]) => assert.ok(bytes.equals(payloads[n].bytes), `payload ${n}`));
});

test('the send buffer stays bounded (backpressure)', async () => {
  const [a, b] = pair();
  const sender = new BlobChannel(a);
  new BlobChannel(b, { onIncoming: () => memorySink() });
  await sender.send(randomBlob(12 * 1024 * 1024).blob).done;
  assert.ok(a.maxBuffered <= 4 * 1024 * 1024 + CHUNK_SIZE, `max buffered ${a.maxBuffered}`);
});

test('a refused transfer rejects on the sender and the next one still works', async () => {
  const [a, b] = pair();
  const sender = new BlobChannel(a);
  new BlobChannel(b, { onIncoming: (begin) => (begin.meta.ok ? memorySink() : null) });

  await assert.rejects(sender.send(randomBlob(5 * CHUNK_SIZE).blob, { ok: false }).done, (err) => {
    assert.ok(err instanceof TransferCancelled);
    assert.equal(err.reason, 'refused');
    return true;
  });
  await sender.send(randomBlob(100).blob, { ok: true }).done;
});

test('sender cancel aborts the receiver sink', async () => {
  const [a, b] = pair();
  const sink = memorySink({ delayMs: 2 });
  const sender = new BlobChannel(a);
  new BlobChannel(b, { onIncoming: () => sink });

  const transfer = sender.send(randomBlob(40 * CHUNK_SIZE).blob, {}, {
    onProgress: (sent) => sent >= 5 * CHUNK_SIZE && transfer.cancel('user'),
  });
  await assert.rejects(transfer.done, /user/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sink.ended, false);
  assert.equal(sink.aborted, 'user');
});

test('receiver cancel stops the sender; later transfers are unaffected', async () => {
  const [a, b] = pair();
  const sender = new BlobChannel(a);
  let receiver;
  const sinks = [];
  receiver = new BlobChannel(b, {
    onIncoming: (begin) => {
      const sink = memorySink();
      sinks.push(sink);
      if (begin.meta.cancel) setTimeout(() => receiver.cancel(begin.id, 'declined'), 1);
      return sink;
    },
  });

  const big = sender.send(randomBlob(200 * CHUNK_SIZE).blob, { cancel: true });
  const next = randomBlob(2 * CHUNK_SIZE);
  const small = sender.send(next.blob, { cancel: false });

  await assert.rejects(big.done, /declined/);
  await small.done;
  assert.equal(sinks[0].aborted, 'declined');
  assert.ok(sinks[1].bytes().equals(next.bytes));
});

test('closing the channel rejects everything pending', async () => {
  const [a, b] = pair();
  const sender = new BlobChannel(a);
  const sink = memorySink({ delayMs: 5 });
  const write = sink.write;
  // Close mid-transfer, once the receiver has started storing data.
  sink.write = async (buffer) => {
    if (!sink.parts.length) setTimeout(() => a.close(), 0);
    return write(buffer);
  };
  new BlobChannel(b, { onIncoming: () => sink });

  // Larger than the send buffer, so the sender is still streaming when the channel closes.
  const first = sender.send(randomBlob(200 * CHUNK_SIZE).blob);
  const second = sender.send(randomBlob(10).blob);

  await assert.rejects(first.done, TransferCancelled);
  await assert.rejects(second.done, TransferCancelled);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sink.ended, false);
  assert.ok(sink.aborted);
  await assert.rejects(sender.send(randomBlob(1).blob).done, TransferCancelled);
});

test('a sink write failure is reported back to the sender', async () => {
  const [a, b] = pair();
  const sender = new BlobChannel(a);
  new BlobChannel(b, {
    onIncoming: () => ({
      write: async () => {
        throw new Error('disk full');
      },
      end: async () => {},
      abort: () => {},
    }),
  });
  await assert.rejects(sender.send(randomBlob(3 * CHUNK_SIZE).blob).done, /disk full/);
});
