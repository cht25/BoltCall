/**
 * src/middleware/rate-limit.js
 * ───────────────────────────────────────────────────────────────────────
 * Rate limiting — brute-force and spam protection.
 *
 *   • auth    → strictest budget (wrong-password guessing)
 *   • general → broad API budget
 *   • socket  → in-memory token buckets for socket events
 *               (express-rate-limit only covers HTTP)
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
    // count per IP (BoltCall sessions are anonymous memberships)
    keyGenerator: (req) => `ip:${req.ip}`,
    handler: (req, res) => {
      res.status(429).json({ error: message, code: 'rate_limited' });
    }
  });
}

const authLimiter = build(config.rateLimits.auth, 'Too many attempts — please try again in 15 minutes');
const generalLimiter = build(config.rateLimits.general, 'Too many requests — please slow down');

/**
 * Socket.IO token bucket (per key). Used for chat messages, media-state
 * updates and signaling events so no single socket can flood the room.
 */
function createSocketLimiter(perMinute) {
  const state = new Map(); // key → { tokens, updatedAt }
  const refillRate = perMinute / 60000; // tokens per ms

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

    // periodic cleanup to avoid unbounded growth
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
  generalLimiter,
  createSocketLimiter
};
