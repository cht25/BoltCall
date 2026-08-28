/**
 * src/sockets/index.js
 * ───────────────────────────────────────────────────────────────────────
 * Socket.IO layer for the single group-call room.
 *
 * Lifecycle:  token check → join room channel → send `room:init` snapshot
 *             → relay signaling / chat / media-state between peers.
 *
 * The server never touches audio/video: WebRTC media flows peer-to-peer.
 * This layer is (1) signaling relay and (2) shared chat + presence state.
 * Everyone is addressed by member id only — the name every client renders
 * is config.room.memberName ("thamjj13"), enforced server-side.
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { verifyToken, tokenFromCookieHeader } = require('../services/tokens');
const { createSocketLimiter } = require('../middleware/rate-limit');
const {
  room,
  snapshot,
  add: addParticipant,
  get: getParticipant,
  remove: removeParticipant,
  updateMedia: updateParticipantMedia,
  pushMessage,
  mediaKinds
} = require('../services/room');

const CHANNEL = 'room'; // single Socket.IO room every participant joins

const chatLimiter = createSocketLimiter(config.rateLimits.socket.chatPerMinute);
const signalLimiter = createSocketLimiter(config.rateLimits.socket.signalPerMinute);
const stateLimiter = createSocketLimiter(config.rateLimits.socket.statePerMinute);

function attachSocketServer(io) {
  // ═══════════════════════════════════════════════════════════════════
  //  Handshake authentication — the token from the auth cookie is verified
  //  here; socket.handshake.auth is never trusted on its own.
  // ═══════════════════════════════════════════════════════════════════
  io.use((socket, next) => {
    try {
      const fromAuth = socket.handshake.auth && socket.handshake.auth.token;
      const fromCookie = tokenFromCookieHeader(socket.handshake.headers.cookie);
      const payload = verifyToken(fromAuth || fromCookie);
      if (!payload || !payload.sub) {
        next(new Error('unauthorized'));
        return;
      }
      socket.data.memberId = payload.sub;
      next();
    } catch (err) {
      logger.warn('[socket] auth failed:', err.message);
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const memberId = socket.data.memberId;

    // ── Register in the room (handles reconnect with a new socket id) ──
    const result = addParticipant(memberId, socket.id);
    if (!result) {
      logger.warn(`[socket] room full — rejecting member=${memberId}`);
      socket.emit('room:full', { maxParticipants: config.room.maxParticipants });
      socket.disconnect(true);
      return;
    }
    // A second tab of the same browser reuses the member cookie; kick the
    // older socket so each member has exactly one live connection.
    if (result.replacedSocketId && result.replacedSocketId !== socket.id) {
      const previous = io.sockets.sockets.get(result.replacedSocketId);
      if (previous) previous.disconnect(true);
    }

    socket.join(CHANNEL);
    logger.info(`[socket] connect — member=${memberId} socket=${socket.id} (in room: ${room.participants.size})`);

    // ── Initial state for the newcomer ────────────────────────────────
    socket.emit('room:init', {
      selfId: memberId,
      memberName: room.memberName,
      snapshot: snapshot()
    });

    // ── Broadcast the updated roster to everyone (newcomer included) ──
    io.to(CHANNEL).emit('room:state', { snapshot: snapshot() });

    // ═════════════════════════════════════════════════════════════════
    //  WebRTC signaling — relayed only to the addressed peer
    // ═════════════════════════════════════════════════════════════════
    function relay(eventName) {
      socket.on(eventName, (payload) => {
        const data = payload && typeof payload === 'object' ? payload : {};
        const target = typeof data.target === 'string' ? data.target : '';
        if (!target || target === memberId) return;
        if (!signalLimiter(`${memberId}:${eventName}`)) {
          socket.emit('error:signal', { error: 'Signaling too fast — please wait a moment' });
          return;
        }
        // Resolve member id → live socket id via the room roster.
        const entry = getParticipant(target);
        if (!entry) return; // peer already left
        const { target: _routed, ...rest } = data;
        io.to(entry.socketId).emit(eventName, {
          from: memberId,
          to: target,
          ...rest // never echo the routing field
        });
      });
    }

    // offer / answer carry SDP; ice carries candidates. candidate may be
    // null (end-of-candidates) — the envelope is always an object.
    relay('webrtc:offer');
    relay('webrtc:answer');
    relay('webrtc:ice');

    // ═════════════════════════════════════════════════════════════════
    //  Media state (mic / camera / screen) — broadcast to everyone
    // ═════════════════════════════════════════════════════════════════
    socket.on('media:state', (payload) => {
      const data = payload && typeof payload === 'object' ? payload : {};
      const patch = {};
      for (const kind of mediaKinds) {
        if (typeof data[kind] === 'boolean') patch[kind] = data[kind];
      }
      if (!Object.keys(patch).length) return;
      if (!stateLimiter(`${memberId}:media`)) return;

      if (updateParticipantMedia(memberId, patch)) {
        io.to(CHANNEL).emit('media:state', { memberId, ...patch });
      }
    });

    // ═════════════════════════════════════════════════════════════════
    //  Text chat — validated server-side, broadcast to everyone
    // ═════════════════════════════════════════════════════════════════
    socket.on('chat:send', (payload) => {
      const raw = payload && typeof payload.text === 'string' ? payload.text : '';
      const text = raw
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .slice(0, config.chat.maxMessageLength);

      if (!text) {
        socket.emit('chat:rejected', { reason: 'empty' });
        return;
      }
      if (!chatLimiter(memberId)) {
        socket.emit('chat:rejected', { reason: 'rate_limited' });
        return;
      }

      const message = pushMessage({ senderId: memberId, text });
      io.to(CHANNEL).emit('chat:receive', message);
    });

    // ── Disconnect: drop from the room and tell the rest ─────────────
    socket.on('disconnect', (reason) => {
      logger.info(`[socket] disconnect — member=${memberId} (${reason})`);
      const existed = removeParticipant(memberId, socket.id);
      if (existed) {
        io.to(CHANNEL).emit('room:state', { snapshot: snapshot() });
        // Notify the remaining peers so they can tear down connections.
        socket.to(CHANNEL).emit('peer:left', { memberId });
      }
    });

    socket.on('error', (err) => {
      logger.warn('[socket] error:', err && err.message);
    });
  });

  return {};
}

module.exports = { attachSocketServer };
