/**
 * src/routes/index.js
 * ───────────────────────────────────────────────────────────────────────
 * BoltCall REST API — intentionally tiny:
 *   GET  /api/health              public liveness check
 *   POST /api/auth/join           room password → session
 *   GET  /api/auth/me             session validation
 *   POST /api/auth/logout         clear session
 *   GET  /api/webrtc/ice-servers  STUN/TURN config for the mesh
 *
 * Everything else (signaling, chat, presence) happens over Socket.IO.
 */

'use strict';

const express = require('express');

const { createAuthRouter } = require('./auth');
const { createWebrtcRouter } = require('./webrtc');
const { room } = require('../services/room');

function createApiRouter({ io }) {
  void io; // reserved for future REST-triggered broadcasts
  const router = express.Router();

  // Health check — also used by Render to keep the service alive.
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      app: 'BoltCall',
      room: room.name,
      participants: room.participants.size,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  // Public room info for the join screen (never leaks the password; the
  // dev password hint only exists when the app runs without a configured
  // ROOM_PASSWORD in a non-production environment).
  router.get('/room/info', (req, res) => {
    res.json({
      name: room.name,
      memberName: room.memberName,
      maxParticipants: room.maxParticipants,
      devPassword: room.devPassword || null
    });
  });

  router.use('/auth', createAuthRouter());
  router.use('/webrtc', createWebrtcRouter());

  return router;
}

module.exports = { createApiRouter };
