/**
 * public/js/app.js — BoltCall frontend orchestration.
 *
 * Flow: join screen (password) → session → local media → socket → mesh.
 * Entering the correct password puts the user straight into the group
 * call — there is no separate "start call" step, no accounts and no
 * names. Everyone in the room is labeled "thamjj13".
 *
 * Shareable call links look like:  {origin}/call/thamjj13?={timestamp}
 * Anyone opening one lands on the join screen (invite hint shown) and a
 * valid session drops them straight into the call.
 */

import { api } from './api.js';
import { media } from './media.js';
import { Mesh } from './peers.js';
import { ui } from './ui.js';

let socket = null;
let mesh = null;
let selfId = null;
let maxParticipants = 0;

// Remote media cache — re-attached whenever a tile is (re)rendered.
const remoteStreams = new Map(); // peerId → { cam?, screen? }
const remoteAudios = new Map(); // peerId → HTMLAudioElement

// ══════════════════════════════════════════════════════════════════════
//  Call links
// ══════════════════════════════════════════════════════════════════════

/** The shareable link for this room: domain.com/call/thamjj13?={date} */
function callLink() {
  const name = ui.memberName || 'thamjj13';
  return `${window.location.origin}/call/${encodeURIComponent(name)}?=${Date.now()}`;
}

/** Does the current URL look like an invitation link? */
function isInviteUrl() {
  return /^\/call(\/|$)/.test(window.location.pathname);
}

function copyShareLink() {
  const url = callLink();
  const done = () => ui.toast('Call link copied — send it to anyone to join this call.', 'success', 5000);
  const fallback = () => {
    // Clipboard API needs a secure context; fall back to a prompt-style copy.
    const area = document.createElement('textarea');
    area.value = url;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      ui.toast(`Copy this link: ${url}`, 'info', 9000);
    }
    area.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(done).catch(fallback);
  } else {
    fallback();
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Duplicate-tab echo guard
//  (Two live tabs on one device = your mic plays back through the other.
//   The newest tab keeps its mic; older tabs auto-mute instead of echo.)
// ══════════════════════════════════════════════════════════════════════

const TAB_ID = Math.random().toString(36).slice(2);
const tabStartedAt = Date.now();
let tabChannel = null;

function setupTabGuard() {
  if (typeof BroadcastChannel === 'undefined') return;
  if (!tabChannel) {
    tabChannel = new BroadcastChannel('boltcall-call-tabs');
    tabChannel.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.tab === TAB_ID || msg.type !== 'active') return;
      // A different tab on this device joined AFTER us → silence ours.
      if (typeof msg.at === 'number' && msg.at < tabStartedAt) return;
      if (media.started && media.micOn) {
        void handleMic(); // toggles off, updates UI + broadcasts state
        ui.toast(
          'This call is open in another tab on this device — microphone muted here to prevent echo.',
          'warn',
          7000
        );
      }
    };
  }
  tabChannel.postMessage({ type: 'active', tab: TAB_ID, at: tabStartedAt });
}

// ══════════════════════════════════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════════════════════════════════

async function boot() {
  ui.loading(true);
  ui.setInviteMode(isInviteUrl());
  try {
    const { member, room } = await api.me();
    await enterRoom(member, room);
  } catch {
    await showJoin();
  } finally {
    ui.loading(false);
  }
}

async function showJoin() {
  await api.roomInfo().catch(() => ({}));
  ui.setInviteMode(isInviteUrl());
  ui.showJoin();
}

// ══════════════════════════════════════════════════════════════════════
//  Join / enter room
// ══════════════════════════════════════════════════════════════════════

async function handleJoin(event) {
  event.preventDefault();
  const password = document.getElementById('joinPassword').value;
  if (!password) return;

  ui.joinBusy(true);
  ui.joinError('');
  try {
    const { member, room } = await api.join(password);
    await enterRoom(member, room);
  } catch (err) {
    ui.joinError(err.message || 'Could not join — please try again.');
  } finally {
    ui.joinBusy(false);
  }
}

async function enterRoom(member, room) {
  selfId = member.id;
  ui.selfId = selfId;
  ui.memberName = member.name;
  maxParticipants = room.maxParticipants || 0;

  ui.showRoom();
  ui.setRoomName(room.name);
  ui.setCount(1, maxParticipants);
  ui.setConnBanner(true, 'Connecting…');

  // The address bar now shows the shareable link for this call.
  try {
    window.history.replaceState(null, '', callLink());
  } catch {
    /* file:// or sandboxed iframes may forbid it — cosmetic only */
  }

  // ── STUN/TURN config for the mesh ─────────────────────────────────
  let iceServers = [];
  try {
    const ice = await api.iceServers();
    iceServers = ice.iceServers || [];
    if (ice.warning) ui.toast(ice.warning, 'warn', 6000);
  } catch {
    iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  }

  // ── Socket (room chat + signaling + presence) ─────────────────────
  connectSocket();

  // ── Local devices: microphone + camera (auto-join the call) ───────
  try {
    await media.start();
  } catch (err) {
    ui.toast(`Could not access microphone/camera: ${err.message}`, 'warn', 6000);
  }

  ui.attachStream(selfId, 'cam', media.camStream);
  ui.updateMediaState(selfId, media.state);
  ui.setControlState('mic', media.micOn);
  ui.setControlState('cam', media.camOn);

  // ── Mesh (peer-to-peer media, both directions) ────────────────────
  mesh = new Mesh({
    selfId,
    socket,
    iceServers,
    onRemoteTrack: attachRemoteMedia,
    onPeerStatus: (peerId, status) => {
      if (status === 'failed') {
        ui.toast('A connection to one participant could not be established.', 'warn', 6000);
      }
    }
  });

  // Deliver signaling that arrived while devices were still starting up.
  for (const pending of pendingSignals.splice(0)) {
    mesh.handle(pending.type, pending.data);
  }

  // If the roster arrived before the mesh existed, bring it up to date.
  if (lastSnapshot) {
    applySnapshot(lastSnapshot);
    mesh.refreshLocalTracks();
  }
  sendMediaState();

  // Detect a second live tab on this device (echo prevention).
  setupTabGuard();
}

let lastSnapshot = null;
const pendingSignals = []; // { type, data } — held until the mesh exists

function routeSignal(type, data) {
  if (mesh) mesh.handle(type, data);
  else pendingSignals.push({ type, data });
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  lastSnapshot = snapshot;

  for (const message of snapshot.history || []) {
    ui.addMessage(message);
  }

  ui.renderRoster(snapshot.participants || []);
  ui.setCount((snapshot.participants || []).length, snapshot.room ? snapshot.room.maxParticipants : 0);

  // Local streams + known remote streams (re-attach after re-render).
  if (media.camStream) ui.attachStream(selfId, 'cam', media.camStream);
  if (media.screenStream) ui.attachStream(selfId, 'screen', media.screenStream);
  ui.updateMediaState(selfId, media.state);

  for (const [peerId, streams] of remoteStreams) {
    for (const [kind, stream] of Object.entries(streams)) {
      ui.attachStream(peerId, kind, stream);
    }
  }

  if (mesh) mesh.sync((snapshot.participants || []).map((p) => p.id));
}

// ══════════════════════════════════════════════════════════════════════
//  Socket
// ══════════════════════════════════════════════════════════════════════

function connectSocket() {
  socket = io({ withCredentials: true });

  socket.on('connect', () => {
    ui.setConnBanner(false);
    sendMediaState(); // re-sync media flags after a reconnect
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') {
      // The server kicked this socket because the same member connected
      // from another tab — go back to the join screen instead of a
      // permanent "reconnecting" banner. IMPORTANT: never log out here —
      // that would destroy the cookie the other (live) tab relies on.
      ui.toast('You joined from another tab — this tab was disconnected.', 'warn');
      socket.close();
      leave({ skipLogout: true });
      return;
    }
    ui.setConnBanner(true, 'Reconnecting…');
  });

  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') {
      ui.toast('Your session expired — enter the password again.', 'error');
      socket.close();
      leave({ skipLogout: true });
    } else {
      ui.setConnBanner(true, 'Connecting…');
    }
  });

  socket.on('room:init', (data) => {
    if (data.selfId) selfId = data.selfId;
    if (data.memberName) ui.memberName = data.memberName;
    if (data.snapshot && data.snapshot.room) ui.setRoomName(data.snapshot.room.name);
    ui.selfId = selfId;
    applySnapshot(data.snapshot);
  });

  socket.on('room:state', (data) => applySnapshot(data.snapshot));
  socket.on('room:full', () => {
    ui.toast('The room is full right now — try again later.', 'error', 6000);
    leave({ skipLogout: true });
  });

  // ── WebRTC signaling (relayed by the server) ──────────────────────
  socket.on('webrtc:offer', (data) => routeSignal('webrtc:offer', data));
  socket.on('webrtc:answer', (data) => routeSignal('webrtc:answer', data));
  socket.on('webrtc:ice', (data) => routeSignal('webrtc:ice', data));
  socket.on('error:signal', (data) => ui.toast(data.error || 'Signaling failed.', 'warn'));

  // ── Presence ──────────────────────────────────────────────────────
  socket.on('peer:left', ({ memberId }) => {
    if (mesh) mesh.dropPeer(memberId);
    cleanupPeerMedia(memberId);
  });

  // ── Shared media state (mic/cam/screen badges for every tile) ─────
  socket.on('media:state', ({ memberId, ...patch }) => {
    if (memberId === selfId) return; // local UI is driven directly
    ui.updateMediaState(memberId, patch);
  });

  // ── Text chat ─────────────────────────────────────────────────────
  socket.on('chat:receive', (message) => ui.addMessage(message));
  socket.on('chat:rejected', (data) => {
    if (data.reason === 'rate_limited') ui.toast('Sending too fast — slow down a little.', 'warn');
  });
}

// ══════════════════════════════════════════════════════════════════════
//  Remote media
// ══════════════════════════════════════════════════════════════════════

function attachRemoteMedia(peerId, kind, stream) {
  if (kind === 'audio') {
    let audio = remoteAudios.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      remoteAudios.set(peerId, audio);
    }
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
      audio.play().catch(() => {
        // Browser wants a gesture first — retry after the next interaction.
        const retry = () => {
          audio.play().catch(() => {});
          document.removeEventListener('pointerdown', retry);
        };
        document.addEventListener('pointerdown', retry);
      });
    }
    return;
  }

  const entry = remoteStreams.get(peerId) || {};
  entry[kind] = stream;
  remoteStreams.set(peerId, entry);
  ui.attachStream(peerId, kind, stream);
}

function cleanupPeerMedia(peerId) {
  const audio = remoteAudios.get(peerId);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    remoteAudios.delete(peerId);
  }
  remoteStreams.delete(peerId);
  ui.removeTile(peerId);
}

// ══════════════════════════════════════════════════════════════════════
//  Local controls
// ══════════════════════════════════════════════════════════════════════

function sendMediaState() {
  if (socket && socket.connected) socket.emit('media:state', media.state);
}

async function handleMic() {
  const on = await media.toggleMic();
  ui.setControlState('mic', on);
  ui.updateMediaState(selfId, media.state);
  sendMediaState();
  return on;
}

async function handleCam() {
  const on = await media.toggleCam();
  ui.setControlState('cam', on);
  ui.updateMediaState(selfId, media.state);
  sendMediaState();
}

async function handleScreen() {
  if (!media.screenOn) {
    try {
      await media.toggleScreen((track) => mesh && mesh.replaceScreenTrack(track));
      ui.attachStream(selfId, 'screen', media.screenStream);
      ui.setControlState('screen', true);
      ui.updateMediaState(selfId, media.state);
      sendMediaState();
    } catch (err) {
      const denied = err && err.name === 'NotAllowedError';
      ui.toast(
        denied ? 'Screen sharing was not allowed by the browser.' : 'Could not start screen sharing.',
        'warn'
      );
    }
    return;
  }
  await media.toggleScreen((track) => mesh && mesh.replaceScreenTrack(track));
  ui.setControlState('screen', false);
  ui.updateMediaState(selfId, media.state);
  sendMediaState();
}

function handleChatSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !socket || !socket.connected) return;
  socket.emit('chat:send', { text });
  input.value = '';
}

// ══════════════════════════════════════════════════════════════════════
//  Leave
// ══════════════════════════════════════════════════════════════════════

async function leave({ skipLogout = false } = {}) {
  if (!skipLogout) {
    try {
      await api.logout();
    } catch {
      /* session may already be gone */
    }
  }

  if (tabChannel) {
    try {
      tabChannel.postMessage({ type: 'left', tab: TAB_ID });
    } catch {
      /* ignore */
    }
  }

  if (mesh) {
    mesh.destroy();
    mesh = null;
  }
  media.stopAll();
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }

  for (const peerId of Array.from(remoteAudios.keys())) cleanupPeerMedia(peerId);
  pendingSignals.length = 0;
  ui.resetRoom();
  lastSnapshot = null;

  try {
    window.history.replaceState(null, '', '/');
  } catch {
    /* cosmetic only */
  }

  await showJoin();
}

// ══════════════════════════════════════════════════════════════════════
//  Wire up static listeners
// ══════════════════════════════════════════════════════════════════════

document.getElementById('joinForm').addEventListener('submit', handleJoin);
document.getElementById('togglePassword').addEventListener('click', () => {
  const input = document.getElementById('joinPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
});
document.getElementById('micButton').addEventListener('click', handleMic);
document.getElementById('camButton').addEventListener('click', handleCam);
document.getElementById('screenButton').addEventListener('click', handleScreen);
document.getElementById('pipButton').addEventListener('click', () => ui.popOut());
document.getElementById('miniButton').addEventListener('click', () => ui.toggleMini());
document.getElementById('chatButton').addEventListener('click', () => ui.toggleChat());
document.getElementById('closeChat').addEventListener('click', () => ui.setChatOpen(false));
document.getElementById('shareLinkButton').addEventListener('click', copyShareLink);
document.getElementById('chatForm').addEventListener('submit', handleChatSubmit);
document.getElementById('endButton').addEventListener('click', () => leave());

ui.onHangup = () => leave();
ui.initMini();

// The browser's "Stop sharing" bar ends the screen share from outside.
media.onScreenEnd = () => {
  ui.setControlState('screen', false);
  ui.updateMediaState(selfId, media.state);
  sendMediaState();
};

boot();
