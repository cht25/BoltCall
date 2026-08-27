/**
 * src/services/ice.js
 * ───────────────────────────────────────────────────────────────────────
 * WebRTC ICE server (STUN/TURN) কনফিগারেশন সরবরাহ করে — Metered.ca ব্যবহার করে।
 *
 * কেন TURN দরকার? — দুই peer যদি symmetric NAT/firewall-এর পেছনে থাকে,
 * সরাসরি P2P কানেকশন হয় না। তখন TURN server মিডিয়া relay করে। STUN শুধু
 * নিজের পাবলিক IP:port আবিষ্কারে সাহায্য করে।
 *
 * নিরাপত্তা — সবচেয়ে গুরুত্বপূর্ণ অংশ:
 *   • METERED_API_KEY কখনো frontend-এ পাঠানো হয় না। শুধু সার্ভার Metered
 *     API-তে কল করে ephemeral TURN credential আনে এবং সেই credential-টুকুই
 *     authenticated client-কে দেয় (GET /api/webrtc/ice-servers)।
 *   • কোনো লগে API key বা credential ছাপা হয় না।
 *
 * তিনটি স্তরে fallback:
 *   ১) METERED_API_KEY + METERED_DOMAIN → অফিসিয়াল API (প্রস্তাবিত)
 *   ২) METERED_TURN_USERNAME/CREDENTIAL → static credential
 *   ৩) কিছুই না থাকলে → শুধু পাবলিক STUN (একই নেটওয়ার্ক/সহজ NAT-এ কাজ করে,
 *      relay লাগলে ব্যর্থ হবে — frontend-কে warning পাঠানো হয়)
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');

// Metered-এর স্ট্যান্ডার্ড relay endpoint তালিকা (ডকুমেন্টেশন অনুযায়ী)
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

// ইন-মেমরি ক্যাশ — প্রতিটি কলে Metered API-তে হিট করা হয় না
let cache = { data: null, expiresAt: 0 };

/** Metered API থেকে ephemeral credential আনা */
async function fetchFromMeteredApi() {
  const domain = config.metered.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(config.metered.apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      // status ছাড়া কিছু লগ করা হয় না (URL-এ key আছে, তাই URL লগ নিষিদ্ধ)
      throw new Error(`Metered API HTTP ${response.status}`);
    }
    const payload = await response.json();
    const iceServers = Array.isArray(payload) ? payload : payload?.iceServers;
    if (!Array.isArray(iceServers) || !iceServers.length) {
      throw new Error('Metered API থেকে অপ্রত্যাশিত রেসপন্স');
    }
    // শুধু প্রয়োজনীয় ফিল্ড রেখে স্যানিটাইজ করা হয়
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
 * ICE কনফিগারেশন রিটার্ন করে (ক্যাশসহ)।
 * @returns {Promise<{iceServers:Array, source:string, ttl:number, warning?:string}>}
 */
async function getIceServers({ force = false } = {}) {
  const nowMs = Date.now();
  if (!force && cache.data && cache.expiresAt > nowMs) {
    return { ...cache.data, cached: true, ttl: Math.round((cache.expiresAt - nowMs) / 1000) };
  }

  let result;

  if (config.metered.apiKey && config.metered.domain && !config.metered.domain.startsWith('YOUR_')) {
    // ── স্তর ১: অফিসিয়াল Metered API ──────────────────────────────
    try {
      const iceServers = await fetchFromMeteredApi();
      result = { iceServers, source: 'metered-api' };
      logger.info(`[ice] Metered API থেকে ${iceServers.length}টি ICE server পাওয়া গেছে`);
    } catch (err) {
      logger.warn('[ice] Metered API ব্যর্থ, static credential চেষ্টা করা হচ্ছে:', err.message);
    }
  }

  if (!result && config.metered.turnUsername && config.metered.turnCredential) {
    // ── স্তর ২: static TURN credential ────────────────────────────
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
    // ── স্তর ৩: শুধু STUN (relay নেই) ─────────────────────────────
    result = {
      iceServers: PUBLIC_STUN_ONLY,
      source: 'stun-only',
      warning:
        'TURN credential কনফিগার করা নেই — কঠিন NAT/firewall-এর পেছনে কল সংযুক্ত না-ও হতে পারে। .env-এ METERED_API_KEY ও METERED_DOMAIN দিন।'
    };
    logger.warn('[ice] TURN credential নেই — শুধু STUN দিয়ে চলছে');
  }

  const ttl = result.source === 'stun-only' ? 60 : config.metered.cacheSeconds;
  cache = { data: result, expiresAt: nowMs + ttl * 1000 };
  return { ...result, cached: false, ttl };
}

/** টেস্ট/রিফ্রেশের জন্য ক্যাশ পরিষ্কার */
function clearCache() {
  cache = { data: null, expiresAt: 0 };
}

module.exports = { getIceServers, clearCache, METERED_URLS };
