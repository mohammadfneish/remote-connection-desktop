import { Emitter } from './util.js';
import { SessionShare } from './session-share.js';

const DISCONNECT_GRACE_MS = 10_000;

/**
 * Shared WebRTC plumbing for host and viewer sessions: handshake over the signaling
 * server, ordered processing of SDP/ICE messages, and teardown.
 * Emits 'connected' and 'ended' (reason, { remote }).
 */
export class PeerSession extends Emitter {
  constructor({ sessionId, peerId, signaling }) {
    super();
    this.id = sessionId;
    this.peerId = peerId;
    this.signaling = signaling;
    this.pc = null;
    this.ended = false;
    this.buffered = []; // signals that arrived before the peer connection existed
    this.signalChain = Promise.resolve();
    this.disconnectTimer = null;
    // Clipboard sync + file transfer (channels are attached by the subclasses).
    this.share = new SessionShare({ canReceiveFiles: () => this.canReceiveFiles() });
  }

  canReceiveFiles() {
    return true;
  }

  createPeer(iceServers) {
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;

    pc.onicecandidate = ({ candidate }) => candidate && this.sendSignal({ candidate: candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      clearTimeout(this.disconnectTimer);
      switch (pc.connectionState) {
        case 'connected':
          this.emit('connected');
          break;
        case 'disconnected':
          // Often recovers by itself (Wi-Fi blip); give ICE a moment before giving up.
          this.disconnectTimer = setTimeout(() => this.end('connection-failed'), DISCONNECT_GRACE_MS);
          break;
        case 'failed':
          this.end('connection-failed');
          break;
      }
    };

    for (const data of this.buffered.splice(0)) this.onSignal(data);
    return pc;
  }

  sendSignal(data) {
    this.signaling.send({ type: 'signal', sessionId: this.id, data });
  }

  onSignal(data) {
    if (this.ended) return;
    if (!this.pc) return void this.buffered.push(data);
    this.signalChain = this.signalChain
      .then(() => this.applySignal(data))
      .catch((err) => console.error('signal handling failed:', err.message));
  }

  async applySignal(data) {
    if (this.ended) return;
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.sendSignal({ sdp: this.pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      await this.pc.addIceCandidate(data.candidate);
    }
  }

  /**
   * @param {string} reason
   * @param {{ remote?: boolean }} opts remote=true when the other side/server ended it,
   *        so we don't echo an 'end' back.
   */
  end(reason = 'ended', { remote = false } = {}) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.disconnectTimer);
    if (!remote) this.signaling.send({ type: 'end', sessionId: this.id, reason });
    this.share.close();
    try {
      this.cleanup();
    } catch (err) {
      console.error('cleanup failed', err);
    }
    this.pc?.close();
    this.emit('ended', reason, { remote });
  }

  cleanup() {}
}

/** Picks the selected ICE candidate pair and reports whether it goes through TURN. */
export function selectedRoute(stats) {
  let pair = null;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!pair) stats.forEach((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && (pair = r));
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  return {
    relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
  };
}
