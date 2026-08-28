/**
 * src/services/room.js
 * ───────────────────────────────────────────────────────────────────────
 * The heart of BoltCall: one shared group-call room, kept in memory.
 *
 * It tracks:
 *   • participants — memberId → { socketId, joinedAt, media: {mic,cam,screen} }
 *   • history     — the last N text messages of the session (new joiners
 *                   receive them so they are not greeted by an empty chat)
 *
 * Everyone in the room is displayed under config.room.memberName —
 * BoltCall never asks for or stores a personal name.
 *
 * ⚠️  Single-instance design: state lives in process memory. Deploy with
 * exactly one instance (render.yaml already sets numInstances: 1).
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');

const mediaKinds = ['mic', 'cam', 'screen'];
const MEDIA_RESET = Object.freeze({ mic: false, cam: false, screen: false });

const room = {
  name: config.room.name,
  memberName: config.room.memberName,
  maxParticipants: config.room.maxParticipants,
  participants: new Map(), // memberId → participant
  history: [], // [{ id, senderId, senderName, text, at }]
  historySeq: 0
};

/** The room state snapshot every participant needs on join / on change. */
function snapshot() {
  const participants = Array.from(room.participants.values()).map((p) => ({
    id: p.id,
    socketId: p.socketId,
    joinedAt: p.joinedAt,
    media: { ...p.media }
  }));
  return {
    room: { name: room.name, memberName: room.memberName, maxParticipants: config.room.maxParticipants },
    participants,
    history: room.history,
    count: participants.length
  };
}

/**
 * Register a socket as a participant. Returns
 * `{ entry, replacedSocketId }` (replacedSocketId set when the same member
 * reconnected with a newer socket), or null when the room is full.
 */
function add(memberId, socketId) {
  if (room.participants.has(memberId)) {
    // Same member reconnected (or a second tab) — keep their place and
    // media state; report the previous socket so the caller can drop it.
    const entry = room.participants.get(memberId);
    const replacedSocketId = entry.socketId;
    entry.socketId = socketId;
    return { entry, replacedSocketId };
  }
  if (room.participants.size >= config.room.maxParticipants) return null;

  const entry = {
    id: memberId,
    socketId,
    joinedAt: Date.now(),
    media: { ...MEDIA_RESET }
  };
  room.participants.set(memberId, entry);
  logger.info(`[room] joined — member=${memberId} (now ${room.participants.size} in room)`);
  return { entry, replacedSocketId: null };
}

/**
 * Remove a participant, but only if their roster entry still belongs to
 * `socketId`. (When a second tab takes over, the old socket disconnects
 * afterwards — it must not delete the entry owned by the new socket.)
 * Returns true when the participant was actually removed.
 */
function remove(memberId, socketId) {
  const entry = room.participants.get(memberId);
  if (!entry) return false;
  if (socketId !== undefined && entry.socketId !== socketId) return false;
  room.participants.delete(memberId);
  logger.info(`[room] left — member=${memberId} (${room.participants.size} remaining)`);
  return true;
}

function get(memberId) {
  return room.participants.get(memberId) || null;
}

function isFull() {
  return room.participants.size >= config.room.maxParticipants;
}

/** Update a participant's media flags; unknown kinds are ignored. */
function updateMedia(memberId, patch) {
  const entry = room.participants.get(memberId);
  if (!entry) return false;
  let changed = false;
  for (const kind of mediaKinds) {
    const value = patch[kind];
    if (typeof value === 'boolean' && value !== entry.media[kind]) {
      entry.media[kind] = value;
      changed = true;
    }
  }
  return changed;
}

/** Append a text message to the session history (bounded). */
function pushMessage({ senderId, text }) {
  room.historySeq += 1;
  const message = {
    id: String(room.historySeq),
    senderId,
    senderName: room.memberName,
    text,
    at: Date.now()
  };
  room.history.push(message);
  if (room.history.length > config.chat.historySize) {
    room.history = room.history.slice(-config.chat.historySize);
  }
  return message;
}

function memberIds() {
  return Array.from(room.participants.keys());
}

module.exports = {
  room,
  snapshot,
  add,
  remove,
  get,
  isFull,
  updateMedia,
  pushMessage,
  memberIds,
  mediaKinds,
  MEDIA_RESET
};
