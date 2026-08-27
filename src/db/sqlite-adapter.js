/**
 * src/db/sqlite-adapter.js
 * ───────────────────────────────────────────────────────────────────────
 * SQLite-এর জন্য repository লেয়ার (data access layer)।
 *
 * ডিজাইন নীতি:
 *   • সব মেথড async (Promise ফেরত দেয়) — যদিও SQLite সিঙ্ক্রোনাস। কারণ
 *     ভবিষ্যতে MongoDB adapter যোগ করলে interface একই থাকবে, উপরের কোড
 *     বদলাতে হবে না।
 *   • DB row (snake_case) → domain object (camelCase) ম্যাপিং এখানেই হয়।
 *     অর্থাৎ SQL-এর গন্ধ এই ফাইলের বাইরে যায় না।
 *   • কোনো মেথড কখনো password_hash বাইরে পাঠায় না—শুধু auth সার্ভিস
 *     ইচ্ছাকৃতভাবে `withSecrets` ফ্ল্যাগ দিয়ে চাইলে পায়।
 */

'use strict';

const crypto = require('crypto');
const { openDatabase } = require('./sqlite-driver');
const { SCHEMA_SQL } = require('./schema');

const newId = () => crypto.randomUUID();
const now = () => Date.now();

/** LIKE query-র জন্য ব্যবহারকারীর ইনপুট escape করা (% _ \ special) */
function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (char) => `\\${char}`);
}

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

// ── Row → Domain mappers ─────────────────────────────────────────────
function mapUser(row, { withSecrets = false } = {}) {
  if (!row) return null;
  const user = {
    id: row.id,
    phone: row.phone,
    name: row.name,
    avatar: row.avatar || null,
    about: row.about || '',
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    isOnline: !!row.is_online,
    tokenVersion: row.token_version,
    privacy: {
      lastSeen: row.privacy_last_seen,
      profilePhoto: row.privacy_profile_photo,
      readReceipts: !!row.privacy_read_receipts
    }
  };
  if (withSecrets) user.passwordHash = row.password_hash;
  return user;
}

function mapMessage(row) {
  if (!row) return null;
  const message = {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    type: row.type,
    content: row.deleted ? '' : row.content,
    mediaUrl: row.deleted ? null : row.media_url || null,
    mediaMeta: row.deleted ? null : parseJson(row.media_meta),
    replyTo: row.reply_to || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at || null,
    deleted: !!row.deleted
  };

  // reply preview (JOIN থেকে এলে)
  if (row.reply_to && row.reply_content !== undefined) {
    message.replyPreview = {
      id: row.reply_to,
      senderId: row.reply_sender_id,
      type: row.reply_type,
      deleted: !!row.reply_deleted,
      content: row.reply_deleted ? '' : row.reply_content,
      mediaUrl: row.reply_deleted ? null : row.reply_media_url || null
    };
  }
  return message;
}

function mapCall(row) {
  if (!row) return null;
  return {
    id: row.id,
    callerId: row.caller_id,
    receiverId: row.receiver_id,
    callType: row.call_type,
    status: row.status,
    startedAt: row.started_at,
    answeredAt: row.answered_at || null,
    endedAt: row.ended_at || null,
    duration: row.duration || 0
  };
}

const USER_COLUMNS = `
  id, phone, name, password_hash, avatar, about, created_at, last_seen, is_online,
  privacy_last_seen, privacy_profile_photo, privacy_read_receipts, token_version
`;

/** direct conversation-এর ইউনিক key: দুই id sorted করে জোড়া */
const directKey = (a, b) => [a, b].sort().join('::');

/**
 * @param {{file:string}} options
 */
function createSqliteAdapter({ file }) {
  const db = openDatabase(file);

  // ═════════════════════════════════════════════════════════════════
  //  USERS
  // ═════════════════════════════════════════════════════════════════
  const users = {
    async create({ phone, name, passwordHash, avatar = null, about = '' }) {
      const id = newId();
      const ts = now();
      db.run(
        `INSERT INTO users (id, phone, name, password_hash, avatar, about, created_at, last_seen, is_online)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [id, phone, name, passwordHash, avatar, about, ts, ts]
      );
      return users.findById(id);
    },

    async findById(id, options = {}) {
      return mapUser(db.get(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]), options);
    },

    async findByPhone(phone, options = {}) {
      return mapUser(db.get(`SELECT ${USER_COLUMNS} FROM users WHERE phone = ?`, [phone]), options);
    },

    /** contact sync-এর জন্য: একাধিক ফোন নম্বর একবারে খোঁজা */
    async findManyByPhones(phones = []) {
      if (!phones.length) return [];
      const chunks = [];
      // SQLite-এ ডিফল্ট variable limit ~999, তাই ব্যাচ করে খোঁজা হয়
      for (let i = 0; i < phones.length; i += 500) chunks.push(phones.slice(i, i + 500));
      const results = [];
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.all(
          `SELECT ${USER_COLUMNS} FROM users WHERE phone IN (${placeholders})`,
          chunk
        );
        results.push(...rows.map((row) => mapUser(row)));
      }
      return results;
    },

    async findByIds(ids = []) {
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db
        .all(`SELECT ${USER_COLUMNS} FROM users WHERE id IN (${placeholders})`, ids)
        .map((row) => mapUser(row));
    },

    /** নাম বা ফোন দিয়ে সার্চ (নিজেকে বাদ দিয়ে) */
    async search({ query, excludeUserId = null, limit = 20 }) {
      const like = `%${escapeLike(query)}%`;
      return db
        .all(
          `SELECT ${USER_COLUMNS} FROM users
           WHERE (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
             AND (? IS NULL OR id != ?)
           ORDER BY is_online DESC, name COLLATE NOCASE ASC
           LIMIT ?`,
          [like, like, excludeUserId, excludeUserId, limit]
        )
        .map((row) => mapUser(row));
    },

    async list({ limit = 50, offset = 0, excludeUserId = null }) {
      return db
        .all(
          `SELECT ${USER_COLUMNS} FROM users
           WHERE (? IS NULL OR id != ?)
           ORDER BY is_online DESC, name COLLATE NOCASE ASC
           LIMIT ? OFFSET ?`,
          [excludeUserId, excludeUserId, limit, offset]
        )
        .map((row) => mapUser(row));
    },

    async updateProfile(id, { name, about, avatar }) {
      const current = db.get(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
      if (!current) return null;
      db.run(
        `UPDATE users SET name = ?, about = ?, avatar = ? WHERE id = ?`,
        [
          name === undefined ? current.name : name,
          about === undefined ? current.about : about,
          avatar === undefined ? current.avatar : avatar,
          id
        ]
      );
      return users.findById(id);
    },

    async updatePrivacy(id, { lastSeen, profilePhoto, readReceipts }) {
      const current = db.get(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
      if (!current) return null;
      db.run(
        `UPDATE users SET privacy_last_seen = ?, privacy_profile_photo = ?, privacy_read_receipts = ?
         WHERE id = ?`,
        [
          lastSeen === undefined ? current.privacy_last_seen : lastSeen,
          profilePhoto === undefined ? current.privacy_profile_photo : profilePhoto,
          readReceipts === undefined ? current.privacy_read_receipts : readReceipts ? 1 : 0,
          id
        ]
      );
      return users.findById(id);
    },

    async updatePassword(id, passwordHash) {
      db.run(`UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`, [
        passwordHash,
        id
      ]);
      return users.findById(id);
    },

    /** presence: শুধু live socket থাকলেই is_online = 1 */
    async setPresence(id, isOnline, lastSeenAt = now()) {
      db.run(`UPDATE users SET is_online = ?, last_seen = ? WHERE id = ?`, [isOnline ? 1 : 0, lastSeenAt, id]);
    },

    /** সার্ভার রিস্টার্টে সব presence রিসেট (পুরনো socket আর নেই) */
    async markAllOffline() {
      db.run(`UPDATE users SET is_online = 0 WHERE is_online = 1`, []);
    },

    async bumpTokenVersion(id) {
      db.run(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`, [id]);
    },

    async count() {
      return db.get(`SELECT COUNT(*) AS n FROM users`, []).n;
    }
  };

  // ═════════════════════════════════════════════════════════════════
  //  CONTACTS
  // ═════════════════════════════════════════════════════════════════
  const contacts = {
    /**
     * ফোনবুক সিঙ্ক — একবারে সব entry upsert করা হয় (transaction-এ)।
     * @param {string} userId
     * @param {Array<{name:string, phone:string}>} entries normalized phone সহ
     */
    async sync(userId, entries = []) {
      db.transaction(() => {
        for (const entry of entries) {
          const match = db.get(`SELECT id FROM users WHERE phone = ?`, [entry.phone]);
          const existing = db.get(`SELECT id FROM contacts WHERE user_id = ? AND contact_phone = ?`, [
            userId,
            entry.phone
          ]);
          if (existing) {
            db.run(`UPDATE contacts SET contact_name = ?, contact_user_id = ? WHERE id = ?`, [
              entry.name || '',
              match ? match.id : null,
              existing.id
            ]);
          } else {
            db.run(
              `INSERT INTO contacts (id, user_id, contact_user_id, contact_phone, contact_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [newId(), userId, match ? match.id : null, entry.phone, entry.name || '', now()]
            );
          }
        }
      });
      return contacts.listForUser(userId);
    },

    /**
     * ইউজারের সব contact — users টেবিলের সাথে phone দিয়ে LEFT JOIN করা হয়,
     * ফলে পরে রেজিস্টার করা কেউও সাথে সাথে "registered" হিসেবে আসে।
     */
    async listForUser(userId) {
      const rows = db.all(
        `SELECT c.id, c.contact_phone, c.contact_name, c.created_at,
                u.id AS u_id, u.phone AS u_phone, u.name AS u_name, u.avatar AS u_avatar,
                u.about AS u_about, u.is_online AS u_is_online, u.last_seen AS u_last_seen,
                u.privacy_last_seen AS u_privacy_last_seen,
                u.privacy_profile_photo AS u_privacy_profile_photo,
                u.privacy_read_receipts AS u_privacy_read_receipts
         FROM contacts c
         LEFT JOIN users u ON u.phone = c.contact_phone
         WHERE c.user_id = ?
         ORDER BY (u.id IS NULL), COALESCE(NULLIF(c.contact_name,''), u.name) COLLATE NOCASE ASC`,
        [userId]
      );

      return rows.map((row) => ({
        id: row.id,
        phone: row.contact_phone,
        savedName: row.contact_name || '',
        createdAt: row.created_at,
        registered: !!row.u_id,
        user: row.u_id
          ? mapUser({
              id: row.u_id,
              phone: row.u_phone,
              name: row.u_name,
              avatar: row.u_avatar,
              about: row.u_about,
              is_online: row.u_is_online,
              last_seen: row.u_last_seen,
              created_at: row.created_at,
              privacy_last_seen: row.u_privacy_last_seen,
              privacy_profile_photo: row.u_privacy_profile_photo,
              privacy_read_receipts: row.u_privacy_read_receipts,
              token_version: 0
            })
          : null
      }));
    },

    /** A কি B-কে কনট্যাক্ট হিসেবে সেভ করেছে? (privacy সিদ্ধান্তে ব্যবহৃত) */
    async isContact(userId, otherUserPhone) {
      const row = db.get(`SELECT 1 AS ok FROM contacts WHERE user_id = ? AND contact_phone = ?`, [
        userId,
        otherUserPhone
      ]);
      return !!row;
    },

    async remove(userId, contactId) {
      const result = db.run(`DELETE FROM contacts WHERE id = ? AND user_id = ?`, [contactId, userId]);
      return result.changes > 0;
    },

    /** presence broadcast-এর জন্য: কারা এই ইউজারকে contact হিসেবে রেখেছে */
    async watchersOf(userPhone) {
      return db
        .all(`SELECT DISTINCT user_id FROM contacts WHERE contact_phone = ?`, [userPhone])
        .map((row) => row.user_id);
    }
  };

  // ═════════════════════════════════════════════════════════════════
  //  CONVERSATIONS
  // ═════════════════════════════════════════════════════════════════
  const conversations = {
    async findDirect(userA, userB) {
      const row = db.get(`SELECT * FROM conversations WHERE direct_key = ?`, [directKey(userA, userB)]);
      return row ? { id: row.id, type: row.type, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },

    /** direct conversation তৈরি (থাকলে সেটিই ফেরত) — race-safe */
    async ensureDirect(userA, userB) {
      const existing = await conversations.findDirect(userA, userB);
      if (existing) return existing;

      const id = newId();
      const ts = now();
      try {
        db.transaction(() => {
          db.run(
            `INSERT INTO conversations (id, type, created_at, updated_at, direct_key)
             VALUES (?, 'direct', ?, ?, ?)`,
            [id, ts, ts, directKey(userA, userB)]
          );
          db.run(
            `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)`,
            [id, userA, ts]
          );
          db.run(
            `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)`,
            [id, userB, ts]
          );
        });
      } catch (err) {
        // UNIQUE(direct_key) ভাঙলে মানে সমান্তরালে অন্য কেউ বানিয়ে ফেলেছে
        const raced = await conversations.findDirect(userA, userB);
        if (raced) return raced;
        throw err;
      }
      return { id, type: 'direct', createdAt: ts, updatedAt: ts };
    },

    async getById(id) {
      const row = db.get(`SELECT * FROM conversations WHERE id = ?`, [id]);
      return row ? { id: row.id, type: row.type, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },

    async isMember(conversationId, userId) {
      return !!db.get(`SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?`, [
        conversationId,
        userId
      ]);
    },

    async memberIds(conversationId) {
      return db
        .all(`SELECT user_id FROM conversation_members WHERE conversation_id = ?`, [conversationId])
        .map((row) => row.user_id);
    },

    async otherMemberId(conversationId, userId) {
      const row = db.get(
        `SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1`,
        [conversationId, userId]
      );
      return row ? row.user_id : null;
    },

    /**
     * সাইডবারের চ্যাট লিস্ট: সর্বশেষ activity অনুযায়ী sorted, প্রতিটির সাথে
     * partner, শেষ message ও unread count।
     */
    async listForUser(userId, { limit = 100 } = {}) {
      const rows = db.all(
        `SELECT c.id, c.type, c.created_at, c.updated_at, me.last_read_at, me.muted,
                other.user_id AS partner_id
         FROM conversations c
         JOIN conversation_members me    ON me.conversation_id = c.id AND me.user_id = ?
         JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id != ?
         ORDER BY c.updated_at DESC
         LIMIT ?`,
        [userId, userId, limit]
      );

      const result = [];
      for (const row of rows) {
        const partner = await users.findById(row.partner_id);
        const lastMessage = await messages.lastVisibleFor(row.id, userId);
        const unreadCount = await messages.unreadCount(row.id, userId);
        result.push({
          id: row.id,
          type: row.type,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          muted: !!row.muted,
          lastReadAt: row.last_read_at,
          partner,
          lastMessage,
          unreadCount
        });
      }
      return result;
    },

    async touch(conversationId, ts = now()) {
      db.run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [ts, conversationId]);
    },

    async setLastRead(conversationId, userId, ts = now()) {
      db.run(
        `UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?`,
        [ts, conversationId, userId]
      );
    },

    /** presence broadcast: এই ইউজার যাদের সাথে চ্যাট করে */
    async partnerIds(userId) {
      return db
        .all(
          `SELECT DISTINCT other.user_id AS id
           FROM conversation_members me
           JOIN conversation_members other
             ON other.conversation_id = me.conversation_id AND other.user_id != me.user_id
           WHERE me.user_id = ?`,
          [userId]
        )
        .map((row) => row.id);
    }
  };

  // ═════════════════════════════════════════════════════════════════
  //  MESSAGES
  // ═════════════════════════════════════════════════════════════════
  const MESSAGE_SELECT = `
    SELECT m.*,
           r.content    AS reply_content,
           r.type       AS reply_type,
           r.sender_id  AS reply_sender_id,
           r.deleted    AS reply_deleted,
           r.media_url  AS reply_media_url
    FROM messages m
    LEFT JOIN messages r ON r.id = m.reply_to
  `;

  const messages = {
    async create({
      conversationId,
      senderId,
      receiverId,
      type = 'text',
      content = '',
      mediaUrl = null,
      mediaMeta = null,
      replyTo = null,
      status = 'sent'
    }) {
      const id = newId();
      const ts = now();
      db.transaction(() => {
        db.run(
          `INSERT INTO messages
             (id, conversation_id, sender_id, receiver_id, type, content, media_url, media_meta,
              reply_to, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            conversationId,
            senderId,
            receiverId,
            type,
            content,
            mediaUrl,
            mediaMeta ? JSON.stringify(mediaMeta) : null,
            replyTo,
            status,
            ts,
            ts
          ]
        );
        db.run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [ts, conversationId]);
      });
      return messages.findById(id);
    },

    async findById(id) {
      return mapMessage(db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]));
    },

    /**
     * চ্যাট হিস্ট্রি (পেজিনেটেড, পুরনো দিকে স্ক্রল করার জন্য `before`)।
     * ইউজার নিজে যেগুলো "delete for me" করেছে সেগুলো বাদ যায়।
     */
    async listForConversation({ conversationId, userId, limit = 40, before = 0 }) {
      const rows = db.all(
        `${MESSAGE_SELECT}
         WHERE m.conversation_id = ?
           AND m.id NOT IN (SELECT message_id FROM message_deletes WHERE user_id = ?)
           AND (? = 0 OR m.created_at < ?)
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT ?`,
        [conversationId, userId, before, before, limit]
      );
      return rows.map(mapMessage).reverse(); // পুরনো → নতুন ক্রমে
    },

    async lastVisibleFor(conversationId, userId) {
      return mapMessage(
        db.get(
          `${MESSAGE_SELECT}
           WHERE m.conversation_id = ?
             AND m.id NOT IN (SELECT message_id FROM message_deletes WHERE user_id = ?)
           ORDER BY m.created_at DESC, m.rowid DESC
           LIMIT 1`,
          [conversationId, userId]
        )
      );
    },

    async unreadCount(conversationId, userId) {
      const row = db.get(
        `SELECT COUNT(*) AS n FROM messages
         WHERE conversation_id = ? AND receiver_id = ? AND status != 'read' AND deleted = 0
           AND id NOT IN (SELECT message_id FROM message_deletes WHERE user_id = ?)`,
        [conversationId, userId, userId]
      );
      return row ? row.n : 0;
    },

    async totalUnread(userId) {
      const row = db.get(
        `SELECT COUNT(*) AS n FROM messages
         WHERE receiver_id = ? AND status != 'read' AND deleted = 0`,
        [userId]
      );
      return row ? row.n : 0;
    },

    /**
     * ইউজার অনলাইনে এলে তার জন্য অপেক্ষমাণ (status='sent') সব মেসেজ
     * delivered করা হয় — কোন কোন মেসেজ আপডেট হলো তা রিটার্ন করা হয় যাতে
     * প্রেরকদের socket-এ জানানো যায়।
     */
    async markDeliveredForReceiver(userId) {
      const pending = db.all(
        `SELECT id, sender_id, conversation_id FROM messages
         WHERE receiver_id = ? AND status = 'sent' AND deleted = 0`,
        [userId]
      );
      if (!pending.length) return [];
      db.run(
        `UPDATE messages SET status = 'delivered', updated_at = ?
         WHERE receiver_id = ? AND status = 'sent' AND deleted = 0`,
        [now(), userId]
      );
      return pending.map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        conversationId: row.conversation_id
      }));
    },

    async markDelivered(messageId) {
      const result = db.run(
        `UPDATE messages SET status = 'delivered', updated_at = ?
         WHERE id = ? AND status = 'sent'`,
        [now(), messageId]
      );
      return result.changes > 0;
    },

    /**
     * নির্দিষ্ট conversation-এ readerId যেসব মেসেজ পেয়েছে সব read করা হয়।
     * @returns {Array<{id:string, senderId:string}>} প্রেরককে জানানোর জন্য
     */
    async markConversationRead(conversationId, readerId) {
      const pending = db.all(
        `SELECT id, sender_id FROM messages
         WHERE conversation_id = ? AND receiver_id = ? AND status != 'read' AND deleted = 0`,
        [conversationId, readerId]
      );
      if (pending.length) {
        db.run(
          `UPDATE messages SET status = 'read', updated_at = ?
           WHERE conversation_id = ? AND receiver_id = ? AND status != 'read' AND deleted = 0`,
          [now(), conversationId, readerId]
        );
      }
      db.run(`UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?`, [
        now(),
        conversationId,
        readerId
      ]);
      return pending.map((row) => ({ id: row.id, senderId: row.sender_id }));
    },

    async edit({ id, content }) {
      const ts = now();
      db.run(`UPDATE messages SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?`, [
        content,
        ts,
        ts,
        id
      ]);
      return messages.findById(id);
    },

    /** delete for everyone — content/media মুছে ফেলা হয়, row থাকে (tombstone) */
    async deleteForEveryone(id) {
      const ts = now();
      db.run(
        `UPDATE messages
         SET deleted = 1, deleted_at = ?, updated_at = ?, content = '', media_url = NULL, media_meta = NULL
         WHERE id = ?`,
        [ts, ts, id]
      );
      return messages.findById(id);
    },

    /** delete for me — শুধু ওই ইউজারের কাছে লুকানো */
    async deleteForMe(id, userId) {
      db.run(
        `INSERT INTO message_deletes (message_id, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (message_id, user_id) DO NOTHING`,
        [id, userId, now()]
      );
      return true;
    },

    async searchInConversation({ conversationId, userId, query, limit = 50 }) {
      const like = `%${escapeLike(query)}%`;
      const rows = db.all(
        `${MESSAGE_SELECT}
         WHERE m.conversation_id = ?
           AND m.deleted = 0
           AND m.id NOT IN (SELECT message_id FROM message_deletes WHERE user_id = ?)
           AND (m.content LIKE ? ESCAPE '\\' OR m.media_meta LIKE ? ESCAPE '\\')
         ORDER BY m.created_at DESC
         LIMIT ?`,
        [conversationId, userId, like, like, limit]
      );
      return rows.map(mapMessage);
    },

    /** সব conversation জুড়ে গ্লোবাল সার্চ (শুধু নিজের conversation-এ) */
    async searchForUser({ userId, query, limit = 50 }) {
      const like = `%${escapeLike(query)}%`;
      const rows = db.all(
        `${MESSAGE_SELECT}
         JOIN conversation_members cm
           ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         WHERE m.deleted = 0
           AND m.id NOT IN (SELECT message_id FROM message_deletes WHERE user_id = ?)
           AND (m.content LIKE ? ESCAPE '\\' OR m.media_meta LIKE ? ESCAPE '\\')
         ORDER BY m.created_at DESC
         LIMIT ?`,
        [userId, userId, like, like, limit]
      );
      return rows.map(mapMessage);
    },

    async count() {
      return db.get(`SELECT COUNT(*) AS n FROM messages`, []).n;
    }
  };

  // ═════════════════════════════════════════════════════════════════
  //  CALLS
  // ═════════════════════════════════════════════════════════════════
  const calls = {
    async create({ id = newId(), callerId, receiverId, callType = 'audio', status = 'ringing' }) {
      const ts = now();
      db.run(
        `INSERT INTO calls (id, caller_id, receiver_id, call_type, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, callerId, receiverId, callType, status, ts]
      );
      return calls.findById(id);
    },

    async findById(id) {
      return mapCall(db.get(`SELECT * FROM calls WHERE id = ?`, [id]));
    },

    async markAnswered(id, answeredAt = now()) {
      db.run(`UPDATE calls SET status = 'answered', answered_at = ? WHERE id = ?`, [answeredAt, id]);
      return calls.findById(id);
    },

    async finish(id, { status, endedAt = now() }) {
      const call = db.get(`SELECT * FROM calls WHERE id = ?`, [id]);
      if (!call) return null;
      const startedForDuration = call.answered_at || null;
      const duration = startedForDuration ? Math.max(0, Math.round((endedAt - startedForDuration) / 1000)) : 0;
      db.run(`UPDATE calls SET status = ?, ended_at = ?, duration = ? WHERE id = ?`, [
        status,
        endedAt,
        duration,
        id
      ]);
      return calls.findById(id);
    },

    async listForUser(userId, { limit = 50 } = {}) {
      return db
        .all(
          `SELECT * FROM calls
           WHERE caller_id = ? OR receiver_id = ?
           ORDER BY started_at DESC
           LIMIT ?`,
          [userId, userId, limit]
        )
        .map(mapCall);
    }
  };

  // ═════════════════════════════════════════════════════════════════
  //  Adapter interface (MongoDB adapter-ও ঠিক এই shape মানবে)
  // ═════════════════════════════════════════════════════════════════
  return {
    driver: `sqlite (${db.impl})`,

    /** স্কিমা তৈরি + presence রিসেট */
    async init() {
      db.exec(SCHEMA_SQL);
      await users.markAllOffline();
      return true;
    },

    async health() {
      const row = db.get('SELECT 1 AS ok', []);
      return {
        ok: !!row,
        driver: `sqlite (${db.impl})`,
        users: await users.count(),
        messages: await messages.count()
      };
    },

    async close() {
      db.close();
    },

    users,
    contacts,
    conversations,
    messages,
    calls,

    // টেস্ট/সিড স্ক্রিপ্টের জন্য raw access (অ্যাপ কোডে ব্যবহার করা হয় না)
    _raw: db
  };
}

module.exports = { createSqliteAdapter, escapeLike };
