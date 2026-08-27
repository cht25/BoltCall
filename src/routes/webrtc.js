/**
 * src/routes/webrtc.js
 * ───────────────────────────────────────────────────────────────────────
 *   GET /api/webrtc/ice-servers
 *
 * শুধুমাত্র লগইন করা ইউজার ICE (STUN/TURN) কনফিগারেশন পায়। Metered API key
 * কখনো রেসপন্সে বা frontend কোডে যায় না — সার্ভার নিজে Metered-এর কাছ থেকে
 * ephemeral credential এনে সেটিই পাঠায়।
 *
 * রেসপন্স:
 * {
 *   iceServers: [ { urls: [...], username, credential } ],
 *   source: 'metered-api' | 'metered-static' | 'stun-only',
 *   ttl: 600,
 *   ringTimeoutMs: 35000,
 *   warning?: string
 * }
 */

'use strict';

const express = require('express');

const config = require('../config');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { getIceServers } = require('../services/ice');

function createWebrtcRouter() {
  const router = express.Router();

  router.get(
    '/ice-servers',
    requireAuth,
    asyncHandler(async (req, res) => {
      const ice = await getIceServers();
      res.json({
        iceServers: ice.iceServers,
        source: ice.source,
        ttl: ice.ttl,
        cached: !!ice.cached,
        warning: ice.warning || null,
        ringTimeoutMs: config.call.ringTimeoutMs
      });
    })
  );

  return router;
}

module.exports = { createWebrtcRouter };
