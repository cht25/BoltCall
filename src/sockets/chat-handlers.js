/**
 * src/sockets/chat-handlers.js
 * ───────────────────────────────────────────────────────────────────────
 * রিয়েল-টাইম চ্যাট ইভেন্ট হ্যান্ডলার।
 *
 * ইভেন্ট ক্যাটালগ (client → server):
 *   chat:send            { conversationId | receiverId | receiverPhone, type, content, mediaUrl, mediaMeta, replyTo, tempId }
 *   chat:typing          { conversationId }
 *   chat:stopTyping      { conversationId }
 *   message:delivered    { messageId }
 *   message:read         { conversationId }
 *   message:edit         { messageId, content }
 *   message:delete       { messageId, scope: 'me' | 'everyone' }
 *   presence:get         { userIds: [] }           → ack
 *
 * (server → client): chat:receive, chat:typing, chat:stopTyping,
 *   message:delivered, message:read, message:edited, message:deleted,
 *   user:online, user:offline, presence:update
 *
 * নিরাপত্তা: senderId কখনো ক্লায়েন্ট থেকে নেওয়া হয় না — সবসময়
 * socket.data.user.id (JWT থেকে যাচাইকৃত)। প্রতিটি ইভেন্টে conversation
 * membership সার্ভারেই যাচাই হয়।
 */

'use strict';

const config = require('../config');
const { getDb } = require('../../database');
const logger = require('../utils/logger');
const messageService = require('../services/message-service');
const { publicMessage } = require('../services/serialize');
const { createSocketLimiter } = require('../middleware/rate-limit');
const {
  emitNewMessage,
  emitMessageEdited,
  emitMessageDeleted,
  emitDelivered,
  emitRead,
  emitToUsers
} = require('./emitters');
const presence = require('../services/presence');

// টাইপিং/মেসেজ ইভেন্টের জন্য token bucket (স্প্যাম প্রতিরোধ)
const messageLimiter = createSocketLimiter(config.rateLimits.socket.messagesPerMinute);
const typingLimiter = createSocketLimiter(config.rateLimits.socket.typingPerMinute);

// membership ক্যাশ — টাইপিং ইভেন্টে প্রতিবার DB হিট এড়াতে (৩০ সেকেন্ড TTL)
const membershipCache = new Map();
const MEMBERSHIP_TTL = 30000;

async function isMemberCached(db, conversationId, userId) {
  const key = `${conversationId}:${userId}`;
  const cached = membershipCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await db.conversations.isMember(conversationId, userId);
  membershipCache.set(key, { value, expiresAt: Date.now() + MEMBERSHIP_TTL });
  if (membershipCache.size > 5000) membershipCache.clear();
  return value;
}

/** ack callback নিরাপদে ডাকার হেল্পার (ক্লায়েন্ট ack না পাঠালেও ক্র্যাশ নয়) */
const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

function registerChatHandlers({ io, socket }) {
  const me = socket.data.user;
  const db = getDb();

  // ═════════════════════════════════════════════════════════════════
  //  chat:send — নতুন মেসেজ
  // ═════════════════════════════════════════════════════════════════
  socket.on('chat:send', async (payload = {}, ack) => {
    try {
      if (!messageLimiter(`msg:${me.id}`)) {
        reply(ack, { ok: false, error: 'অনেক দ্রুত মেসেজ পাঠানো হচ্ছে — একটু ধীরে', code: 'rate_limited' });
        return;
      }

      const { message, receiverId } = await messageService.sendMessage(db, me.id, {
        conversationId: payload.conversationId,
        receiverId: payload.receiverId,
        receiverPhone: payload.receiverPhone,
        type: payload.type,
        content: payload.content,
        mediaUrl: payload.mediaUrl,
        mediaMeta: payload.mediaMeta,
        replyTo: payload.replyTo
      });

      // প্রেরকের optimistic bubble মিলিয়ে নিতে tempId ফেরত পাঠানো হয়
      reply(ack, { ok: true, message: publicMessage(message), tempId: payload.tempId || null });
      emitNewMessage(io, { message, senderId: me.id, receiverId });
    } catch (err) {
      logger.debug('[socket] chat:send ব্যর্থ:', err.message);
      reply(ack, {
        ok: false,
        error: err.expose ? err.message : 'মেসেজ পাঠানো যায়নি',
        code: err.code || 'send_failed',
        tempId: payload.tempId || null
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  chat:typing / chat:stopTyping
  //  (ক্লায়েন্ট throttle করে; সার্ভারেও token bucket আছে)
  // ═════════════════════════════════════════════════════════════════
  const relayTyping = async (event, payload = {}) => {
    try {
      if (!payload.conversationId) return;
      if (!typingLimiter(`typing:${me.id}`)) return;
      const allowed = await isMemberCached(db, payload.conversationId, me.id);
      if (!allowed) return;

      const otherId = await db.conversations.otherMemberId(payload.conversationId, me.id);
      if (!otherId) return;
      emitToUsers(io, [otherId], event, {
        conversationId: payload.conversationId,
        userId: me.id,
        name: me.name
      });
    } catch (err) {
      logger.debug(`[socket] ${event} ব্যর্থ:`, err.message);
    }
  };

  socket.on('chat:typing', (payload) => relayTyping('chat:typing', payload));
  socket.on('chat:stopTyping', (payload) => relayTyping('chat:stopTyping', payload));

  // ═════════════════════════════════════════════════════════════════
  //  message:delivered — ক্লায়েন্ট একটি মেসেজ পেয়েছে বলে জানায়
  //  (সার্ভার যাচাই করে: শুধু প্রাপকই delivered করতে পারে)
  // ═════════════════════════════════════════════════════════════════
  socket.on('message:delivered', async (payload = {}, ack) => {
    try {
      if (!payload.messageId) return;
      const message = await db.messages.findById(payload.messageId);
      if (!message || message.receiverId !== me.id) {
        reply(ack, { ok: false, code: 'forbidden' });
        return;
      }
      const changed = await db.messages.markDelivered(message.id);
      if (changed) {
        emitDelivered(io, message.senderId, { conversationId: message.conversationId, ids: [message.id] });
      }
      reply(ack, { ok: true });
    } catch (err) {
      logger.debug('[socket] message:delivered ব্যর্থ:', err.message);
      reply(ack, { ok: false });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  message:read — conversation খোলা/দৃশ্যমান হলে সব read
  // ═════════════════════════════════════════════════════════════════
  socket.on('message:read', async (payload = {}, ack) => {
    try {
      if (!payload.conversationId) return;
      const allowed = await isMemberCached(db, payload.conversationId, me.id);
      if (!allowed) {
        reply(ack, { ok: false, code: 'forbidden' });
        return;
      }

      const updated = await db.messages.markConversationRead(payload.conversationId, me.id);

      // read receipt বন্ধ থাকলে প্রেরককে জানানো হয় না
      const fresh = await db.users.findById(me.id);
      if (fresh && fresh.privacy?.readReceipts !== false && updated.length) {
        const bySender = new Map();
        for (const row of updated) {
          if (!bySender.has(row.senderId)) bySender.set(row.senderId, []);
          bySender.get(row.senderId).push(row.id);
        }
        for (const [senderId, ids] of bySender) {
          emitRead(io, senderId, { conversationId: payload.conversationId, ids });
        }
      }
      reply(ack, { ok: true, readCount: updated.length });
    } catch (err) {
      logger.debug('[socket] message:read ব্যর্থ:', err.message);
      reply(ack, { ok: false });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  message:edit
  // ═════════════════════════════════════════════════════════════════
  socket.on('message:edit', async (payload = {}, ack) => {
    try {
      const { message, memberIds } = await messageService.editMessage(db, me.id, payload.messageId, payload.content);
      emitMessageEdited(io, memberIds, message);
      reply(ack, { ok: true, message: publicMessage(message) });
    } catch (err) {
      reply(ack, { ok: false, error: err.expose ? err.message : 'এডিট ব্যর্থ', code: err.code });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  message:delete — scope: 'me' | 'everyone'
  // ═════════════════════════════════════════════════════════════════
  socket.on('message:delete', async (payload = {}, ack) => {
    try {
      const scope = payload.scope === 'everyone' ? 'everyone' : 'me';
      const result = await messageService.deleteMessage(db, me.id, payload.messageId, scope);
      emitMessageDeleted(io, result.memberIds, {
        messageId: payload.messageId,
        conversationId: result.message.conversationId,
        scope: result.scope
      });
      reply(ack, { ok: true, scope: result.scope });
    } catch (err) {
      reply(ack, { ok: false, error: err.expose ? err.message : 'ডিলিট ব্যর্থ', code: err.code });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  presence:get — নির্দিষ্ট ইউজারদের অনলাইন স্ট্যাটাস (reconnect-এর পর)
  // ═════════════════════════════════════════════════════════════════
  socket.on('presence:get', async (payload = {}, ack) => {
    try {
      const ids = Array.isArray(payload.userIds) ? payload.userIds.slice(0, 200) : [];
      const users = await db.users.findByIds(ids);
      const statuses = users.map((user) => ({
        userId: user.id,
        isOnline: presence.isOnline(user.id) && user.privacy?.lastSeen !== 'nobody',
        lastSeen: user.privacy?.lastSeen === 'nobody' ? null : user.lastSeen
      }));
      reply(ack, { ok: true, statuses });
    } catch (err) {
      reply(ack, { ok: false });
    }
  });
}

module.exports = { registerChatHandlers, isMemberCached };
