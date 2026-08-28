/**
 * src/services/ice.js
 * ───────────────────────────────────────────────────────────────────────
 * WebRTC ICE server (STUN/TURN) configuration — uses Metered.ca.
 *
 * Why TURN? — when two peers sit behind symmetric NAT/firewalls a direct
 * P2P connection is impossible; a TURN server relays the media instead.
 * STUN only helps discover one's own public IP:port.
 *
 * Security — the most important part:
 *   • METERED_API_KEY never reaches the frontend. Only the server calls
 *     the Metered API for ephemeral TURN credentials and serves just
 *     those to authenticated members (GET /api/webrtc/ice-servers).
 *   • API keys or credentials never appear in logs.
 *
 * Three-level fallback:
 *   1) METERED_API_KEY + METERED_DOMAIN → official API (recommended)
 *   2) METERED_TURN_USERNAME/CREDENTIAL → static credentials
 *   3) nothing configured → public STUN only (works on the same network
 *      and easy NATs; relay scenarios fail — the frontend gets a warning)
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');

// Metered's standard relay endpoint list (per their docs)
const METERED_URLS = [
  'stun:stun.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80?transport=tcp',
  'turn:global.relay.metered.ca:443',
  'turns:global.relay.metered.ca:443?transport=tcp'
];

const PUBLIC_STUN_ONLY = [
  { urls: ['stun:stun.relay.metered.ca:80', 'stun:stun.l.google.com:19302'] }
];

// In-memory cache — don't hit the Metered API on every call
let cache = { data: null, expiresAt: 0 };

/** Fetch ephemeral credentials from the Metered API. */
async function fetchFromMeteredApi() {
  const domain = config.metered.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(config.metered.apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      // Only the status is logged — the URL contains the key, so never log it
      throw new Error(`Metered API HTTP ${response.status}`);
    }
    const payload = await response.json();
    const iceServers = Array.isArray(payload) ? payload : payload?.iceServers;
    if (!Array.isArray(iceServers) || !iceServers.length) {
      throw new Error('Unexpected response from Metered API');
    }
    // Keep only the fields the browser needs
    return iceServers
      .filter((server) => server && server.urls)
      .map((server) => ({
        urls: server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {})
      }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return ICE configuration (with caching).
 * @returns {Promise<{iceServers:Array, source:string, ttl:number, warning?:string}>}
 */
async function getIceServers({ force = false } = {}) {
  const nowMs = Date.now();
  if (!force && cache.data && cache.expiresAt > nowMs) {
    return { ...cache.data, cached: true, ttl: Math.round((cache.expiresAt - nowMs) / 1000) };
  }

  let result;

  if (config.metered.apiKey && config.metered.domain && !config.metered.domain.startsWith('YOUR_')) {
    // ── Level 1: official Metered API ────────────────────────────────
    try {
      const iceServers = await fetchFromMeteredApi();
      result = { iceServers, source: 'metered-api' };
      logger.info(`[ice] got ${iceServers.length} ICE servers from the Metered API`);
    } catch (err) {
      logger.warn('[ice] Metered API failed, trying static credentials:', err.message);
    }
  }

  if (!result && config.metered.turnUsername && config.metered.turnCredential) {
    // ── Level 2: static TURN credentials ─────────────────────────────
    result = {
      iceServers: [
        {
          urls: METERED_URLS,
          username: config.metered.turnUsername,
          credential: config.metered.turnCredential
        }
      ],
      source: 'metered-static'
    };
  }

  if (!result) {
    // ── Level 3: public STUN only (no relay) ─────────────────────────
    result = {
      iceServers: PUBLIC_STUN_ONLY,
      source: 'stun-only',
      warning:
        'No TURN relay configured — calls may fail behind strict NAT/firewalls. Set METERED_API_KEY and METERED_DOMAIN in .env.'
    };
    logger.warn('[ice] no TURN credentials — running STUN-only');
  }

  const ttl = result.source === 'stun-only' ? 60 : config.metered.cacheSeconds;
  cache = { data: result, expiresAt: nowMs + ttl * 1000 };
  return { ...result, cached: false, ttl };
}

/** Clear the cache (tests / manual refresh). */
function clearCache() {
  cache = { data: null, expiresAt: 0 };
}

module.exports = { getIceServers, clearCache, METERED_URLS };
