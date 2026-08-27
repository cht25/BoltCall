/**
 * src/middleware/rate-limit.js
 * ───────────────────────────────────────────────────────────────────────
 * Rate limiting — স্প্যাম, brute-force ও abuse প্রতিরোধ।
 *
 * আলাদা আলাদা বাজেট রাখা হয়েছে কারণ সব endpoint-এর ঝুঁকি সমান নয়:
 *   • auth   → brute-force আটকাতে সবচেয়ে কঠোর
 *   • search → ডাটাবেস স্ক্যান ব্যয়বহুল
 *   • upload → ডিস্ক/ব্যান্ডউইথ ব্যয়বহুল
 *   • message→ স্প্যাম আটকানো (socket পাশেও token bucket আছে)
 */

'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

function build({ windowMs, max }, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // লগইন-করা ইউজার হলে userId, নাহলে IP অনুযায়ী গণনা
    keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
    handler: (req, res) => {
      res.status(429).json({ error: message, code: 'rate_limited' });
    }
  });
}

const authLimiter = build(config.rateLimits.auth, 'অনেকবার চেষ্টা করা হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন');
const searchLimiter = build(config.rateLimits.search, 'সার্চের সীমা ছাড়িয়ে গেছে — একটু পরে চেষ্টা করুন');
const messageLimiter = build(config.rateLimits.message, 'অনেক দ্রুত মেসেজ পাঠানো হচ্ছে — একটু ধীরে');
const uploadLimiter = build(config.rateLimits.upload, 'আপলোডের সীমা ছাড়িয়ে গেছে — একটু পরে চেষ্টা করুন');
const generalLimiter = build(config.rateLimits.general, 'অনেক বেশি রিকোয়েস্ট — একটু পরে চেষ্টা করুন');

/**
 * Socket.IO ইভেন্টের জন্য সাধারণ token bucket (per socket)।
 * express-rate-limit শুধু HTTP-তে কাজ করে, তাই socket-এর জন্য এটি।
 */
function createSocketLimiter(perMinute) {
  const state = new Map(); // key → { tokens, updatedAt }
  const refillRate = perMinute / 60000; // প্রতি ms-এ কত token

  return function consume(key, cost = 1) {
    const nowMs = Date.now();
    const entry = state.get(key) || { tokens: perMinute, updatedAt: nowMs };
    const elapsed = nowMs - entry.updatedAt;
    entry.tokens = Math.min(perMinute, entry.tokens + elapsed * refillRate);
    entry.updatedAt = nowMs;

    if (entry.tokens < cost) {
      state.set(key, entry);
      return false;
    }
    entry.tokens -= cost;
    state.set(key, entry);

    // মেমরি লিক আটকাতে মাঝে মাঝে পুরনো এন্ট্রি পরিষ্কার
    if (state.size > 5000) {
      for (const [k, v] of state) {
        if (nowMs - v.updatedAt > 300000) state.delete(k);
      }
    }
    return true;
  };
}

module.exports = {
  authLimiter,
  searchLimiter,
  messageLimiter,
  uploadLimiter,
  generalLimiter,
  createSocketLimiter
};
