/**
 * src/routes/users.js
 * ───────────────────────────────────────────────────────────────────────
 *   GET    /api/users              — ডিরেক্টরি (নতুন চ্যাট শুরু করার জন্য)
 *   GET    /api/users/search?q=    — নাম/ফোন দিয়ে সার্চ
 *   GET    /api/users/:id          — একজনের পাবলিক প্রোফাইল
 *   PATCH  /api/users/me           — নিজের নাম/about/privacy আপডেট
 *   POST   /api/users/me/avatar    — প্রোফাইল ছবি আপলোড
 *   DELETE /api/users/me/avatar    — প্রোফাইল ছবি মুছে ফেলা
 *
 * সব endpoint authenticated; কোনো রেসপন্সে password hash বা অন্য গোপন
 * তথ্য যায় না (src/services/serialize.js দেখুন)।
 */

'use strict';

const express = require('express');
const fs = require('fs');

const { getDb } = require('../../database');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { searchLimiter, uploadLimiter } = require('../middleware/rate-limit');
const { createUploader, verifyAndDescribe, resolveUploadPath } = require('../services/uploads');
const { presentUser, presentUsers } = require('../services/visibility');
const { normalizePhone } = require('../utils/phone');
const { parseInteger, requireId, requireOneOf, sanitizeLine, sanitizeText } = require('../utils/validate');
const { badRequest, notFound } = require('../utils/errors');
const { emitToUsers } = require('../sockets/emitters');

function createUsersRouter({ io }) {
  const router = express.Router();
  const avatarUploader = createUploader('avatar');

  router.use(requireAuth);

  // ── ডিরেক্টরি ───────────────────────────────────────────────────
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const limit = parseInteger(req.query.limit, { fallback: 50, min: 1, max: 100 });
      const offset = parseInteger(req.query.offset, { fallback: 0, min: 0, max: 10000 });
      const users = await db.users.list({ limit, offset, excludeUserId: req.user.id });
      res.json({ users: await presentUsers(db, users, req.user) });
    })
  );

  // ── সার্চ (নাম বা ফোন নম্বর) ─────────────────────────────────────
  router.get(
    '/search',
    searchLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const rawQuery = String(req.query.q || '').trim();
      if (rawQuery.length < 2) {
        res.json({ users: [] });
        return;
      }

      // ইনপুট যদি ফোন নম্বরের মতো দেখায়, normalized রূপেও খোঁজা হয়
      const queries = new Set([rawQuery]);
      const normalized = normalizePhone(rawQuery);
      if (normalized) queries.add(normalized);

      const found = new Map();
      for (const query of queries) {
        // eslint-disable-next-line no-await-in-loop
        const users = await db.users.search({ query, excludeUserId: req.user.id, limit: 20 });
        for (const user of users) found.set(user.id, user);
      }

      res.json({ users: await presentUsers(db, Array.from(found.values()), req.user) });
    })
  );

  // ── নিজের প্রোফাইল আপডেট ─────────────────────────────────────────
  router.patch(
    '/me',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const updates = {};

      if (req.body.name !== undefined) {
        const name = sanitizeLine(req.body.name, 60);
        if (name.length < 2) throw badRequest('নাম কমপক্ষে ২ অক্ষরের হতে হবে', 'validation');
        updates.name = name;
      }
      if (req.body.about !== undefined) {
        updates.about = sanitizeText(req.body.about, 160).trim();
      }

      let user = req.user;
      if (Object.keys(updates).length) {
        user = await db.users.updateProfile(req.user.id, updates);
      }

      // privacy সেটিং (ঐচ্ছিক)
      if (req.body.privacy && typeof req.body.privacy === 'object') {
        const privacy = {};
        if (req.body.privacy.lastSeen !== undefined) {
          privacy.lastSeen = requireOneOf(req.body.privacy.lastSeen, ['everyone', 'contacts', 'nobody'], 'lastSeen');
        }
        if (req.body.privacy.profilePhoto !== undefined) {
          privacy.profilePhoto = requireOneOf(
            req.body.privacy.profilePhoto,
            ['everyone', 'contacts', 'nobody'],
            'profilePhoto'
          );
        }
        if (req.body.privacy.readReceipts !== undefined) {
          privacy.readReceipts = !!req.body.privacy.readReceipts;
        }
        if (Object.keys(privacy).length) {
          user = await db.users.updatePrivacy(req.user.id, privacy);
        }
      }

      // প্রোফাইল বদলালে যাদের সাথে চ্যাট আছে তাদের UI আপডেট করা হয়
      const partnerIds = await db.conversations.partnerIds(user.id);
      emitToUsers(io, [...partnerIds, user.id], 'user:updated', await presentUser(db, user, null));

      res.json({ user: await presentUser(db, user, user) });
    })
  );

  // ── প্রোফাইল ছবি আপলোড ───────────────────────────────────────────
  router.post(
    '/me/avatar',
    uploadLimiter,
    avatarUploader.single('avatar'),
    asyncHandler(async (req, res) => {
      const db = getDb();
      const described = await verifyAndDescribe(req.file, 'avatar');

      // পুরনো ছবি ডিস্ক থেকে মুছে ফেলা হয় (জায়গা বাঁচাতে)
      const previous = req.user.avatar ? resolveUploadPath(req.user.avatar) : null;
      const user = await db.users.updateProfile(req.user.id, { avatar: described.url });
      if (previous) {
        fs.promises.unlink(previous).catch(() => {});
      }

      const partnerIds = await db.conversations.partnerIds(user.id);
      emitToUsers(io, [...partnerIds, user.id], 'user:updated', await presentUser(db, user, null));

      res.json({ user: await presentUser(db, user, user), avatar: described.url });
    })
  );

  router.delete(
    '/me/avatar',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const previous = req.user.avatar ? resolveUploadPath(req.user.avatar) : null;
      const user = await db.users.updateProfile(req.user.id, { avatar: null });
      if (previous) fs.promises.unlink(previous).catch(() => {});
      res.json({ user: await presentUser(db, user, user) });
    })
  );

  // ── একজনের প্রোফাইল (সবার শেষে, যাতে /search আগে ম্যাচ করে) ───────
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const id = requireId(req.params.id, 'user id');
      const user = await db.users.findById(id);
      if (!user) throw notFound('ইউজার পাওয়া যায়নি', 'user_not_found');
      res.json({ user: await presentUser(db, user, req.user) });
    })
  );

  return router;
}

module.exports = { createUsersRouter };
