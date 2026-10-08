import { PeerSession } from './peer.js';

const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1600;
const MAX_FPS = 30;
const MAX_BITRATE = 8_000_000;
const INPUT_TYPES = new Set(['mm', 'md', 'mu', 'wh', 'kd', 'ku']);

/**
 * Host side of a session: captures a screen, streams it to the viewer and replays the
 * viewer's input (through the main process) while control is allowed.
 *
 * Control channel messages (JSON over the 'control' data channel):
 *   host -> viewer: { t: 'hello', name, platform }, { t: 'screens', list, current },
 *                   { t: 'control', allowed }
 *   viewer -> host: input events (see main/input.js), { t: 'screen', id }
 * Clipboard and files use their own channels (see session-share.js).
 */
export class HostSession extends PeerSession {
  constructor({ sessionId, peer, signaling, iceServers, device, allowControl = true }) {
    super({ sessionId, peerId: peer.id, signaling });
    this.peer = peer;
    this.iceServers = iceServers;
    this.device = device;
    this.allowControl = allowControl;
    this.screens = [];
    this.current = null;
    this.stream = null;
    this.sender = null;
    this.channel = null;
  }

  async start() {
    this.screens = await window.rc.listScreens();
    if (!this.screens.length) throw new Error('no screens available to share');
    this.current = this.screens.find((s) => s.primary) ?? this.screens[0];
    this.stream = await captureScreen(this.current);
    if (this.ended) return this.stopStream();

    const pc = this.createPeer(this.iceServers);
    const track = this.stream.getVideoTracks()[0];
    track.contentHint = 'detail'; // favor sharp text over smooth motion
    track.onended = () => this.end('capture-failed');
    this.sender = pc.addTrack(track, this.stream);

    this.channel = pc.createDataChannel('control', { ordered: true });
    this.channel.onopen = () => {
      this.sendControl({ t: 'hello', name: this.device.name, platform: this.device.platform });
      this.sendScreens();
      this.sendControl({ t: 'control', allowed: this.allowControl });
    };
    this.channel.onmessage = (event) => this.onControl(event.data);
    this.share.attach(pc.createDataChannel('clipboard', { ordered: true }));
    this.share.attach(pc.createDataChannel('files', { ordered: true }));

    await window.rc.host.start(this.current.displayId);
    await pc.setLocalDescription(await pc.createOffer());
    this.sendSignal({ sdp: pc.localDescription.toJSON() });
    await this.tuneSender();
  }

  async tuneSender() {
    const params = this.sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_BITRATE;
    params.encodings[0].maxFramerate = MAX_FPS;
    params.degradationPreference = 'maintain-resolution';
    try {
      await this.sender.setParameters(params);
    } catch (err) {
      console.warn('could not tune video sender:', err.message);
    }
  }

  onControl(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (INPUT_TYPES.has(msg.t)) {
      if (this.allowControl) window.rc.host.input(msg);
    } else if (msg.t === 'screen') {
      this.switchScreen(msg.id).catch((err) => console.error('screen switch failed:', err.message));
    }
  }

  async switchScreen(displayId) {
    const next = this.screens.find((s) => s.displayId === displayId);
    if (!next || next === this.current || this.ended) return;

    const stream = await captureScreen(next);
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => this.end('capture-failed');
    await this.sender.replaceTrack(track); // no renegotiation needed
    this.stopStream();
    this.stream = stream;
    this.current = next;
    await window.rc.host.setDisplay(next.displayId);
    this.sendScreens();
  }

  // A view-only viewer can't drop files onto this computer.
  canReceiveFiles() {
    return this.allowControl;
  }

  setAllowControl(allowed) {
    this.allowControl = allowed;
    if (!allowed) window.rc.host.release(); // don't leave keys/buttons held down
    this.sendControl({ t: 'control', allowed });
  }

  sendScreens() {
    this.sendControl({
      t: 'screens',
      list: this.screens.map(({ displayId, name, primary }) => ({ id: displayId, name, primary })),
      current: this.current.displayId,
    });
  }

  sendControl(msg) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(msg));
  }

  stopStream() {
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
  }

  cleanup() {
    this.stopStream();
    window.rc.host.stop();
  }
}

/** Captures a whole screen without showing a picker. */
async function captureScreen(screen) {
  const scale = Math.min(1, MAX_WIDTH / screen.width, MAX_HEIGHT / screen.height);
  const width = Math.round(screen.width * scale);
  const height = Math.round(screen.height * scale);
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screen.sourceId,
          maxWidth: width,
          maxHeight: height,
          maxFrameRate: MAX_FPS,
        },
      },
    });
  } catch (err) {
    // Newer path: main's display-media handler hands over the selected source.
    console.warn('desktop getUserMedia failed, falling back to getDisplayMedia:', err.message);
    await window.rc.host.share(screen.sourceId);
    return navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { width: { max: width }, height: { max: height }, frameRate: { max: MAX_FPS } },
    });
  }
}
