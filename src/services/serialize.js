/**
 * src/services/serialize.js
 * ───────────────────────────────────────────────────────────────────────
 * API রেসপন্সের জন্য "সেফ" object তৈরি করা।
 *
 * এখানেই privacy নীতি প্রয়োগ হয়:
 *   • password_hash, token_version কখনো বাইরে যায় না
 *   • last seen / online status ও profile photo ইউজারের privacy সেটিং
 *     অনুযায়ী লুকানো হতে পারে (everyone | contacts | nobody)
 *
 * ⚠️ Frontend-এ কোনো privacy লজিক রাখা হয়নি — সিদ্ধান্ত সার্ভারেই হয়,
 *    কারণ ক্লায়েন্টকে বিশ্বাস করা যায় না।
 */

'use strict';

/**
 * @param {object} user domain user (adapter থেকে)
 * @param {{viewerId?:string, viewerIsContact?:boolean}} context
 */
function publicUser(user, { viewerId = null, viewerIsContact = false } = {}) {
  if (!user) return null;
  const isSelf = viewerId && viewerId === user.id;

  const canSee = (setting) => {
    if (isSelf) return true;
    if (setting === 'nobody') return false;
    if (setting === 'contacts') return !!viewerIsContact;
    return true; // 'everyone'
  };

  const showPresence = canSee(user.privacy?.lastSeen);
  const showPhoto = canSee(user.privacy?.profilePhoto);

  const payload = {
    id: user.id,
    name: user.name,
    phone: user.phone,
    about: user.about || '',
    avatar: showPhoto ? user.avatar || null : null,
    isOnline: showPresence ? !!user.isOnline : false,
    lastSeen: showPresence ? user.lastSeen : null,
    presenceHidden: !showPresence,
    createdAt: user.createdAt
  };

  // নিজের প্রোফাইল হলে privacy সেটিংও পাঠানো হয় (settings UI-এর জন্য)
  if (isSelf) {
    payload.privacy = {
      lastSeen: user.privacy?.lastSeen || 'everyone',
      profilePhoto: user.privacy?.profilePhoto || 'everyone',
      readReceipts: user.privacy?.readReceipts !== false
    };
  }
  return payload;
}

/** message domain object → API shape (একই, শুধু নিশ্চিত করা যে কিছু ফাঁস হচ্ছে না) */
function publicMessage(message) {
  if (!message) return null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    receiverId: message.receiverId,
    type: message.type,
    content: message.content,
    mediaUrl: message.mediaUrl,
    mediaMeta: message.mediaMeta,
    replyTo: message.replyTo,
    replyPreview: message.replyPreview || null,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    editedAt: message.editedAt,
    deleted: message.deleted
  };
}

function publicConversation(summary, context = {}) {
  if (!summary) return null;
  return {
    id: summary.id,
    type: summary.type,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    muted: !!summary.muted,
    unreadCount: summary.unreadCount || 0,
    partner: publicUser(summary.partner, context),
    lastMessage: publicMessage(summary.lastMessage)
  };
}

function publicCall(call) {
  if (!call) return null;
  return {
    id: call.id,
    callerId: call.callerId,
    receiverId: call.receiverId,
    callType: call.callType,
    status: call.status,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    duration: call.duration
  };
}

module.exports = { publicUser, publicMessage, publicConversation, publicCall };
