import { Emitter } from './util.js';

const MAX_BACKOFF_MS = 30_000;

/**
 * WebSocket connection to the signaling server with automatic reconnect.
 * Emits 'state' ('connecting' | 'online' | 'offline') and one event per server
 * message type ('welcome', 'incoming', 'signal', ...).
 */
export class SignalingClient extends Emitter {
  constructor({ url, identity }) {
    super();
    this.url = url;
    this.identity = identity; // () => hello payload
    this.ws = null;
    this.state = 'offline';
    this.backoff = 1000;
    this.retryTimer = null;
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.setState('connecting');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.error('invalid server URL', this.url, err.message);
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', ...this.identity() }));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.backoff = 1000;
        this.setState('online');
      }
      this.emit(msg.type, msg);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      this.setState('offline');
      this.emit('disconnected');
      // 4001: another instance with our ID took over; don't fight over it.
      if (event.code !== 4001) this.scheduleReconnect();
    };
  }

  setUrl(url) {
    this.url = url;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.emit('disconnected');
    this.connect();
  }

  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN || this.state !== 'online') return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }
}
