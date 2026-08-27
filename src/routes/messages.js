/**
 * src/routes/messages.js
 * ───────────────────────────────────────────────────────────────────────
 *   POST   /api/messages          — মেসেজ পাঠানো (socket বিকল হলে fallback)
 *   PATCH  /api/messages/:id      — নিজের text মেসেজ এডিট
 *   DELETE /api/messages/:id      — ?scope=me | everyone
 *   GET    /api/messages/search   — সব চ্যাট জুড়ে সার্চ
 *
 * এই route গুলো message-service ব্যবহার করে, ঠিক যেমন Socket.IO handler
 * করে — তাই authorization/policy একই থাকে এবং real-time ইভেন্টও যায়।
 */

'use strict';

const express = require('express');

const { getDb } = require('../../database');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { messageLimiter, searchLimiter } = require('../middleware/rate-limit');
const messageService = require('../services/message-service');
const { publicMessage } = require('../services/serialize');
const { requireId, requireOneOf } = require('../utils/validate');
const { emitNewMessage, emitMessageEdited, emitMessageDeleted } = require('../sockets/emitters');

function createMessagesRouter({ io }) {
  const router = express.Router();
  router.use(requireAuth);

  // ── মেসেজ পাঠানো ─────────────────────────────────────────────────
  router.post(
    '/',
    messageLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const { message, receiverId } = await messageService.sendMessage(db, req.user.id, {
        conversationId: req.body.conversationId,
        receiverId: req.body.receiverId,
        receiverPhone: req.body.receiverPhone,
        type: req.body.type,
        content: req.body.content,
        mediaUrl: req.body.mediaUrl,
        mediaMeta: req.body.mediaMeta,
        replyTo: req.body.replyTo
      });

      emitNewMessage(io, { message, senderId: req.user.id, receiverId });
      res.status(201).json({ message: publicMessage(message) });
    })
  );

  // ── গ্লোবাল সার্চ (":id" রুটের আগে থাকতে হবে) ──────────────────────
  router.get(
    '/search',
    searchLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const query = String(req.query.q || '').trim();
      if (query.length < 2) {
        res.json({ messages: [] });
        return;
      }
      const messages = await db.messages.searchForUser({ userId: req.user.id, query, limit: 60 });
      res.json({ messages: messages.map(publicMessage) });
    })
  );

  // ── এডিট ─────────────────────────────────────────────────────────
  router.patch(
    '/:id',
    messageLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const id = requireId(req.params.id, 'message id');
      const { message, memberIds } = await messageService.editMessage(db, req.user.id, id, req.body.content);
      emitMessageEdited(io, memberIds, message);
      res.json({ message: publicMessage(message) });
    })
  );

  // ── ডিলিট ────────────────────────────────────────────────────────
  router.delete(
    '/:id',
    messageLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const id = requireId(req.params.id, 'message id');
      const scope = requireOneOf(String(req.query.scope || req.body.scope || 'me'), ['me', 'everyone'], 'scope');

      const result = await messageService.deleteMessage(db, req.user.id, id, scope);
      emitMessageDeleted(io, result.memberIds, {
        messageId: id,
        conversationId: result.message.conversationId,
        scope: result.scope
      });
      res.json({ ok: true, scope: result.scope });
    })
  );

  return router;
}

module.exports = { createMessagesRouter };
