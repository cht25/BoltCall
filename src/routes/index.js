/**
 * src/routes/index.js
 * ───────────────────────────────────────────────────────────────────────
 * সব REST route এক জায়গায় মাউন্ট করা হয় (/api প্রিফিক্সে)।
 *
 *   GET   /api/health                      (পাবলিক, কোনো গোপন তথ্য নেই)
 *   *     /api/auth/*                      register/login/logout/me/password
 *   *     /api/users/*                     ডিরেক্টরি, সার্চ, প্রোফাইল
 *   *     /api/contacts/*                  কনট্যাক্ট সিঙ্ক
 *   *     /api/conversations/*             চ্যাট লিস্ট, হিস্ট্রি, read, সার্চ
 *   *     /api/messages/*                  পাঠানো/এডিট/ডিলিট/সার্চ
 *   POST  /api/upload/{image,audio,file}   মিডিয়া আপলোড
 *   GET   /api/webrtc/ice-servers          STUN/TURN কনফিগ
 *   GET   /api/calls                       কল হিস্ট্রি
 */

'use strict';

const express = require('express');

const { createAuthRouter } = require('./auth');
const { createUsersRouter } = require('./users');
const { createContactsRouter } = require('./contacts');
const { createConversationsRouter } = require('./conversations');
const { createMessagesRouter } = require('./messages');
const { createUploadRouter } = require('./upload');
const { createWebrtcRouter } = require('./webrtc');
const { createCallsRouter } = require('./calls');
const presence = require('../services/presence');

function createApiRouter({ io }) {
  const router = express.Router();

  // health check — Render এই endpoint দিয়ে service জীবিত কি না দেখে
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      app: 'NexaChat',
      uptimeSeconds: Math.round(process.uptime()),
      onlineUsers: presence.onlineCount()
    });
  });

  router.use('/auth', createAuthRouter());
  router.use('/users', createUsersRouter({ io }));
  router.use('/contacts', createContactsRouter());
  router.use('/conversations', createConversationsRouter({ io }));
  router.use('/messages', createMessagesRouter({ io }));
  router.use('/upload', createUploadRouter());
  router.use('/webrtc', createWebrtcRouter());
  router.use('/calls', createCallsRouter());

  return router;
}

module.exports = { createApiRouter };
