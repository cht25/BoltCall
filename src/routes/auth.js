/**
 * src/routes/auth.js
 * ───────────────────────────────────────────────────────────────────────
 * BoltCall entry gate:
 *   POST /api/auth/join   — room password → signed member token (cookie)
 *   GET  /api/auth/me     — session check (still valid after refresh)
 *   POST /api/auth/logout — clear the member cookie
 *
 * There is no registration, no phone number and NO name field: every
 * member appears as config.room.memberName in the room.
 *
 * Security notes:
 *   • password verification is constant-time (bcrypt.compare / timingSafeEqual)
 *   • wrong-password attempts share the same generic message and hit the
 *     auth rate limiter (brute-force protection)
 *   • the JWT is only issued after the password verifies
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('../config');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');
const { signToken, setAuthCookies, clearAuthCookies } = require('../services/tokens');
const { unauthorized } = require('../utils/errors');
const logger = require('../utils/logger');

/** Constant-time comparison for plain-text room passwords. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison so timing differs less by length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

async function passwordMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  if (config.room.password.kind === 'hash') {
    try {
      return await bcrypt.compare(candidate, config.room.password.value);
    } catch {
      return false;
    }
  }
  return safeEqual(candidate, config.room.password.value);
}

function createAuthRouter() {
  const router = express.Router();

  // ── POST /api/auth/join ─────────────────────────────────────────────
  router.post(
    '/join',
    authLimiter,
    asyncHandler(async (req, res) => {
      const password = typeof req.body.password === 'string' ? req.body.password : '';

      // Identical message whether the password is wrong or the room is full
      // (no information leak).
      const invalid = () => unauthorized('Incorrect password', 'invalid_password');

      if (!password || !(await passwordMatches(password))) {
        logger.warn('[auth] join rejected — wrong password');
        throw invalid();
      }

      const memberId = crypto.randomUUID();
      const token = signToken(memberId);
      setAuthCookies(res, token);
      logger.info(`[auth] join accepted — member=${memberId}`);

      res.json({
        ok: true,
        member: { id: memberId, name: config.room.memberName },
        room: { name: config.room.name }
      });
    })
  );

  // ── GET /api/auth/me — session validation after refresh ─────────────
  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({
        ok: true,
        member: { id: req.user.id, name: config.room.memberName },
        room: {
          name: config.room.name,
          maxParticipants: config.room.maxParticipants,
          devPassword: !config.isProduction ? config.room.password.devHint || null : null
        }
      });
    })
  );

  // ── POST /api/auth/logout ───────────────────────────────────────────
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      clearAuthCookies(res);
      res.json({ ok: true });
    })
  );

  return router;
}

module.exports = { createAuthRouter };
