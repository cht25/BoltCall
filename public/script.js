/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  BoltCall — Client Application                              ║
 * ║  Auth + WebRTC + Socket.IO + Chat + Voice + Image + PWA     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
//  GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════

let socket = null;
let localStream = null;
const peerConnections = new Map();
const remoteStreams = new Map();
let currentRoomId = null;
let userName = '';
let mySocketId = null;
let iceServers = [];
let authToken = null;          // JWT token — login-এ সেট হয়
let isAudioMuted = false;
let isVideoOff = false;
let isScreenSharing = false;
let screenShareStream = null;
let callTimerInterval = null;
let callStartTime = null;
let isChatOpen = false;
let unreadCount = 0;
let pendingImageData = null;

// ═══════════════════════════════════════════════════════════════════
//  DOM REFERENCES
// ═══════════════════════════════════════════════════════════════════

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Screens
const loginScreen   = $('#login-screen');
const landingScreen = $('#landing-screen');
const callScreen    = $('#call-screen');

// Login
const loginForm     = $('#login-form');
const loginPassword = $('#login-password');
const btnTogglePw   = $('#btn-toggle-pw');
const loginStatus   = $('#login-status');
const btnLogin      = $('#btn-login');

// Landing
const usernameInput = $('#username-input');
const roomInput     = $('#room-input');
const btnCreateRoom = $('#btn-create-room');
const btnJoinRoom   = $('#btn-join-room');
const btnLogout     = $('#btn-logout');
const landingStatus = $('#landing-status');

// Call
const videoGrid        = $('#video-grid');
const localVideo       = $('#local-video');
const localPlaceholder = $('#local-placeholder');
const waitingOverlay   = $('#waiting-overlay');
const roomIdDisplay    = $('#room-id-display');
const shareRoomId      = $('#share-room-id');
const callTimer        = $('#call-timer');

// Controls
const btnToggleAudio  = $('#btn-toggle-audio');
const btnToggleVideo  = $('#btn-toggle-video');
const btnEndCall      = $('#btn-end-call');
const btnToggleScreen = $('#btn-toggle-screen');
const btnToggleChat   = $('#btn-toggle-chat');
const btnCopyRoom     = $('#btn-copy-room');
const btnLeaveRoom    = $('#btn-leave-room');

// Chat
const chatPanel         = $('#chat-panel');
const chatMessages      = $('#chat-messages');
const chatInput         = $('#chat-input');
const btnSendMessage    = $('#btn-send-message');
const btnCloseChat      = $('#btn-close-chat');
const chatBadge         = $('#chat-badge');
const btnAttachImage    = $('#btn-attach-image');
const btnVoiceRecord    = $('#btn-voice-record');
const fileInput         = $('#file-input');
const imagePreviewBar   = $('#image-preview-bar');
const imagePreviewThumb = $('#image-preview-thumb');
const imagePreviewName  = $('#image-preview-name');
const btnEditImage      = $('#btn-edit-image');
const btnCancelImage    = $('#btn-cancel-image');
const voiceRecordingBar = $('#voice-recording-bar');
const voiceTimer        = $('#voice-timer');
const btnCancelVoice    = $('#btn-cancel-voice');
const btnSendVoice      = $('#btn-send-voice');

// Annotation
const annotationModal    = $('#annotation-modal');
const annotationCanvas   = $('#annotation-canvas');
const annotColor         = $('#annot-color');
const annotStroke        = $('#annot-stroke');
const btnAnnotUndo       = $('#btn-annot-undo');
const btnAnnotClear      = $('#btn-annot-clear');
const btnCloseAnnotation = $('#btn-close-annotation');
const btnAnnotCancel     = $('#btn-annot-cancel');
const btnAnnotSend       = $('#btn-annot-send');
const toolBtns           = $$('.tool-btn[data-tool]');

// Indicators
const localAudioInd = $('#local-audio-indicator');
const localVideoInd = $('#local-video-indicator');

// PWA
const pwaBanner         = $('#pwa-banner');
const pwaInstallAccept  = $('#pwa-install-accept');
const pwaInstallDismiss = $('#pwa-install-dismiss');

// ═══════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initAuth();
  initLandingEvents();
  initCallControls();
  initChatEvents();
  initAnnotation();
  initClipboardPaste();
  initPWA();
  registerServiceWorker();

  // যদি আগে থেকে token থাকে, auto-login
  const savedToken = localStorage.getItem('boltcall_token');
  if (savedToken) {
    authToken = savedToken;
    verifyTokenAndProceed();
  }

  console.log('⚡ BoltCall initialized');
});

// ═══════════════════════════════════════════════════════════════════
//  SERVICE WORKER REGISTRATION
// ═══════════════════════════════════════════════════════════════════

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('✅ SW registered:', reg.scope))
      .catch(err => console.warn('SW registration failed:', err));
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PWA — Auto Install Prompt
// ═══════════════════════════════════════════════════════════════════

let deferredInstallPrompt = null;

function initPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;

    // Standalone mode না হলে banner দেখান
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!isStandalone) {
      pwaBanner.classList.remove('hidden');
    }
  });

  pwaInstallAccept?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('App installed!', 'success');
    }
    deferredInstallPrompt = null;
    pwaBanner.classList.add('hidden');
  });

  pwaInstallDismiss?.addEventListener('click', () => {
    pwaBanner.classList.add('hidden');
    sessionStorage.setItem('pwa_dismissed', '1');
  });

  // যদি আগে dismiss করে থাকে এই session-এ
  if (sessionStorage.getItem('pwa_dismissed')) {
    pwaBanner.classList.add('hidden');
  }

  window.addEventListener('appinstalled', () => {
    pwaBanner.classList.add('hidden');
    showToast('BoltCall installed!', 'success');
  });
}

// ═══════════════════════════════════════════════════════════════════
//  AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════

function initAuth() {
  // Login form submit
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await performLogin();
  });

  // Password toggle
  btnTogglePw.addEventListener('click', () => {
    const isPassword = loginPassword.type === 'password';
    loginPassword.type = isPassword ? 'text' : 'password';
    btnTogglePw.textContent = isPassword ? '🙈' : '👁️';
  });

  // Logout
  btnLogout?.addEventListener('click', () => {
    localStorage.removeItem('boltcall_token');
    authToken = null;
    switchScreen('login');
    showToast('Logged out', 'info');
  });
}

async function performLogin() {
  const password = loginPassword.value.trim();
  if (!password) {
    setLoginStatus('Password দিন', 'error');
    return;
  }

  btnLogin.disabled = true;
  setLoginStatus('Verifying...', '');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();

    if (!res.ok) {
      setLoginStatus(data.error || 'Login failed', 'error');
      btnLogin.disabled = false;
      return;
    }

    authToken = data.token;
    localStorage.setItem('boltcall_token', authToken);
    setLoginStatus('Success!', 'success');

    setTimeout(() => switchScreen('landing'), 400);

  } catch (err) {
    setLoginStatus('Connection error', 'error');
  }

  btnLogin.disabled = false;
}

async function verifyTokenAndProceed() {
  try {
    const res = await fetch('/api/verify', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (res.ok) {
      switchScreen('landing');
    } else {
      localStorage.removeItem('boltcall_token');
      authToken = null;
    }
  } catch {
    // Network error — token may still be valid, try anyway
    switchScreen('landing');
  }
}

function setLoginStatus(msg, type) {
  loginStatus.textContent = msg;
  loginStatus.className = 'login-status' + (type ? ` ${type}` : '');
}

// ═══════════════════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function switchScreen(name) {
  loginScreen.classList.remove('active');
  landingScreen.classList.remove('active');
  callScreen.classList.remove('active');

  switch (name) {
    case 'login':   loginScreen.classList.add('active'); break;
    case 'landing': landingScreen.classList.add('active'); break;
    case 'call':    callScreen.classList.add('active'); break;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  BACKGROUND PARTICLES
// ═══════════════════════════════════════════════════════════════════

function initParticles() {
  const c = $('#particles');
  const colors = ['#00f0ff', '#ff0090', '#b400ff', '#00ff88'];
  for (let i = 0; i < 25; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (10 + Math.random() * 15) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    p.style.width = p.style.height = (2 + Math.random() * 2) + 'px';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    c.appendChild(p);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LANDING EVENTS
// ═══════════════════════════════════════════════════════════════════

function initLandingEvents() {
  btnCreateRoom.addEventListener('click', async () => {
    userName = usernameInput.value.trim() || 'Anonymous';
    setLandingStatus('Room তৈরি হচ্ছে...', 'info');
    try {
      const res = await fetch('/api/create-room', {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await joinRoom(data.roomId);
    } catch (err) {
      setLandingStatus('ব্যর্থ: ' + err.message, 'error');
    }
  });

  btnJoinRoom.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    if (!roomId) { setLandingStatus('Room ID দিন', 'error'); return; }
    userName = usernameInput.value.trim() || 'Anonymous';
    await joinRoom(roomId);
  });

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoinRoom.click();
  });
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`
  };
}

function setLandingStatus(msg, type = '') {
  landingStatus.textContent = msg;
  landingStatus.className = 'status-bar' + (type ? ` ${type}` : '');
}

// ═══════════════════════════════════════════════════════════════════
//  ROOM JOIN
// ═══════════════════════════════════════════════════════════════════

async function joinRoom(roomId) {
  try {
    setLandingStatus('Camera access...', 'info');
    await getLocalStream();

    setLandingStatus('Connecting...', 'info');
    socket = io({
      transports: ['websocket', 'polling'],
      auth: { token: authToken },   // Socket auth
      reconnection: true,
      reconnectionAttempts: 5
    });

    setupSocketEvents();

    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('Timeout')), 10000);
    });

    socket.emit('join-room', { roomId, userName });

  } catch (err) {
    console.error('Join error:', err);
    setLandingStatus('ব্যর্থ: ' + err.message, 'error');
    cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LOCAL MEDIA
// ═══════════════════════════════════════════════════════════════════

async function getLocalStream() {
  const constraints = {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
  localVideo.srcObject = localStream;
  localPlaceholder.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════════

function setupSocketEvents() {
  socket.on('room-joined', ({ roomId, userId, users, servers }) => {
    mySocketId = userId;
    currentRoomId = roomId;
    iceServers = servers || [];
    switchScreen('call');
    roomIdDisplay.textContent = roomId;
    shareRoomId.textContent = roomId;
    startCallTimer();
    showToast(`Room ${roomId}`, 'success');

    users.forEach(u => {
      if (u.id !== mySocketId) createPeerConnection(u.id, true);
    });
  });

  socket.on('user-joined', ({ userId, userName: n }) => {
    showToast(`${n} joined`, 'info');
    createPeerConnection(userId, true);
    waitingOverlay.classList.add('hidden');
  });

  socket.on('offer', async ({ from, offer }) => {
    const pc = createPeerConnection(from, false);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, answer });
    } catch (err) { console.error('Offer error:', err); }
  });

  socket.on('answer', async ({ from, answer }) => {
    const pc = peerConnections.get(from);
    if (pc) try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch {}
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const pc = peerConnections.get(from);
    if (pc && candidate) try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  });

  socket.on('user-left', ({ userId, userName: n }) => {
    showToast(`${n} left`, 'info');
    removePeerConnection(userId);
  });

  socket.on('call-ended', () => {
    showToast('Call ended', 'info');
    peerConnections.forEach((pc, id) => { pc.close(); removeVideoElement(id); });
    peerConnections.clear(); remoteStreams.clear();
    waitingOverlay.classList.remove('hidden');
  });

  socket.on('user-audio-toggle', ({ userId, muted }) => updateRemoteIndicator(userId, 'audio', muted));
  socket.on('user-video-toggle', ({ userId, enabled }) => {
    updateRemoteIndicator(userId, 'video', !enabled);
    toggleRemotePlaceholder(userId, !enabled);
  });

  socket.on('room-full', ({ roomId }) => {
    showToast(`Room ${roomId} full`, 'error');
    cleanup();
  });

  socket.on('chat-message', (data) => handleIncomingChatMessage(data));

  socket.on('disconnect', () => showToast('Disconnected', 'error'));
  socket.on('reconnect', () => {
    showToast('Reconnected', 'success');
    if (currentRoomId) socket.emit('join-room', { roomId: currentRoomId, userName });
  });
}

// ═══════════════════════════════════════════════════════════════════
//  WEBRTC PEER CONNECTION
// ═══════════════════════════════════════════════════════════════════

function createPeerConnection(userId, isInitiator) {
  if (peerConnections.has(userId)) peerConnections.get(userId).close();

  const config = {
    iceServers: iceServers.length > 0 ? iceServers : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const pc = new RTCPeerConnection(config);
  peerConnections.set(userId, pc);

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: userId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    let stream = remoteStreams.get(userId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreams.set(userId, stream);
      createRemoteVideoElement(userId, stream);
    }
    if (!stream.getTracks().find(t => t.id === e.track.id)) stream.addTrack(e.track);
    waitingOverlay.classList.add('hidden');
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      const card = document.getElementById(`vc-${userId}`);
      if (card) card.classList.add('connected');
    }
    if (pc.connectionState === 'closed') removePeerConnection(userId);
  };

  pc.onnegotiationneeded = async () => {
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: userId, offer });
      } catch (err) { console.error('Negotiation error:', err); }
    }
  };

  return pc;
}

function removePeerConnection(userId) {
  const pc = peerConnections.get(userId);
  if (pc) { pc.close(); peerConnections.delete(userId); }
  remoteStreams.delete(userId);
  removeVideoElement(userId);
  if (peerConnections.size === 0) waitingOverlay.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════
//  REMOTE VIDEO ELEMENTS
// ═══════════════════════════════════════════════════════════════════

function createRemoteVideoElement(userId, stream) {
  removeVideoElement(userId);
  const card = document.createElement('div');
  card.className = 'video-card remote';
  card.id = `vc-${userId}`;
  card.innerHTML = `
    <video id="rv-${userId}" autoplay playsinline></video>
    <div class="video-overlay">
      <span class="video-name" id="rn-${userId}">Remote</span>
      <div class="video-indicators">
        <span class="indicator" id="ra-${userId}">🎤</span>
        <span class="indicator" id="rvi-${userId}">📹</span>
      </div>
    </div>
    <div class="video-placeholder hidden" id="rp-${userId}">
      <div class="avatar-circle">👤</div>
    </div>`;
  videoGrid.appendChild(card);
  document.getElementById(`rv-${userId}`).srcObject = stream;
}

function removeVideoElement(userId) {
  document.getElementById(`vc-${userId}`)?.remove();
}

function updateRemoteIndicator(userId, type, muted) {
  const el = document.getElementById(type === 'audio' ? `ra-${userId}` : `rvi-${userId}`);
  if (el) { el.classList.toggle('muted', muted); el.textContent = muted ? (type === 'audio' ? '🔇' : '📵') : (type === 'audio' ? '🎤' : '📹'); }
}

function toggleRemotePlaceholder(userId, show) {
  const ph = document.getElementById(`rp-${userId}`);
  const vid = document.getElementById(`rv-${userId}`);
  if (ph && vid) { ph.classList.toggle('hidden', !show); vid.style.display = show ? 'none' : 'block'; }
}

// ═══════════════════════════════════════════════════════════════════
//  CALL CONTROLS
// ═══════════════════════════════════════════════════════════════════

function initCallControls() {
  btnToggleAudio.addEventListener('click', () => {
    if (!localStream) return;
    isAudioMuted = !isAudioMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !isAudioMuted; });
    btnToggleAudio.classList.toggle('inactive', isAudioMuted);
    localAudioInd.classList.toggle('muted', isAudioMuted);
    localAudioInd.textContent = isAudioMuted ? '🔇' : '🎤';
    if (currentRoomId) socket.emit('audio-toggle', { roomId: currentRoomId, muted: isAudioMuted });
  });

  btnToggleVideo.addEventListener('click', () => {
    if (!localStream) return;
    isVideoOff = !isVideoOff;
    localStream.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
    btnToggleVideo.classList.toggle('inactive', isVideoOff);
    localVideoInd.classList.toggle('muted', isVideoOff);
    localVideoInd.textContent = isVideoOff ? '📵' : '📹';
    localPlaceholder.classList.toggle('hidden', !isVideoOff);
    if (currentRoomId) socket.emit('video-toggle', { roomId: currentRoomId, enabled: !isVideoOff });
  });

  btnToggleScreen.addEventListener('click', async () => {
    if (!isScreenSharing) await startScreenShare();
    else stopScreenShare();
  });

  btnEndCall.addEventListener('click', () => {
    if (currentRoomId && socket) socket.emit('end-call', { roomId: currentRoomId });
    cleanup(); switchScreen('landing'); showToast('Call ended', 'info');
  });

  btnLeaveRoom.addEventListener('click', () => { cleanup(); switchScreen('landing'); });

  btnCopyRoom.addEventListener('click', () => {
    if (currentRoomId) {
      navigator.clipboard.writeText(currentRoomId)
        .then(() => showToast('Room ID copied!', 'success'))
        .catch(() => prompt('Copy:', currentRoomId));
    }
  });

  btnToggleChat.addEventListener('click', () => {
    isChatOpen = !isChatOpen;
    chatPanel.classList.toggle('collapsed', !isChatOpen);
    if (isChatOpen) { unreadCount = 0; updateChatBadge(); }
  });

  btnCloseChat.addEventListener('click', () => { isChatOpen = false; chatPanel.classList.add('collapsed'); });
}

async function startScreenShare() {
  try {
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
    const track = screenShareStream.getVideoTracks()[0];
    peerConnections.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(track);
    });
    localVideo.srcObject = screenShareStream;
    isScreenSharing = true;
    btnToggleScreen.classList.add('active');
    showToast('Screen sharing', 'success');
    track.onended = () => stopScreenShare();
  } catch { showToast('Screen share failed', 'error'); }
}

function stopScreenShare() {
  if (screenShareStream) { screenShareStream.getTracks().forEach(t => t.stop()); screenShareStream = null; }
  if (localStream) {
    const vt = localStream.getVideoTracks()[0];
    peerConnections.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender && vt) sender.replaceTrack(vt);
    });
    localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  btnToggleScreen.classList.remove('active');
}

// ═══════════════════════════════════════════════════════════════════
//  CALL TIMER
// ═══════════════════════════════════════════════════════════════════

function startCallTimer() {
  callStartTime = Date.now();
  callTimerInterval = setInterval(() => {
    const e = Date.now() - callStartTime;
    callTimer.textContent = String(Math.floor(e / 60000)).padStart(2, '0') + ':' + String(Math.floor((e % 60000) / 1000)).padStart(2, '0');
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  callTimer.textContent = '00:00';
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT CHAT
// ═══════════════════════════════════════════════════════════════════

function initChatEvents() {
  btnSendMessage.addEventListener('click', sendTextMessage);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); } });

  btnAttachImage.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleImageFile(e.target.files[0]); fileInput.value = ''; });

  btnEditImage.addEventListener('click', () => { if (pendingImageData) openAnnotationModal(pendingImageData); });
  btnCancelImage.addEventListener('click', () => { pendingImageData = null; imagePreviewBar.classList.add('hidden'); });

  btnVoiceRecord.addEventListener('click', toggleVoiceRecording);
  btnCancelVoice.addEventListener('click', cancelVoiceRecording);
  btnSendVoice.addEventListener('click', sendVoiceMessage);
}

function sendTextMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !currentRoomId || !socket) return;
  socket.emit('chat-message', { roomId: currentRoomId, message: msg, userName });
  chatInput.value = '';
}

function handleIncomingChatMessage(data) {
  const isOwn = data.from === mySocketId;
  if (!isChatOpen && !isOwn) { unreadCount++; updateChatBadge(); }

  const el = document.createElement('div');
  el.className = `chat-msg ${isOwn ? 'own' : 'other'}`;
  const time = new Date(data.timestamp).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });

  switch (data.type) {
    case 'text':
      el.innerHTML = `${!isOwn ? `<span class="msg-sender">${esc(data.userName)}</span>` : ''}
        <div class="msg-bubble">${esc(data.message)}</div><span class="msg-time">${time}</span>`;
      break;
    case 'voice':
      el.innerHTML = `${!isOwn ? `<span class="msg-sender">${esc(data.userName)}</span>` : ''}
        <div class="msg-bubble"><div class="voice-bubble">
          <button class="voice-play-btn" onclick="playVoice(this,'${data.audioData}')">▶</button>
          <span class="voice-duration">🎤 ${fmtDur(data.duration)}</span>
        </div></div><span class="msg-time">${time}</span>`;
      break;
    case 'image':
      el.innerHTML = `${!isOwn ? `<span class="msg-sender">${esc(data.userName)}</span>` : ''}
        <div class="msg-bubble"><div class="image-bubble">
          <img src="${data.imageData}" onclick="showFullImg(this.src)">
          ${data.caption ? `<div class="image-caption">${esc(data.caption)}</div>` : ''}
        </div></div><span class="msg-time">${time}</span>`;
      break;
  }

  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateChatBadge() {
  if (unreadCount > 0) { chatBadge.textContent = unreadCount > 9 ? '9+' : unreadCount; chatBadge.classList.remove('hidden'); }
  else chatBadge.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
//  VOICE RECORDING
// ═══════════════════════════════════════════════════════════════════

let mediaRecorder = null, audioChunks = [], voiceRecordStart = null, voiceTimerInterval = null;

async function toggleVoiceRecording() {
  if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); return; }
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mic, { mimeType: getAudioMime() });
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      mic.getTracks().forEach(t => t.stop());
      const dur = Math.round((Date.now() - voiceRecordStart) / 1000);
      voiceRecordingBar.classList.remove('hidden');
      voiceTimer.textContent = fmtDur(dur);
      stopVoiceTimer();
    };
    mediaRecorder.start(100);
    voiceRecordStart = Date.now();
    btnVoiceRecord.classList.add('active');
    startVoiceTimer();
  } catch { showToast('Mic denied', 'error'); }
}

function cancelVoiceRecording() {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  mediaRecorder = null; audioChunks = [];
  voiceRecordingBar.classList.add('hidden');
  btnVoiceRecord.classList.remove('active');
  stopVoiceTimer();
}

function sendVoiceMessage() {
  if (!audioChunks.length || !currentRoomId) return;
  const blob = new Blob(audioChunks, { type: getAudioMime() });
  const dur = Math.round((Date.now() - voiceRecordStart) / 1000);
  const reader = new FileReader();
  reader.onloadend = () => {
    socket.emit('voice-message', { roomId: currentRoomId, audioData: reader.result, userName, duration: dur });
  };
  reader.readAsDataURL(blob);
  mediaRecorder = null; audioChunks = [];
  voiceRecordingBar.classList.add('hidden');
  btnVoiceRecord.classList.remove('active');
  stopVoiceTimer();
}

function getAudioMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'audio/webm';
}

function startVoiceTimer() {
  voiceTimerInterval = setInterval(() => {
    voiceTimer.textContent = fmtDur(Math.round((Date.now() - voiceRecordStart) / 1000));
  }, 1000);
}
function stopVoiceTimer() { if (voiceTimerInterval) { clearInterval(voiceTimerInterval); voiceTimerInterval = null; } }

window.playVoice = function(btn, data) {
  const a = new Audio(data); btn.textContent = '⏸'; a.play(); a.onended = () => { btn.textContent = '▶'; };
};

// ═══════════════════════════════════════════════════════════════════
//  IMAGE SHARING
// ═══════════════════════════════════════════════════════════════════

function handleImageFile(file) {
  if (!file.type.startsWith('image/')) { showToast('শুধু image', 'error'); return; }
  if (file.size > 10 * 1024 * 1024) { showToast('10MB limit', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingImageData = e.target.result;
    imagePreviewThumb.src = pendingImageData;
    imagePreviewName.textContent = file.name;
    imagePreviewBar.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function initClipboardPaste() {
  document.addEventListener('paste', (e) => {
    if (!callScreen.classList.contains('active')) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) { handleImageFile(file); showToast('Image from clipboard', 'info'); }
        break;
      }
    }
  });
}

window.showFullImg = function(src) {
  const ov = document.createElement('div');
  ov.className = 'image-fullscreen';
  ov.innerHTML = `<img src="${src}">`;
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
};

// ═══════════════════════════════════════════════════════════════════
//  ANNOTATION ENGINE
// ═══════════════════════════════════════════════════════════════════

let ctx = null, isDrawing = false, currentTool = 'pen', drawHistory = [], currentPath = [], shapeStart = null, bgImage = null;

function initAnnotation() {
  ctx = annotationCanvas.getContext('2d');

  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      annotationCanvas.style.cursor = currentTool === 'text' ? 'text' : 'crosshair';
    });
  });

  annotationCanvas.addEventListener('mousedown', onDown);
  annotationCanvas.addEventListener('mousemove', onMove);
  annotationCanvas.addEventListener('mouseup', onUp);
  annotationCanvas.addEventListener('mouseleave', onUp);

  annotationCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.touches[0], r = annotationCanvas.getBoundingClientRect(); onDown({ offsetX: t.clientX - r.left, offsetY: t.clientY - r.top }); });
  annotationCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); const t = e.touches[0], r = annotationCanvas.getBoundingClientRect(); onMove({ offsetX: t.clientX - r.left, offsetY: t.clientY - r.top }); });
  annotationCanvas.addEventListener('touchend', onUp);

  btnAnnotUndo.addEventListener('click', () => { if (drawHistory.length) { drawHistory.pop(); redraw(); } });
  btnAnnotClear.addEventListener('click', () => { drawHistory = []; redraw(); });
  btnCloseAnnotation.addEventListener('click', closeAnnotation);
  btnAnnotCancel.addEventListener('click', closeAnnotation);
  btnAnnotSend.addEventListener('click', sendAnnotated);
}

function openAnnotationModal(dataUrl) {
  annotationModal.classList.remove('hidden');
  const img = new Image();
  img.onload = () => {
    bgImage = img;
    const maxW = Math.min(800, window.innerWidth * 0.9);
    const scale = Math.min(maxW / img.width, maxW / img.height, 1);
    annotationCanvas.width = img.width * scale;
    annotationCanvas.height = img.height * scale;
    drawHistory = [];
    redraw();
  };
  img.src = dataUrl;
}

function closeAnnotation() { annotationModal.classList.add('hidden'); bgImage = null; drawHistory = []; }

function redraw() {
  if (!ctx || !bgImage) return;
  ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  ctx.drawImage(bgImage, 0, 0, annotationCanvas.width, annotationCanvas.height);
  drawHistory.forEach(a => drawAction(a));
}

function drawAction(a) {
  if (!ctx) return;
  ctx.save();
  ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
  ctx.lineWidth = a.sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  switch (a.tool) {
    case 'pen':
      if (a.points.length < 2) break;
      ctx.beginPath(); ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
      ctx.stroke(); break;
    case 'highlighter':
      ctx.globalAlpha = 0.35; ctx.lineWidth = a.sw * 4;
      if (a.points.length < 2) break;
      ctx.beginPath(); ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
      ctx.stroke(); break;
    case 'eraser':
      ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = 'rgba(0,0,0,1)';
      if (a.points.length < 2) break;
      ctx.beginPath(); ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
      ctx.stroke();
      ctx.globalCompositeOperation = 'destination-over';
      if (bgImage) ctx.drawImage(bgImage, 0, 0, annotationCanvas.width, annotationCanvas.height);
      break;
    case 'arrow':
      if (!a.start || !a.end) break;
      const dx = a.end.x - a.start.x, dy = a.end.y - a.start.y, ang = Math.atan2(dy, dx), hl = 15;
      ctx.beginPath(); ctx.moveTo(a.start.x, a.start.y); ctx.lineTo(a.end.x, a.end.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a.end.x, a.end.y);
      ctx.lineTo(a.end.x - hl * Math.cos(ang - Math.PI / 6), a.end.y - hl * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(a.end.x, a.end.y);
      ctx.lineTo(a.end.x - hl * Math.cos(ang + Math.PI / 6), a.end.y - hl * Math.sin(ang + Math.PI / 6));
      ctx.stroke(); break;
    case 'rect':
      if (!a.start || !a.end) break;
      ctx.strokeRect(a.start.x, a.start.y, a.end.x - a.start.x, a.end.y - a.start.y); break;
    case 'circle':
      if (!a.start || !a.end) break;
      ctx.beginPath();
      ctx.ellipse((a.start.x + a.end.x) / 2, (a.start.y + a.end.y) / 2,
        Math.abs(a.end.x - a.start.x) / 2, Math.abs(a.end.y - a.start.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke(); break;
    case 'text':
      ctx.font = `${a.sw * 4}px Rajdhani, sans-serif`;
      ctx.fillText(a.text, a.start.x, a.start.y); break;
  }
  ctx.restore();
}

function onDown(e) {
  isDrawing = true;
  const x = e.offsetX, y = e.offsetY;
  if (currentTool === 'text') {
    const text = prompt('লেখা:');
    if (text) { drawHistory.push({ tool: 'text', color: annotColor.value, sw: +annotStroke.value, start: { x, y }, text }); redraw(); }
    isDrawing = false;
  } else if (['pen', 'highlighter', 'eraser'].includes(currentTool)) {
    currentPath = [{ x, y }];
  } else {
    shapeStart = { x, y };
  }
}

function onMove(e) {
  if (!isDrawing) return;
  const x = e.offsetX, y = e.offsetY;
  if (['pen', 'highlighter', 'eraser'].includes(currentTool)) {
    currentPath.push({ x, y }); redraw();
    drawAction({ tool: currentTool, color: annotColor.value, sw: +annotStroke.value, points: currentPath });
  } else if (shapeStart) {
    redraw();
    drawAction({ tool: currentTool, color: annotColor.value, sw: +annotStroke.value, start: shapeStart, end: { x, y } });
  }
}

function onUp(e) {
  if (!isDrawing) return; isDrawing = false;
  const x = e.offsetX || 0, y = e.offsetY || 0;
  if (['pen', 'highlighter', 'eraser'].includes(currentTool)) {
    if (currentPath.length > 1) drawHistory.push({ tool: currentTool, color: annotColor.value, sw: +annotStroke.value, points: [...currentPath] });
    currentPath = [];
  } else if (shapeStart) {
    drawHistory.push({ tool: currentTool, color: annotColor.value, sw: +annotStroke.value, start: shapeStart, end: { x, y } });
    shapeStart = null;
  }
  redraw();
}

function sendAnnotated() {
  const data = annotationCanvas.toDataURL('image/png');
  if (currentRoomId && socket) socket.emit('image-message', { roomId: currentRoomId, imageData: data, caption: '(annotated)', userName });
  closeAnnotation(); pendingImageData = null; imagePreviewBar.classList.add('hidden');
  showToast('Image sent', 'success');
}

// ═══════════════════════════════════════════════════════════════════
//  CLEANUP
// ═══════════════════════════════════════════════════════════════════

function cleanup() {
  if (socket) { socket.disconnect(); socket = null; }
  peerConnections.forEach(pc => pc.close()); peerConnections.clear(); remoteStreams.clear();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (screenShareStream) { screenShareStream.getTracks().forEach(t => t.stop()); screenShareStream = null; }
  stopCallTimer();
  currentRoomId = null; mySocketId = null; isAudioMuted = false; isVideoOff = false;
  isScreenSharing = false; unreadCount = 0; pendingImageData = null;
  $$('.video-card.remote').forEach(el => el.remove());
  localVideo.srcObject = null;
  localPlaceholder.classList.remove('hidden');
  waitingOverlay.classList.remove('hidden');
  btnToggleAudio.classList.remove('inactive');
  btnToggleVideo.classList.remove('inactive');
  btnToggleScreen.classList.remove('active');
  imagePreviewBar.classList.add('hidden');
  voiceRecordingBar.classList.add('hidden');
  chatBadge.classList.add('hidden');
  $$('.chat-msg').forEach(el => el.remove());
}

// ═══════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════

function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function fmtDur(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function showToast(msg, type = 'info') {
  const c = $('#toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 4000);
}

window.addEventListener('beforeunload', () => {
  if (socket && currentRoomId) socket.emit('end-call', { roomId: currentRoomId });
  cleanup();
});
