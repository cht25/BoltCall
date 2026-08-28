/**
 * public/js/ui.js — DOM rendering: participant tiles, chat, toasts, controls.
 *
 * Every participant is labeled with the room's memberName (server-enforced
 * default "thamjj13"); the local tile additionally gets a small "you" badge
 * so you can find yourself in the grid — but no personal name is ever
 * asked for or displayed.
 */

import { el, escapeHtml, fmtTime, fmtDay } from './utils.js';

class UI {
  constructor() {
    this.tiles = new Map(); // memberId → { cam, screen, avatar, micBadge, camBadge, screenBadge, nameEl }
    this.memberName = 'thamjj13';
    this.selfId = null;
    this.chatOpen = true;
    this.unread = 0;
    this.lastDay = null;
    this.historyIds = new Set();
    this.manualSpotlightId = null;
  }

  loading(show) {
    const loader = document.getElementById('appLoader');
    loader.hidden = !show;
  }

  // ══════════════════════ screens ══════════════════════

  showJoin() {
    document.getElementById('joinScreen').hidden = false;
    document.getElementById('roomScreen').hidden = true;
    const hint = document.getElementById('devHint');
        document.getElementById('joinPassword').focus();
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
    const messages = document.getElementById('chatMessages');
    messages.textContent = '';
    this.historyIds.clear();
    this.lastDay = null;
    this.unread = 0;
    this.#updateUnread();
    this.setControlState('mic', true);
    this.setControlState('cam', true);
    this.setControlState('screen', false);
  }

  joinError(message) {
    const box = document.getElementById('joinError');
    box.textContent = message;
    box.hidden = !message;
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
    const label = count === 1 ? '1 in the call' : `${count} in the call`;
    document.getElementById('participantCount').textContent = max ? `${label} · max ${max}` : label;
  }

  setConnBanner(visible, text = 'Reconnecting…') {
    const banner = document.getElementById('connBanner');
    banner.textContent = text;
    banner.hidden = !visible;
  }

  // ══════════════════════ tiles ══════════════════════

  updateGridLayout() {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;

    let targetSpotlightId = this.manualSpotlightId;

    if (!targetSpotlightId || !this.tiles.has(targetSpotlightId)) {
      this.manualSpotlightId = null;
      targetSpotlightId = null;

      // Find first person sharing screen
      for (const [id, tileInfo] of this.tiles) {
        if (tileInfo.node.classList.contains('is-sharing')) {
          targetSpotlightId = id;
          break;
        }
      }

      // If exactly 2 people, spotlight the remote user
      if (!targetSpotlightId && this.tiles.size === 2) {
        for (const [id] of this.tiles) {
          if (id !== this.selfId) {
            targetSpotlightId = id;
            break;
          }
        }
      }
    }

    if (targetSpotlightId) {
      grid.classList.add('has-spotlight');
    } else {
      grid.classList.remove('has-spotlight');
    }

    for (const [id, tileInfo] of this.tiles) {
      if (id === targetSpotlightId) {
        tileInfo.node.classList.add('tile--spotlight');
      } else {
        tileInfo.node.classList.remove('tile--spotlight');
      }
    }
  }

  // =====


  /** Render the roster. Removes tiles of participants who left. */
  renderRoster(participants) {
    const grid = document.getElementById('videoGrid');
    const wanted = new Set(participants.map((p) => p.id));

    for (const [id] of this.tiles) {
      if (!wanted.has(id)) this.removeTile(id);
    }

    for (const participant of participants) {
      if (!this.tiles.has(participant.id)) this.#addTile(participant.id);
      this.updateMediaState(participant.id, participant.media);
    }

    document.getElementById('roomEmpty').hidden = participants.length > 0;
    this.updateGridLayout();
  }

  #addTile(memberId) {
    const grid = document.getElementById('videoGrid');
    const isSelf = memberId === this.selfId;

    const tile = el('article', `tile${isSelf ? ' is-self' : ''}`);
    tile.dataset.member = memberId;
    tile.addEventListener('click', () => {
      this.manualSpotlightId = this.manualSpotlightId === memberId ? null : memberId;
      this.updateGridLayout();
    });
    tile.style.cursor = 'pointer';

    const cam = el('video', 'tile-video');
    cam.autoplay = true;
    cam.playsInline = true;
    cam.autoPictureInPicture = true;
    cam.muted = true; // prevent echo, audio is handled via separate Audio element

    const screen = el('video', 'tile-video--screen');
    screen.autoplay = true;
    screen.playsInline = true;
    screen.autoPictureInPicture = true;
    screen.muted = true;
    screen.hidden = true;

    const avatarWrap = el('div', 'tile-avatar');
    avatarWrap.appendChild(el('div', 'avatar-circle', (this.memberName[0] || 't').toUpperCase()));

    const nameRow = el('div', 'tile-name');
    nameRow.appendChild(el('span', 'tile-name-text', this.memberName));
    if (isSelf) nameRow.appendChild(el('span', 'you-badge', 'you'));

    const badges = el('div', 'tile-badges');
    const micBadge = el('span', 'tile-badge tile-badge--off', '🎙✕');
    micBadge.title = 'Microphone off';
    const camBadge = el('span', 'tile-badge tile-badge--off', '📷✕');
    camBadge.title = 'Camera off';
    const screenBadge = el('span', 'tile-badge tile-badge--screen', '🖥');
    screenBadge.title = 'Sharing screen';
    badges.append(micBadge, camBadge, screenBadge);

    tile.append(cam, screen, avatarWrap, nameRow, badges);
    grid.appendChild(tile);

    this.tiles.set(memberId, { node: tile, cam, screen, avatarWrap, micBadge, camBadge, screenBadge });
    return tile;
  }

  removeTile(memberId) {
    const tile = this.tiles.get(memberId);
    if (!tile) return;
    // Detach streams (the mesh owns remote receiver tracks — stopping
    // them here would break the peer connection; local tracks are stopped
    // centrally by media.stopAll() on leave).
    for (const key of ['cam', 'screen']) {
      tile[key].srcObject = null;
    }
    const node = document.querySelector(`.tile[data-member="${CSS.escape(memberId)}"]`);
    if (node) node.remove();
    this.tiles.delete(memberId);
  }

  /** Attach a local (or remote) stream to a tile. */
  attachStream(memberId, kind, stream) {
    const tile = this.tiles.get(memberId);
    if (!tile) return;
    const video = kind === 'screen' ? tile.screen : tile.cam;
    video.srcObject = stream;
    if (kind === 'screen') video.hidden = false;
  }

  /** Update mic/cam/screen badges from the shared media state. */
  updateMediaState(memberId, state) {
    const tile = this.tiles.get(memberId);
    if (!tile || !state) return;
    tile.micBadge.hidden = state.mic !== false;
    tile.camBadge.hidden = state.cam !== false;
    tile.screenBadge.hidden = state.screen !== true;

    if (state.screen === true) {
      tile.node.classList.add('is-sharing');
    } else {
      tile.node.classList.remove('is-sharing');
    }
    this.updateGridLayout();

    // The avatar stands in for the camera whenever there is no live
    // video to show (camera off, or no video track at all).
    const hasLiveVideo = (() => {
      const stream = tile.cam.srcObject;
      const track = stream ? stream.getVideoTracks()[0] : null;
      return !!track;
    })();
    const showVideo = state.cam !== false && hasLiveVideo;
    tile.avatarWrap.hidden = showVideo;
    tile.cam.hidden = !showVideo;

    // The small screen-share inset appears only while that participant is
    // actually sharing (and the track has arrived).
    tile.screen.hidden = state.screen !== true || !tile.screen.srcObject;
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
    button.classList.toggle('is-active', on);
    button.classList.toggle('is-off', !on);
    button.setAttribute('aria-pressed', String(on));
    const label = button.querySelector('.ctrl-label');
    if (kind === 'screen') label.textContent = on ? 'Stop share' : 'Screen';
  }

  // ══════════════════════ toasts ══════════════════════

  toast(message, type = 'info', ttl = 4000) {
    const host = document.getElementById('toastHost');
    const node = el('div', `toast toast--${type}`, message);
    host.appendChild(node);
    setTimeout(() => node.remove(), ttl);
  }
}

export const ui = new UI();
