/**
 * public/js/state.js
 * ───────────────────────────────────────────────────────────────────────
 * ক্লায়েন্ট-সাইড state store (কোনো ফ্রেমওয়ার্ক ছাড়া)।
 *
 * নীতি: DOM-ই একমাত্র সত্য নয় — মেসেজ/চ্যাট/ইউজার সব এখানে Map আকারে
 * থাকে, আর রেন্ডারার শুধু প্রয়োজনীয় অংশ ইনক্রিমেন্টালি আপডেট করে
 * (পুরো লিস্ট বারবার re-render করা হয় না — পারফরম্যান্সের জন্য জরুরি)।
 */

const SETTINGS_KEY = 'nexachat.settings.v1';

export const state = {
  /** @type {object|null} লগইন করা ইউজার */
  me: null,

  /** সকেট সংযোগ */
  socket: null,
  connected: false,

  /** id → conversation summary */
  conversations: new Map(),
  /** conversationId → Map(messageId → message) — ক্রম বজায় রাখা হয় */
  messages: new Map(),
  /** conversationId → boolean (পুরনো মেসেজ আরও আছে কি না) */
  hasMore: new Map(),
  /** userId → user (partner/contact cache) */
  users: new Map(),
  /** contact list (registered + unregistered) */
  contacts: [],
  /** কল হিস্ট্রি */
  calls: [],

  activeConversationId: null,

  /** conversationId → timeout id (typing indicator নিভানোর জন্য) */
  typing: new Map(),

  /** reply / edit অবস্থা */
  replyTo: null,
  editing: null,

  /** ICE কনফিগ ক্যাশ */
  ice: null,

  /** ব্রাউজার-সাইড সেটিংস (localStorage-এ সংরক্ষিত) */
  settings: {
    desktopNotifications: false,
    messageSound: true
  },

  /** ডকুমেন্ট দৃশ্যমান কি না — read receipt ও notification সিদ্ধান্তে ব্যবহৃত */
  windowFocused: true
};

// ── settings persistence ─────────────────────────────────────────────
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch {
    /* corrupt হলে ডিফল্টই থাকবে */
  }
  return state.settings;
}

export function saveSettings(patch = {}) {
  Object.assign(state.settings, patch);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* private mode-এ লেখা যাবে না — উপেক্ষা */
  }
  return state.settings;
}

// ── users ────────────────────────────────────────────────────────────
export function cacheUser(user) {
  if (user && user.id) state.users.set(user.id, { ...(state.users.get(user.id) || {}), ...user });
  return user;
}
export const getUser = (userId) => state.users.get(userId) || null;

// ── conversations ────────────────────────────────────────────────────
export function upsertConversation(conversation) {
  if (!conversation || !conversation.id) return null;
  const existing = state.conversations.get(conversation.id) || {};
  const merged = { ...existing, ...conversation };
  state.conversations.set(conversation.id, merged);
  if (merged.partner) cacheUser(merged.partner);
  return merged;
}

export const getConversation = (id) => state.conversations.get(id) || null;

/** সর্বশেষ activity অনুযায়ী sorted তালিকা */
export function sortedConversations() {
  return Array.from(state.conversations.values()).sort((a, b) => {
    const aTime = a.lastMessage?.createdAt || a.updatedAt || 0;
    const bTime = b.lastMessage?.createdAt || b.updatedAt || 0;
    return bTime - aTime;
  });
}

/** partner userId দিয়ে conversation খোঁজা (কল/কনট্যাক্ট থেকে চ্যাট খুলতে) */
export function findConversationByPartner(userId) {
  for (const conversation of state.conversations.values()) {
    if (conversation.partner && conversation.partner.id === userId) return conversation;
  }
  return null;
}

// ── messages ─────────────────────────────────────────────────────────
export function messageMap(conversationId) {
  if (!state.messages.has(conversationId)) state.messages.set(conversationId, new Map());
  return state.messages.get(conversationId);
}

export function putMessage(message) {
  if (!message || !message.conversationId) return null;
  messageMap(message.conversationId).set(message.id, message);
  return message;
}

export function getMessage(conversationId, messageId) {
  return messageMap(conversationId).get(messageId) || null;
}

export function removeMessage(conversationId, messageId) {
  messageMap(conversationId).delete(messageId);
}

/** সময় অনুযায়ী sorted মেসেজ তালিকা */
export function sortedMessages(conversationId) {
  return Array.from(messageMap(conversationId).values()).sort((a, b) => a.createdAt - b.createdAt);
}

export const totalUnread = () =>
  Array.from(state.conversations.values()).reduce((sum, conversation) => sum + (conversation.unreadCount || 0), 0);
