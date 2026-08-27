/**
 * src/middleware/auth.js
 * ───────────────────────────────────────────────────────────────────────
 * প্রমাণীকরণ (authentication) middleware।
 *
 * প্রতিটি protected request-এ:
 *   ১) cookie বা Authorization header থেকে JWT নেওয়া হয়
 *   ২) signature ও expiry যাচাই করা হয়
 *   ৩) ডাটাবেস থেকে ইউজার লোড করা হয় (token-এ থাকা তথ্য বিশ্বাস করা হয় না)
 *   ৪) token_version মিলিয়ে দেখা হয় — পাসওয়ার্ড বদলালে পুরনো token বাতিল
 *
 * req.user সবসময় ডাটাবেসের বর্তমান অবস্থা, ক্লায়েন্টের দাবি নয়।
 */

'use strict';

const { getDb } = require('../../database');
const { extractToken, verifyToken } = require('../services/tokens');
const { unauthorized } = require('../utils/errors');

async function resolveUser(req) {
  const { token, source } = extractToken(req);
  if (!token) return { user: null, source: null };

  const payload = verifyToken(token);
  if (!payload || !payload.sub) return { user: null, source };

  const user = await getDb().users.findById(payload.sub);
  if (!user) return { user: null, source };

  // token_version না মিললে সেশন বাতিল
  if (Number(payload.ver || 1) !== Number(user.tokenVersion || 1)) return { user: null, source };

  return { user, source };
}

/** বাধ্যতামূলক লগইন */
async function requireAuth(req, res, next) {
  try {
    const { user, source } = await resolveUser(req);
    if (!user) {
      next(unauthorized('সেশন শেষ হয়ে গেছে — আবার লগইন করুন', 'session_expired'));
      return;
    }
    req.user = user;
    req.authSource = source;
    next();
  } catch (err) {
    next(err);
  }
}

/** লগইন থাকলে req.user সেট করে, না থাকলেও request চলতে দেয় */
async function optionalAuth(req, res, next) {
  try {
    const { user, source } = await resolveUser(req);
    req.user = user || null;
    req.authSource = source;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, optionalAuth, resolveUser };
