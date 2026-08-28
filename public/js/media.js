/**
 * public/js/media.js — local devices: microphone, camera, screen share.
 *
 * BoltCall never asks for a name. Every participant appears as
 * config.room.memberName ("thamjj13") — the server enforces that label,
 * and here we additionally try to push it into the local media tracks
 * (where supported) so it matches inside the user's own OS indicators.
 *
 * Screen sharing: the display video track is a SEPARATE outgoing track
 * (its own transceiver in every peer connection), so camera and screen
 * can both be live at once — in both directions.
 */

const MEMBER_NAME = 'thamjj13';

class LocalMedia {
  constructor() {
    this.camStream = null; // audio + camera video (one stream)
    this.screenStream = null;
    this.screenTrack = null;
    this.micOn = true;
    this.camOn = true;
    this.screenOn = false;
    this.started = false;
    /** @type {(state: {mic:boolean, cam:boolean, screen:boolean}) => void} */
    this.onChange = null;
    /** Called when the screen share ends from the browser side. */
    this.onScreenEnd = null;
  }

  /** Try camera+mic; fall back to mic-only; never throws for missing devices. */
  async start() {
    this.started = true;
    try {
      this.camStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }
      });
    } catch (err) {
      this.camStream = null;
      if (!(err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError'))) {
        throw err; // unexpected failure — surface it
      }
      // Camera refused or missing — try microphone alone so the user can
      // still speak and hear the call.
      try {
        this.camStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
        this.camOn = false;
      } catch {
        // no devices at all — user can still watch, chat and share screen
        this.micOn = false;
        this.camOn = false;
      }
    }

    this.#applyDisplayName(this.camStream);
    if (this.camStream && this.camStream.getVideoTracks().length === 0) this.camOn = false;
    return this.camStream;
  }

  /** Push "thamjj13" into track labels where the browser supports it. */
  async #applyDisplayName(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        await track.applyConstraints({ displayName: MEMBER_NAME });
      } catch {
        /* not supported by this browser — the server-side label still holds */
      }
    }
  }

  audioTrack() {
    return this.camStream ? this.camStream.getAudioTracks()[0] || null : null;
  }

  camTrack() {
    return this.camStream ? this.camStream.getVideoTracks()[0] || null : null;
  }

  screenVideoTrack() {
    return this.screenTrack;
  }

  hasDevices() {
    return !!this.camStream;
  }

  async toggleMic() {
    this.micOn = !this.micOn;
    const track = this.audioTrack();
    if (track) track.enabled = this.micOn;
    this.#notify();
    return this.micOn;
  }

  async toggleCam() {
    this.camOn = !this.camOn;
    const track = this.camTrack();
    if (track) track.enabled = this.camOn;
    this.#notify();
    return this.camOn;
  }

  /**
   * Start/stop screen sharing. `replaceInMesh(track|null)` is a callback
   * the mesh provides so the new track lands in every peer connection.
   */
  async toggleScreen(replaceInMesh) {
    if (!this.screenOn) {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15 } },
        audio: false // voice keeps flowing through the microphone
      });
      this.screenStream = stream;
      this.screenTrack = stream.getVideoTracks()[0];
      this.screenOn = true;

      // The browser's "Stop sharing" button ends the track from outside.
      this.screenTrack.addEventListener('ended', () => this.stopScreen(replaceInMesh));
      replaceInMesh(this.screenTrack);
    } else {
      this.stopScreen(replaceInMesh);
    }
    this.#notify();
    return this.screenOn;
  }

  stopScreen(replaceInMesh) {
    if (!this.screenOn) return;
    this.screenOn = false;
    const track = this.screenTrack;
    this.screenTrack = null;
    if (track) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      this.screenStream = null;
    }
    if (replaceInMesh) replaceInMesh(null);
    this.#notify();
    if (this.onScreenEnd) this.onScreenEnd();
  }

  get state() {
    return { mic: this.micOn, cam: this.camOn, screen: this.screenOn };
  }

  #notify() {
    if (this.onChange) this.onChange(this.state);
  }

  stopAll() {
    for (const stream of [this.camStream, this.screenStream]) {
      if (!stream) continue;
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.camStream = null;
    this.screenStream = null;
    this.screenTrack = null;
    this.screenOn = false;
    this.started = false;
  }
}

export const media = new LocalMedia();
