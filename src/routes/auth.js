/**
 * src/routes/auth.js
 * ───────────────────────────────────────────────────────────────────────
 * প্রমাণীকরণ endpoint সমূহ:
 *   POST /api/auth/register  — ফোন নম্বর দিয়ে নতুন অ্যাকাউন্ট (OTP ছাড়া, ডেমো)
 *   POST /api/auth/login     — ফোন + পাসওয়ার্ড/PIN
 *   POST /api/auth/logout    — cookie মুছে ফেলা
 *   GET  /api/auth/me        — সেশন যাচাই (পেজ রিফ্রেশের পরেও লগইন থাকে)
 *   PATCH /api/auth/password — পাসওয়ার্ড পরিবর্তন (পুরনো সব সেশন বাতিল)
 *
 * নিরাপত্তা:
 *   • পাসওয়ার্ড কখনো plaintext-এ সংরক্ষণ হয় না — bcrypt hash (cost 10)
 *   • লগইন ব্যর্থ হলে একই generic বার্তা (কোন নম্বর রেজিস্টার্ড তা ফাঁস হয় না)
 *   • rate limiter দিয়ে brute-force প্রতিরোধ
 *   • JWT httpOnly cookie-তে যায়, সাথে CSRF cookie
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const { getDb } = require('../../database');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');
const { createUploader, verifyAndDescribe } = require('../services/uploads');
const { signToken, setAuthCookies, clearAuthCookies } = require('../services/tokens');
const { presentUser } = require('../services/visibility');
const { normalizePhone } = require('../utils/phone');
const { requireString, requirePassword, sanitizeLine, sanitizeText } = require('../utils/validate');
const { badRequest, conflict, unauthorized } = require('../utils/errors');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 10;

function createAuthRouter() {
  const router = express.Router();
  const avatarUploader = createUploader('avatar');

  /** ভ্যালিডেশন ব্যর্থ হলে আপলোড হয়ে যাওয়া ফাইল মুছে ফেলা হয় */
  async function cleanupFile(file) {
    if (!file) return;
    try {
      await fs.promises.unlink(file.path);
    } catch {
      /* উপেক্ষা করা যায় */
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  POST /api/auth/register
  //  multipart/form-data (avatar সহ) বা JSON — দুটোই সমর্থিত
  // ═══════════════════════════════════════════════════════════════════
  router.post(
    '/register',
    authLimiter,
    avatarUploader.single('avatar'),
    asyncHandler(async (req, res) => {
      const db = getDb();
      try {
        const rawPhone = requireString(req.body.phone, 'ফোন নম্বর', { min: 5, max: 24 });
        const phone = normalizePhone(rawPhone);
        if (!phone) {
          throw badRequest('ফোন নম্বরটি সঠিক নয় (উদাহরণ: +8801712345678)', 'invalid_phone');
        }

        const name = sanitizeLine(requireString(req.body.name, 'নাম', { min: 2, max: 60 }), 60);
        const password = requirePassword(req.body.password);
        const about = sanitizeText(req.body.about || '', 160).trim();

        // ── ডুপ্লিকেট ফোন নম্বর প্রতিরোধ ────────────────────────────
        const existing = await db.users.findByPhone(phone);
        if (existing) {
          throw conflict('এই ফোন নম্বর দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে — লগইন করুন', 'phone_exists');
        }

        // ── ঐচ্ছিক প্রোফাইল ছবি ────────────────────────────────────
        let avatarUrl = null;
        if (req.file) {
          const described = await verifyAndDescribe(req.file, 'avatar');
          avatarUrl = described.url;
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const user = await db.users.create({ phone, name, passwordHash, avatar: avatarUrl, about });

        const token = signToken(user);
        setAuthCookies(res, token);
        logger.success(`[auth] নতুন রেজিস্ট্রেশন — userId=${user.id}`);

        res.status(201).json({
          user: await presentUser(db, user, user),
          token // Bearer ব্যবহারকারী ক্লায়েন্টের জন্য (ব্রাউজার cookie ব্যবহার করে)
        });
      } catch (err) {
        await cleanupFile(req.file);
        throw err;
      }
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  POST /api/auth/login
  // ═══════════════════════════════════════════════════════════════════
  router.post(
    '/login',
    authLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const rawPhone = requireString(req.body.phone, 'ফোন নম্বর', { min: 5, max: 24 });
      const phone = normalizePhone(rawPhone);
      const password = typeof req.body.password === 'string' ? req.body.password : '';

      // একই বার্তা — user enumeration এড়াতে
      const invalid = unauthorized('ফোন নম্বর অথবা পাসওয়ার্ড ভুল', 'invalid_credentials');
      if (!phone || !password) throw invalid;

      const user = await db.users.findByPhone(phone, { withSecrets: true });
      if (!user) {
        // টাইমিং অ্যাটাক কমাতে একটি ডামি compare চালানো হয়
        await bcrypt.compare(password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
        throw invalid;
      }

      const ok = await bcrypt.compare(password, user.passwordHash || '');
      if (!ok) throw invalid;

      const token = signToken(user);
      setAuthCookies(res, token);
      logger.info(`[auth] লগইন সফল — userId=${user.id}`);

      res.json({ user: await presentUser(db, user, user), token });
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  POST /api/auth/logout
  // ═══════════════════════════════════════════════════════════════════
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      clearAuthCookies(res);
      res.json({ ok: true });
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  GET /api/auth/me — সেশন ভ্যালিডেশন
  // ═══════════════════════════════════════════════════════════════════
  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = getDb();
      // csrf cookie মেয়াদোত্তীর্ণ হলে নতুন করে ইস্যু করা হয়
      const token = signToken(req.user);
      setAuthCookies(res, token);

      res.json({
        user: await presentUser(db, req.user, req.user),
        unreadTotal: await db.messages.totalUnread(req.user.id)
      });
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  PATCH /api/auth/password — পাসওয়ার্ড/PIN পরিবর্তন
  // ═══════════════════════════════════════════════════════════════════
  router.patch(
    '/password',
    requireAuth,
    authLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const current = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
      const next = requirePassword(req.body.newPassword, 'নতুন পাসওয়ার্ড');

      const full = await db.users.findById(req.user.id, { withSecrets: true });
      const ok = await bcrypt.compare(current, full.passwordHash || '');
      if (!ok) throw unauthorized('বর্তমান পাসওয়ার্ড ভুল', 'invalid_credentials');

      const passwordHash = await bcrypt.hash(next, BCRYPT_ROUNDS);
      const updated = await db.users.updatePassword(req.user.id, passwordHash);

      // token_version বেড়ে গেছে → নতুন token দিতে হবে, পুরনো সব সেশন বাতিল
      setAuthCookies(res, signToken(updated));
      res.json({ ok: true, user: await presentUser(db, updated, updated) });
    })
  );

  return router;
}

module.exports = { createAuthRouter };
