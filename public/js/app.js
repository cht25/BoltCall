/**
 * public/js/app.js — BoltCall frontend orchestration.
 *
 * Flow: join screen (password) → session → local media → socket → mesh.
 * Entering the correct password puts the user straight into the group
 * call — there is no separate "start call" step, no accounts and no
 * names. Everyone in the room is labeled "thamjj13".
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
//  Boot
// ══════════════════════════════════════════════════════════════════════

async function boot() {
  ui.loading(true);
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
  const info = await api.roomInfo().catch(() => ({ devPassword: null }));
  ui.showJoin(info);
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
      // permanent "reconnecting" banner.
      ui.toast('You joined from another tab — this tab was disconnected.', 'warn');
      socket.close();
      leave();
      return;
    }
    ui.setConnBanner(true, 'Reconnecting…');
  });

  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') {
      ui.toast('Your session expired — enter the password again.', 'error');
      socket.close();
      leave({ stayOnJoin: true });
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
    leave({ stayOnJoin: true });
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
      document.body.appendChild(audio);
      remoteAudios.set(peerId, audio);
    }
    audio.srcObject = stream;
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

async function leave({ stayOnJoin = false } = {}) {
  void stayOnJoin;
  try {
    await api.logout();
  } catch {
    /* session may already be gone */
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
document.getElementById('chatButton').addEventListener('click', () => ui.toggleChat());
document.getElementById('closeChat').addEventListener('click', () => ui.setChatOpen(false));
document.getElementById('chatForm').addEventListener('submit', handleChatSubmit);
document.getElementById('leaveButton').addEventListener('click', () => leave());

// The browser's "Stop sharing" bar ends the screen share from outside.
media.onScreenEnd = () => {
  ui.setControlState('screen', false);
  ui.updateMediaState(selfId, media.state);
  sendMediaState();
};

boot();
