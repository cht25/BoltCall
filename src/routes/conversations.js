/**
 * src/routes/conversations.js
 * ───────────────────────────────────────────────────────────────────────
 *   GET  /api/conversations                 — সাইডবারের চ্যাট লিস্ট
 *   POST /api/conversations                 — {userId|phone} দিয়ে চ্যাট খোলা
 *   GET  /api/conversations/:id/messages    — হিস্ট্রি (paginated)
 *   POST /api/conversations/:id/read        — সব মেসেজ read করা
 *   GET  /api/conversations/:id/search?q=   — এই চ্যাটের ভেতরে সার্চ
 *
 * Authorization: প্রতিটি endpoint-এ যাচাই করা হয় ইউজার সত্যিই ওই
 * conversation-এর সদস্য কি না — শুধু id জানলেই কেউ অন্যের চ্যাট পড়তে পারবে না।
 */

'use strict';

const express = require('express');

const config = require('../config');
const { getDb } = require('../../database');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rate-limit');
const { publicConversation, publicMessage } = require('../services/serialize');
const { presentUser } = require('../services/visibility');
const { normalizePhone } = require('../utils/phone');
const { parseInteger, requireId } = require('../utils/validate');
const { badRequest, forbidden, notFound } = require('../utils/errors');
const { emitRead, emitToUsers } = require('../sockets/emitters');

function createConversationsRouter({ io }) {
  const router = express.Router();
  router.use(requireAuth);

  /** সদস্যপদ যাচাই করে conversation ফেরত দেয়, নাহলে error */
  async function requireMembership(db, conversationId, userId) {
    const conversation = await db.conversations.getById(conversationId);
    if (!conversation) throw notFound('চ্যাট পাওয়া যায়নি', 'conversation_not_found');
    const isMember = await db.conversations.isMember(conversationId, userId);
    if (!isMember) throw forbidden('এই চ্যাট দেখার অনুমতি নেই', 'not_a_member');
    return conversation;
  }

  // ── চ্যাট লিস্ট ───────────────────────────────────────────────────
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const summaries = await db.conversations.listForUser(req.user.id, { limit: 200 });

      const conversations = [];
      for (const summary of summaries) {
        // privacy প্রয়োগ করে partner object তৈরি
        // eslint-disable-next-line no-await-in-loop
        const partner = await presentUser(db, summary.partner, req.user);
        conversations.push({ ...publicConversation(summary), partner });
      }

      res.json({ conversations });
    })
  );

  // ── নতুন/বিদ্যমান direct চ্যাট খোলা ───────────────────────────────
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const db = getDb();
      let partner = null;

      if (req.body.userId) {
        partner = await db.users.findById(requireId(req.body.userId, 'userId'));
      } else if (req.body.phone) {
        const phone = normalizePhone(req.body.phone);
        if (!phone) throw badRequest('ফোন নম্বর সঠিক নয়', 'invalid_phone');
        partner = await db.users.findByPhone(phone);
      } else {
        throw badRequest('userId অথবা phone দিতে হবে', 'validation');
      }

      if (!partner) throw notFound('এই ব্যবহারকারী NexaChat-এ নেই', 'user_not_found');
      if (partner.id === req.user.id) throw badRequest('নিজের সাথে চ্যাট করা যাবে না', 'self_conversation');

      const conversation = await db.conversations.ensureDirect(req.user.id, partner.id);
      const unreadCount = await db.messages.unreadCount(conversation.id, req.user.id);
      const lastMessage = await db.messages.lastVisibleFor(conversation.id, req.user.id);

      const payload = {
        ...publicConversation({ ...conversation, unreadCount, lastMessage, partner }),
        partner: await presentUser(db, partner, req.user)
      };

      // অপর প্রান্তেও চ্যাট লিস্টে যেন সাথে সাথে দেখা যায়
      emitToUsers(io, [partner.id], 'conversation:created', { conversationId: conversation.id });

      res.status(201).json({ conversation: payload });
    })
  );

  // ── মেসেজ হিস্ট্রি ────────────────────────────────────────────────
  router.get(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const conversationId = requireId(req.params.id, 'conversation id');
      await requireMembership(db, conversationId, req.user.id);

      const limit = parseInteger(req.query.limit, {
        fallback: config.chat.messagePageSize,
        min: 1,
        max: 100
      });
      // `before` = timestamp; পুরনো মেসেজ লোড করতে ব্যবহৃত হয়
      const before = parseInteger(req.query.before, { fallback: 0, min: 0 });

      const messages = await db.messages.listForConversation({
        conversationId,
        userId: req.user.id,
        limit,
        before
      });

      res.json({
        conversationId,
        messages: messages.map(publicMessage),
        hasMore: messages.length === limit
      });
    })
  );

  // ── conversation read করা (দুই টিক নীল) ───────────────────────────
  router.post(
    '/:id/read',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const conversationId = requireId(req.params.id, 'conversation id');
      await requireMembership(db, conversationId, req.user.id);

      const updated = await db.messages.markConversationRead(conversationId, req.user.id);

      // read receipt বন্ধ থাকলে প্রেরককে জানানো হয় না (privacy)
      if (req.user.privacy?.readReceipts !== false && updated.length) {
        const bySender = new Map();
        for (const row of updated) {
          if (!bySender.has(row.senderId)) bySender.set(row.senderId, []);
          bySender.get(row.senderId).push(row.id);
        }
        for (const [senderId, ids] of bySender) {
          emitRead(io, senderId, { conversationId, ids });
        }
      }

      res.json({ ok: true, readCount: updated.length });
    })
  );

  // ── চ্যাটের ভেতরে সার্চ ───────────────────────────────────────────
  router.get(
    '/:id/search',
    searchLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const conversationId = requireId(req.params.id, 'conversation id');
      await requireMembership(db, conversationId, req.user.id);

      const query = String(req.query.q || '').trim();
      if (query.length < 2) {
        res.json({ messages: [] });
        return;
      }

      const messages = await db.messages.searchInConversation({
        conversationId,
        userId: req.user.id,
        query,
        limit: 60
      });
      res.json({ messages: messages.map(publicMessage) });
    })
  );

  return router;
}

module.exports = { createConversationsRouter };
