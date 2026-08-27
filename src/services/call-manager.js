/**
 * src/services/call-manager.js
 * ───────────────────────────────────────────────────────────────────────
 * কল state machine — সার্ভার সাইড।
 *
 * ফ্রন্টএন্ডেও একটি state machine আছে (UI-র জন্য), কিন্তু চূড়ান্ত সত্য
 * সার্ভারের এই ম্যাপেই — কারণ ক্লায়েন্টকে বিশ্বাস করা যায় না। এখানে যা
 * নিশ্চিত করা হয়:
 *
 *   • একজন ইউজার একই সময়ে একটির বেশি সক্রিয় কলে থাকতে পারে না (busy)
 *   • signaling (offer/answer/ICE) শুধু ওই কলের দুই participant-এর মধ্যেই
 *     রিলে হয় — অন্য কেউ callId জানলেও ঢুকতে পারবে না
 *   • রিসিভার নির্দিষ্ট সময়ে না ধরলে সার্ভার নিজেই timeout করে (No answer)
 *   • প্রতিটি কল calls টেবিলে লগ হয় (history + missed call)
 *
 * state: ringing → connecting → connected → ended
 */

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * @param {object} options
 * @param {object} options.db            database adapter
 * @param {number} options.ringTimeoutMs রিং টাইমআউট
 * @param {(call:object)=>void} options.onTimeout টাইমআউট হলে socket লেয়ারকে জানানো
 */
function createCallManager({ db, ringTimeoutMs, onTimeout }) {
  const calls = new Map(); // callId → call
  const userToCall = new Map(); // userId → callId

  const isBusy = (userId) => userToCall.has(userId);

  function participants(call) {
    return [call.callerId, call.receiverId];
  }

  function isParticipant(call, userId) {
    return call && (call.callerId === userId || call.receiverId === userId);
  }

  /** কলের অপর প্রান্তের userId */
  function peerOf(call, userId) {
    if (!isParticipant(call, userId)) return null;
    return call.callerId === userId ? call.receiverId : call.callerId;
  }

  function clearTimer(call) {
    if (call && call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }
  }

  /**
   * নতুন কল শুরু (caller → receiver)।
   * @returns {Promise<{ok:true, call:object}|{ok:false, reason:string}>}
   */
  async function start({ callerId, receiverId, callType }) {
    if (callerId === receiverId) return { ok: false, reason: 'self_call' };
    if (isBusy(callerId)) return { ok: false, reason: 'caller_busy' };
    if (isBusy(receiverId)) return { ok: false, reason: 'receiver_busy' };

    const id = crypto.randomUUID();
    const call = {
      id,
      callerId,
      receiverId,
      callType: callType === 'video' ? 'video' : 'audio',
      state: 'ringing',
      createdAt: Date.now(),
      answeredAt: null,
      timer: null
    };

    calls.set(id, call);
    userToCall.set(callerId, id);
    userToCall.set(receiverId, id);

    // DB-তে লগ (missed call হিসেব করার জন্যও দরকার)
    await db.calls.create({
      id,
      callerId,
      receiverId,
      callType: call.callType,
      status: 'ringing'
    });

    // ── রিং টাইমআউট: নির্দিষ্ট সময়ে উত্তর না এলে কল বাতিল ────────────
    call.timer = setTimeout(async () => {
      const current = calls.get(id);
      if (!current || current.state !== 'ringing') return;
      logger.info(`[call] timeout — callId=${id}`);
      const finished = await finish(id, 'missed');
      if (finished && typeof onTimeout === 'function') onTimeout(finished);
    }, ringTimeoutMs);

    logger.info(`[call] শুরু — ${call.callType} call, callId=${id}`);
    return { ok: true, call };
  }

  /** রিসিভার accept করল → state 'connecting' (SDP আদান-প্রদান শুরু) */
  async function accept(callId, byUserId) {
    const call = calls.get(callId);
    if (!call) return { ok: false, reason: 'not_found' };
    if (call.receiverId !== byUserId) return { ok: false, reason: 'not_receiver' };
    if (call.state !== 'ringing') return { ok: false, reason: 'invalid_state' };

    clearTimer(call);
    call.state = 'connecting';
    call.answeredAt = Date.now();
    await db.calls.markAnswered(callId, call.answeredAt);
    logger.info(`[call] accepted — callId=${callId}`);
    return { ok: true, call };
  }

  /** মিডিয়া কানেক্ট হয়েছে (frontend জানায়) — শুধু state আপডেট */
  function markConnected(callId, byUserId) {
    const call = calls.get(callId);
    if (!call || !isParticipant(call, byUserId)) return null;
    if (call.state === 'connecting') call.state = 'connected';
    return call;
  }

  /**
   * কল শেষ/বাতিল করা এবং সব state পরিষ্কার করা।
   * @param {string} callId
   * @param {'ended'|'rejected'|'missed'|'busy'|'failed'|'cancelled'} status
   */
  async function finish(callId, status) {
    const call = calls.get(callId);
    if (!call) return null;

    clearTimer(call);
    calls.delete(callId);
    for (const userId of participants(call)) {
      if (userToCall.get(userId) === callId) userToCall.delete(userId);
    }

    const dbStatus = status === 'ended' ? 'answered' : status;
    const record = await db.calls.finish(callId, {
      status: call.answeredAt ? 'answered' : dbStatus,
      endedAt: Date.now()
    });

    const finished = {
      ...call,
      state: 'ended',
      endStatus: status,
      duration: record ? record.duration : 0,
      wasAnswered: !!call.answeredAt
    };
    logger.info(`[call] শেষ — callId=${callId}, status=${status}, duration=${finished.duration}s`);
    return finished;
  }

  /** কোনো ইউজারের চলমান কল (socket disconnect হলে cleanup-এ কাজে লাগে) */
  function callOfUser(userId) {
    const callId = userToCall.get(userId);
    return callId ? calls.get(callId) : null;
  }

  const get = (callId) => calls.get(callId) || null;
  const activeCount = () => calls.size;

  return {
    start,
    accept,
    markConnected,
    finish,
    get,
    callOfUser,
    isBusy,
    isParticipant,
    peerOf,
    participants,
    activeCount
  };
}

module.exports = { createCallManager };
