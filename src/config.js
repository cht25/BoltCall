/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  src/config.js — BoltCall central configuration                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * This file reads every environment variable from .env, converts types and
 * returns one frozen (immutable) config object for the rest of the app.
 * Nothing else in the codebase reads process.env directly.
 *
 * BoltCall is NOT a messenger: it is one shared group-call room.
 *  • Anyone who knows the room password joins the SAME group call.
 *  • There is no registration, no contacts and no personal name —
 *    every participant is displayed as `memberName` (default "thamjj13").
 */

'use strict';

require('dotenv').config();

const crypto = require('crypto');

// ── Small parsing helpers ─────────────────────────────────────────────
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
 * SESSION_SECRET is required in production (a weak secret is a straight
 * security risk). In development a random one is generated, which means
 * sessions reset on restart — fine for local work.
 */
function resolveSessionSecret() {
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET || '';
  const weak = !secret || secret === 'change_me' || secret.length < 16;

  if (weak && isProduction) {
    // eslint-disable-next-line no-console
    console.error('[config] FATAL: SESSION_SECRET must be set in production (at least 16 chars).');
    process.exit(1);
  }
  if (weak) {
    const generated = crypto.randomBytes(32).toString('hex');
    // eslint-disable-next-line no-console
    console.warn('[config] ⚠️  SESSION_SECRET not set — a temporary dev secret was generated.');
    return generated;
  }
  return secret;
}

const DEV_DEFAULT_PASSWORD = 'boltcall';

/**
 * The single room password. Two options:
 *   1) ROOM_PASSWORD_HASH — a bcrypt hash of the password (recommended in
 *      production so the plain password never lives in the environment).
 *   2) ROOM_PASSWORD — plain password, compared in constant time.
 * In development, falling back to the default lets the app boot out of the
 * box; the join screen then shows a visible "dev password" hint.
 */
function resolveRoomPassword() {
  const hash = process.env.ROOM_PASSWORD_HASH || '';
  const plain = process.env.ROOM_PASSWORD || '';

  if (hash) return { kind: 'hash', value: hash };
  if (plain) {
    if (plain.length < 6 && isProduction) {
      // eslint-disable-next-line no-console
      console.error('[config] FATAL: ROOM_PASSWORD must be at least 6 characters in production.');
      process.exit(1);
    }
    return { kind: 'plain', value: plain };
  }
  if (isProduction) {
    // eslint-disable-next-line no-console
    console.error('[config] FATAL: set ROOM_PASSWORD (or ROOM_PASSWORD_HASH) in production.');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn(`[config] ⚠️  ROOM_PASSWORD not set — dev default "${DEV_DEFAULT_PASSWORD}" is in use.`);
  return { kind: 'plain', value: DEV_DEFAULT_PASSWORD };
}

const config = Object.freeze({
  env: NODE_ENV,
  isProduction,

  // ── HTTP server ────────────────────────────────────────────────────
  port: num(process.env.PORT, 3000),
  trustProxy: bool(process.env.TRUST_PROXY, isProduction),

  // ── Session (JWT cookie) ───────────────────────────────────────────
  sessionSecret: resolveSessionSecret(),
  sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 7),
  cookieName: 'boltcall_token',
  csrfCookieName: 'boltcall_csrf',

  // ── CORS / CSP ─────────────────────────────────────────────────────
  corsOrigins: list(process.env.CORS_ORIGIN),
  frameAncestors: list(process.env.FRAME_ANCESTORS).length
    ? list(process.env.FRAME_ANCESTORS)
    : [isProduction ? "'self'" : '*'],

  // ── The group-call room ────────────────────────────────────────────
  room: {
    name: process.env.ROOM_NAME || 'boltcall-room',
    // Every participant appears under this name — never asked from users.
    memberName: process.env.MEMBER_NAME || 'thamjj13',
    password: resolveRoomPassword(),
    // Soft cap for the mesh (kept generous for house parties / classes).
    maxParticipants: num(process.env.MAX_PARTICIPANTS, 24)
  },

  // ── Text chat policy ───────────────────────────────────────────────
  chat: {
    maxMessageLength: num(process.env.MAX_MESSAGE_LENGTH, 1000),
    historySize: num(process.env.CHAT_HISTORY_SIZE, 100)
  },

  // ── WebRTC ICE (Metered.ca) ────────────────────────────────────────
  metered: {
    apiKey: process.env.METERED_API_KEY || '',
    domain: process.env.METERED_DOMAIN || '',
    turnUsername: process.env.METERED_TURN_USERNAME || '',
    turnCredential: process.env.METERED_TURN_CREDENTIAL || '',
    cacheSeconds: num(process.env.ICE_CACHE_SECONDS, 600)
  },

  // ── Rate-limit budgets (per window) ────────────────────────────────
  rateLimits: {
    auth: { windowMs: 15 * 60 * 1000, max: num(process.env.RL_AUTH_MAX, 20) },
    general: { windowMs: 15 * 60 * 1000, max: num(process.env.RL_GENERAL_MAX, 1500) },
    // in-memory token buckets for socket events (per socket)
    socket: {
      chatPerMinute: num(process.env.RL_SOCKET_CHAT, 60),
      signalPerMinute: num(process.env.RL_SOCKET_SIGNAL, 600), // ICE candidates are chatty
      statePerMinute: num(process.env.RL_SOCKET_STATE, 120)
    }
  }
});

module.exports = config;
