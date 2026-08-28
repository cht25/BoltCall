/**
 * public/js/peers.js — full-mesh WebRTC manager.
 *
 * Every participant holds ONE RTCPeerConnection to every other
 * participant. Media (voice, video, screen) flows peer-to-peer in both
 * directions; the Socket.IO server only relays SDP/ICE.
 *
 * Transceiver convention — both sides add transceivers in the same order,
 * and WebRTC pairs transceivers positionally, so index → kind is stable:
 *   0 → audio (microphone)
 *   1 → camera video
 *   2 → screen-share video (created lazily when sharing starts)
 *
 * Negotiation uses the "perfect negotiation" pattern plus one refinement:
 * only the member with the smaller id initiates the FIRST connection, so
 * initial handshakes never race. A watchdog re-arms lost offers, and dead
 * ('failed') connections are rebuilt automatically.
 */

import { media } from './media.js';

const STUCK_MS = 10000; // a peer that never negotiated within this is re-armed
const MAX_RECREATES = 3; // then give up and mark the tile "connecting"

const KIND_BY_POSITION = ['audio', 'cam', 'screen'];

export class Mesh {
  /**
   * @param {object} opts
   * @param {string} opts.selfId
   * @param {import('socket.io-client').Socket} opts.socket
   * @param {object[]} opts.iceServers
   * @param {(peerId: string, kind: 'audio'|'cam'|'screen', stream: MediaStream) => void} opts.onRemoteTrack
   * @param {(peerId: string, status: 'connecting'|'connected'|'failed'|'left') => void} opts.onPeerStatus
   */
  constructor({ selfId, socket, iceServers, onRemoteTrack, onPeerStatus }) {
    this.selfId = selfId;
    this.socket = socket;
    this.iceServers = iceServers;
    this.onRemoteTrack = onRemoteTrack;
    this.onPeerStatus = onPeerStatus;
    this.peers = new Map(); // peerId → peer
  }

  /** Diff the roster: create missing peers, drop peers that left. */
  sync(participantIds) {
    const wanted = new Set(participantIds.filter((id) => id !== this.selfId));
    for (const id of wanted) {
      if (!this.peers.has(id)) this.#createPeer(id);
    }
    for (const [id] of this.peers) {
      if (!wanted.has(id)) this.dropPeer(id);
    }
  }

  /** Dispatch a Socket.IO signaling event. */
  handle(type, data) {
    const from = data && typeof data.from === 'string' ? data.from : '';
    if (!from || from === this.selfId) return;
    const peer = this.#ensurePeer(from);

    if (type === 'webrtc:offer') this.#handleOffer(peer, data.sdp).catch(() => {});
    else if (type === 'webrtc:answer') this.#handleAnswer(peer, data.sdp).catch(() => {});
    else if (type === 'webrtc:ice') this.#handleIce(peer, data.candidate).catch(() => {});
  }

  #send(peerId, event, payload) {
    this.socket.emit(event, { target: peerId, ...payload });
  }

  /** Create a peer connection and wire its state machine. */
  #createPeer(peerId) {
    const polite = this.selfId > peerId; // larger id yields on collisions
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    const peer = {
      id: peerId,
      pc,
      polite,
      makingOffer: false,
      // Until the first offer arrives, the responder suppresses its own
      // offer so the initial connection never races.
      waitForOffer: polite,
      negotiated: false,
      closed: false,
      recreateCount: 0,
      pendingCandidates: [], // ICE may arrive before the remote description
      screenTransceiver: null, // our own send-side screen transceiver
      stuckTimer: null
    };

    pc.onicecandidate = (event) => {
      if (peer.closed) return;
      this.#send(peerId, 'webrtc:ice', { candidate: event.candidate || null });
    };

    pc.onnegotiationneeded = () => {
      this.#makeOffer(peer).catch(() => {});
    };

    pc.ontrack = (event) => {
      if (peer.closed) return;
      // Positional pairing: the index of the receiving transceiver tells
      // what the remote side is sending on it (see header comment).
      const index = pc.getTransceivers().indexOf(event.transceiver);
      const kind = event.track.kind === 'audio' ? 'audio' : KIND_BY_POSITION[index] || 'cam';
      const stream =
        event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      this.onRemoteTrack(peerId, kind, stream);
    };

    pc.onconnectionstatechange = () => {
      if (peer.closed) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.#clearStuck(peer);
        this.onPeerStatus(peerId, 'connected');
      } else if (state === 'connecting') {
        this.#clearStuck(peer);
        this.onPeerStatus(peerId, 'connecting');
      } else if (state === 'failed') {
        this.#recreate(peer);
      }
    };

    // Watchdog: covers lost offers/answers and peers that never connect.
    peer.stuckTimer = setTimeout(() => {
      if (peer.closed || peer.negotiated || pc.connectionState !== 'new') return;
      if (peer.waitForOffer) {
        // The initiator never showed up — stop waiting and initiate.
        peer.waitForOffer = false;
        this.#makeOffer(peer).catch(() => {});
      } else if (pc.signalingState === 'stable') {
        // Our offer got lost — retry.
        this.#makeOffer(peer).catch(() => {});
      } else {
        // Half-open state — start fresh.
        this.#recreate(peer);
      }
    }, STUCK_MS);

    this.peers.set(peerId, peer);
    this.#addLocalTracks(peer);
    return peer;
  }

  #ensurePeer(peerId) {
    return this.peers.get(peerId) || this.#createPeer(peerId);
  }

  /** Add/replace the local screen track in every peer connection. */
  replaceScreenTrack(track) {
    for (const peer of this.peers.values()) {
      if (peer.closed) continue;
      if (peer.screenTransceiver) {
        peer.screenTransceiver.sender.replaceTrack(track).catch(() => {});
      } else if (track) {
        const sender = peer.pc.addTrack(track, media.screenStream);
        peer.screenTransceiver = peer.pc.getTransceivers().find((t) => t.sender === sender) || null;
      }
    }
  }

  /** Add local mic/camera/screen tracks to a (new) peer connection. */
  #addLocalTracks(peer) {
    const camStream = media.camStream;
    if (!camStream) return;

    const audioTrack = camStream.getAudioTracks()[0];
    const camTrack = camStream.getVideoTracks()[0];
    if (audioTrack) peer.pc.addTrack(audioTrack, camStream);
    if (camTrack) peer.pc.addTrack(camTrack, camStream);
    if (media.screenOn && media.screenTrack) {
      const sender = peer.pc.addTrack(media.screenTrack, media.screenStream);
      peer.screenTransceiver = peer.pc.getTransceivers().find((t) => t.sender === sender) || null;
    }
    peer.localTracksAdded = true;
  }

  /**
   * Called when local media becomes available AFTER peers were created
   * (e.g. the permission prompt took a while). Adds the tracks and lets
   * negotiationneeded fire so every existing connection starts carrying
   * audio/video.
   */
  refreshLocalTracks() {
    if (!media.camStream) return;
    for (const peer of this.peers.values()) {
      if (!peer.closed && !peer.localTracksAdded) this.#addLocalTracks(peer);
    }
  }

  /** Perfect-negotiation offer creation. */
  async #makeOffer(peer) {
    if (peer.closed) return;
    if (peer.waitForOffer && !peer.negotiated) return; // responder holds off
    if (peer.makingOffer) return;
    if (peer.pc.signalingState !== 'stable') return;

    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      this.#send(peer.id, 'webrtc:offer', { sdp: peer.pc.localDescription });
    } catch (err) {
      if (peer.pc.signalingState === 'stable') throw err;
      // otherwise a benign race with an incoming description
    } finally {
      peer.makingOffer = false;
    }
  }

  async #handleOffer(peer, sdp) {
    if (peer.closed || !sdp || sdp.type !== 'offer') return;
    try {
      const readyForOffer = !peer.makingOffer && peer.pc.signalingState === 'stable';
      const offerCollision = !readyForOffer;
      // Per the perfect-negotiation pattern, the polite side rolls back
      // (implicitly, via setRemoteDescription) and answers; the impolite
      // side ignores the colliding offer.
      if (!peer.polite && offerCollision) return;

      peer.waitForOffer = false;
      await peer.pc.setRemoteDescription(sdp);
      this.#flushCandidates(peer);

      await peer.pc.setLocalDescription();
      this.#send(peer.id, 'webrtc:answer', { sdp: peer.pc.localDescription });
      peer.negotiated = true;
      this.#clearStuck(peer);
    } catch (err) {
      if (peer.pc.signalingState === 'stable') throw err;
      // otherwise a collision — let it converge
    }
  }

  async #handleAnswer(peer, sdp) {
    if (peer.closed || !sdp || sdp.type !== 'answer') return;
    if (peer.pc.signalingState !== 'have-local-offer') return;
    await peer.pc.setRemoteDescription(sdp);
    this.#flushCandidates(peer);
    peer.negotiated = true;
    this.#clearStuck(peer);
  }

  async #handleIce(peer, candidate) {
    if (peer.closed) return;
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate); // flush once the remote description lands
      return;
    }
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch {
      /* stale candidate — ignore */
    }
  }

  #flushCandidates(peer) {
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      if (candidate) peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  #clearStuck(peer) {
    if (peer.stuckTimer) {
      clearTimeout(peer.stuckTimer);
      peer.stuckTimer = null;
    }
  }

  #recreate(peer) {
    if (peer.closed) return;
    if (peer.recreateCount >= MAX_RECREATES) {
      this.onPeerStatus(peer.id, 'failed');
      return;
    }
    peer.recreateCount += 1;
    this.dropPeer(peer.id, { quiet: true });
    this.#createPeer(peer.id);
  }

  dropPeer(peerId, { quiet = false } = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.closed = true;
    this.#clearStuck(peer);
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
    this.peers.delete(peerId);
    if (!quiet) this.onPeerStatus(peerId, 'left');
  }

  destroy() {
    for (const id of Array.from(this.peers.keys())) {
      this.dropPeer(id, { quiet: true });
    }
  }
}
