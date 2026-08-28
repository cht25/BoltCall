/**
 * src/routes/webrtc.js
 * ───────────────────────────────────────────────────────────────────────
 *   GET /api/webrtc/ice-servers
 *
 * ICE (STUN/TURN) configuration for the mesh. Only authenticated members
 * receive it. The Metered API key never reaches the frontend — the server
 * fetches ephemeral TURN credentials itself and serves just those.
 *
 * Response:
 * {
 *   iceServers: [ { urls: [...], username, credential } ],
 *   source: 'metered-api' | 'metered-static' | 'stun-only',
 *   ttl: 600,
 *   warning?: string
 * }
 */

'use strict';

const express = require('express');

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
        warning: ice.warning || null
      });
    })
  );

  return router;
}

module.exports = { createWebrtcRouter };
