/**
 * src/services/presence.js
 * ───────────────────────────────────────────────────────────────────────
 * অনলাইন/অফলাইন presence রেজিস্ট্রি।
 *
 * গুরুত্বপূর্ণ নীতি: ডাটাবেসে অ্যাকাউন্ট থাকা মানেই ইউজার "অনলাইন" নয়।
 * একজন ইউজার অনলাইন কেবল তখনই, যখন তার অন্তত একটি live Socket.IO connection
 * আছে। একই ইউজার একাধিক ট্যাব/ডিভাইস থেকে যুক্ত হতে পারে, তাই userId → Set
 * of socketId ম্যাপ রাখা হয়। শেষ socket বিচ্ছিন্ন হলেই offline + last_seen।
 *
 * (একাধিক সার্ভার instance চালাতে হলে এই ম্যাপটি Redis adapter দিয়ে
 *  প্রতিস্থাপন করতে হবে — interface একই রাখা হয়েছে যাতে বদলানো সহজ হয়।)
 */

'use strict';

const userSockets = new Map(); // userId → Set<socketId>

/** @returns {boolean} এই ইউজার এখন প্রথমবার অনলাইন হলো কি না */
function addSocket(userId, socketId) {
  let sockets = userSockets.get(userId);
  const isFirst = !sockets || sockets.size === 0;
  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }
  sockets.add(socketId);
  return isFirst;
}

/** @returns {boolean} এটিই শেষ socket ছিল কি না (তাহলে offline করতে হবে) */
function removeSocket(userId, socketId) {
  const sockets = userSockets.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    userSockets.delete(userId);
    return true;
  }
  return false;
}

const isOnline = (userId) => userSockets.has(userId);
const socketIdsOf = (userId) => Array.from(userSockets.get(userId) || []);
const onlineUserIds = () => Array.from(userSockets.keys());
const onlineCount = () => userSockets.size;

/** টেস্টের জন্য */
function reset() {
  userSockets.clear();
}

module.exports = { addSocket, removeSocket, isOnline, socketIdsOf, onlineUserIds, onlineCount, reset };
