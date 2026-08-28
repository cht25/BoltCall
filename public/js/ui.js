/**
 * public/js/ui.js — DOM rendering: participant tiles, chat, toasts, controls,
 * spotlight layout, floating self-view, per-tile fullscreen, mini call view.
 *
 * Layout rules (WhatsApp-style):
 *   • 2 people            → the remote participant fills the stage, your own
 *                           camera floats as a small draggable popup.
 *   • someone shares      → their screen fills the stage (or their tile) and
 *                           their camera shrinks to a floating inset on top.
 *   • click a tile        → pin/unpin it as the full-screen spotlight.
 *   • double-click / ⤢    → true fullscreen of that camera or screen share.
 *
 * Every tile <video> is always muted — voice comes from a separate hidden
 * Audio element per peer (see app.js), so your own mic can never loop
 * back through the page.
 */

import { el, escapeHtml, fmtTime, fmtDay } from './utils.js';

// ── tiny inline-SVG badge factory ────────────────────────────────────
const BADGE_ICONS = {
  micOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" x2="12" y1="18" y2="22"/><line x1="2.5" y1="2.5" x2="21.5" y2="21.5"/></svg>',
  camOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 8l-6 4 6 4V8z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/><line x1="2.5" y1="2.5" x2="21.5" y2="21.5"/></svg>',
  screen:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  expand:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>'
};

class UI {
  constructor() {
    this.tiles = new Map(); // memberId → tile refs
    this.memberName = 'thamjj13';
    this.selfId = null;
    this.chatOpen = true;
    this.unread = 0;
    this.lastDay = null;
    this.historyIds = new Set();
    this.manualSpotlightId = null;
    this.lastMedia = new Map(); // memberId → last media state {mic,cam,screen}
    this.count = 0;
    this.max = 0;
    // mini floating call view
    this.miniOpen = false;
    this._miniTimer = null;
    // callbacks wired by app.js
    this.onHangup = null;
  }

  loading(show) {
    const loader = document.getElementById('appLoader');
    loader.hidden = !show;
  }

  // ══════════════════════ screens ══════════════════════

  showJoin() {
    document.getElementById('joinScreen').hidden = false;
    document.getElementById('roomScreen').hidden = true;
    document.getElementById('joinPassword').focus();
  }

  /** Show a hint when the visitor arrived through a /call/… share link. */
  setInviteMode(invited) {
    const note = document.getElementById('inviteNote');
    if (note) note.hidden = !invited;
  }

  showRoom() {
    document.getElementById('joinScreen').hidden = true;
    document.getElementById('roomScreen').hidden = false;
    document.getElementById('roomEmpty').hidden = false;
    this.setChatOpen(true);
  }

  /** Clear all room state (tiles, chat) — used when leaving. */
  resetRoom() {
    for (const id of Array.from(this.tiles.keys())) this.removeTile(id);
    this.tiles.clear();
    this.lastMedia.clear();
    this.manualSpotlightId = null;
    const messages = document.getElementById('chatMessages');
    messages.textContent = '';
    this.historyIds.clear();
    this.lastDay = null;
    this.unread = 0;
    this.#updateUnread();
    this.setControlState('mic', true);
    this.setControlState('cam', true);
    this.setControlState('screen', false);
    this.closeMini();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  joinError(message) {
    const box = document.getElementById('joinError');
    box.textContent = message;
    box.hidden = !message;
  }

  /** Visible hint shown only in development with the default password. */
  setDevHint(password) {
    const box = document.getElementById('devPasswordHint');
    if (!box) return;
    box.hidden = !password;
    if (password) box.textContent = `Development mode — default password: ${password}`;
  }

  joinBusy(busy) {
    const button = document.getElementById('joinButton');
    button.disabled = busy;
    button.querySelector('.btn-label').textContent = busy ? 'Joining…' : 'Join the call';
  }

  setRoomName(name) {
    document.getElementById('roomName').textContent = name;
  }

  setCount(count, max) {
    this.count = count;
    this.max = max;
    const label = `${count} in the call`;
    document.getElementById('participantCount').textContent = max ? `${label} · max ${max}` : label;
    const miniCount = document.getElementById('miniCount');
    if (miniCount) miniCount.textContent = count === 1 ? '1 person' : `${count} people`;
  }

  setConnBanner(visible, text = 'Reconnecting…') {
    const banner = document.getElementById('connBanner');
    banner.textContent = text;
    banner.hidden = !visible;
  }

  // ══════════════════════ spotlight / grid layout ══════════════════════

  /** Pick the spotlight: manual pin > active screen share > remote in a 1:1. */
  #pickSpotlight() {
    if (this.manualSpotlightId && this.tiles.has(this.manualSpotlightId)) {
      return this.manualSpotlightId;
    }
    this.manualSpotlightId = null;

    for (const [id, tile] of this.tiles) {
      if (tile.node.classList.contains('is-sharing')) return id;
    }

    if (this.tiles.size === 2) {
      for (const [id] of this.tiles) {
        if (id !== this.selfId) return id;
      }
    }
    return null;
  }

  updateGridLayout() {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;

    const target = this.#pickSpotlight();
    grid.classList.toggle('has-spotlight', !!target);
    const stage = grid.closest('.stage');
    if (stage) stage.classList.toggle('spotlight-mode', !!target);

    // self first → floats at the very bottom corner, others stack above
    const ordered = [...this.tiles.keys()].sort((a, b) => {
      if (a === this.selfId) return -1;
      if (b === this.selfId) return 1;
      return 0;
    });

    let floatIndex = 0;
    for (const id of ordered) {
      const tile = this.tiles.get(id);
      if (!tile) continue;
      const isSpot = !!target && id === target;
      const floating = !!target && !isSpot;
      tile.node.classList.toggle('tile--spotlight', isSpot);
      tile.node.classList.toggle('tile--floating', floating);
      tile.node.style.setProperty('--i', floating ? String(floatIndex++) : '0');

      // Chrome's auto-PiP feature should only consider the main video.
      this.#autoPipFor(tile, isSpot);
    }
  }

  /** The video element that visually represents a tile (screen wins). */
  #mainVideoOf(tile) {
    if (!tile.screen.hidden && tile.screen.srcObject) return tile.screen;
    if (!tile.cam.hidden && tile.cam.srcObject) return tile.cam;
    return tile.screen.srcObject ? tile.screen : tile.cam;
  }

  #autoPipFor(tile, isSpotlight) {
    try {
      tile.cam.autoPictureInPicture = false;
      tile.screen.autoPictureInPicture = false;
      if (isSpotlight) this.#mainVideoOf(tile).autoPictureInPicture = true;
    } catch {
      /* autoPiP unsupported — harmless */
    }
  }

  // ══════════════════════ tiles ══════════════════════

  /** Render the roster. Removes tiles of participants who left. */
  renderRoster(participants) {
    const wanted = new Set(participants.map((p) => p.id));

    for (const [id] of this.tiles) {
      if (!wanted.has(id)) this.removeTile(id);
    }

    for (const participant of participants) {
      if (!this.tiles.has(participant.id)) this.#addTile(participant.id);
      if (participant.media) this.updateMediaState(participant.id, participant.media);
    }

    document.getElementById('roomEmpty').hidden = participants.length > 1;
    this.updateGridLayout();
  }

  #addTile(memberId) {
    const grid = document.getElementById('videoGrid');
    const isSelf = memberId === this.selfId;

    const tile = el('article', `tile${isSelf ? ' is-self' : ''}`);
    tile.dataset.member = memberId;
    tile.style.cursor = 'pointer';
    tile.addEventListener('click', (event) => {
      if (tile._dragged || event.target.closest('button')) return;
      this.manualSpotlightId = this.manualSpotlightId === memberId ? null : memberId;
      this.updateGridLayout();
    });
    tile.addEventListener('dblclick', (event) => {
      if (tile._dragged || event.target.closest('button')) return;
      this.fullscreenTile(memberId);
    });

    const cam = el('video', 'tile-video');
    cam.autoplay = true;
    cam.playsInline = true;
    cam.muted = true; // voice lives in a separate Audio element — never here
    cam.hidden = true;

    const screen = el('video', 'tile-video--screen');
    screen.autoplay = true;
    screen.playsInline = true;
    screen.muted = true;
    screen.hidden = true;

    const avatarWrap = el('div', 'tile-avatar');
    avatarWrap.appendChild(el('div', 'avatar-circle', (this.memberName[0] || 't').toUpperCase()));

    const nameRow = el('div', 'tile-name');
    nameRow.appendChild(el('span', 'tile-name-text', this.memberName));
    if (isSelf) nameRow.appendChild(el('span', 'you-badge', 'you'));

    const badges = el('div', 'tile-badges');
    const micBadge = el('span', 'tile-badge tile-badge--off');
    micBadge.innerHTML = BADGE_ICONS.micOff;
    micBadge.title = 'Microphone off';
    const camBadge = el('span', 'tile-badge tile-badge--off');
    camBadge.innerHTML = BADGE_ICONS.camOff;
    camBadge.title = 'Camera off';
    const screenBadge = el('span', 'tile-badge tile-badge--screen');
    screenBadge.innerHTML = BADGE_ICONS.screen;
    screenBadge.title = 'Sharing screen';
    badges.append(micBadge, camBadge, screenBadge);

    const expandBtn = el('button', 'tile-expand');
    expandBtn.type = 'button';
    expandBtn.title = 'View full screen';
    expandBtn.setAttribute('aria-label', 'View full screen');
    expandBtn.innerHTML = BADGE_ICONS.expand;
    expandBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.fullscreenTile(memberId);
    });

    tile.append(cam, screen, avatarWrap, nameRow, badges, expandBtn);
    grid.appendChild(tile);

    const refs = { node: tile, cam, screen, avatarWrap, micBadge, camBadge, screenBadge };
    this.tiles.set(memberId, refs);

    if (isSelf) this.#enableFloatDrag(tile);
    this.#refreshTile(memberId);
    return tile;
  }

  removeTile(memberId) {
    const tile = this.tiles.get(memberId);
    if (!tile) return;
    // Detach streams (the mesh owns remote receiver tracks — stopping
    // them here would break the peer connection; local tracks are stopped
    // centrally by media.stopAll() on leave).
    tile.cam.srcObject = null;
    tile.screen.srcObject = null;
    tile.node.remove();
    this.tiles.delete(memberId);
    this.lastMedia.delete(memberId);
    if (this.manualSpotlightId === memberId) this.manualSpotlightId = null;
    this.updateGridLayout();
  }

  /** Attach a local (or remote) stream to a tile. Tiles stay muted, always. */
  attachStream(memberId, kind, stream) {
    const tile = this.tiles.get(memberId);
    if (!tile) return;
    const video = kind === 'screen' ? tile.screen : tile.cam;
    video.muted = true; // hard guarantee: no tile may ever play audio
    video.srcObject = stream || null;
    if (stream) {
      const attempt = video.play ? video.play() : null;
      if (attempt && attempt.catch) attempt.catch(() => {});
    }
    this.#refreshTile(memberId);
  }

  /** Update mic/cam/screen badges + visibility from the shared media state. */
  updateMediaState(memberId, state) {
    const tile = this.tiles.get(memberId);
    if (!tile || !state) return;
    const prev = this.lastMedia.get(memberId) || {};
    this.lastMedia.set(memberId, { ...prev, ...state });
    this.#refreshTile(memberId);
  }

  /**
   * Single source of truth for what a tile shows: camera vs avatar,
   * screen inset, badges and sharing class. Runs on every state change
   * AND every (re-)attach — this is what makes the camera appear the
   * moment the first track arrives, without a manual toggle.
   */
  #refreshTile(memberId) {
    const tile = this.tiles.get(memberId);
    if (!tile) return;
    const state = this.lastMedia.get(memberId) || {};

    tile.micBadge.hidden = state.mic !== false;
    tile.camBadge.hidden = state.cam !== false;
    tile.screenBadge.hidden = state.screen !== true;

    const sharing = state.screen === true;
    tile.node.classList.toggle('is-sharing', sharing);

    const camStream = tile.cam.srcObject;
    const camTrack = camStream && camStream.getVideoTracks()[0];
    const showCam = state.cam !== false && !!camTrack;
    tile.avatarWrap.hidden = showCam;
    tile.cam.hidden = !showCam;

    tile.screen.hidden = !sharing || !tile.screen.srcObject;

    this.updateGridLayout();
  }

  // ══════════════════════ fullscreen ══════════════════════

  /** Fullscreen the tile's camera or screen share (screen wins). */
  fullscreenTile(memberId) {
    const tile = this.tiles.get(memberId);
    if (!tile) return;
    const target = this.#mainVideoOf(tile);
    if (!target || !target.srcObject) {
      this.toast('No video to show full screen yet.', 'warn');
      return;
    }
    if (document.fullscreenElement) {
      const exiting = document.exitFullscreen && document.exitFullscreen();
      if (exiting && exiting.catch) exiting.catch(() => {});
      return;
    }
    // Standard → prefixed → iPhone's video-only fullscreen.
    const request =
      target.requestFullscreen ||
      target.webkitRequestFullscreen ||
      target.webkitEnterFullscreen;
    if (!request) {
      this.toast('Full screen is not available in this browser.', 'warn');
      return;
    }
    try {
      const result = request.call(target);
      if (result && result.catch) {
        result.catch(() => this.toast('Full screen is not available in this browser.', 'warn'));
      }
    } catch {
      this.toast('Full screen is not available in this browser.', 'warn');
    }
  }

  // ══════════════════════ floating self view (drag) ══════════════════════

  #enableFloatDrag(tile) {
    tile.addEventListener('pointerdown', (event) => {
      if (!tile.classList.contains('tile--floating')) return;
      if (event.target.closest('button')) return;
      const stage = tile.closest('.stage');
      if (!stage) return;

      const stageRect = stage.getBoundingClientRect();
      const rect = tile.getBoundingClientRect();
      const grabRight = event.clientX - rect.right;
      const grabBottom = event.clientY - rect.bottom;
      let moved = false;

      const onMove = (ev) => {
        const dx = Math.abs(ev.clientX - event.clientX);
        const dy = Math.abs(ev.clientY - event.clientY);
        if (!moved && dx + dy < 4) return;
        moved = true;
        tile._dragged = true;

        let right = stageRect.right - ev.clientX + grabRight;
        let bottom = stageRect.bottom - ev.clientY + grabBottom;
        right = Math.min(Math.max(right, 0), Math.max(0, stageRect.width - rect.width));
        bottom = Math.min(Math.max(bottom, 0), Math.max(0, stageRect.height - rect.height));

        tile.style.setProperty('--i', '0');
        tile.style.setProperty('--fx', `${right - 16}px`);
        tile.style.setProperty('--fy', `${bottom - 88}px`);
      };

      const onUp = () => {
        tile.removeEventListener('pointermove', onMove);
        tile.removeEventListener('pointerup', onUp);
        tile.removeEventListener('pointercancel', onUp);
        // let the trailing click event observe the flag before clearing
        setTimeout(() => {
          tile._dragged = false;
        }, 0);
      };

      tile.setPointerCapture(event.pointerId);
      tile.addEventListener('pointermove', onMove);
      tile.addEventListener('pointerup', onUp);
      tile.addEventListener('pointercancel', onUp);
    });
  }

  // ══════════════════════ mini floating call view ══════════════════════

  toggleMini() {
    if (this.miniOpen) this.closeMini();
    else this.openMini();
  }

  openMini() {
    const mini = document.getElementById('miniCall');
    if (!mini) return;
    this.miniOpen = true;
    document.body.classList.add('mini-active');
    mini.hidden = false;
    const label = document.getElementById('miniLabel');
    if (label) label.textContent = `${this.memberName} — in call`;
    this.setCount(this.count, this.max); // refresh mini count
    this.#miniLoop();
  }

  closeMini() {
    if (!this.miniOpen && document.getElementById('miniCall').hidden) return;
    this.miniOpen = false;
    document.body.classList.remove('mini-active');
    document.getElementById('miniCall').hidden = true;
    if (this._miniTimer) {
      clearTimeout(this._miniTimer);
      this._miniTimer = null;
    }
  }

  /** Best video to mirror into the mini window / pop out. */
  #spotlightSource() {
    // 1) current spotlight tile
    const spot = document.querySelector('.tile.tile--spotlight');
    if (spot) {
      const tile = this.tiles.get(spot.dataset.member);
      if (tile) {
        const main = this.#mainVideoOf(tile);
        if (main && main.srcObject) return main;
      }
    }
    // 2) any remote camera/screen, 3) our own camera
    const candidates = [...this.tiles.keys()].filter((id) => id !== this.selfId);
    candidates.push(this.selfId);
    for (const id of candidates) {
      const tile = this.tiles.get(id);
      if (!tile) continue;
      const main = this.#mainVideoOf(tile);
      if (main && main.srcObject) return main;
    }
    return null;
  }

  #miniLoop() {
    if (!this.miniOpen) return;
    const canvas = document.getElementById('miniCanvas');
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return; // no 2d canvas available — mini shows chrome only

    const draw = () => {
      if (!this.miniOpen) return;
      const video = this.#spotlightSource();
      if (video && video.readyState >= 2 && video.videoWidth) {
        // cover-crop the source into the 16:9 canvas
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const scale = Math.max(canvas.width / vw, canvas.height / vh);
        const sw = canvas.width / scale;
        const sh = canvas.height / scale;
        const sx = (vw - sw) / 2;
        const sy = (vh - sh) / 2;
        try {
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } catch {
          /* transient frame error — next tick retries */
        }
      }
      this._miniTimer = setTimeout(() => requestAnimationFrame(draw), 80); // ~12 fps
    };

    draw();
  }

  #enableMiniDrag() {
    const mini = document.getElementById('miniCall');
    if (!mini) return;
    mini.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = mini.getBoundingClientRect();
      const grabX = event.clientX - rect.left;
      const grabY = event.clientY - rect.top;

      const onMove = (ev) => {
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
        const left = Math.min(
          Math.max(ev.clientX - grabX, 0),
          Math.max(0, window.innerWidth - rect.width)
        );
        const top = Math.min(
          Math.max(ev.clientY - grabY, 0),
          Math.max(0, window.innerHeight - rect.height)
        );
        mini.style.left = `${left}px`;
        mini.style.top = `${top}px`;
      };

      const onUp = () => {
        mini.removeEventListener('pointermove', onMove);
        mini.removeEventListener('pointerup', onUp);
        mini.removeEventListener('pointercancel', onUp);
      };

      mini.setPointerCapture(event.pointerId);
      mini.addEventListener('pointermove', onMove);
      mini.addEventListener('pointerup', onUp);
      mini.addEventListener('pointercancel', onUp);
    });
  }

  /** OS-level Picture-in-Picture of the current main video. */
  async popOut() {
    const video = this.#spotlightSource();
    if (!video || !video.srcObject) {
      this.toast('Nothing to pop out yet — waiting for video.', 'warn');
      return;
    }
    if (!document.pictureInPictureEnabled && !video.requestPictureInPicture) {
      this.toast('Picture-in-Picture is not supported in this browser.', 'warn');
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      this.toast('Could not open Picture-in-Picture here.', 'warn');
    }
  }

  // ══════════════════════ chat ══════════════════════

  addMessage(message) {
    // Server history is re-sent with every snapshot — render each id once.
    if (message.id !== undefined && message.id !== null) {
      if (this.historyIds.has(message.id)) return;
      this.historyIds.add(message.id);
    }
    const container = document.getElementById('chatMessages');
    const day = fmtDay(message.at);
    if (day !== this.lastDay) {
      this.lastDay = day;
      container.appendChild(el('div', 'chat-day', day));
    }

    const mine = message.senderId === this.selfId;
    const msg = el('div', `chat-msg${mine ? ' chat-msg--mine' : ''}`);
    if (!mine) msg.appendChild(el('div', 'msg-name', escapeHtml(message.senderName)));
    msg.appendChild(el('div', 'msg-bubble', escapeHtml(message.text)));
    msg.appendChild(el('div', 'msg-time', fmtTime(message.at)));

    container.appendChild(msg);
    this.#scrollChat();

    if (!this.chatOpen) {
      this.unread += 1;
      this.#updateUnread();
    }
  }

  addSystemMessage(text) {
    const container = document.getElementById('chatMessages');
    const msg = el('div', 'chat-msg chat-msg--system');
    msg.appendChild(el('div', 'msg-bubble', text));
    container.appendChild(msg);
    this.#scrollChat();
  }

  setChatOpen(open) {
    this.chatOpen = open;
    const panel = document.getElementById('chatPanel');
    panel.classList.toggle('is-open', open);
    panel.classList.toggle('is-closed', !open);
    const button = document.getElementById('chatButton');
    button.classList.toggle('is-active', open);
    button.setAttribute('aria-pressed', String(open));
    if (open) {
      this.unread = 0;
      this.#updateUnread();
      this.#scrollChat();
    }
  }

  toggleChat() {
    this.setChatOpen(!this.chatOpen);
  }

  #updateUnread() {
    const badge = document.getElementById('chatUnread');
    badge.hidden = this.unread === 0;
    badge.textContent = this.unread > 99 ? '99+' : String(this.unread);
  }

  #scrollChat() {
    const container = document.getElementById('chatMessages');
    container.scrollTop = container.scrollHeight;
  }

  // ══════════════════════ controls ══════════════════════

  setControlState(kind, on) {
    const ids = { mic: 'micButton', cam: 'camButton', screen: 'screenButton' };
    const button = document.getElementById(ids[kind]);
    if (!button) return;
    if (kind === 'screen') {
      button.classList.toggle('is-active', on);
      button.title = on ? 'Stop sharing' : 'Share screen';
    } else {
      button.classList.toggle('is-off', !on);
      button.classList.toggle('is-active', on);
      button.title = `${kind === 'mic' ? 'Microphone' : 'Camera'} ${on ? 'on' : 'off'}`;
    }
    button.setAttribute('aria-pressed', String(on));
  }

  // ══════════════════════ toasts ══════════════════════

  toast(message, type = 'info', ttl = 4000) {
    const host = document.getElementById('toastHost');
    const node = el('div', `toast toast--${type}`, message);
    host.appendChild(node);
    setTimeout(() => node.remove(), ttl);
  }

  /** Wire static mini-view listeners once at startup. */
  initMini() {
    this.#enableMiniDrag();
    const expand = document.getElementById('miniExpand');
    if (expand) expand.addEventListener('click', () => this.closeMini());
    const end = document.getElementById('miniEnd');
    if (end) {
      end.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.onHangup) this.onHangup();
      });
    }
  }
}

export const ui = new UI();
