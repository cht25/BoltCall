/**
 * src/db/schema.js
 * ───────────────────────────────────────────────────────────────────────
 * সম্পূর্ণ ডাটাবেস স্কিমা (DDL)। সার্ভার প্রথমবার চালু হলেই এই স্ক্রিপ্ট
 * চলে যায় — অর্থাৎ হাতে কোনো SQL চালানোর দরকার নেই ("CREATE TABLE IF NOT
 * EXISTS" ব্যবহার করা হয়েছে, তাই বারবার চালানো নিরাপদ)।
 *
 * সময় (timestamp) সব জায়গায় INTEGER — Unix epoch milliseconds (UTC)।
 * সার্ভারই সময় নির্ধারণ করে, ক্লায়েন্টের ঘড়ি বিশ্বাস করা হয় না।
 */

'use strict';

const SCHEMA_SQL = `
-- ═══════════════════════════════════════════════════════════════════════
--  users — রেজিস্টার্ড অ্যাকাউন্ট
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  phone                 TEXT NOT NULL UNIQUE,          -- normalized E.164 (+8801...)
  name                  TEXT NOT NULL,
  password_hash         TEXT NOT NULL,                 -- bcrypt hash (plaintext কখনো নয়)
  avatar                TEXT,                          -- /uploads/avatars/xxx.jpg
  about                 TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  last_seen             INTEGER NOT NULL,
  is_online             INTEGER NOT NULL DEFAULT 0,    -- শুধু live socket থাকলে 1
  privacy_last_seen     TEXT NOT NULL DEFAULT 'everyone',   -- everyone|contacts|nobody
  privacy_profile_photo TEXT NOT NULL DEFAULT 'everyone',
  privacy_read_receipts INTEGER NOT NULL DEFAULT 1,
  token_version         INTEGER NOT NULL DEFAULT 1     -- বাড়ালে পুরনো JWT বাতিল হয়
);
CREATE INDEX IF NOT EXISTS idx_users_phone   ON users (phone);
CREATE INDEX IF NOT EXISTS idx_users_name    ON users (name);

-- ═══════════════════════════════════════════════════════════════════════
--  contacts — কে কার ফোনবুক এন্ট্রি সিঙ্ক করেছে
--  contact_user_id হলো cache; আসল সত্য হলো contact_phone ↔ users.phone join,
--  কারণ পরে রেজিস্টার করা ব্যক্তিও যেন স্বয়ংক্রিয়ভাবে "registered" দেখায়।
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contacts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  contact_phone   TEXT NOT NULL,
  contact_name    TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  UNIQUE (user_id, contact_phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_user  ON contacts (user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (contact_phone);

-- ═══════════════════════════════════════════════════════════════════════
--  conversations — আপাতত শুধু 'direct' (1-on-1); 'group' ভবিষ্যতের জন্য
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'direct',
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- direct chat-এ দুই সদস্যের id sorted করে রাখা হয় → ডুপ্লিকেট conversation
  -- তৈরি হওয়া UNIQUE constraint দিয়েই আটকে যায়
  direct_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at       INTEGER NOT NULL,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members (user_id);

-- ═══════════════════════════════════════════════════════════════════════
--  messages
--  status: sent → delivered → read  (সার্ভারই authoritative)
--  type:   text | image | audio | file | system
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  receiver_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  type            TEXT NOT NULL DEFAULT 'text',
  content         TEXT NOT NULL DEFAULT '',
  media_url       TEXT,
  media_meta      TEXT,                                -- JSON: {name,size,mime,duration,width,height}
  reply_to        TEXT REFERENCES messages (id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'sent',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted         INTEGER NOT NULL DEFAULT 0,          -- 1 = delete for everyone
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_receiver     ON messages (receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_sender       ON messages (sender_id, created_at DESC);

-- "delete for me" — শুধু যে ইউজার মুছেছে তার কাছেই লুকানো থাকে
CREATE TABLE IF NOT EXISTS message_deletes (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════════════
--  calls — কল হিস্ট্রি (WebRTC মিডিয়া সার্ভারে যায় না, শুধু মেটাডাটা)
--  status: ringing | answered | missed | rejected | busy | failed | cancelled
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  caller_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  call_type   TEXT NOT NULL DEFAULT 'audio',           -- audio | video
  status      TEXT NOT NULL DEFAULT 'ringing',
  started_at  INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at    INTEGER,
  duration    INTEGER NOT NULL DEFAULT 0               -- সেকেন্ড
);
CREATE INDEX IF NOT EXISTS idx_calls_caller   ON calls (caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_receiver ON calls (receiver_id, started_at DESC);
`;

module.exports = { SCHEMA_SQL };
