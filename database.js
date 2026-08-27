/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  database.js — ডাটাবেস abstraction / factory                        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * অ্যাপ্লিকেশনের বাকি সব কোড শুধু এই ফাইলের `getDb()` ব্যবহার করে; কেউই
 * সরাসরি SQL বা SQLite লাইব্রেরি ছোঁয় না। ফলে ভবিষ্যতে MongoDB যোগ করা
 * সহজ — শুধু নিচের interface মেনে একটি নতুন adapter লিখে
 * `DB_DRIVER=mongodb` দিলেই হবে, বাকি কোড অপরিবর্তিত থাকবে।
 *
 * ── Adapter Interface (contract) ───────────────────────────────────────
 *  init()      : Promise<boolean>            — স্কিমা/ইনডেক্স তৈরি
 *  health()    : Promise<{ok, driver, ...}>
 *  close()     : Promise<void>
 *
 *  users:
 *    create({phone,name,passwordHash,avatar,about})   → user
 *    findById(id, {withSecrets})                      → user|null
 *    findByPhone(phone, {withSecrets})                → user|null
 *    findManyByPhones([phone])                        → user[]
 *    findByIds([id])                                  → user[]
 *    search({query, excludeUserId, limit})            → user[]
 *    list({limit, offset, excludeUserId})             → user[]
 *    updateProfile(id, {name, about, avatar})         → user
 *    updatePrivacy(id, {lastSeen, profilePhoto, readReceipts}) → user
 *    updatePassword(id, hash)                         → user
 *    setPresence(id, isOnline, lastSeenAt)            → void
 *    markAllOffline()                                 → void
 *    bumpTokenVersion(id)                             → void
 *    count()                                          → number
 *
 *  contacts:
 *    sync(userId, [{name, phone}])   → contact[]
 *    listForUser(userId)             → contact[]
 *    isContact(userId, phone)        → boolean
 *    remove(userId, contactId)       → boolean
 *    watchersOf(phone)               → userId[]
 *
 *  conversations:
 *    findDirect(a, b) / ensureDirect(a, b)     → conversation
 *    getById(id) / isMember(id, userId)
 *    memberIds(id) / otherMemberId(id, userId)
 *    listForUser(userId, {limit})              → summary[]
 *    touch(id, ts) / setLastRead(id, userId, ts)
 *    partnerIds(userId)                        → userId[]
 *
 *  messages:
 *    create({...}) / findById(id)
 *    listForConversation({conversationId, userId, limit, before})
 *    lastVisibleFor(conversationId, userId)
 *    unreadCount(conversationId, userId) / totalUnread(userId)
 *    markDeliveredForReceiver(userId) / markDelivered(id)
 *    markConversationRead(conversationId, readerId)
 *    edit({id, content}) / deleteForEveryone(id) / deleteForMe(id, userId)
 *    searchInConversation({...}) / searchForUser({...}) / count()
 *
 *  calls:
 *    create({callerId, receiverId, callType, status})
 *    findById(id) / markAnswered(id) / finish(id, {status})
 *    listForUser(userId, {limit})
 * ───────────────────────────────────────────────────────────────────────
 */

'use strict';

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { createSqliteAdapter } = require('./src/db/sqlite-adapter');

let adapter = null;

/**
 * কনফিগার করা driver অনুযায়ী adapter তৈরি করে স্কিমা init করে।
 * সার্ভার বুট হওয়ার সময় একবারই ডাকা হয়।
 */
async function initDatabase({ file = config.db.path, driver = config.db.driver } = {}) {
  if (adapter) return adapter;

  switch (driver) {
    case 'sqlite':
      adapter = createSqliteAdapter({ file });
      break;

    /**
     * MongoDB সাপোর্ট যোগ করার ধাপ:
     *   ১) `npm i mongodb`
     *   ২) src/db/mongo-adapter.js লিখুন — উপরের interface হুবহু মেনে
     *      (একই মেথড নাম, একই রিটার্ন shape; _id → id ম্যাপ করুন)
     *   ৩) এখানে case 'mongodb' যোগ করে সেটি require করুন
     *   ৪) .env-এ DB_DRIVER=mongodb ও MONGODB_URI দিন
     * বাকি অ্যাপ্লিকেশন কোডে একটি লাইনও বদলাতে হবে না।
     */
    case 'mongodb':
      throw new Error(
        "DB_DRIVER=mongodb এখনো ইনস্টল করা নেই। database.js-এর interface মেনে src/db/mongo-adapter.js যোগ করুন, অথবা DB_DRIVER=sqlite ব্যবহার করুন।"
      );

    default:
      throw new Error(`অজানা DB_DRIVER: ${driver}`);
  }

  await adapter.init();
  const health = await adapter.health();
  logger.success(
    `[db] ইনিশিয়ালাইজ সম্পন্ন — driver=${health.driver}, users=${health.users}, messages=${health.messages}`
  );
  return adapter;
}

/** ইনিশিয়ালাইজ হওয়া adapter রিটার্ন করে (না হলে স্পষ্ট error) */
function getDb() {
  if (!adapter) {
    throw new Error('ডাটাবেস এখনো init হয়নি — আগে initDatabase() কল করুন।');
  }
  return adapter;
}

async function closeDatabase() {
  if (adapter) {
    await adapter.close();
    adapter = null;
  }
}

module.exports = { initDatabase, getDb, closeDatabase };
