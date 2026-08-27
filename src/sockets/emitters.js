/**
 * src/sockets/emitters.js
 * ───────────────────────────────────────────────────────────────────────
 * Socket.IO broadcast হেল্পার।
 *
 * প্রতিটি authenticated socket `user:<userId>` নামের room-এ join করে।
 * ফলে একজন ইউজারের সব ডিভাইস/ট্যাবে একসাথে ইভেন্ট পাঠানো যায় এবং
 * REST route (যেমন POST /api/messages) থেকেও real-time ইভেন্ট পাঠানো সহজ হয়
 * — অর্থাৎ HTTP আর WebSocket পথ দুটোই একই ফলাফল দেয়।
 */

'use strict';

const { publicMessage } = require('../services/serialize');

const userRoom = (userId) => `user:${userId}`;

/** নির্দিষ্ট ইউজারদের কাছে একই ইভেন্ট পাঠানো */
function emitToUsers(io, userIds, event, payload) {
  for (const userId of new Set(userIds.filter(Boolean))) {
    io.to(userRoom(userId)).emit(event, payload);
  }
}

/** নতুন মেসেজ — প্রেরক (অন্য ট্যাব) ও প্রাপক দুজনকেই পাঠানো হয় */
function emitNewMessage(io, { message, senderId, receiverId }) {
  const payload = publicMessage(message);
  emitToUsers(io, [receiverId, senderId], 'chat:receive', payload);

  // প্রাপক অনলাইন থাকায় সার্ভার যদি সাথে সাথে delivered করে থাকে,
  // প্রেরককে status আপডেট জানানো হয় (double tick)
  if (message.status === 'delivered') {
    emitToUsers(io, [senderId], 'message:delivered', {
      conversationId: message.conversationId,
      ids: [message.id]
    });
  }
}

function emitMessageEdited(io, memberIds, message) {
  emitToUsers(io, memberIds, 'message:edited', publicMessage(message));
}

function emitMessageDeleted(io, memberIds, { messageId, conversationId, scope }) {
  emitToUsers(io, memberIds, 'message:deleted', { messageId, conversationId, scope });
}

function emitDelivered(io, senderId, { conversationId, ids }) {
  if (!ids || !ids.length) return;
  emitToUsers(io, [senderId], 'message:delivered', { conversationId, ids });
}

function emitRead(io, senderId, { conversationId, ids }) {
  if (!ids || !ids.length) return;
  emitToUsers(io, [senderId], 'message:read', { conversationId, ids });
}

/** presence পরিবর্তন — শুধু সংশ্লিষ্ট ইউজারদের জানানো হয় (সবাইকে নয়) */
function emitPresence(io, watcherIds, payload) {
  emitToUsers(io, watcherIds, payload.isOnline ? 'user:online' : 'user:offline', payload);
  emitToUsers(io, watcherIds, 'presence:update', payload);
}

module.exports = {
  userRoom,
  emitToUsers,
  emitNewMessage,
  emitMessageEdited,
  emitMessageDeleted,
  emitDelivered,
  emitRead,
  emitPresence
};
