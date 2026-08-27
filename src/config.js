/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  src/config.js — কেন্দ্রীয় কনফিগারেশন লেয়ার                          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * এই ফাইলটি .env থেকে সব environment variable পড়ে, টাইপ কনভার্ট করে এবং
 * অ্যাপ্লিকেশনের বাকি অংশের জন্য একটি frozen (immutable) config object
 * রিটার্ন করে। কোথাও সরাসরি process.env ব্যবহার না করে এই ফাইল ব্যবহার
 * করা হয় — এতে ভুল নাম/টাইপো ধরা পড়ে এবং default মান একই জায়গায় থাকে।
 */

'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');

// ── ছোট ছোট parsing helper ────────────────────────────────────────────
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const list = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

/**
 * SESSION_SECRET না দিলে development-এ random secret বানানো হয় (সার্ভার
 * রিস্টার্টে session বাতিল হয়ে যাবে)। Production-এ secret না থাকলে সার্ভার
 * চালু হবে না — কারণ এটি সোজা নিরাপত্তা ঝুঁকি।
 */
function resolveSessionSecret() {
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET || '';
  const weak = !secret || secret === 'change_me' || secret.length < 16;

  if (weak && isProduction) {
    // eslint-disable-next-line no-console
    console.error(
      '[config] FATAL: production-এ SESSION_SECRET অবশ্যই সেট করতে হবে (কমপক্ষে ১৬ অক্ষর)।'
    );
    process.exit(1);
  }
  if (weak) {
    const generated = crypto.randomBytes(32).toString('hex');
    // eslint-disable-next-line no-console
    console.warn(
      '[config] ⚠️  SESSION_SECRET সেট করা নেই — development-এর জন্য একটি সাময়িক secret তৈরি হলো।'
    );
    return generated;
  }
  return secret;
}

const config = Object.freeze({
  env: NODE_ENV,
  isProduction,

  // ── HTTP server ────────────────────────────────────────────────────
  // Render নিজের PORT ইনজেক্ট করে; তাই process.env.PORT-ই প্রধান।
  port: num(process.env.PORT, 3000),
  trustProxy: bool(process.env.TRUST_PROXY, isProduction),

  // ── Auth / session ─────────────────────────────────────────────────
  sessionSecret: resolveSessionSecret(),
  sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 7),
  cookieName: 'nexachat_token',
  csrfCookieName: 'nexachat_csrf',

  // ── CORS / CSP ─────────────────────────────────────────────────────
  corsOrigins: list(process.env.CORS_ORIGIN),
  frameAncestors: list(process.env.FRAME_ANCESTORS).length
    ? list(process.env.FRAME_ANCESTORS)
    : [isProduction ? "'self'" : '*'],

  // ── Database ───────────────────────────────────────────────────────
  db: {
    driver: (process.env.DB_DRIVER || 'sqlite').toLowerCase(),
    // relative path হলে project root ধরে resolve করা হয়
    path: path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/nexachat.sqlite')
  },

  // ── Media upload ───────────────────────────────────────────────────
  upload: {
    dir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
    maxFileSizeMb: num(process.env.MAX_FILE_SIZE_MB, 10),
    get maxFileSizeBytes() {
      return num(process.env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024;
    },
    publicPath: '/uploads'
  },

  // ── Chat policy (সার্ভারই চূড়ান্ত সিদ্ধান্ত নেয়) ────────────────────
  chat: {
    editWindowMs: num(process.env.MESSAGE_EDIT_WINDOW_MINUTES, 15) * 60 * 1000,
    deleteForEveryoneWindowMs:
      num(process.env.DELETE_FOR_EVERYONE_WINDOW_MINUTES, 60) * 60 * 1000,
    maxMessageLength: num(process.env.MAX_MESSAGE_LENGTH, 4000),
    messagePageSize: num(process.env.MESSAGE_PAGE_SIZE, 40)
  },

  // ── Calling ────────────────────────────────────────────────────────
  call: {
    ringTimeoutMs: num(process.env.CALL_RING_TIMEOUT_SECONDS, 35) * 1000
  },

  // ── WebRTC ICE (Metered.ca) ────────────────────────────────────────
  metered: {
    apiKey: process.env.METERED_API_KEY || '',
    domain: process.env.METERED_DOMAIN || '',
    turnUsername: process.env.METERED_TURN_USERNAME || '',
    turnCredential: process.env.METERED_TURN_CREDENTIAL || '',
    cacheSeconds: num(process.env.ICE_CACHE_SECONDS, 600)
  },

  // ── Misc ───────────────────────────────────────────────────────────
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '+880',
  seedDemoPin: process.env.SEED_DEMO_PIN || 'nexa1234',

  // ── Rate limit বাজেট (প্রতি window) ────────────────────────────────
  rateLimits: {
    auth: { windowMs: 15 * 60 * 1000, max: num(process.env.RL_AUTH_MAX, 20) },
    search: { windowMs: 60 * 1000, max: num(process.env.RL_SEARCH_MAX, 60) },
    message: { windowMs: 60 * 1000, max: num(process.env.RL_MESSAGE_MAX, 180) },
    upload: { windowMs: 15 * 60 * 1000, max: num(process.env.RL_UPLOAD_MAX, 80) },
    general: { windowMs: 15 * 60 * 1000, max: num(process.env.RL_GENERAL_MAX, 1500) },
    // socket signaling এর জন্য in-memory token bucket
    socket: {
      messagesPerMinute: num(process.env.RL_SOCKET_MESSAGES, 180),
      typingPerMinute: num(process.env.RL_SOCKET_TYPING, 120),
      callRequestsPerMinute: num(process.env.RL_SOCKET_CALLS, 12)
    }
  }
});

module.exports = config;
