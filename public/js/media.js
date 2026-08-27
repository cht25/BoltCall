/**
 * public/js/media.js
 * ───────────────────────────────────────────────────────────────────────
 * মিডিয়া অ্যাবস্ট্র্যাকশন: WebRTC peer connection + MediaRecorder ভয়েস মেসেজ।
 *
 * গুরুত্বপূর্ণ WebRTC ক্রম (সার্ভার call-handlers এর সাথে মিলে):
 *   1) getUserMedia → স্থানীয় ট্র্যাক পাওয়া
 *   2) RTCPeerConnection তৈরি + সব লোকাল ট্র্যাক addTrack করা
 *   3) createOffer → setLocalDescription → সার্ভারে offer পাঠানো
 *   (offer এর আগে ট্র্যাক যোগ করা বাধ্যতামূলক — এটি না করলে ক্যালিতে মিডিয়া যাবে না)
 *
 * ICE candidate গুলো remote description সেট হওয়ার আগে queue-এ রাখা হয়
 * (addIceCandidate remoteDescription-এর পরেই কাজ করে)।
 */

import { api } from './api.js';

let iceServersCache = null;

export async function getIceServers() {
  if (iceServersCache) return iceServersCache;
  try {
    const data = await api.webrtc.iceServers();
    iceServersCache = Array.isArray(data && data.iceServers) ? data.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch {
    iceServersCache = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  return iceServersCache;
}

export function clearIceCache() {
  iceServersCache = null;
}

export class CallConnection {
  constructor({ iceServers, onIceCandidate, onTrack, onConnectionState, onStats }) {
    this.peer = new RTCPeerConnection({ iceServers });
    this.localStream = null;
    this.candidateQueue = [];
    this.remoteSet = false;
    this.onIceCandidate = onIceCandidate; // ({candidate}) => void
    this.onTrack = onTrack; // (MediaStream) => void
    this.onConnectionState = onConnectionState; // (state) => void
    this.onStats = onStats; // ({incoming, outgoing}) => void
    this._statsTimer = null;

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate && this.onIceCandidate({ candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
      }
    };
    this.peer.ontrack = (event) => {
      const stream = event.streams[0];
      this.onTrack && this.onTrack(stream);
    };
    this.peer.onconnectionstatechange = () => {
      const state = this.peer.connectionState;
      this.onConnectionState && this.onConnectionState(state);
      if (state === 'connected') this._startStats();
      if (['failed', 'closed', 'disconnected'].includes(state)) this._stopStats();
    };
  }

  setLocalStream(stream) {
    this.localStream = stream;
    if (stream) {
      stream.getTracks().forEach((track) => this.peer.addTrack(track, stream)); // step 2: tracks first
    }
  }

  async createOffer() {
    const offer = await this.peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await this.peer.setLocalDescription(offer);
    return offer;
  }

  async createAnswer() {
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    return answer;
  }

  async setRemoteDescription(description) {
    await this.peer.setRemoteDescription(new RTCSessionDescription(description));
    this.remoteSet = true;
    // queue করা ICE candidate গুলো এখন যোগ করা যাবে
    while (this.candidateQueue.length) {
      const c = this.candidateQueue.shift();
      try {
        await this.peer.addIceCandidate(c && c.candidate ? new RTCIceCandidate(c.candidate) : c);
      } catch (err) {
        console.warn('ICE add error', err);
      }
    }
  }

  async addRemoteCandidate(candidate) {
    if (!candidate) return;
    if (!this.remoteSet) {
      this.candidateQueue.push(candidate); // remote description আসার আগে জমা রাখি
      return;
    }
    try {
      await this.peer.addIceCandidate(candidate.candidate ? new RTCIceCandidate(candidate.candidate) : candidate);
    } catch (err) {
      console.warn('ICE add error', err);
    }
  }

  replaceVideoTrack(stream) {
    const sender = this.peer.getSenders().find((s) => s.track && s.track.kind === 'video');
    const newTrack = stream.getVideoTracks()[0];
    if (sender && newTrack) sender.replaceTrack(newTrack);
  }

  toggleAudio(enabled) {
    if (this.localStream) this.localStream.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  toggleVideo(enabled) {
    if (this.localStream) this.localStream.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }

  _startStats() {
    if (this._statsTimer) return;
    this._statsTimer = setInterval(async () => {
      if (!this.peer || this.peer.connectionState !== 'connected') return;
      try {
        const stats = await this.peer.getStats();
        let incoming = 0;
        let outgoing = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp') incoming += report.bytesReceived || 0;
          if (report.type === 'outbound-rtp') outgoing += report.bytesSent || 0;
        });
        this.onStats && this.onStats({ incoming, outgoing });
      } catch {
        /* ignore */
      }
    }, 1000);
  }

  _stopStats() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  close() {
    this._stopStats();
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.peer) {
      this.peer.onicecandidate = null;
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      try {
        this.peer.close();
      } catch {
        /* ignore */
      }
    }
    this.peer = null;
    this.candidateQueue = [];
  }
}

// ══════════════ MEDIA HELPERS ══════════════
export async function getUserMedia(constraints) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('এই ব্রাউজারে ক্যামেরা/মাইক সাপোর্ট করে না');
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

export function attachStream(videoEl, stream) {
  if (!videoEl) return;
  if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
}

// ══════════════ VOICE RECORDER (MediaRecorder) ══════════════
export class VoiceRecorder {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.startTime = 0;
    this.onTick = null;
    this._timer = null;
  }

  async start({ mimeType = 'audio/webm' } = {}) {
    if (this.recorder) throw new Error('ইতিমধ্যে রেকর্ডিং চলছে');
    this.stream = await getUserMedia({ audio: true });
    let options = {};
    if (typeof MediaRecorder !== 'undefined') {
      const candidates = [mimeType, 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      options = { mimeType: candidates.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '' };
    }
    this.recorder = new MediaRecorder(this.stream, options);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.startTime = Date.now();
    this._timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.onTick && this.onTick(elapsed);
    }, 200);
  }

  async stop() {
    if (!this.recorder) return null;
    clearInterval(this._timer);
    const recorder = this.recorder;
    const stream = this.stream;
    const chunks = this.chunks;
    const stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    stopStream(stream);
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    return { blob, duration: Math.floor((Date.now() - this.startTime) / 1000) };
  }

  cancel() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    clearInterval(this._timer);
    if (this.stream) stopStream(this.stream);
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }
}
