import { PeerSession, selectedRoute } from './peer.js';
import { captureInput } from './input-capture.js';

/**
 * Viewer side of a session: receives the remote screen and sends local input.
 * Emits 'remote-info' ({ name, platform }), 'screens' ({ list, current }),
 * 'control' (allowed), 'first-frame' and 'stats'.
 */
export class ViewerSession extends PeerSession {
  constructor({ sessionId, targetId, signaling, video, stage }) {
    super({ sessionId, peerId: targetId, signaling });
    this.video = video;
    this.stage = stage;
    this.channel = null;
    this.viewOnly = false;
    this.controlAllowed = true;
    this.detachInput = null;
    this.statsTimer = null;
    this.lastBytes = null;
  }

  /** Called once the host accepted. The host sends the offer; we answer. */
  start(iceServers) {
    const pc = this.createPeer(iceServers);

    pc.ontrack = (event) => {
      // Play frames as soon as they arrive instead of buffering for smoothness.
      try {
        event.receiver.jitterBufferTarget = 0;
      } catch {
        // not supported: keep the default
      }
      this.video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      this.video.addEventListener('loadeddata', () => this.emit('first-frame'), { once: true });
    };

    pc.ondatachannel = ({ channel }) => {
      if (channel.label !== 'control') return;
      this.channel = channel;
      channel.onmessage = (event) => this.onControl(event.data);
    };

    this.detachInput = captureInput({
      stage: this.stage,
      video: this.video,
      send: (event) => this.channel?.readyState === 'open' && this.channel.send(JSON.stringify(event)),
      isActive: () => !this.ended && !this.viewOnly && this.controlAllowed,
    });

    this.statsTimer = setInterval(() => this.collectStats(), 1000);
  }

  onControl(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'hello') this.emit('remote-info', { name: msg.name, platform: msg.platform });
    else if (msg.t === 'screens') this.emit('screens', { list: msg.list, current: msg.current });
    else if (msg.t === 'control') {
      this.controlAllowed = Boolean(msg.allowed);
      this.emit('control', this.controlAllowed);
    }
  }

  selectScreen(id) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ t: 'screen', id }));
  }

  setViewOnly(on) {
    this.viewOnly = on;
  }

  async collectStats() {
    if (!this.pc || this.ended) return;
    const stats = await this.pc.getStats();
    let inbound = null;
    stats.forEach((r) => r.type === 'inbound-rtp' && r.kind === 'video' && (inbound = r));
    const route = selectedRoute(stats);

    let kbps = null;
    if (inbound) {
      if (this.lastBytes) {
        const seconds = (inbound.timestamp - this.lastBytes.timestamp) / 1000;
        if (seconds > 0) kbps = Math.round(((inbound.bytesReceived - this.lastBytes.bytes) * 8) / seconds / 1000);
      }
      this.lastBytes = { bytes: inbound.bytesReceived, timestamp: inbound.timestamp };
    }

    this.emit('stats', {
      fps: inbound?.framesPerSecond ?? null,
      width: inbound?.frameWidth ?? null,
      height: inbound?.frameHeight ?? null,
      kbps,
      rttMs: route?.rttMs ?? null,
      relayed: route?.relayed ?? null,
    });
  }

  cleanup() {
    clearInterval(this.statsTimer);
    this.detachInput?.();
    this.video.srcObject = null;
  }
}
