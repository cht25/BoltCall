/**
 * public/script.js
 * ───────────────────────────────────────────────────────────────────────
 * NexaChat ক্লায়েন্ট অ্যাপ্লিকেশন (ES module)।
 *
 * দায়িত্ব:
 *   • Auth (login / register / session restore)
 *   • REST কল (api.js মডিউলের মাধ্যমে)
 *   • Socket.IO রিয়েল-টাইম (মেসেজ, receipts, presence, typing, calls)
 *   • মিডিয়া: ছবি এডিটর (Canvas), ভয়েস রেকর্ডার, ফাইল আপলোড
 *   • WebRTC 1-on-1 অডিও/ভিডিও কল (media.js মডিউল)
 *
 * নিরাপত্তা নীতি ক্লায়েন্টেও মানা হয়েছে:
 *   • কোনো ইউজার আইডি সার্ভারের বাইরে থেকে আসে না — সবসময় JWT cookie দিয়ে যাচাই
 *   • ব্যবহারকারীর লেখা টেক্সট সরাসরি innerHTML-এ বসানো হয় না (escapeHtml/linkify)
 *   • WebRTC-তে offer তৈরির আগে লোকাল ট্র্যাক যোগ করা হয় (media.js দেখুন)
 */

import { api, ApiError } from './api.js';
import {
  toast,
  openModal,
  closeModal,
  closeTopModal,
  confirmDialog,
  showScreen,
  setMobileView,
  setConnectionState,
  setLoading,
  showFormError,
  openLightbox,
  setSkeleton,
  initModals
} from './ui.js';
import {
  $,
  $$,
  escapeHtml,
  linkify,
  initials,
  setAvatar,
  formatTime,
  formatFull,
  formatListTime,
  formatDayLabel,
  formatRelative,
  formatDuration,
  formatBytes,
  debounce,
  throttle,
  tempId,
  downscaleImage,
  copyText,
  prettyPhone,
  createImageBitmapSafe
} from './utils.js';
import {
  state,
  loadSettings,
  saveSettings,
  cacheUser,
  getUser,
  upsertConversation,
  getConversation,
  findConversationByPartner,
  messageMap,
  putMessage,
  getMessage,
  removeMessage,
  sortedConversations,
  sortedMessages,
  totalUnread
} from './state.js';
import { CallConnection, VoiceRecorder, getUserMedia, attachStream, stopStream, getIceServers, clearIceCache } from './media.js';

// ═══════════════════════════════════════════════════════════════════
//  Socket.IO ইভেন্ট কনস্ট্যান্ট (সার্ভারের সাথে মিল রাখতে)
// ═══════════════════════════════════════════════════════════════════
const EV = {
  RECEIVE: 'chat:receive',
  SEND: 'chat:send',
  TYPING: 'chat:typing',
  STOP_TYPING: 'chat:stopTyping',
  DELIVERED: 'message:delivered',
  READ: 'message:read',
  EDIT: 'message:edit',
  DELETE: 'message:delete',
  PRESENCE: 'presence:update',
  ONLINE: 'user:online',
  OFFLINE: 'user:offline',
  CONV_CREATED: 'conversation:created',
  USER_UPDATED: 'user:updated',
  MISS_CALL: 'notification:missed-call',
  ACCEPT: 'call:accept',
  REJECT: 'call:reject',
  OFFER: 'call:offer',
  ANSWER: 'call:answer',
  ICE: 'call:ice-candidate',
  CONNECTED: 'call:connected',
  END: 'call:end',
  TIMEOUT: 'call:timeout',
  BUSY: 'call:busy',
  HANDLED: 'call:handled',
  INCOMING: 'call:incoming',
  RINGING: 'call:ringing',
  CALL_ACCEPTED: 'call:accepted'
};

// মডিউল-স্কোপ ভেরিয়েবল
let registerAvatarBlob = null; // রেজিস্ট্রেশনের সময় বেছে নেওয়া ছবি
let pendingCall = null; // আসা কল (callee দিক)
let ringTimeoutMs = 35000; // সার্ভার থেকে আসবে
let infoUser = null; // বর্তমান info panel-এর ইউজার
let currentMenuMessageId = null; // কনটেক্সট মেনুর মেসেজ
let scrollAtBottom = true; // মেসেজ স্ক্রলার নিচে আছে কি না
const messageEls = new Map(); // messageId → DOM element (দ্রুত আপডেটের জন্য)
let recorder = null; // VoiceRecorder ইনস্ট্যান্স
let pendingVoice = null; // রেকর্ড করা ভয়েস {blob,duration}
let booted = false; // বুট একাধিকবার চলা ঠেকাতে

// কল স্টেট (caller বা callee)
let call = null;

// ═══════════════════════════════════════════════════════════════════
//  বুটস্ট্রাপ
// ═══════════════════════════════════════════════════════════════════
async function boot() {
  if (booted) return; // DOMContentLoaded + readyState চেক ডাবল কল এড়াতে
  booted = true;
  loadSettings();
  bindGlobalUI();
  bindAuthUI();
  bindChatUI();
  bindSidebarUI();
  bindModals();
  bindCallOverlay();
  bindContextMenu();
  bindKeyboard();
  bindWindow();
  initModals(); // [data-close-modal] ও backdrop ক্লিক ওয়্যারিং

  setConnectionState('connecting', 'Connecting…');
  showScreen('loading');

  try {
    const { user } = await api.auth.me();
    await startApp(user);
  } catch (err) {
    // সেশন নেই — লগইন স্ক্রিন
    showScreen('auth');
    setConnectionState('offline', 'Not signed in');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  অ্যাপ শুরু (লগইন/রেজিস্টার/সেশন পুনরুদ্ধারের পর)
// ═══════════════════════════════════════════════════════════════════
async function startApp(user) {
  state.me = user;
  cacheUser(user);
  renderMyIdentity();
  applySettingsToUI();
  updateDiagnostics();
  showScreen('app');
  setMobileView('list');

  try {
    await Promise.all([loadConversations(), loadContacts(), loadCalls()]);
  } catch (err) {
    toast('Could not load your data — check the connection', 'error');
  }

  connectSocket();

  // ICE কনফিগ + রিং টাইমআউট সার্ভার থেকে নিয়ে ক্যাশ করি
  getIceServersSafe();

  if (state.settings.desktopNotifications) requestNotificationPermission();
}

// ═══════════════════════════════════════════════════════════════════
//  SOCKET.IO সংযোগ
// ═══════════════════════════════════════════════════════════════════
function connectSocket() {
  if (state.socket && (state.socket.connected || state.socket.connecting)) return;

  const socket = window.io({ autoConnect: true, transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    state.connected = true;
    setConnectionState('online', 'Connected');
  });

  socket.on('disconnect', (reason) => {
    state.connected = false;
    setConnectionState('offline', 'Reconnecting…');
    if (reason === 'io server disconnect') socket.connect(); // সার্ভার কেটে দিলে নিজে পুনঃসংযোগ
  });

  socket.on('connect_error', () => setConnectionState('offline', 'Connection error'));

  socket.on('ready', (payload) => {
    if (payload && Array.isArray(payload.delivered)) {
      // সার্ভার ইতিমধ্যে কিছু মেসেজ delivered করেছে — লোকাল স্ট্যাটাস আপডেট
    }
  });

  // ── চ্যাট ইভেন্ট ──────────────────────────────────────────────
  socket.on(EV.RECEIVE, onMessageReceived);
  socket.on(EV.TYPING, onPeerTyping);
  socket.on(EV.STOP_TYPING, onPeerStopTyping);
  socket.on(EV.DELIVERED, onMessagesDelivered);
  socket.on(EV.READ, onMessagesRead);
  socket.on(EV.EDIT, onMessageEdited);
  socket.on(EV.DELETE, onMessageDeletedBroadcast);
  socket.on(EV.PRESENCE, onPresenceUpdate);
  socket.on(EV.ONLINE, (p) => onPresenceUpdate({ ...p, isOnline: true }));
  socket.on(EV.OFFLINE, (p) => onPresenceUpdate({ ...p, isOnline: false }));
  socket.on(EV.CONV_CREATED, () => loadConversations());
  socket.on(EV.USER_UPDATED, onUserUpdated);
  socket.on(EV.MISS_CALL, onMissedCallNotification);

  // ── কল ইভেন্ট ─────────────────────────────────────────────────
  socket.on(EV.INCOMING, onIncomingCall);
  socket.on(EV.RINGING, () => {});
  socket.on(EV.CALL_ACCEPTED, onCallAccepted);
  socket.on(EV.OFFER, onCallOffer);
  socket.on(EV.ANSWER, onCallAnswer);
  socket.on(EV.ICE, onCallIceCandidate);
  socket.on(EV.CONNECTED, () => onCallMediaConnected());
  socket.on(EV.END, onCallEnded);
  socket.on(EV.TIMEOUT, onCallTimedOut);
  socket.on(EV.BUSY, onCallBusy);
  socket.on(EV.HANDLED, onCallHandledElsewhere);
}

/** ack সহ socket emit (টাইমআউট সহ) */
function emitAck(event, payload, timeout = 8000) {
  return new Promise((resolve) => {
    if (!state.socket || !state.socket.connected) {
      resolve(null);
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeout);
    state.socket.emit(event, payload, (res) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(res);
      }
    });
  });
}

function emit(event, payload) {
  if (state.socket && state.socket.connected) state.socket.emit(event, payload);
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH UI
// ═══════════════════════════════════════════════════════════════════
function bindAuthUI() {
  const loginTab = $('#tabLogin');
  const registerTab = $('#tabRegister');
  const loginForm = $('#loginForm');
  const registerForm = $('#registerForm');

  const showLogin = () => {
    loginTab.classList.add('is-active');
    registerTab.classList.remove('is-active');
    loginForm.hidden = false;
    registerForm.hidden = true;
    loginTab.setAttribute('aria-selected', 'true');
    registerTab.setAttribute('aria-selected', 'false');
  };
  const showRegister = () => {
    registerTab.classList.add('is-active');
    loginTab.classList.remove('is-active');
    registerForm.hidden = false;
    loginForm.hidden = true;
    registerTab.setAttribute('aria-selected', 'true');
    loginTab.setAttribute('aria-selected', 'false');
  };
  loginTab.addEventListener('click', showLogin);
  registerTab.addEventListener('click', showRegister);

  // ডেমো অ্যাকাউন্ট দিয়ে ফোন পূরণ
  $$('.demo-fill').forEach((btn) =>
    btn.addEventListener('click', () => {
      $('#loginPhone').value = btn.dataset.phone;
      $('#loginPassword').value = 'nexa1234';
      showLogin();
    })
  );

  // রেজিস্ট্রেশন অ্যাভাটার পিকার
  const avatarBtn = $('#registerAvatarBtn');
  const avatarInput = $('#registerAvatarInput');
  avatarBtn.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      registerAvatarBlob = await downscaleImage(file, 512, 0.85);
      const url = URL.createObjectURL(registerAvatarBlob);
      const preview = $('#registerAvatarPreview');
      preview.src = url;
      preview.hidden = false;
      $('#registerAvatarIcon').hidden = true;
      $('#registerAvatarClear').hidden = false;
    } catch (err) {
      toast('Could not read that image', 'error');
    }
  });
  $('#registerAvatarClear').addEventListener('click', () => {
    registerAvatarBlob = null;
    const preview = $('#registerAvatarPreview');
    preview.src = '';
    preview.hidden = true;
    $('#registerAvatarIcon').hidden = false;
    $('#registerAvatarClear').hidden = true;
    avatarInput.value = '';
  });

  loginForm.addEventListener('submit', onLogin);
  registerForm.addEventListener('submit', onRegister);
}

async function onLogin(event) {
  event.preventDefault();
  const phone = $('#loginPhone').value.trim();
  const password = $('#loginPassword').value;
  if (!phone || !password) {
    showFormError('#loginError', 'Phone and password are required');
    return;
  }
  setLoading($('#loginSubmit'), true);
  showFormError('#loginError', '');
  try {
    const { user } = await api.auth.login(phone, password);
    await startApp(user);
  } catch (err) {
    showFormError('#loginError', err.message || 'Login failed');
  } finally {
    setLoading($('#loginSubmit'), false);
  }
}

async function onRegister(event) {
  event.preventDefault();
  const name = $('#registerName').value.trim();
  const phone = $('#registerPhone').value.trim();
  const password = $('#registerPassword').value;
  const about = $('#registerAbout').value.trim();

  if (name.length < 2) return showFormError('#registerError', 'Name must be at least 2 characters');
  if (!phone) return showFormError('#registerError', 'Phone number is required');
  if (password.length < 4) return showFormError('#registerError', 'Password must be at least 4 characters');

  setLoading($('#registerSubmit'), true);
  showFormError('#registerError', '');
  try {
    const { user } = await api.auth.register({
      name,
      phone,
      password,
      about,
      avatarBlob: registerAvatarBlob
    });
    await startApp(user);
  } catch (err) {
    showFormError('#registerError', err.message || 'Registration failed');
  } finally {
    setLoading($('#registerSubmit'), false);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SIDEBAR + TABS
// ═══════════════════════════════════════════════════════════════════
function bindSidebarUI() {
  $('#newChatBtn').addEventListener('click', () => openNewChat());
  $('#syncContactsBtn').addEventListener('click', () => openModal('#contactSyncModal'));
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#logoutBtn').addEventListener('click', doLogout);

  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  );

  const search = $('#sidebarSearch');
  search.addEventListener('input', debounce(() => filterSidebar(search.value.trim()), 120));
  search.addEventListener('focus', () => {});
  $('#sidebarSearchClear').addEventListener('click', () => {
    search.value = '';
    filterSidebar('');
    search.focus();
  });

  $('#emptyNewChatBtn').addEventListener('click', () => openNewChat());
  $('#emptySyncBtn').addEventListener('click', () => openModal('#contactSyncModal'));
  $('#backToListBtn').addEventListener('click', () => setMobileView('list'));
  $('#chatsBadge').textContent = '';
}

function switchTab(tabName) {
  $$('.tab').forEach((t) => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $('#chatsPane').hidden = tabName !== 'chats';
  $('#contactsPane').hidden = tabName !== 'contacts';
  $('#callsPane').hidden = tabName !== 'calls';
}

function updateUnreadBadge() {
  const total = totalUnread();
  const badge = $('#chatsBadge');
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  কনভারসেশন লোড + রেন্ডার
// ═══════════════════════════════════════════════════════════════════
async function loadConversations() {
  setSkeleton('#chatSkeleton', true);
  try {
    const { conversations } = await api.conversations.list();
    conversations.forEach((conversation) => upsertConversation(conversation));
    renderConversationList();
  } catch (err) {
    toast('Could not load chats', 'error');
  } finally {
    setSkeleton('#chatSkeleton', false);
  }
}

function renderConversationList() {
  const list = $('#chatList');
  const items = sortedConversations();
  list.innerHTML = '';
  if (!items.length) {
    $('#chatsEmpty').hidden = false;
  } else {
    $('#chatsEmpty').hidden = true;
    for (const conversation of items) {
      list.appendChild(buildConversationEl(conversation));
    }
  }
  updateUnreadBadge();
}

function buildConversationEl(conversation) {
  const partner = conversation.partner || {};
  const last = conversation.lastMessage;
  const li = document.createElement('li');
  li.className = 'chat-item' + (conversation.id === state.activeConversationId ? ' active' : '');
  li.dataset.conversationId = conversation.id;
  li.dataset.search = `${partner.name || ''} ${partner.phone || ''} ${last?.content || ''}`.toLowerCase();

  const avatarSpan = document.createElement('span');
  avatarSpan.className = 'avatar avatar-sm';
  setAvatar(avatarSpan, partner);

  const preview = last
    ? (last.deleted === 'everyone'
        ? 'Message deleted'
        : last.type === 'image'
          ? '📷 Photo'
          : last.type === 'audio'
            ? '🎙️ Voice message'
            : last.type === 'file'
              ? '📄 File'
              : (last.content || '').slice(0, 60))
    : 'No messages yet';

  const isOut = last && last.senderId === state.me?.id;
  li.innerHTML = `
    <span class="chat-item-avatar"></span>
    <span class="chat-item-body">
      <span class="chat-item-top">
        <strong class="chat-item-name"></strong>
        <span class="chat-item-time">${formatListTime(last?.createdAt || conversation.updatedAt)}</span>
      </span>
      <span class="chat-item-bottom">
        <span class="chat-item-preview ellipsis">${isOut ? 'You: ' : ''}${escapeHtml(preview)}</span>
        ${conversation.unreadCount ? `<span class="chat-item-unread">${conversation.unreadCount}</span>` : ''}
      </span>
    </span>`;
  li.querySelector('.chat-item-avatar').replaceWith(avatarSpan);
  li.querySelector('.chat-item-name').textContent = partner.name || prettyPhone(partner.phone) || 'Unknown';

  li.addEventListener('click', () => openConversation(conversation.id));
  return li;
}

/** সাইডবার সার্চ — কনভারসেশন + কনট্যাক্ট ফিল্টার */
function filterSidebar(query) {
  const q = query.toLowerCase();
  $('#sidebarSearchClear').hidden = !q;
  $$('#chatList .chat-item').forEach((el) => {
    el.hidden = q && !String(el.dataset.search || '').includes(q);
  });
  // কনট্যাক্ট পেনেও ফিল্টার
  $$('#registeredList .contact-item, #unregisteredList .contact-item').forEach((el) => {
    el.hidden = q && !String(el.dataset.search || '').includes(q);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  চ্যাট ওপেন + মেসেজ লোড
// ═══════════════════════════════════════════════════════════════════
async function openConversation(conversationId, { markRead = true } = {}) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;

  state.activeConversationId = conversationId;
  setMobileView('chat');

  // লিস্টে active হাইলাইট
  $$('#chatList .chat-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.conversationId === conversationId)
  );

  renderChatHeader(conversation);
  $('#chatEmpty').hidden = true;
  $('#chatView').hidden = false;

  // আগে লোড করা আছে কি?
  const loaded = messageMap(conversationId).size;
  if (!loaded) {
    setSkeleton('#messagesSkeleton', true);
    $('#conversationEmpty').hidden = true;
    try {
      await loadMessages(conversationId);
    } finally {
      setSkeleton('#messagesSkeleton', false);
    }
  } else {
    renderAllMessages(conversationId);
  }

  if (markRead) markConversationRead(conversationId);
  focusComposer();
}

function renderChatHeader(conversation) {
  const partner = conversation.partner || {};
  setAvatar($('#chatAvatar'), partner);
  $('#chatName').textContent = partner.name || prettyPhone(partner.phone) || 'Unknown';
  updatePresenceText(partner);
}

function updatePresenceText(partner) {
  if (!partner) return;
  const text = partner.presenceHidden
    ? ''
    : partner.isOnline
      ? 'online'
      : partner.lastSeen
        ? `last seen ${formatRelative(partner.lastSeen)}`
        : 'offline';
  $('#chatStatus').textContent = text;
}

async function loadMessages(conversationId, { before = 0 } = {}) {
  const { messages, hasMore } = await api.conversations.messages(conversationId, { limit: 40, before });
  messages.forEach((message) => putMessage(message));
  state.hasMore.set(conversationId, hasMore);
  renderAllMessages(conversationId);
  if (before) {
    $('#loadOlderBtn').hidden = !hasMore;
  } else {
    $('#loadOlderBtn').hidden = !hasMore;
    scrollToBottom(true);
  }
}

async function loadOlder() {
  const conversationId = state.activeConversationId;
  if (!conversationId || !state.hasMore.get(conversationId)) return;
  const sorted = sortedMessages(conversationId);
  const earliest = sorted.length ? sorted[0].createdAt : Date.now();
  const scroller = $('#messageScroller');
  const prevHeight = scroller.scrollHeight;
  const prevTop = scroller.scrollTop;
  try {
    const { messages } = await api.conversations.messages(conversationId, { limit: 40, before: earliest - 1 });
    if (!messages.length) {
      state.hasMore.set(conversationId, false);
      $('#loadOlderBtn').hidden = true;
      return;
    }
    messages.forEach((message) => putMessage(message));
    renderAllMessages(conversationId);
    // পুরনো মেসেজ ওপরে যোগ হওয়ায় স্ক্রল পজিশন ধরে রাখি
    const newHeight = scroller.scrollHeight;
    scroller.scrollTop = prevTop + (newHeight - prevHeight);
  } catch (err) {
    toast('Could not load older messages', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  মেসেজ রেন্ডার
// ═══════════════════════════════════════════════════════════════════
function isOutgoing(message) {
  return message.senderId === state.me?.id;
}

function renderAllMessages(conversationId) {
  const list = $('#messageList');
  list.innerHTML = '';
  messageEls.clear();

  const sorted = sortedMessages(conversationId);
  $('#conversationEmpty').hidden = sorted.length > 0;

  let lastDay = null;
  for (const message of sorted) {
    const day = new Date(message.createdAt).toDateString();
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.innerHTML = `<span>${escapeHtml(formatDayLabel(message.createdAt))}</span>`;
      list.appendChild(sep);
      lastDay = day;
    }
    list.appendChild(buildMessageEl(message));
  }
  scrollToBottom(true);
}

function buildMessageEl(message) {
  const wrap = document.createElement('div');
  wrap.className = 'message ' + (isOutgoing(message) ? 'out' : 'in');
  if (message.status === 'failed') wrap.classList.add('failed');
  if (message.deleted === 'everyone') wrap.classList.add('deleted');
  wrap.dataset.messageId = message.id;

  const replyHtml = message.replyTo
    ? `<div class="msg-reply" data-reply="${escapeHtml(message.replyTo.id || '')}">
         <span class="msg-reply-name">${escapeHtml(message.replyTo.senderName || '')}</span>
         <span class="msg-reply-text ellipsis">${escapeHtml(message.replyTo.content || message.replyTo.preview || '')}</span>
       </div>`
    : '';

  const body = renderMessageBody(message);

  const statusIcon = isOutgoing(message) ? `<span class="msg-ticks" data-status="${message.status || 'sent'}">${ticksFor(message.status)}</span>` : '';
  const edited = message.editedAt ? '<span class="msg-edited" title="Edited"> (edited)</span>' : '';

  wrap.innerHTML = `
    ${replyHtml}
    <div class="msg-bubble">${body}</div>
    <div class="msg-meta">
      <span class="msg-time">${formatTime(message.createdAt)}</span>
      ${edited}
      ${statusIcon}
    </div>`;

  messageEls.set(message.id, wrap);
  return wrap;
}

function renderMessageBody(message) {
  if (message.deleted === 'everyone') {
    return '<span class="msg-deleted-text">This message was deleted</span>';
  }
  switch (message.type) {
    case 'image': {
      const url = message.mediaUrl;
      const meta = message.mediaMeta || {};
      return `<button class="msg-media-image" aria-label="Open image"><img loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(meta.name || 'image')}" /></button>
              ${message.content ? `<div class="msg-caption">${linkify(message.content)}</div>` : ''}`;
    }
    case 'audio': {
      const meta = message.mediaMeta || {};
      return `<div class="msg-audio">
                <span class="msg-audio-icon" aria-hidden="true">🎙️</span>
                <audio controls preload="metadata" src="${escapeHtml(message.mediaUrl)}"></audio>
                <span class="msg-audio-dur mono">${formatDuration(meta.duration || 0)}</span>
              </div>
              ${message.content ? `<div class="msg-caption">${linkify(message.content)}</div>` : ''}`;
    }
    case 'file': {
      const meta = message.mediaMeta || {};
      return `<a class="msg-file" href="${escapeHtml(message.mediaUrl)}" target="_blank" rel="noopener noreferrer">
                <span class="msg-file-icon" aria-hidden="true">📄</span>
                <span class="msg-file-body">
                  <strong class="ellipsis">${escapeHtml(meta.name || 'file')}</strong>
                  <small class="muted">${formatBytes(meta.size || 0)}</small>
                </span>
                <span class="msg-file-download" aria-hidden="true">↓</span>
              </a>
              ${message.content ? `<div class="msg-caption">${linkify(message.content)}</div>` : ''}`;
    }
    case 'system':
      return `<span class="msg-system-text">${escapeHtml(message.content || '')}</span>`;
    default:
      return `<div class="msg-text">${linkify(message.content || '')}</div>`;
  }
}

function ticksFor(status) {
  switch (status) {
    case 'sending':
      return '🕓';
    case 'sent':
      return '✓';
    case 'delivered':
      return '✓✓';
    case 'read':
      return '✓✓';
    case 'failed':
      return '⚠';
    default:
      return '';
  }
}

function updateMessageEl(messageId) {
  const message = getMessage(state.activeConversationId, messageId);
  if (!message) return;
  const old = messageEls.get(messageId);
  const fresh = buildMessageEl(message);
  if (old && old.parentNode) old.replaceWith(fresh);
  else $('#messageList').appendChild(fresh);
}

function scrollToBottom(force) {
  const scroller = $('#messageScroller');
  if (force || scrollAtBottom) {
    scroller.scrollTop = scroller.scrollHeight;
    scrollAtBottom = true;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  মেসেজ পাঠানো
// ═══════════════════════════════════════════════════════════════════
function bindChatUI() {
  const composer = $('#composerInput');
  composer.addEventListener('input', onComposerInput);
  composer.addEventListener('keydown', onComposerKeydown);
  composer.addEventListener('paste', onComposerPaste);

  $('#sendBtn').addEventListener('click', () => sendComposer());
  $('#micBtn').addEventListener('click', toggleRecording);
  $('#emojiBtn').addEventListener('click', toggleEmojiPicker);
  $('#attachBtn').addEventListener('click', toggleAttachMenu);

  $$('#attachMenu [data-attach]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const kind = btn.dataset.attach;
      if (kind === 'image') $('#imageFileInput').click();
      else $('#docFileInput').click();
      closeAttachMenu();
    })
  );

  $('#imageFileInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) openImageEditor(file, { onSend: sendImageBlob });
    event.target.value = '';
  });
  $('#docFileInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) openFileConfirm(file);
    event.target.value = '';
  });

  $('#replyCancel').addEventListener('click', clearReply);
  $('#editCancel').addEventListener('click', cancelEdit);

  $('#recordCancel').addEventListener('click', cancelRecording);
  $('#recordStop').addEventListener('click', stopRecording);
  $('#voiceDiscard').addEventListener('click', discardVoice);
  $('#voiceSend').addEventListener('click', sendVoice);

  // ইন-চ্যাট সার্চ
  $('#searchInChatBtn').addEventListener('click', toggleChatSearch);
  $('#chatSearchClose').addEventListener('click', () => {
    $('#chatSearchBar').hidden = true;
    $('#chatSearchInput').value = '';
    $('#chatSearchResults').innerHTML = '';
  });
  $('#chatSearchInput').addEventListener('input', debounce(onChatSearch, 250));
  $('#loadOlderBtn').addEventListener('click', loadOlder);

  // পার্টনার ইনফো
  $('#partnerInfoBtn').addEventListener('click', openInfoPanel);
  $('#audioCallBtn').addEventListener('click', () => startCallFromChat('audio'));
  $('#videoCallBtn').addEventListener('click', () => startCallFromChat('video'));

  // স্ক্রল ট্র্যাকিং (নিচে আছে কি না)
  $('#messageScroller').addEventListener('scroll', () => {
    const scroller = $('#messageScroller');
    scrollAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  });

  // মেসেজ লিস্টে ক্লিক ডেলিগেশন
  $('#messageList').addEventListener('click', onMessageListClick);
}

function onComposerInput() {
  const composer = $('#composerInput');
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  if (composer.value.trim()) notifyTyping();
}

function onComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendComposer();
  }
}

function onComposerPaste(event) {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        openImageEditor(file, { onSend: sendImageBlob });
      }
      break;
    }
  }
}

const notifyTyping = throttle(() => {
  if (state.activeConversationId) emit(EV.TYPING, { conversationId: state.activeConversationId });
}, 2000);

function stopTyping() {
  if (state.activeConversationId) emit(EV.STOP_TYPING, { conversationId: state.activeConversationId });
}

async function sendComposer() {
  const composer = $('#composerInput');
  const text = composer.value.trim();

  if (state.editing) {
    return editCurrentMessage(text);
  }
  if (!text) return;

  const conversationId = state.activeConversationId;
  if (!conversationId) return;

  const replyTo = state.replyTo ? { id: state.replyTo.id } : null;
  const tid = tempId();
  const optimistic = {
    id: tid,
    conversationId,
    senderId: state.me.id,
    receiverId: getConversation(conversationId)?.partner?.id,
    type: 'text',
    content: text,
    status: 'sending',
    createdAt: Date.now(),
    replyTo: state.replyTo
      ? { id: state.replyTo.id, senderName: state.replyTo.senderName, content: state.replyTo.content }
      : null
  };
  putMessage(optimistic);
  renderAllMessages(conversationId);
  composer.value = '';
  composer.style.height = 'auto';
  stopTyping();
  clearReply();

  const server = await deliverMessage(
    { conversationId, type: 'text', content: text, replyTo: state.replyTo?.id || null },
    optimistic
  );
  if (!server) {
    optimistic.status = 'failed';
    updateMessageEl(tid);
  }
}

async function deliverMessage(payload, optimistic) {
  let serverMsg = null;
  if (state.socket && state.socket.connected) {
    const ack = await emitAck(EV.SEND, payload);
    if (ack && ack.ok) serverMsg = ack.message;
  }
  if (!serverMsg) {
    try {
      const res = await api.messages.send(payload);
      serverMsg = res.message;
    } catch {
      serverMsg = null;
    }
  }
  if (serverMsg) {
    // optimistic এন্ট্রি সার্ভারের আইডি দিয়ে বদলে দিই (DOM-ও সরাই)
    if (optimistic && optimistic.id !== serverMsg.id) {
      removeMessage(payload.conversationId, optimistic.id);
      const oldEl = messageEls.get(optimistic.id);
      if (oldEl) oldEl.remove();
      messageEls.delete(optimistic.id);
    }
    putMessage(serverMsg);
    updateMessageEl(serverMsg.id);
    bumpConversationLastMessage(serverMsg);
  }
  return serverMsg;
}

function bumpConversationLastMessage(message) {
  const conversation = getConversation(message.conversationId);
  if (conversation) {
    conversation.lastMessage = message;
    conversation.updatedAt = message.createdAt;
    renderConversationList();
  }
}

// মেসেজ লিস্ট ক্লিক: ছবি লাইটবক্স, ফেইল্ড রিট্রাই, রিপ্লাই জাম্প
function onMessageListClick(event) {
  const imgBtn = event.target.closest('.msg-media-image');
  if (imgBtn) {
    const src = imgBtn.querySelector('img').src;
    openLightbox(src, 'image');
    return;
  }
  const failed = event.target.closest('.message.failed');
  if (failed) {
    retryMessage(failed.dataset.messageId);
    return;
  }
  const reply = event.target.closest('.msg-reply');
  if (reply && reply.dataset.reply) {
    const target = messageEls.get(reply.dataset.reply);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1200);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  মেসেজ রিসিভ + রিসিপ্ট হ্যান্ডলার
// ═══════════════════════════════════════════════════════════════════
function onMessageReceived(message) {
  if (!message || !message.conversationId) return;
  const isNew = !getMessage(message.conversationId, message.id);
  putMessage(message);

  // সিস্টেম মেসেজ (কল হিস্ট্রি ইত্যাদি)
  const conversation = getConversation(message.conversationId);
  if (conversation) {
    conversation.lastMessage = message;
    conversation.updatedAt = message.createdAt;
    if (message.senderId !== state.me?.id) {
      if (state.activeConversationId !== message.conversationId || !state.windowFocused) {
        conversation.unreadCount = (conversation.unreadCount || 0) + 1;
      }
    }
    renderConversationList();
  } else {
    // অজানা কনভারসেশন — রিফ্রেশ
    loadConversations();
  }

  if (message.conversationId === state.activeConversationId) {
    if (isNew) renderAllMessages(message.conversationId);
    // অ্যাক্টিভ + ফোকাসড হলে স্বয়ংক্রিয় read
    if (message.senderId !== state.me?.id && state.windowFocused) {
      markConversationRead(message.conversationId);
    }
    notifyNewMessage(message);
  } else if (message.senderId !== state.me?.id) {
    notifyNewMessage(message);
  }
}

function notifyNewMessage(message) {
  const partner = getConversation(message.conversationId)?.partner;
  if (state.settings.messageSound && !state.windowFocused) beep(660, 90);
  if (state.settings.desktopNotifications && document.hidden) {
    try {
      const n = new Notification(partner?.name || 'New message', {
        body: message.type === 'text' ? message.content : `${message.type} message`,
        tag: message.conversationId
      });
      n.onclick = () => {
        window.focus();
        openConversation(message.conversationId);
      };
    } catch {
      /* নটিফিকেশন ব্লক করা থাকলে উপেক্ষা */
    }
  }
}

function onMessagesDelivered({ conversationId, ids }) {
  if (!conversationId || !ids) return;
  for (const id of ids) {
    const message = getMessage(conversationId, id);
    if (message && message.status !== 'read') {
      message.status = 'delivered';
      if (message.id === state.activeConversationId || true) updateMessageEl(id);
    }
  }
}

function onMessagesRead({ conversationId, ids }) {
  if (!conversationId || !ids) return;
  for (const id of ids) {
    const message = getMessage(conversationId, id);
    if (message && message.status !== 'read') {
      message.status = 'read';
      updateMessageEl(id);
    }
  }
}

function onMessageEdited(message) {
  if (!message || !message.conversationId) return;
  putMessage(message);
  if (message.conversationId === state.activeConversationId) updateMessageEl(message.id);
  const conversation = getConversation(message.conversationId);
  if (conversation && conversation.lastMessage && conversation.lastMessage.id === message.id) {
    conversation.lastMessage = message;
    renderConversationList();
  }
}

function onMessageDeletedBroadcast({ messageId, conversationId, scope }) {
  if (scope !== 'everyone') return; // 'me' কেবল ডিলিটকারী নিজে হ্যান্ডেল করে
  const message = getMessage(conversationId, messageId);
  if (!message) return;
  message.deleted = 'everyone';
  if (conversationId === state.activeConversationId) updateMessageEl(messageId);
}

// ═══════════════════════════════════════════════════════════════════
//  টাইপিং ইনডিকেটর
// ═══════════════════════════════════════════════════════════════════
function onPeerTyping({ conversationId, userId, name }) {
  if (conversationId !== state.activeConversationId || userId === state.me?.id) return;
  showTyping(name || 'Someone');
}
function onPeerStopTyping({ conversationId, userId }) {
  if (conversationId !== state.activeConversationId) return;
  hideTyping();
}
function showTyping(name) {
  $('#typingText').textContent = `${name} is typing…`;
  $('#typingIndicator').hidden = false;
}
function hideTyping() {
  $('#typingIndicator').hidden = true;
}

// ═══════════════════════════════════════════════════════════════════
//  PRESENCE + USER UPDATES
// ═══════════════════════════════════════════════════════════════════
function onPresenceUpdate(payload) {
  if (!payload || !payload.userId) return;
  const user = getUser(payload.userId) || {};
  const updated = { ...user, isOnline: !!payload.isOnline, lastSeen: payload.lastSeen ?? user.lastSeen };
  cacheUser(updated);

  // অ্যাক্টিভ চ্যাটের হেডার
  const conversation = findConversationByPartner(payload.userId);
  if (conversation && conversation.id === state.activeConversationId) {
    updatePresenceText(updated);
  }
  // কনভারসেশন লিস্টে অ্যাভাটার/স্ট্যাটাস
  renderConversationList();
  // ইনফো প্যানেল
  if (infoUser && infoUser.id === payload.userId) {
    infoUser = { ...infoUser, ...updated };
    renderInfoPanel(infoUser);
  }
}

function onUserUpdated(user) {
  if (!user || !user.id) return;
  cacheUser(user);
  if (user.id === state.me?.id) {
    state.me = { ...state.me, ...user };
    renderMyIdentity();
    populateSettings();
  }
  const conversation = findConversationByPartner(user.id);
  if (conversation) {
    conversation.partner = { ...conversation.partner, ...user };
    renderConversationList();
    if (conversation.id === state.activeConversationId) renderChatHeader(conversation);
  }
  if (infoUser && infoUser.id === user.id) {
    infoUser = { ...infoUser, ...user };
    renderInfoPanel(infoUser);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  রিড রিসিপ্ট পাঠানো
// ═══════════════════════════════════════════════════════════════════
function markConversationRead(conversationId) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  const hadUnread = conversation.unreadCount > 0;
  conversation.unreadCount = 0;
  if (hadUnread) renderConversationList();
  emit(EV.READ, { conversationId });
  api.conversations.markRead(conversationId).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
//  রিপ্লাই + এডিট
// ═══════════════════════════════════════════════════════════════════
function setReply(messageId) {
  const message = getMessage(state.activeConversationId, messageId);
  if (!message || message.deleted === 'everyone') return;
  state.replyTo = {
    id: message.id,
    senderName: isOutgoing(message) ? 'You' : getConversation(state.activeConversationId)?.partner?.name || 'Them',
    content: message.type === 'text' ? message.content : message.type
  };
  $('#replyToName').textContent = state.replyTo.senderName;
  $('#replyToText').textContent = message.type === 'text' ? message.content : message.type;
  $('#replyBar').hidden = false;
  cancelEdit();
  focusComposer();
}
function clearReply() {
  state.replyTo = null;
  $('#replyBar').hidden = true;
}

function startEdit(messageId) {
  const message = getMessage(state.activeConversationId, messageId);
  if (!message || message.type !== 'text' || message.senderId !== state.me?.id) return;
  state.editing = messageId;
  clearReply();
  const composer = $('#composerInput');
  composer.value = message.content;
  composer.focus();
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  $('#editOriginalText').textContent = message.content;
  $('#editBar').hidden = false;
}
function cancelEdit() {
  state.editing = null;
  $('#editBar').hidden = true;
  const composer = $('#composerInput');
  if (!state.replyTo) {
    composer.value = '';
    composer.style.height = 'auto';
  }
}
async function editCurrentMessage(text) {
  const id = state.editing;
  if (!id) return;
  cancelEdit();
  if (!text) return;
  try {
    await api.messages.edit(id, text);
    // সার্ভার থেকে message:edited ব্রডকাস্ট আসবে — এখানে optimistic
    const message = getMessage(state.activeConversationId, id);
    if (message) {
      message.content = text;
      message.editedAt = Date.now();
      updateMessageEl(id);
    }
  } catch (err) {
    toast(err.message || 'Could not edit message', 'error');
  }
}

async function retryMessage(messageId) {
  const message = getMessage(state.activeConversationId, messageId);
  if (!message) return;
  const payload = { conversationId: message.conversationId, type: message.type, content: message.content };
  message.status = 'sending';
  updateMessageEl(messageId);
  await deliverMessage(payload, message);
}

// ═══════════════════════════════════════════════════════════════════
//  মেসেজ ডিলিট
// ═══════════════════════════════════════════════════════════════════
async function deleteMessage(messageId, scope) {
  const message = getMessage(state.activeConversationId, messageId);
  if (!message) return;
  try {
    await api.messages.remove(messageId, scope);
    if (scope === 'me') {
      removeMessage(message.conversationId, messageId);
      const el = messageEls.get(messageId);
      if (el) el.remove();
      messageEls.delete(messageId);
    } else {
      message.deleted = 'everyone';
      updateMessageEl(messageId);
    }
  } catch (err) {
    toast(err.message || 'Could not delete message', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  মিডিয়া পাঠানো (ছবি / ভয়েস / ফাইল)
// ═══════════════════════════════════════════════════════════════════
async function sendImageBlob(blob, caption) {
  const conversationId = state.activeConversationId;
  if (!conversationId) return;
  const tid = tempId();
  const optimistic = {
    id: tid,
    conversationId,
    senderId: state.me.id,
    type: 'image',
    content: caption || '',
    mediaUrl: URL.createObjectURL(blob),
    status: 'sending',
    createdAt: Date.now()
  };
  putMessage(optimistic);
  renderAllMessages(conversationId);

  try {
    const file = await api.upload.image(blob, 'image.jpg');
    const payload = {
      conversationId,
      type: 'image',
      content: caption || '',
      mediaUrl: file.url,
      mediaMeta: { name: file.name, size: file.size, mime: file.mime }
    };
    const server = await deliverMessage(payload, optimistic);
    if (!server) {
      optimistic.status = 'failed';
      updateMessageEl(tid);
    }
  } catch (err) {
    toast(err.message || 'Image upload failed', 'error');
    optimistic.status = 'failed';
    updateMessageEl(tid);
  }
}

async function sendFileMessage(file) {
  const conversationId = state.activeConversationId;
  if (!conversationId) return;
  const caption = $('#fileCaption').value.trim();
  closeModal('#fileConfirmModal');
  const tid = tempId();
  const optimistic = {
    id: tid,
    conversationId,
    senderId: state.me.id,
    type: 'file',
    content: caption,
    mediaUrl: URL.createObjectURL(file),
    status: 'sending',
    createdAt: Date.now(),
    mediaMeta: { name: file.name, size: file.size, mime: file.type }
  };
  putMessage(optimistic);
  renderAllMessages(conversationId);
  try {
    const uploaded = await api.upload.file(file);
    const payload = {
      conversationId,
      type: 'file',
      content: caption,
      mediaUrl: uploaded.url,
      mediaMeta: { name: uploaded.name, size: uploaded.size, mime: uploaded.mime }
    };
    const server = await deliverMessage(payload, optimistic);
    if (!server) {
      optimistic.status = 'failed';
      updateMessageEl(tid);
    }
  } catch (err) {
    toast(err.message || 'File upload failed', 'error');
    optimistic.status = 'failed';
    updateMessageEl(tid);
  }
}

async function sendVoice() {
  if (!pendingVoice) return;
  const conversationId = state.activeConversationId;
  if (!conversationId) return;
  const { blob, duration } = pendingVoice;
  pendingVoice = null;
  $('#voicePreview').hidden = true;
  const tid = tempId();
  const optimistic = {
    id: tid,
    conversationId,
    senderId: state.me.id,
    type: 'audio',
    mediaUrl: URL.createObjectURL(blob),
    status: 'sending',
    createdAt: Date.now(),
    mediaMeta: { duration }
  };
  putMessage(optimistic);
  renderAllMessages(conversationId);
  try {
    const uploaded = await api.upload.audio(blob, 'voice.webm');
    const payload = {
      conversationId,
      type: 'audio',
      mediaUrl: uploaded.url,
      mediaMeta: { name: uploaded.name, size: uploaded.size, mime: uploaded.mime, duration }
    };
    const server = await deliverMessage(payload, optimistic);
    if (!server) {
      optimistic.status = 'failed';
      updateMessageEl(tid);
    }
  } catch (err) {
    toast(err.message || 'Voice upload failed', 'error');
    optimistic.status = 'failed';
    updateMessageEl(tid);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ভয়েস রেকর্ডার
// ═══════════════════════════════════════════════════════════════════
async function toggleRecording() {
  if (recorder) {
    stopRecording();
    return;
  }
  try {
    recorder = new VoiceRecorder();
    recorder.onTick = (seconds) => {
      $('#recordingTime').textContent = formatDuration(seconds);
    };
    await recorder.start();
    $('#recordingBar').hidden = false;
    $('#recordingTime').textContent = '0:00';
    $('#micBtn').setAttribute('aria-pressed', 'true');
  } catch (err) {
    toast('Microphone access denied', 'error');
    recorder = null;
  }
}
async function stopRecording() {
  if (!recorder) return;
  $('#recordingBar').hidden = true;
  $('#micBtn').setAttribute('aria-pressed', 'false');
  try {
    const result = await recorder.stop();
    recorder = null;
    if (!result) return;
    pendingVoice = result;
    const audio = $('#voicePreviewAudio');
    audio.src = URL.createObjectURL(result.blob);
    $('#voicePreviewTime').textContent = formatDuration(result.duration);
    $('#voicePreview').hidden = false;
  } catch {
    recorder = null;
  }
}
function cancelRecording() {
  if (recorder) recorder.cancel();
  recorder = null;
  $('#recordingBar').hidden = true;
  $('#micBtn').setAttribute('aria-pressed', 'false');
}
function discardVoice() {
  pendingVoice = null;
  $('#voicePreview').hidden = true;
  $('#voicePreviewAudio').src = '';
}

// ═══════════════════════════════════════════════════════════════════
//  EMOJI + ATTACH MENU
// ═══════════════════════════════════════════════════════════════════
const EMOJIS = ['😀', '😂', '🥰', '😍', '🤔', '😎', '😭', '😡', '👍', '👎', '🙏', '👏', '🔥', '💯', '❤️', '💔', '🎉', '🎶', '✨', '🌟', '😴', '🤝', '👋', '💪', '🍻', '☕', '🌹', '⚡', '✅', '❌'];

function toggleEmojiPicker() {
  const picker = $('#emojiPicker');
  if (!picker.dataset.built) {
    picker.innerHTML = EMOJIS.map((e) => `<button type="button" class="emoji-item">${e}</button>`).join('');
    picker.dataset.built = '1';
    picker.addEventListener('click', (event) => {
      const btn = event.target.closest('.emoji-item');
      if (btn) insertAtCursor($('#composerInput'), btn.textContent);
    });
  }
  picker.hidden = !picker.hidden;
  closeAttachMenu();
}
function toggleAttachMenu() {
  const menu = $('#attachMenu');
  menu.hidden = !menu.hidden;
  $('#emojiPicker').hidden = true;
}
function closeAttachMenu() {
  $('#attachMenu').hidden = true;
}

function insertAtCursor(input, text) {
  const start = input.selectionStart || input.value.length;
  const end = input.selectionEnd || input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
  onComposerInput();
}

// ═══════════════════════════════════════════════════════════════════
//  ইন-চ্যাট সার্চ
// ═══════════════════════════════════════════════════════════════════
function toggleChatSearch() {
  const bar = $('#chatSearchBar');
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $('#chatSearchInput').focus();
}
async function onChatSearch() {
  const conversationId = state.activeConversationId;
  const query = $('#chatSearchInput').value.trim();
  const resultsEl = $('#chatSearchResults');
  if (!conversationId || query.length < 2) {
    resultsEl.innerHTML = '';
    $('#chatSearchCount').textContent = '';
    return;
  }
  try {
    const { messages } = await api.conversations.search(conversationId, query);
    $('#chatSearchCount').textContent = `${messages.length} result${messages.length === 1 ? '' : 's'}`;
    resultsEl.innerHTML = messages
      .map(
        (m) =>
          `<li><button type="button" class="search-result" data-id="${escapeHtml(m.id)}"><span class="sr-name">${escapeHtml(isOutgoing(m) ? 'You' : (getConversation(conversationId)?.partner?.name || 'Them'))}</span><span class="sr-text ellipsis">${escapeHtml(m.type === 'text' ? m.content : m.type)}</span><span class="sr-time">${formatTime(m.createdAt)}</span></button></li>`
      )
      .join('');
    resultsEl.querySelectorAll('.search-result').forEach((btn) =>
      btn.addEventListener('click', () => {
        const target = messageEls.get(btn.dataset.id);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1200);
        }
      })
    );
  } catch {
    resultsEl.innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════════════
async function loadContacts() {
  try {
    const { registered, unregistered } = await api.contacts.list();
    state.contacts = [...registered, ...unregistered];
    renderContacts(registered, unregistered);
  } catch (err) {
    /* উপেক্ষা */
  }
}

function renderContacts(registered = [], unregistered = []) {
  const regSection = $('#registeredSection');
  const unregSection = $('#unregisteredSection');
  const regList = $('#registeredList');
  const unregList = $('#unregisteredList');

  regList.innerHTML = '';
  unregList.innerHTML = '';

  if (registered.length) {
    regSection.hidden = false;
    $('#registeredCount').textContent = registered.length;
    regList.innerHTML = registered
      .map(
        (c) => `<li class="contact-item" data-search="${(c.savedName || c.user?.name || '').toLowerCase()} ${c.phone}" data-user-id="${escapeHtml(c.user?.id || '')}">
          <span class="avatar avatar-sm"></span>
          <span class="contact-body"><strong>${escapeHtml(c.savedName || c.user?.name || prettyPhone(c.phone))}</strong>
          <small class="muted">${escapeHtml(c.user?.about || prettyPhone(c.phone))}</small></span>
          <button class="icon-btn start-chat" title="Start chat" aria-label="Start chat">💬</button>
        </li>`
      )
      .join('');
    regList.querySelectorAll('.contact-item').forEach((li) => {
      const userId = li.dataset.userId;
      const user = registered.find((c) => c.user?.id === userId)?.user;
      setAvatar(li.querySelector('.avatar'), user);
      li.querySelector('.start-chat').addEventListener('click', () => startChatWithUser(user));
    });
  } else {
    regSection.hidden = true;
  }

  if (unregistered.length) {
    unregSection.hidden = false;
    $('#unregisteredCount').textContent = unregistered.length;
    unregList.innerHTML = unregistered
      .map(
        (c) => `<li class="contact-item muted-item" data-search="${(c.savedName || '').toLowerCase()} ${c.phone}">
          <span class="avatar avatar-sm" data-initials="?"></span>
          <span class="contact-body"><strong>${escapeHtml(c.savedName || prettyPhone(c.phone))}</strong>
          <small class="muted">Not on NexaChat</small></span>
        </li>`
      )
      .join('');
  } else {
    unregSection.hidden = true;
  }

  $('#contactsEmpty').hidden = registered.length + unregistered.length > 0;
}

async function startChatWithUser(user) {
  if (!user || !user.id) return;
  let conversation = findConversationByPartner(user.id);
  if (!conversation) {
    const { conversation: created } = await api.conversations.create({ userId: user.id });
    conversation = upsertConversation(created);
    renderConversationList();
  }
  switchTab('chats');
  openConversation(conversation.id);
}

// কনট্যাক্ট সিঙ্ক মোডাল
function bindModals() {
  initModals();

  $('#contactSyncSubmit').addEventListener('click', doContactSync);
  $('#pickContactsBtn').addEventListener('click', pickDeviceContacts);
  $('#fillDemoContactsBtn').addEventListener('click', fillDemoContacts);

  $('#newChatSearch').addEventListener('input', debounce(onNewChatSearch, 250));
  $('#newChatResults').addEventListener('click', (event) => {
    const li = event.target.closest('[data-user-id]');
    if (li) {
      const user = getUser(li.dataset.userId);
      if (user) startChatWithUser(user);
      closeModal('#newChatModal');
    }
  });

  $('#profileSave').addEventListener('click', saveProfile);
  $('#profileAvatarBtn').addEventListener('click', () => $('#profileAvatarInput').click());
  $('#profileAvatarInput').addEventListener('change', onProfileAvatarChange);
  $('#profileAvatarRemove').addEventListener('click', removeProfileAvatar);

  $('#settingsSave').addEventListener('click', saveSettingsModal);
  $('#changePasswordBtn').addEventListener('click', changePassword);
  $('#refreshIceBtn').addEventListener('click', getIceServersSafe);

  $('#fileConfirmSend').addEventListener('click', () => {
    const file = $('#fileConfirmModal').dataset.file;
    if (file) sendFileMessage(file);
  });
}

async function doContactSync() {
  const raw = $('#contactSyncInput').value.trim();
  if (!raw) {
    $('#contactSyncError').hidden = false;
    $('#contactSyncError').textContent = 'Add at least one contact';
    return;
  }
  let contacts;
  try {
    contacts = JSON.parse(raw);
    if (!Array.isArray(contacts)) throw new Error('not array');
  } catch {
    // "Name, +phone" লাইন ফরম্যাট
    contacts = raw
      .split('\n')
      .map((line) => line.split(','))
      .filter((parts) => parts.length >= 2)
      .map((parts) => ({ name: parts[0].trim(), phone: parts[1].trim() }));
  }
  if (!contacts.length) {
    $('#contactSyncError').hidden = false;
    $('#contactSyncError').textContent = 'No valid contacts found';
    return;
  }
  try {
    const result = await api.contacts.sync(contacts);
    $('#contactSyncResult').hidden = false;
    $('#contactSyncResult').innerHTML = `<p>Synced <strong>${result.synced}</strong> contact${result.synced === 1 ? '' : 's'}.
      ${result.registered.length ? `<strong>${result.registered.length}</strong> already on NexaChat 🎉` : 'None are on NexaChat yet.'}</p>`;
    $('#contactSyncError').hidden = true;
    await loadContacts();
    switchTab('contacts');
    setTimeout(() => closeModal('#contactSyncModal'), 1200);
  } catch (err) {
    $('#contactSyncError').hidden = false;
    $('#contactSyncError').textContent = err.message || 'Sync failed';
  }
}

async function pickDeviceContacts() {
  if (!('contacts' in navigator) || !navigator.contacts?.select) {
    toast('Contact picker not supported on this device', 'warning');
    return;
  }
  try {
    const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    const lines = picked
      .map((c) => `${c.name?.[0] || 'Friend'}, ${c.tel?.[0] || ''}`)
      .filter((l) => l.includes(','));
    $('#contactSyncInput').value = lines.join('\n');
  } catch {
    /* বাতিল করলে কিছু করার নেই */
  }
}

function fillDemoContacts() {
  $('#contactSyncInput').value = [
    'Rahim, +8801700000001',
    'Karim, +8801700000002',
    'Nusrat, +8801700000003',
    'Auntie, +8801800000009'
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════
//  NEW CHAT সার্চ
// ═══════════════════════════════════════════════════════════════════
function openNewChat() {
  $('#newChatSearch').value = '';
  $('#newChatResults').innerHTML = '<li class="muted">Type a name or phone number…</li>';
  openModal('#newChatModal', { focus: '#newChatSearch' });
}

async function onNewChatSearch() {
  const query = $('#newChatSearch').value.trim();
  const list = $('#newChatResults');
  if (query.length < 2) {
    list.innerHTML = '<li class="muted">Type at least 2 characters…</li>';
    return;
  }
  list.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const { users } = await api.users.search(query);
    if (!users.length) {
      list.innerHTML = '<li class="muted">No registered users found</li>';
      return;
    }
    list.innerHTML = users
      .map(
        (u) => `<li class="user-result" data-user-id="${escapeHtml(u.id)}">
          <span class="avatar avatar-sm"></span>
          <span class="user-result-body"><strong>${escapeHtml(u.name)}</strong>
          <small class="muted">${escapeHtml(prettyPhone(u.phone))}</small></span>
          <span class="user-result-go">→</span>
        </li>`
      )
      .join('');
    list.querySelectorAll('.user-result').forEach((li) => {
      const user = users.find((u) => u.id === li.dataset.userId);
      setAvatar(li.querySelector('.avatar'), user);
    });
  } catch {
    list.innerHTML = '<li class="muted">Search failed</li>';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PROFILE MODAL
// ═══════════════════════════════════════════════════════════════════
function openProfile() {
  if (!state.me) return;
  $('#profileName').value = state.me.name || '';
  $('#profileAbout').value = state.me.about || '';
  $('#profilePhone').value = prettyPhone(state.me.phone);
  const preview = $('#profileAvatarPreview');
  const initialsEl = $('#profileAvatarInitials');
  if (state.me.avatar) {
    preview.src = state.me.avatar;
    preview.hidden = false;
    initialsEl.hidden = true;
  } else {
    initialsEl.textContent = initials(state.me.name);
    initialsEl.hidden = false;
    preview.hidden = true;
    preview.src = '';
  }
  $('#profileOnline').textContent = state.me.isOnline ? 'Online' : 'Offline';
  $('#profileLastSeen').textContent = state.me.lastSeen ? formatRelative(state.me.lastSeen) : '—';
  openModal('#profileModal');
}

async function onProfileAvatarChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const blob = await downscaleImage(file, 512, 0.85);
    await api.users.uploadAvatar(blob, () => {});
    toast('Profile photo updated', 'success');
    // অ্যাভাটার নতুন করে লোড
    const { user } = await api.auth.me();
    state.me = { ...state.me, ...user };
    cacheUser(user);
    renderMyIdentity();
    openProfile();
  } catch (err) {
    toast(err.message || 'Avatar upload failed', 'error');
  }
  event.target.value = '';
}

async function removeProfileAvatar() {
  try {
    await api.users.removeAvatar();
    const { user } = await api.auth.me();
    state.me = { ...state.me, ...user };
    renderMyIdentity();
    openProfile();
    toast('Profile photo removed', 'success');
  } catch (err) {
    toast(err.message || 'Could not remove photo', 'error');
  }
}

async function saveProfile() {
  const name = $('#profileName').value.trim();
  const about = $('#profileAbout').value.trim();
  if (name.length < 2) {
    toast('Name must be at least 2 characters', 'error');
    return;
  }
  try {
    await api.users.updateMe({ name, about });
    toast('Profile saved', 'success');
    closeModal('#profileModal');
  } catch (err) {
    toast(err.message || 'Could not save profile', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS MODAL
// ═══════════════════════════════════════════════════════════════════
function openSettings() {
  populateSettings();
  openModal('#settingsModal');
}

function populateSettings() {
  const me = state.me || {};
  const privacy = me.privacy || {};
  $('#privacyLastSeen').value = privacy.lastSeen || 'everyone';
  $('#privacyProfilePhoto').value = privacy.profilePhoto || 'everyone';
  $('#privacyReadReceipts').checked = privacy.readReceipts !== false;
  $('#notifyDesktop').checked = !!state.settings.desktopNotifications;
  $('#notifySound').checked = !!state.settings.messageSound;
}

function applySettingsToUI() {
  populateSettings();
}

async function saveSettingsModal() {
  const privacy = {
    lastSeen: $('#privacyLastSeen').value,
    profilePhoto: $('#privacyProfilePhoto').value,
    readReceipts: $('#privacyReadReceipts').checked
  };
  saveSettings({
    desktopNotifications: $('#notifyDesktop').checked,
    messageSound: $('#notifySound').checked
  });
  if ($('#notifyDesktop').checked) requestNotificationPermission();
  try {
    await api.users.updateMe({ privacy });
    toast('Settings saved', 'success');
  } catch (err) {
    toast(err.message || 'Could not save settings', 'error');
  }
  closeModal('#settingsModal');
}

async function changePassword() {
  const current = $('#currentPassword').value;
  const next = $('#newPassword').value;
  if (!current || next.length < 4) {
    toast('Enter your current PIN and a new one (min 4 chars)', 'error');
    return;
  }
  try {
    await api.auth.changePassword(current, next);
    $('#currentPassword').value = '';
    $('#newPassword').value = '';
    toast('Password changed — all other sessions signed out', 'success');
  } catch (err) {
    toast(err.message || 'Could not change password', 'error');
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════
//  INFO PANEL
// ═══════════════════════════════════════════════════════════════════
async function openInfoPanel() {
  const conversationId = state.activeConversationId;
  const conversation = getConversation(conversationId);
  if (!conversation || !conversation.partner) return;
  const partner = conversation.partner;
  try {
    const { user } = await api.users.get(partner.id);
    infoUser = user;
  } catch {
    infoUser = partner;
  }
  renderInfoPanel(infoUser);
  $('#infoPanel').hidden = false;
}
function renderInfoPanel(user) {
  if (!user) return;
  setAvatar($('#infoAvatar'), user);
  $('#infoName').textContent = user.name || prettyPhone(user.phone);
  $('#infoPhone').textContent = prettyPhone(user.phone);
  $('#infoPresence').textContent = user.presenceHidden
    ? 'Last seen hidden'
    : user.isOnline
      ? 'Online'
      : user.lastSeen
        ? `Last seen ${formatRelative(user.lastSeen)}`
        : 'Offline';
  $('#infoAbout').textContent = user.about || 'No status';

  // শেয়ার্ড মিডিয়া
  const conversation = findConversationByPartner(user.id);
  const grid = $('#infoMediaGrid');
  if (conversation) {
    const media = sortedMessages(conversation.id).filter((m) => m.mediaUrl && (m.type === 'image' || m.type === 'file'));
    if (media.length) {
      grid.innerHTML = media
        .slice(0, 12)
        .map(
          (m) =>
            `<button class="media-thumb" data-url="${escapeHtml(m.mediaUrl)}" data-type="${escapeHtml(m.type)}">${
              m.type === 'image' ? `<img loading="lazy" src="${escapeHtml(m.mediaUrl)}" alt="" />` : '📄'
            }</button>`
        )
        .join('');
      grid.querySelectorAll('.media-thumb').forEach((btn) =>
        btn.addEventListener('click', () => {
          if (btn.dataset.type === 'image') openLightbox(btn.dataset.url, 'image');
          else window.open(btn.dataset.url, '_blank', 'noopener');
        })
      );
    } else {
      grid.innerHTML = '<p class="muted">No media yet.</p>';
    }
  }

  $('#infoAudioCall').onclick = () => startCallFromUser(user, 'audio');
  $('#infoVideoCall').onclick = () => startCallFromUser(user, 'video');
}

// ═══════════════════════════════════════════════════════════════════
//  CALLS HISTORY
// ═══════════════════════════════════════════════════════════════════
async function loadCalls() {
  try {
    const { calls } = await api.calls.list();
    state.calls = calls;
    renderCalls(calls);
  } catch {
    /* উপেক্ষা */
  }
}
function renderCalls(calls = []) {
  const list = $('#callList');
  if (!calls.length) {
    $('#callsEmpty').hidden = false;
    list.innerHTML = '';
    return;
  }
  $('#callsEmpty').hidden = true;
  list.innerHTML = calls
    .map((c) => {
      const peer = c.peer || {};
      const icon = c.callType === 'video' ? '📹' : '📞';
      const stateText = c.status === 'missed' ? 'Missed' : c.status === 'rejected' ? 'Declined' : c.status === 'cancelled' ? 'Cancelled' : 'Outgoing/Incoming';
      const dir = c.direction === 'outgoing' ? '↗' : '↘';
      return `<li class="call-item" data-user-id="${escapeHtml(peer.id || '')}">
        <span class="call-icon">${icon}</span>
        <span class="call-body"><strong>${escapeHtml(peer.name || 'Unknown')}</strong>
        <small class="muted">${dir} ${stateText} · ${formatDuration(c.duration || 0)}</small></span>
        <small class="call-time">${formatListTime(c.startedAt)}</small>
      </li>`;
    })
    .join('');
  list.querySelectorAll('.call-item').forEach((li) => {
    li.addEventListener('click', () => {
      const user = getUser(li.dataset.userId);
      if (user) startChatWithUser(user);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
//  WEBRTC কল
// ═══════════════════════════════════════════════════════════════════
function startCallFromChat(callType) {
  const conversation = getConversation(state.activeConversationId);
  if (conversation && conversation.partner) startCallFromUser(conversation.partner, callType);
}
function startCallFromUser(user, callType) {
  if (!user || !user.id) return;
  if (call) {
    toast('You are already in a call', 'warning');
    return;
  }
  startCall(user, callType);
}

async function getIceServersSafe() {
  try {
    const data = await api.webrtc.iceServers();
    if (Array.isArray(data.iceServers)) {
      state.ice = data.iceServers;
      if (data.ringTimeoutMs) ringTimeoutMs = data.ringTimeoutMs;
      $('#diagIce').textContent = `${data.source || 'unknown'}${data.warning ? ' (no TURN)' : ''}`;
    }
  } catch {
    $('#diagIce').textContent = 'unavailable';
  }
  if (!state.ice) state.ice = await getIceServers();
}

async function startCall(targetUser, callType) {
  await getIceServersSafe();
  const iceServers = state.ice || (await getIceServers());
  const ack = await emitAck(CALL_REQUEST, { targetUserId: targetUser.id, callType });
  return internalStartCall(targetUser, callType, iceServers, ack);
}

// সার্ভার ইভেন্ট নাম (EV অবজেক্টের বাইরে রাখা হলো)
const CALL_REQUEST = 'call:request';

async function internalStartCall(targetUser, callType, iceServers, ack) {
  if (!ack || !ack.ok) {
    if (ack && ack.reason === 'offline') toast(`${targetUser.name} is offline`, 'warning');
    else if (ack && ack.reason === 'busy') toast(`${targetUser.name} is on another call`, 'warning');
    else toast(ack?.message || 'Could not start call', 'error');
    return;
  }
  call = {
    callId: ack.callId,
    callType,
    role: 'caller',
    target: targetUser,
    iceServers,
    state: 'ringing',
    startTime: Date.now(),
    ringTimer: null,
    callTimer: null,
    peer: null,
    localStream: null
  };
  showActiveCall(targetUser, callType, 'calling');
  call.ringTimer = setTimeout(() => {
    if (call && call.role === 'caller' && call.state !== 'connected') {
      endCall('cancelled');
      toast('No answer', 'warning');
    }
  }, ringTimeoutMs);
}

// কলার কল ধরা হয়েছে → এখন offer তৈরি (ট্র্যাক যোগের পরেই)
async function onCallAccepted({ callId }) {
  if (!call || call.callId !== callId || call.role !== 'caller') return;
  clearTimeout(call.ringTimer);
  call.state = 'connecting';
  setCallState('connecting');
  try {
    const stream = await getUserMedia({ audio: true, video: call.callType === 'video' });
    call.localStream = stream;
    call.peer = createPeer(call);
    call.peer.setLocalStream(stream); // ⚠️ offer-এর আগে ট্র্যাক যোগ (বাধ্যতামূলক)
    attachLocal(stream, call.callType);
    const offer = await call.peer.createOffer();
    emit(EV.OFFER, { callId, sdp: offer });
  } catch (err) {
    toast('Could not access camera/microphone', 'error');
    endCall('failed');
  }
}

function createPeer(c) {
  return new CallConnection({
    iceServers: c.iceServers,
    onIceCandidate: (data) => emit(EV.ICE, { callId: c.callId, candidate: data.candidate }),
    onTrack: (stream) => attachRemote(stream, c.callType),
    onConnectionState: (stateName) => onPeerConnectionState(stateName, c),
    onStats: () => {}
  });
}

function onPeerConnectionState(stateName, c) {
  if (stateName === 'connected') {
    c.state = 'connected';
    setCallState('connected');
    startCallTimer(c);
  } else if (stateName === 'failed') {
    $('#callWarning').hidden = false;
    $('#callWarning').textContent = 'Connection failed — trying to recover…';
  } else if (stateName === 'disconnected') {
    $('#callWarning').hidden = false;
    $('#callWarning').textContent = 'Connection unstable…';
  }
}

// callee: offer পেয়ে remote সেট + answer পাঠায়
async function onCallOffer({ callId, sdp }) {
  if (!call || call.callId !== callId) return;
  try {
    await call.peer.setRemoteDescription(sdp);
    const answer = await call.peer.createAnswer();
    emit(EV.ANSWER, { callId, sdp: answer });
    call.state = 'connecting';
    setCallState('connecting');
  } catch (err) {
    endCall('failed');
  }
}

// caller: answer পেয়ে remote সেট
async function onCallAnswer({ callId, sdp }) {
  if (!call || call.callId !== callId) return;
  try {
    await call.peer.setRemoteDescription(sdp);
  } catch (err) {
    /* উপেক্ষা */
  }
}

function onCallIceCandidate({ callId, candidate }) {
  if (!call || call.callId !== callId) return;
  call.peer.addRemoteCandidate(candidate);
}

function onCallMediaConnected() {
  if (!call) return;
  call.state = 'connected';
  setCallState('connected');
  startCallTimer(call);
}

function attachLocal(stream, callType) {
  const video = $('#localVideo');
  if (callType === 'video') {
    attachStream(video, stream);
    video.hidden = false;
  } else {
    video.hidden = true;
  }
}

function attachRemote(stream, callType) {
  if (callType === 'video') {
    const video = $('#remoteVideo');
    attachStream(video, stream);
    video.hidden = false;
    $('#callPeerCard').classList.add('with-video');
  } else {
    const audio = $('#remoteAudio');
    attachStream(audio, stream);
  }
}

function startCallTimer(c) {
  if (c.callTimer) return;
  c.callTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - c.startTime) / 1000);
    const timer = $('#callTimer');
    timer.hidden = false;
    timer.textContent = formatDuration(elapsed);
  }, 1000);
}

function setCallState(stateName) {
  const label = { calling: 'Calling…', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…' }[stateName] || '';
  $('#activeCallState').textContent = label;
}

// আসা কল
function onIncomingCall({ callId, callType, from }) {
  if (call) {
    // ইতিমধ্যে কল চলছে — সার্ভার ব্যবস্থা করবে, এখানে শুধু ইগনোর
    return;
  }
  pendingCall = { callId, callType, from };
  setAvatar($('#incomingAvatar'), from);
  $('#incomingName').textContent = from?.name || prettyPhone(from?.phone) || 'Unknown';
  $('#incomingPhone').textContent = from?.phone ? prettyPhone(from.phone) : '';
  $('#incomingCallTitle').textContent = callType === 'video' ? '📹 Incoming video call' : '📞 Incoming audio call';
  openModal('#incomingCallModal');
  beep(880, 200);
  setTimeout(() => beep(880, 200), 400);
}

async function acceptCall() {
  if (!pendingCall) return;
  const { callId, callType, from } = pendingCall;
  closeModal('#incomingCallModal');
  await getIceServersSafe();
  const iceServers = state.ice || (await getIceServers());
  call = {
    callId,
    callType,
    role: 'callee',
    target: from,
    iceServers,
    state: 'connecting',
    startTime: Date.now(),
    callTimer: null,
    peer: null,
    localStream: null
  };
  showActiveCall(from, callType, 'connecting');
  try {
    const stream = await getUserMedia({ audio: true, video: callType === 'video' });
    call.localStream = stream;
    call.peer = createPeer(call);
    call.peer.setLocalStream(stream); // offer-এর আগে ট্র্যাক ready
    attachLocal(stream, callType);
    emit(EV.ACCEPT, { callId });
    // offer সার্ভার থেকে আসবে → onCallOffer
  } catch (err) {
    toast('Could not access camera/microphone', 'error');
    endCall('failed');
  }
}

async function rejectCall() {
  if (!pendingCall) return;
  emit(EV.REJECT, { callId: pendingCall.callId });
  closeModal('#incomingCallModal');
  pendingCall = null;
}

function endCall(reason) {
  if (call) {
    emit(EV.END, { callId: call.callId, reason });
    cleanupCall();
  } else if (pendingCall) {
    emit(EV.REJECT, { callId: pendingCall.callId });
    closeModal('#incomingCallModal');
    pendingCall = null;
  }
}

function cleanupCall() {
  if (call) {
    if (call.ringTimer) clearTimeout(call.ringTimer);
    if (call.callTimer) clearInterval(call.callTimer);
    if (call.peer) call.peer.close();
    if (call.localStream) stopStream(call.localStream);
  }
  call = null;
  pendingCall = null;
  closeModal('#activeCallModal');
  closeModal('#incomingCallModal');
  resetCallUI();
}

function onCallEnded({ callId, reason, duration }) {
  if (!call || call.callId !== callId) return;
  const wasConnected = call.state === 'connected';
  cleanupCall();
  if (wasConnected) toast(`Call ended · ${formatDuration(duration || 0)}`, 'info');
  else if (reason === 'rejected') toast('Call declined', 'warning');
  else if (reason === 'cancelled') toast('Call cancelled', 'info');
  loadCalls();
}
function onCallTimedOut({ callId }) {
  if (!call || call.callId !== callId) return;
  const role = call.role;
  cleanupCall();
  toast(role === 'caller' ? 'No answer' : 'Missed call', 'warning');
  loadCalls();
}
function onCallBusy() {
  toast('User is busy on another call', 'warning');
  if (call) cleanupCall();
}
function onCallHandledElsewhere() {
  if (pendingCall) {
    closeModal('#incomingCallModal');
    pendingCall = null;
  }
}
function onMissedCallNotification() {
  toast('You missed a call', 'warning');
  loadCalls();
}

function showActiveCall(user, callType, stateName) {
  setAvatar($('#callPeerAvatar'), user);
  $('#callPeerName').textContent = user?.name || prettyPhone(user?.phone) || 'Unknown';
  setCallState(stateName);
  $('#callTimer').hidden = true;
  $('#callWarning').hidden = true;
  // অডিও কলে ক্যামেরা/ফ্লিপ বাটন লুকানো
  $('#toggleCamBtn').hidden = callType !== 'video';
  $('#flipCamBtn').hidden = callType !== 'video';
  $('#remoteVideo').hidden = callType !== 'video';
  $('#remoteAudio').srcObject = null;
  openModal('#activeCallModal');
}

function resetCallUI() {
  const local = $('#localVideo');
  local.srcObject = null;
  local.hidden = true;
  $('#remoteVideo').srcObject = null;
  $('#remoteAudio').srcObject = null;
  $('#callPeerCard').classList.remove('with-video');
  $('#toggleMicBtn').setAttribute('aria-pressed', 'false');
  $('#toggleCamBtn').setAttribute('aria-pressed', 'false');
  $('#callWarning').hidden = true;
}

function bindCallOverlay() {
  $('#acceptCallBtn').addEventListener('click', acceptCall);
  $('#rejectCallBtn').addEventListener('click', rejectCall);
  $('#endCallBtn').addEventListener('click', () => endCall('ended'));

  $('#toggleMicBtn').addEventListener('click', () => {
    if (!call || !call.peer) return;
    const muted = $('#toggleMicBtn').getAttribute('aria-pressed') === 'true';
    const next = !muted;
    call.peer.toggleAudio(!next);
    $('#toggleMicBtn').setAttribute('aria-pressed', String(next));
  });
  $('#toggleCamBtn').addEventListener('click', () => {
    if (!call || !call.peer || call.callType !== 'video') return;
    const off = $('#toggleCamBtn').getAttribute('aria-pressed') === 'true';
    const next = !off;
    call.peer.toggleVideo(!next);
    $('#localVideo').style.visibility = next ? 'hidden' : 'visible';
    $('#toggleCamBtn').setAttribute('aria-pressed', String(next));
  });
  $('#flipCamBtn').addEventListener('click', flipCamera);
  $('#toggleSpeakerBtn').addEventListener('click', () => {
    const on = $('#toggleSpeakerBtn').getAttribute('aria-pressed') === 'true';
    $('#toggleSpeakerBtn').setAttribute('aria-pressed', String(!on));
  });
}

async function flipCamera() {
  if (!call || !call.peer || call.callType !== 'video') return;
  try {
    const newStream = await getUserMedia({ audio: false, video: { facingMode: 'environment' } });
    const videoTrack = newStream.getVideoTracks()[0];
    if (videoTrack) {
      call.peer.replaceVideoTrack(new MediaStream([videoTrack]));
      const local = $('#localVideo');
      local.srcObject = new MediaStream([videoTrack]);
    }
    stopStream(call.localStream);
    call.localStream = newStream;
  } catch {
    toast('Could not switch camera', 'warning');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  IMAGE EDITOR (Canvas)
// ═══════════════════════════════════════════════════════════════════
let editor = null;

function openImageEditor(source, { caption = '', onSend } = {}) {
  const canvas = $('#editorCanvas');
  const ctx = canvas.getContext('2d');
  const blobUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
  const url = blobUrl || source;
  const image = new Image();
  image.onload = () => {
    const maxW = 760;
    const maxH = 520;
    const scale = Math.min(1, maxW / image.width, maxH / image.height);
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    editor = {
      canvas,
      ctx,
      image,
      scale,
      tool: 'draw',
      color: $('#editorColor').value,
      size: Number($('#editorSize').value),
      actions: [],
      undoStack: [],
      cropRect: null,
      onSend
    };
    redrawEditor();
    $('#imageCaption').value = caption;
    openModal('#imageEditorModal');
  };
  image.src = url;
}

function redrawEditor() {
  if (!editor) return;
  const { ctx, canvas, image, actions } = editor;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const action of actions) drawAction(ctx, action);
  if (editor.cropRect) {
    const r = editor.cropRect;
    ctx.strokeStyle = '#0bdcc8';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
  }
}

function drawAction(ctx, action) {
  ctx.save();
  ctx.strokeStyle = action.color;
  ctx.fillStyle = action.color;
  ctx.lineWidth = action.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (action.tool === 'highlight') ctx.globalAlpha = 0.4;
  if (action.tool === 'draw' || action.tool === 'highlight') {
    ctx.beginPath();
    action.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  } else if (action.tool === 'arrow') {
    const { x0, y0, x1, y1 } = action;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = 12;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else if (action.tool === 'rect') {
    ctx.strokeRect(action.x0, action.y0, action.x1 - action.x0, action.y1 - action.y0);
  } else if (action.tool === 'circle') {
    const rx = Math.abs(action.x1 - action.x0) / 2;
    const ry = Math.abs(action.y1 - action.y0) / 2;
    ctx.beginPath();
    ctx.ellipse((action.x0 + action.x1) / 2, (action.y0 + action.y1) / 2, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (action.tool === 'text') {
    ctx.globalAlpha = 1;
    ctx.font = `${Math.max(14, action.size * 4)}px sans-serif`;
    ctx.fillText(action.text, action.x, action.y);
  }
  ctx.restore();
}

function bindEditor() {
  $$('#imageEditorModal .tool').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.id === 'editorUndo') return undoEditor();
      if (btn.id === 'editorRedo') return redoEditor();
      if (btn.id === 'editorClear') return clearEditor();
      if (btn.id === 'editorApplyCrop') return applyCrop();
      // ড্রয়িং টুলগুলোর মধ্যে শুধু একটি active থাকবে
      $$('#imageEditorModal .tool[data-tool]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      if (btn.dataset.tool) editor.tool = btn.dataset.tool;
    })
  );
  $('#editorColor').addEventListener('input', () => (editor && (editor.color = $('#editorColor').value)));
  $('#editorSize').addEventListener('input', () => (editor && (editor.size = Number($('#editorSize').value))));

  const canvas = $('#editorCanvas');
  let drawing = false;
  const pos = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  };
  canvas.addEventListener('pointerdown', (event) => {
    if (!editor) return;
    canvas.setPointerCapture(event.pointerId);
    const p = pos(event);
    if (editor.tool === 'text') {
      const text = prompt('Enter text:');
      if (text) {
        editor.actions.push({ tool: 'text', x: p.x, y: p.y, text, color: editor.color, size: editor.size });
        redrawEditor();
      }
      return;
    }
    drawing = true;
    if (editor.tool === 'draw' || editor.tool === 'highlight') {
      editor.current = { tool: editor.tool, points: [p], color: editor.color, size: editor.size };
    } else if (editor.tool === 'crop') {
      editor.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    } else {
      editor.current = { tool: editor.tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, color: editor.color, size: editor.size };
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!editor || !drawing) return;
    const p = pos(event);
    if (editor.tool === 'draw' || editor.tool === 'highlight') {
      editor.current.points.push(p);
      redrawEditor();
      drawAction(editor.ctx, editor.current);
    } else if (editor.tool === 'crop') {
      editor.cropRect.w = p.x - editor.cropRect.x;
      editor.cropRect.h = p.y - editor.cropRect.y;
      redrawEditor();
    } else {
      editor.current.x1 = p.x;
      editor.current.y1 = p.y;
      redrawEditor();
      drawAction(editor.ctx, editor.current);
    }
  });
  const finish = () => {
    if (!editor || !drawing) return;
    drawing = false;
    if (editor.current) {
      editor.actions.push(editor.current);
      editor.current = null;
    }
    if (editor.tool === 'crop' && editor.cropRect) {
      $('#editorApplyCrop').hidden = false;
    }
    redrawEditor();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointerleave', finish);

  $('#editorCancel').addEventListener('click', () => {
    closeModal('#imageEditorModal');
    editor = null;
  });
  $('#editorSend').addEventListener('click', () => {
    if (!editor) return;
    const caption = $('#imageCaption').value.trim();
    canvas.toBlob(
      async (blob) => {
        closeModal('#imageEditorModal');
        const cb = editor.onSend;
        editor = null;
        if (blob && cb) cb(blob, caption);
      },
      'image/jpeg',
      0.86
    );
  });
}

function undoEditor() {
  if (!editor || !editor.actions.length) return;
  editor.undoStack.push(editor.actions.pop());
  redrawEditor();
}
function redoEditor() {
  if (!editor || !editor.undoStack.length) return;
  editor.actions.push(editor.undoStack.pop());
  redrawEditor();
}
function clearEditor() {
  if (!editor) return;
  editor.actions = [];
  editor.undoStack = [];
  redrawEditor();
}
function applyCrop() {
  if (!editor || !editor.cropRect) return;
  const r = editor.cropRect;
  const x = Math.max(0, Math.min(r.x, r.x + r.w));
  const y = Math.max(0, Math.min(r.y, r.y + r.h));
  const w = Math.abs(r.w);
  const h = Math.abs(r.h);
  if (w < 10 || h < 10) return;
  const temp = document.createElement('canvas');
  temp.width = w;
  temp.height = h;
  temp.getContext('2d').drawImage(editor.canvas, x, y, w, h, 0, 0, w, h);
  editor.image = temp;
  editor.canvas.width = w;
  editor.canvas.height = h;
  editor.actions = [];
  editor.undoStack = [];
  editor.cropRect = null;
  $('#editorApplyCrop').hidden = true;
  redrawEditor();
}

// ═══════════════════════════════════════════════════════════════════
//  FILE CONFIRM
// ═══════════════════════════════════════════════════════════════════
function openFileConfirm(file) {
  if (!file) return;
  $('#fileConfirmName').textContent = file.name;
  $('#fileConfirmMeta').textContent = `${formatBytes(file.size)} · ${file.type || 'file'}`;
  $('#fileCaption').value = '';
  $('#fileConfirmModal').dataset.file = file;
  openModal('#fileConfirmModal');
}

// ═══════════════════════════════════════════════════════════════════
//  কনটেক্সট মেনু (মেসেজ)
// ═══════════════════════════════════════════════════════════════════
function bindContextMenu() {
  const list = $('#messageList');
  list.addEventListener('contextmenu', (event) => {
    const el = event.target.closest('.message');
    if (!el) return;
    event.preventDefault();
    currentMenuMessageId = el.dataset.messageId;
    const menu = $('#messageMenu');
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.hidden = false;
    // এডিট/ডিলিট অপশন কন্ডিশনাল
    const message = getMessage(state.activeConversationId, currentMenuMessageId);
    const canEdit = message && message.type === 'text' && message.senderId === state.me?.id && message.deleted !== 'everyone';
    menu.querySelector('[data-action="edit"]').hidden = !canEdit;
    menu.querySelector('[data-action="delete-all"]').hidden = !canEdit;
  });

  $('#messageMenu').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    $('#messageMenu').hidden = true;
    const id = currentMenuMessageId;
    if (!id) return;
    if (action === 'reply') setReply(id);
    else if (action === 'copy') {
      const message = getMessage(state.activeConversationId, id);
      if (message) copyText(message.content || '');
    } else if (action === 'edit') startEdit(id);
    else if (action === 'delete-me') deleteMessage(id, 'me');
    else if (action === 'delete-all') deleteMessage(id, 'everyone');
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#messageMenu')) $('#messageMenu').hidden = true;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  GLOBAL UI + KEYBOARD + WINDOW
// ═══════════════════════════════════════════════════════════════════
function bindGlobalUI() {
  $('#myProfileBtn').addEventListener('click', openProfile);
  $('#infoCloseBtn').addEventListener('click', () => ($('#infoPanel').hidden = true));
  window.addEventListener('nexachat:session-expired', () => {
    toast('Your session expired — please sign in again', 'warning');
    state.socket && state.socket.disconnect();
    state.socket = null;
    showScreen('auth');
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (isModalOpen()) {
        closeTopModal();
        return;
      }
      if (document.body.dataset.mobileView === 'chat') setMobileView('list');
      $('#messageMenu').hidden = true;
      return;
    }
    const tag = (event.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openNewChat();
    } else if (event.key === '/' && !typing && !isModalOpen()) {
      event.preventDefault();
      $('#sidebarSearch').focus();
    }
  });
}

function bindWindow() {
  window.addEventListener('focus', () => {
    state.windowFocused = true;
    if (state.activeConversationId) markConversationRead(state.activeConversationId);
  });
  window.addEventListener('blur', () => {
    state.windowFocused = false;
  });
  document.addEventListener('visibilitychange', () => {
    state.windowFocused = !document.hidden && document.hasFocus();
  });
  window.addEventListener('beforeunload', () => {
    if (state.socket) state.socket.disconnect();
  });
}

function renderMyIdentity() {
  if (!state.me) return;
  setAvatar($('#myAvatar'), state.me);
}

async function doLogout() {
  const ok = await confirmDialog({ title: 'Log out?', text: 'You will be signed out of this device.', confirmLabel: 'Log out', danger: false });
  if (!ok) return;
  try {
    await api.auth.logout();
  } catch {
    /* উপেক্ষা */
  }
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.me = null;
  showScreen('auth');
}

// ── ছোট ইউটিল ──────────────────────────────────────────────────────
function focusComposer() {
  if (window.matchMedia('(min-width: 860px)').matches) $('#composerInput').focus();
}
function beep(freq = 440, duration = 120) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.value = 0.04;
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, duration);
  } catch {
    /* উপেক্ষা */
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ডায়াগনস্টিকস
// ═══════════════════════════════════════════════════════════════════
function updateDiagnostics() {
  $('#diagSecure').textContent = window.isSecureContext ? 'Yes (HTTPS)' : 'No (insecure)';
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const cams = devices.filter((d) => d.kind === 'videoinput').length;
        const mics = devices.filter((d) => d.kind === 'audioinput').length;
        $('#diagMedia').textContent = `${cams} cam, ${mics} mic`;
      })
      .catch(() => ($('#diagMedia').textContent = 'blocked'));
  } else {
    $('#diagMedia').textContent = 'unsupported';
  }
}

// ── স্টার্ট ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', boot);
// মডিউল লোডের সময়ই DOM প্রস্তুত থাকলে
if (document.readyState !== 'loading') boot();

// editor এর জন্য event binding (modal এ থাকা সত্ত্বেও একবার bind করি)
bindEditor();
