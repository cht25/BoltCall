/**
 * src/services/message-service.js
 * ───────────────────────────────────────────────────────────────────────
 * মেসেজ সম্পর্কিত সব ব্যবসায়িক নিয়ম (business rules) এক জায়গায়।
 *
 * REST endpoint (POST /api/messages) এবং Socket.IO event (chat:send) —
 * দুটোই এই সার্ভিস ব্যবহার করে, ফলে নিয়ম দুই জায়গায় আলাদা করে লিখতে হয় না
 * এবং authorization ফাঁক তৈরি হয় না।
 *
 * এখানে প্রয়োগ হওয়া নিয়মগুলো:
 *   • প্রেরক অবশ্যই conversation-এর সদস্য হতে হবে
 *   • কেউ অন্যের নামে মেসেজ পাঠাতে পারবে না (senderId সবসময় সেশন থেকে আসে)
 *   • reply_to অবশ্যই একই conversation-এর মেসেজ হতে হবে
 *   • media মেসেজের mediaUrl অবশ্যই আমাদের /uploads পাথ হতে হবে
 *   • edit → শুধু নিজের text মেসেজ, নির্দিষ্ট সময়সীমার মধ্যে
 *   • delete for everyone → শুধু নিজের মেসেজ, নির্দিষ্ট সময়সীমার মধ্যে
 */

'use strict';

const config = require('../config');
const presence = require('./presence');
const { sanitizeText } = require('../utils/validate');
const { badRequest, forbidden, notFound } = require('../utils/errors');

const SENDABLE_TYPES = ['text', 'image', 'audio', 'file'];

/** media URL যাচাই — শুধু নিজের আপলোড ডিরেক্টরির ফাইল গ্রহণযোগ্য */
function assertOwnMediaUrl(mediaUrl) {
  if (typeof mediaUrl !== 'string' || !/^\/uploads\/(images|audio|files|avatars)\/[A-Za-z0-9._-]+$/.test(mediaUrl)) {
    throw badRequest('media URL অবৈধ', 'invalid_media_url');
  }
  return mediaUrl;
}

/**
 * নতুন মেসেজ তৈরি করে (persist) এবং কাদের কাছে broadcast হবে তা জানায়।
 *
 * @returns {Promise<{message:object, conversation:object, receiverId:string, created:boolean}>}
 */
async function sendMessage(db, senderId, payload = {}) {
  const type = SENDABLE_TYPES.includes(payload.type) ? payload.type : 'text';

  // ── ১) conversation নির্ধারণ ও authorization ──────────────────────
  let conversation = null;
  let receiverId = null;

  if (payload.conversationId) {
    conversation = await db.conversations.getById(payload.conversationId);
    if (!conversation) throw notFound('চ্যাট পাওয়া যায়নি', 'conversation_not_found');
    const isMember = await db.conversations.isMember(conversation.id, senderId);
    if (!isMember) throw forbidden('এই চ্যাটে মেসেজ পাঠানোর অনুমতি নেই', 'not_a_member');
    receiverId = await db.conversations.otherMemberId(conversation.id, senderId);
  } else {
    // receiverId বা phone দিয়ে সরাসরি চ্যাট শুরু
    let receiver = null;
    if (payload.receiverId) {
      receiver = await db.users.findById(payload.receiverId);
    } else if (payload.receiverPhone) {
      receiver = await db.users.findByPhone(payload.receiverPhone);
    }
    if (!receiver) throw notFound('প্রাপক পাওয়া যায়নি', 'receiver_not_found');
    if (receiver.id === senderId) throw badRequest('নিজেকে মেসেজ পাঠানো যাবে না', 'self_message');
    conversation = await db.conversations.ensureDirect(senderId, receiver.id);
    receiverId = receiver.id;
  }
  if (!receiverId) throw badRequest('এই চ্যাটে কোনো প্রাপক নেই', 'no_receiver');

  // ── ২) কনটেন্ট ভ্যালিডেশন ─────────────────────────────────────────
  let content = sanitizeText(payload.content || '', config.chat.maxMessageLength);
  let mediaUrl = null;
  let mediaMeta = null;

  if (type === 'text') {
    content = content.trim();
    if (!content) throw badRequest('খালি মেসেজ পাঠানো যাবে না', 'empty_message');
  } else {
    mediaUrl = assertOwnMediaUrl(payload.mediaUrl);
    mediaMeta = payload.mediaMeta && typeof payload.mediaMeta === 'object' ? sanitizeMeta(payload.mediaMeta) : null;
    content = content.trim().slice(0, 1000); // ছবির caption
  }

  // ── ৩) reply_to যাচাই ────────────────────────────────────────────
  let replyTo = null;
  if (payload.replyTo) {
    const original = await db.messages.findById(payload.replyTo);
    if (!original || original.conversationId !== conversation.id) {
      throw badRequest('যে মেসেজের উত্তর দিচ্ছেন সেটি এই চ্যাটে নেই', 'invalid_reply');
    }
    replyTo = original.id;
  }

  // ── ৪) status নির্ধারণ (সার্ভারই authoritative) ───────────────────
  // প্রাপকের live socket থাকলে সাথে সাথে delivered, নাহলে sent
  const status = presence.isOnline(receiverId) ? 'delivered' : 'sent';

  const message = await db.messages.create({
    conversationId: conversation.id,
    senderId,
    receiverId,
    type,
    content,
    mediaUrl,
    mediaMeta,
    replyTo,
    status
  });

  return { message, conversation, receiverId, created: true };
}

/** media metadata থেকে শুধু নিরাপদ ফিল্ডগুলো রাখা হয় */
function sanitizeMeta(meta) {
  const output = {};
  if (meta.name) output.name = sanitizeText(String(meta.name), 160).replace(/[/\\]/g, '_');
  if (Number.isFinite(Number(meta.size))) output.size = Math.max(0, Math.round(Number(meta.size)));
  if (meta.mime) output.mime = sanitizeText(String(meta.mime), 100);
  if (Number.isFinite(Number(meta.duration))) output.duration = Math.max(0, Number(meta.duration));
  if (Number.isFinite(Number(meta.width))) output.width = Math.max(0, Math.round(Number(meta.width)));
  if (Number.isFinite(Number(meta.height))) output.height = Math.max(0, Math.round(Number(meta.height)));
  return output;
}

/**
 * সিস্টেম মেসেজ (যেমন "Missed video call") — সার্ভার নিজেই তৈরি করে।
 * status সরাসরি 'read' রাখা হয় যাতে unread counter-এ না গোনা হয়।
 */
async function createSystemMessage(db, { conversationId, senderId, receiverId, content, mediaMeta = null }) {
  return db.messages.create({
    conversationId,
    senderId,
    receiverId,
    type: 'system',
    content: sanitizeText(content, 300),
    mediaMeta,
    status: 'read'
  });
}

/** নিজের text মেসেজ এডিট (সময়সীমার মধ্যে) */
async function editMessage(db, userId, messageId, rawContent) {
  const message = await db.messages.findById(messageId);
  if (!message) throw notFound('মেসেজ পাওয়া যায়নি', 'message_not_found');
  if (message.senderId !== userId) throw forbidden('শুধু নিজের মেসেজ এডিট করা যায়', 'not_message_owner');
  if (message.deleted) throw badRequest('মুছে ফেলা মেসেজ এডিট করা যায় না', 'message_deleted');
  if (message.type !== 'text') throw badRequest('শুধু টেক্সট মেসেজ এডিট করা যায়', 'not_editable');

  const age = Date.now() - message.createdAt;
  if (age > config.chat.editWindowMs) {
    const minutes = Math.round(config.chat.editWindowMs / 60000);
    throw forbidden(`${minutes} মিনিটের পর মেসেজ এডিট করা যায় না`, 'edit_window_expired');
  }

  const content = sanitizeText(rawContent || '', config.chat.maxMessageLength).trim();
  if (!content) throw badRequest('খালি মেসেজ সংরক্ষণ করা যাবে না', 'empty_message');

  const updated = await db.messages.edit({ id: messageId, content });
  const memberIds = await db.conversations.memberIds(message.conversationId);
  return { message: updated, memberIds };
}

/**
 * মেসেজ ডিলিট।
 * @param {'me'|'everyone'} scope
 */
async function deleteMessage(db, userId, messageId, scope = 'me') {
  const message = await db.messages.findById(messageId);
  if (!message) throw notFound('মেসেজ পাওয়া যায়নি', 'message_not_found');

  const isMember = await db.conversations.isMember(message.conversationId, userId);
  if (!isMember) throw forbidden('এই মেসেজে অনুমতি নেই', 'not_a_member');

  const memberIds = await db.conversations.memberIds(message.conversationId);

  if (scope === 'everyone') {
    // ⚠️ কেউ অন্যের মেসেজ সবার জন্য মুছতে পারবে না
    if (message.senderId !== userId) {
      throw forbidden('শুধু নিজের মেসেজ সবার জন্য মোছা যায়', 'not_message_owner');
    }
    const age = Date.now() - message.createdAt;
    if (age > config.chat.deleteForEveryoneWindowMs) {
      const minutes = Math.round(config.chat.deleteForEveryoneWindowMs / 60000);
      throw forbidden(`${minutes} মিনিটের পর "সবার জন্য মুছুন" সম্ভব নয়`, 'delete_window_expired');
    }
    const updated = await db.messages.deleteForEveryone(messageId);
    return { scope: 'everyone', message: updated, memberIds };
  }

  await db.messages.deleteForMe(messageId, userId);
  return { scope: 'me', message: { ...message, hiddenFor: userId }, memberIds: [userId] };
}

module.exports = {
  sendMessage,
  editMessage,
  deleteMessage,
  createSystemMessage,
  assertOwnMediaUrl,
  SENDABLE_TYPES
};
