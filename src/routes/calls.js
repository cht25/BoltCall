/**
 * src/routes/calls.js
 * ───────────────────────────────────────────────────────────────────────
 *   GET /api/calls — কল হিস্ট্রি (নিজের অংশ নেওয়া কলগুলো)
 *
 * কল signaling কখনো HTTP দিয়ে হয় না — সেটি সম্পূর্ণভাবে authenticated
 * Socket.IO চ্যানেলে হয় (src/sockets/call-handlers.js)। এখানে শুধু হিস্ট্রি।
 */

'use strict';

const express = require('express');

const { getDb } = require('../../database');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { publicCall } = require('../services/serialize');
const { presentUser } = require('../services/visibility');
const { parseInteger } = require('../utils/validate');

function createCallsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const limit = parseInteger(req.query.limit, { fallback: 50, min: 1, max: 100 });
      const calls = await db.calls.listForUser(req.user.id, { limit });

      // প্রতিটি কলের অপর প্রান্তের ইউজার তথ্য যোগ করা হয় (UI-তে নাম দেখাতে)
      const cache = new Map();
      const output = [];
      for (const call of calls) {
        const peerId = call.callerId === req.user.id ? call.receiverId : call.callerId;
        if (!cache.has(peerId)) {
          // eslint-disable-next-line no-await-in-loop
          const user = await db.users.findById(peerId);
          // eslint-disable-next-line no-await-in-loop
          cache.set(peerId, user ? await presentUser(db, user, req.user) : null);
        }
        output.push({
          ...publicCall(call),
          direction: call.callerId === req.user.id ? 'outgoing' : 'incoming',
          peer: cache.get(peerId)
        });
      }

      res.json({ calls: output });
    })
  );

  return router;
}

module.exports = { createCallsRouter };
