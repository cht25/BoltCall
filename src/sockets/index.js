/**
 * src/sockets/index.js
 * ───────────────────────────────────────────────────────────────────────
 * Socket.IO সেটআপ: authentication → presence → chat handlers → call handlers।
 *
 * ⚠️ গুরুত্বপূর্ণ: socket.handshake.auth.userId কখনো বিশ্বাস করা হয় না।
 * প্রতিটি connection-এ httpOnly cookie (বা auth.token) থেকে JWT নিয়ে
 * signature+expiry যাচাই করা হয়, ডাটাবেস থেকে ইউজার লোড করা হয় এবং
 * socket.id ↔ authenticated userId ম্যাপ তৈরি হয়। যাচাই ব্যর্থ হলে
 * connection সরাসরি প্রত্যাখ্যাত।
 */

'use strict';

const config = require('../config');
const { getDb } = require('../../database');
const logger = require('../utils/logger');
const presence = require('../services/presence');
const { verifyToken, tokenFromCookieHeader } = require('../services/tokens');
const { createCallManager } = require('../services/call-manager');
const { registerChatHandlers } = require('./chat-handlers');
const { registerCallHandlers, handleCallTimeout, cleanupCallsForUser } = require('./call-handlers');
const { userRoom, emitDelivered, emitPresence } = require('./emitters');

/**
 * কোন কোন ইউজারকে এই ইউজারের presence পরিবর্তন জানানো হবে?
 * — যারা তাকে কনট্যাক্টে সেভ করেছে, এবং যাদের সাথে তার চ্যাট আছে।
 * (সবাইকে broadcast করা হয় না — অপ্রয়োজনীয় তথ্য ফাঁস ও ট্রাফিক এড়াতে)
 */
async function presenceWatchers(db, user) {
  const [contactWatchers, partners] = await Promise.all([
    db.contacts.watchersOf(user.phone),
    db.conversations.partnerIds(user.id)
  ]);
  return Array.from(new Set([...contactWatchers, ...partners]));
}

function attachSocketServer(io) {
  const db = getDb();

  // ── কল state machine (রিং টাইমআউট হলে socket লেয়ারকে জানায়) ──────
  const callManager = createCallManager({
    db,
    ringTimeoutMs: config.call.ringTimeoutMs,
    onTimeout: (call) => {
      handleCallTimeout(io, call).catch((err) => logger.error('[call] timeout handler:', err.message));
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  Handshake authentication middleware
  // ═════════════════════════════════════════════════════════════════
  io.use(async (socket, next) => {
    try {
      const fromAuth = socket.handshake.auth && socket.handshake.auth.token;
      const fromCookie = tokenFromCookieHeader(socket.handshake.headers.cookie);
      const payload = verifyToken(fromAuth || fromCookie);

      if (!payload || !payload.sub) {
        next(new Error('unauthorized'));
        return;
      }

      const user = await db.users.findById(payload.sub);
      if (!user || Number(payload.ver || 1) !== Number(user.tokenVersion || 1)) {
        next(new Error('unauthorized'));
        return;
      }

      // যাচাইকৃত পরিচয় socket-এ সংরক্ষণ (এর বাইরে কোনো পরিচয় বিশ্বাস নয়)
      socket.data.user = { id: user.id, name: user.name, phone: user.phone };
      next();
    } catch (err) {
      logger.warn('[socket] auth ব্যর্থ:', err.message);
      next(new Error('unauthorized'));
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  Connection lifecycle
  // ═════════════════════════════════════════════════════════════════
  io.on('connection', async (socket) => {
    const me = socket.data.user;
    socket.join(userRoom(me.id));

    const becameOnline = presence.addSocket(me.id, socket.id);
    logger.info(`[socket] connect — user=${me.id} socket=${socket.id} (online: ${presence.onlineCount()})`);

    try {
      if (becameOnline) {
        await db.users.setPresence(me.id, true);
        const watchers = await presenceWatchers(db, me);
        emitPresence(io, watchers, { userId: me.id, isOnline: true, lastSeen: Date.now() });
      }

      // ── অফলাইনে থাকা অবস্থায় আসা মেসেজগুলো এখন delivered ─────────
      const delivered = await db.messages.markDeliveredForReceiver(me.id);
      if (delivered.length) {
        const bySender = new Map();
        for (const row of delivered) {
          const key = `${row.senderId}:${row.conversationId}`;
          if (!bySender.has(key)) bySender.set(key, { senderId: row.senderId, conversationId: row.conversationId, ids: [] });
          bySender.get(key).ids.push(row.id);
        }
        for (const group of bySender.values()) {
          emitDelivered(io, group.senderId, { conversationId: group.conversationId, ids: group.ids });
        }
      }

      // ── ক্লায়েন্টকে জানানো: এখন সব ইভেন্ট পাঠানো নিরাপদ ────────────
      socket.emit('ready', {
        userId: me.id,
        serverTime: Date.now(),
        deliveredCount: delivered.length
      });
    } catch (err) {
      logger.error('[socket] connection setup error:', err.message);
    }

    // ── ইভেন্ট হ্যান্ডলার রেজিস্ট্রেশন ─────────────────────────────
    registerChatHandlers({ io, socket });
    registerCallHandlers({ io, socket, callManager });

    // ── disconnect: presence + call cleanup ───────────────────────
    socket.on('disconnect', async (reason) => {
      const becameOffline = presence.removeSocket(me.id, socket.id);
      logger.info(`[socket] disconnect — user=${me.id} (${reason})`);

      try {
        if (becameOffline) {
          const lastSeen = Date.now();
          await db.users.setPresence(me.id, false, lastSeen);
          const watchers = await presenceWatchers(db, me);
          emitPresence(io, watchers, { userId: me.id, isOnline: false, lastSeen });
        }
        // চলমান কল থাকলে পরিষ্কার করা
        await cleanupCallsForUser(io, callManager, me.id);
      } catch (err) {
        logger.error('[socket] disconnect cleanup error:', err.message);
      }
    });

    socket.on('error', (err) => {
      logger.warn('[socket] error:', err && err.message);
    });
  });

  return { callManager };
}

module.exports = { attachSocketServer };
