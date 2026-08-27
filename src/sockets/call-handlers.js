/**
 * src/sockets/call-handlers.js
 * ───────────────────────────────────────────────────────────────────────
 * WebRTC signaling — Socket.IO-র উপরে।
 *
 * ⚠️ কোনো room-link ব্যবস্থা নেই। কল সরাসরি userId বা ফোন নম্বর দিয়ে হয়।
 *
 * ইভেন্ট (client → server):
 *   call:request        { targetUserId | targetPhone, callType: 'audio'|'video' } → ack
 *   call:accept         { callId }
 *   call:reject         { callId }
 *   call:offer          { callId, sdp }
 *   call:answer         { callId, sdp }
 *   call:ice-candidate  { callId, candidate }
 *   call:connected      { callId }
 *   call:end            { callId, reason? }
 *
 * ইভেন্ট (server → client):
 *   call:incoming { callId, callType, from }        — রিসিভারের কাছে
 *   call:ringing  { callId, callType, to }          — কলারের কাছে
 *   call:accepted { callId }                        — কলার এখন offer বানাবে
 *   call:offer / call:answer / call:ice-candidate   — রিলে (শুধু participant-দের মধ্যে)
 *   call:busy     { callId, targetUserId }
 *   call:timeout  { callId }
 *   call:end      { callId, reason, duration }
 *   call:handled  { callId }                        — অন্য ট্যাবে কল ধরা হয়েছে
 *
 * নিরাপত্তা নীতি:
 *   • প্রেরকের পরিচয় সবসময় socket.data.user (JWT যাচাইকৃত) — payload নয়
 *   • callId জানলেও অ-participant কোনো signaling পাঠাতে/পেতে পারে না
 *   • একই ইউজারের একাধিক সমান্তরাল কল নিষিদ্ধ (busy)
 *   • রিসিভার অফলাইন হলে কল শুরুই হয় না
 */

'use strict';

const config = require('../config');
const { getDb } = require('../../database');
const logger = require('../utils/logger');
const presence = require('../services/presence');
const messageService = require('../services/message-service');
const { publicUser, publicMessage } = require('../services/serialize');
const { normalizePhone } = require('../utils/phone');
const { createSocketLimiter } = require('../middleware/rate-limit');
const { emitToUsers } = require('./emitters');

const callLimiter = createSocketLimiter(config.rateLimits.socket.callRequestsPerMinute);
const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

/** সেকেন্ড → 1:05 ফরম্যাট */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * কল শেষ হলে চ্যাটে একটি system মেসেজ যোগ করা হয় (WhatsApp-এর মতো
 * "Missed video call" / "Audio call · 1:05")। এতে কল হিস্ট্রি চ্যাটেও দেখা যায়।
 */
async function writeCallSystemMessage(io, call) {
  try {
    const db = getDb();
    const conversation = await db.conversations.ensureDirect(call.callerId, call.receiverId);
    const typeLabel = call.callType === 'video' ? 'Video' : 'Audio';

    let content;
    switch (call.endStatus) {
      case 'ended':
        content = call.wasAnswered
          ? `${typeLabel} call · ${formatDuration(call.duration)}`
          : `Cancelled ${typeLabel.toLowerCase()} call`;
        break;
      case 'missed':
        content = `Missed ${typeLabel.toLowerCase()} call`;
        break;
      case 'rejected':
        content = `${typeLabel} call declined`;
        break;
      case 'busy':
        content = 'Line was busy';
        break;
      case 'cancelled':
        content = `Cancelled ${typeLabel.toLowerCase()} call`;
        break;
      default:
        content = `${typeLabel} call failed`;
    }

    const message = await messageService.createSystemMessage(db, {
      conversationId: conversation.id,
      senderId: call.callerId,
      receiverId: call.receiverId,
      content,
      mediaMeta: {
        kind: 'call',
        callType: call.callType,
        status: call.endStatus,
        duration: call.duration || 0
      }
    });

    emitToUsers(io, [call.callerId, call.receiverId], 'chat:receive', publicMessage(message));
  } catch (err) {
    logger.warn('[call] system message লিখতে ব্যর্থ:', err.message);
  }
}

/** কল শেষ করে দুই প্রান্তকে জানানো + system message */
async function endCall(io, callManager, callId, status, { except = null } = {}) {
  const finished = await callManager.finish(callId, status);
  if (!finished) return null;

  const payload = {
    callId,
    reason: status,
    duration: finished.duration || 0,
    wasAnswered: finished.wasAnswered
  };
  const targets = [finished.callerId, finished.receiverId].filter((id) => id !== except);
  emitToUsers(io, targets, 'call:end', payload);
  await writeCallSystemMessage(io, finished);
  return finished;
}

/** রিং টাইমআউট (call-manager থেকে ডাকা হয়) */
async function handleCallTimeout(io, call) {
  emitToUsers(io, [call.callerId, call.receiverId], 'call:timeout', { callId: call.id });
  emitToUsers(io, [call.callerId, call.receiverId], 'call:end', {
    callId: call.id,
    reason: 'timeout',
    duration: 0,
    wasAnswered: false
  });
  // মিসড কল নোটিফিকেশন — রিসিভারের UI-তে দেখানোর জন্য
  emitToUsers(io, [call.receiverId], 'notification:missed-call', {
    callId: call.id,
    callerId: call.callerId,
    callType: call.callType
  });
  await writeCallSystemMessage(io, { ...call, endStatus: 'missed', duration: 0, wasAnswered: false });
}

function registerCallHandlers({ io, socket, callManager }) {
  const me = socket.data.user;
  const db = getDb();

  /** payload থেকে call বের করে participant যাচাই করে */
  function requireParticipantCall(callId) {
    const call = callManager.get(callId);
    if (!call) return { error: 'not_found' };
    if (!callManager.isParticipant(call, me.id)) {
      logger.warn(`[call] অননুমোদিত signaling চেষ্টা — userId=${me.id}, callId=${callId}`);
      return { error: 'forbidden' };
    }
    return { call };
  }

  // ═════════════════════════════════════════════════════════════════
  //  call:request — কল শুরু (userId বা ফোন নম্বর দিয়ে, কোনো room নেই)
  // ═════════════════════════════════════════════════════════════════
  socket.on('call:request', async (payload = {}, ack) => {
    try {
      if (!callLimiter(`call:${me.id}`)) {
        reply(ack, { ok: false, reason: 'rate_limited', message: 'অনেকবার কল করা হচ্ছে — একটু পরে চেষ্টা করুন' });
        return;
      }

      const callType = payload.callType === 'video' ? 'video' : 'audio';

      // ── টার্গেট ইউজার নির্ণয় ──────────────────────────────────
      let target = null;
      if (payload.targetUserId) {
        target = await db.users.findById(String(payload.targetUserId));
      } else if (payload.targetPhone) {
        const phone = normalizePhone(payload.targetPhone);
        if (phone) target = await db.users.findByPhone(phone);
      }

      if (!target) {
        reply(ack, { ok: false, reason: 'not_found', message: 'ব্যবহারকারী পাওয়া যায়নি' });
        return;
      }
      if (target.id === me.id) {
        reply(ack, { ok: false, reason: 'self_call', message: 'নিজেকে কল করা যাবে না' });
        return;
      }
      if (!presence.isOnline(target.id)) {
        reply(ack, { ok: false, reason: 'offline', message: `${target.name} এখন অফলাইন` });
        return;
      }

      const started = await callManager.start({ callerId: me.id, receiverId: target.id, callType });
      if (!started.ok) {
        if (started.reason === 'receiver_busy') {
          socket.emit('call:busy', { targetUserId: target.id });
          reply(ack, { ok: false, reason: 'busy', message: `${target.name} এখন অন্য কলে আছেন` });
          return;
        }
        if (started.reason === 'caller_busy') {
          reply(ack, { ok: false, reason: 'already_in_call', message: 'আপনি ইতিমধ্যে একটি কলে আছেন' });
          return;
        }
        reply(ack, { ok: false, reason: started.reason, message: 'কল শুরু করা যায়নি' });
        return;
      }

      const call = started.call;
      const caller = await db.users.findById(me.id);

      // রিসিভারের সব ডিভাইসে incoming কল
      emitToUsers(io, [target.id], 'call:incoming', {
        callId: call.id,
        callType: call.callType,
        from: publicUser(caller, { viewerId: target.id })
      });

      // কলারের কাছে ringing
      emitToUsers(io, [me.id], 'call:ringing', {
        callId: call.id,
        callType: call.callType,
        to: publicUser(target, { viewerId: me.id })
      });

      reply(ack, {
        ok: true,
        callId: call.id,
        callType: call.callType,
        ringTimeoutMs: config.call.ringTimeoutMs,
        to: publicUser(target, { viewerId: me.id })
      });
    } catch (err) {
      logger.error('[call] call:request error:', err.message);
      reply(ack, { ok: false, reason: 'failed', message: 'কল শুরু করা যায়নি' });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  call:accept — রিসিভার কল ধরল
  //  (এরপর কলার offer তৈরি করবে; ট্র্যাক যোগ করার পরেই — frontend দেখুন)
  // ═════════════════════════════════════════════════════════════════
  socket.on('call:accept', async (payload = {}, ack) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error) {
      reply(ack, { ok: false, reason: error });
      return;
    }
    const accepted = await callManager.accept(call.id, me.id);
    if (!accepted.ok) {
      reply(ack, { ok: false, reason: accepted.reason });
      return;
    }

    emitToUsers(io, [call.callerId], 'call:accepted', { callId: call.id, callType: call.callType });
    // রিসিভারের অন্য ট্যাব/ডিভাইসে রিং বন্ধ করার সংকেত
    socket.to(`user:${me.id}`).emit('call:handled', { callId: call.id });
    reply(ack, { ok: true, callId: call.id, callType: call.callType });
  });

  // ═════════════════════════════════════════════════════════════════
  //  call:reject
  // ═════════════════════════════════════════════════════════════════
  socket.on('call:reject', async (payload = {}, ack) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error) {
      reply(ack, { ok: false, reason: error });
      return;
    }
    socket.to(`user:${me.id}`).emit('call:handled', { callId: call.id });
    await endCall(io, callManager, call.id, 'rejected');
    reply(ack, { ok: true });
  });

  // ═════════════════════════════════════════════════════════════════
  //  SDP ও ICE রিলে — শুধু কলের অপর participant-এর কাছে
  // ═════════════════════════════════════════════════════════════════
  socket.on('call:offer', (payload = {}, ack) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error) {
      reply(ack, { ok: false, reason: error });
      return;
    }
    if (!payload.sdp || typeof payload.sdp !== 'object') {
      reply(ack, { ok: false, reason: 'invalid_sdp' });
      return;
    }
    const peerId = callManager.peerOf(call, me.id);
    emitToUsers(io, [peerId], 'call:offer', {
      callId: call.id,
      sdp: payload.sdp,
      fromUserId: me.id, // সার্ভার নির্ধারিত — ক্লায়েন্টের দাবি নয়
      iceRestart: !!payload.iceRestart
    });
    reply(ack, { ok: true });
  });

  socket.on('call:answer', (payload = {}, ack) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error) {
      reply(ack, { ok: false, reason: error });
      return;
    }
    if (!payload.sdp || typeof payload.sdp !== 'object') {
      reply(ack, { ok: false, reason: 'invalid_sdp' });
      return;
    }
    const peerId = callManager.peerOf(call, me.id);
    emitToUsers(io, [peerId], 'call:answer', { callId: call.id, sdp: payload.sdp, fromUserId: me.id });
    reply(ack, { ok: true });
  });

  socket.on('call:ice-candidate', (payload = {}) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error || !payload.candidate) return;
    const peerId = callManager.peerOf(call, me.id);
    emitToUsers(io, [peerId], 'call:ice-candidate', {
      callId: call.id,
      candidate: payload.candidate,
      fromUserId: me.id
    });
  });

  // মিডিয়া কানেক্ট হয়েছে — শুধু সার্ভার-সাইড state আপডেট
  socket.on('call:connected', (payload = {}) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error) return;
    callManager.markConnected(call.id, me.id);
  });

  // ═════════════════════════════════════════════════════════════════
  //  call:end — যে কেউ কল কাটতে পারে (রিং অবস্থায় কাটলে cancelled)
  // ═════════════════════════════════════════════════════════════════
  socket.on('call:end', async (payload = {}, ack) => {
    const { call, error } = requireParticipantCall(payload.callId);
    if (error) {
      reply(ack, { ok: false, reason: error });
      return;
    }
    const status = call.state === 'ringing' ? (me.id === call.callerId ? 'cancelled' : 'rejected') : 'ended';
    await endCall(io, callManager, call.id, status);
    reply(ack, { ok: true });
  });
}

/**
 * socket disconnect হলে চলমান কল পরিষ্কার করা — নইলে অপর প্রান্ত
 * অনির্দিষ্টকাল "connecting" অবস্থায় ঝুলে থাকবে।
 */
async function cleanupCallsForUser(io, callManager, userId) {
  const call = callManager.callOfUser(userId);
  if (!call) return;
  // অন্য কোনো ডিভাইস/ট্যাব এখনো অনলাইন থাকলে কল কাটার দরকার নেই
  if (presence.isOnline(userId)) return;

  const status = call.state === 'ringing' ? (userId === call.callerId ? 'cancelled' : 'missed') : 'ended';
  logger.info(`[call] disconnect cleanup — callId=${call.id}, status=${status}`);
  await endCall(io, callManager, call.id, status, { except: userId });
}

module.exports = { registerCallHandlers, handleCallTimeout, cleanupCallsForUser, endCall };
