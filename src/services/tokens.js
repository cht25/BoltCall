/**
 * src/services/tokens.js
 * ───────────────────────────────────────────────────────────────────────
 * সেশন ব্যবস্থাপনা: JWT তৈরি/যাচাই + cookie সেট করা।
 *
 * কেন httpOnly cookie? — JWT localStorage-এ রাখলে XSS হলে token চুরি হয়ে
 * যায়। httpOnly cookie JavaScript পড়তে পারে না, তাই অনেক নিরাপদ। পাশাপাশি
 * CSRF ঠেকাতে double-submit pattern ব্যবহার করা হয়: একটি পড়ার-যোগ্য
 * csrf cookie + প্রতিটি state-changing request-এ X-CSRF-Token header।
 *
 * টোকেনে থাকে { sub: userId, ver: token_version }। ইউজারের token_version
 * বাড়ালে (যেমন পাসওয়ার্ড বদল) আগের সব token সাথে সাথে অকার্যকর হয়ে যায়।
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const TTL_SECONDS = config.sessionTtlDays * 24 * 60 * 60;

/** ইউজারের জন্য signed JWT */
function signToken(user) {
  return jwt.sign({ sub: user.id, ver: user.tokenVersion || 1 }, config.sessionSecret, {
    expiresIn: TTL_SECONDS,
    issuer: 'nexachat'
  });
}

/** @returns {{sub:string, ver:number}|null} */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, config.sessionSecret, { issuer: 'nexachat' });
  } catch {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Render/production-এ HTTPS বাধ্যতামূলক (WebRTC-ও secure context চায়)
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: TTL_SECONDS * 1000,
    path: '/'
  };
}

/** auth cookie + csrf cookie দুইটিই সেট করে */
function setAuthCookies(res, token) {
  res.cookie(config.cookieName, token, cookieOptions());
  res.cookie(config.csrfCookieName, crypto.randomBytes(24).toString('hex'), {
    httpOnly: false, // frontend পড়ে header-এ পাঠাবে (double-submit)
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: TTL_SECONDS * 1000,
    path: '/'
  });
}

function clearAuthCookies(res) {
  res.clearCookie(config.cookieName, { path: '/' });
  res.clearCookie(config.csrfCookieName, { path: '/' });
}

/** request থেকে token বের করা: cookie অথবা Authorization: Bearer */
function extractToken(req) {
  const fromCookie = req.cookies ? req.cookies[config.cookieName] : null;
  if (fromCookie) return { token: fromCookie, source: 'cookie' };

  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { token: header.slice(7).trim(), source: 'bearer' };

  return { token: null, source: null };
}

/** Socket.IO handshake-এর cookie header parse (cookie-parser এখানে নেই) */
function tokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const parts = String(cookieHeader).split(';');
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name === config.cookieName) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

module.exports = {
  signToken,
  verifyToken,
  setAuthCookies,
  clearAuthCookies,
  extractToken,
  tokenFromCookieHeader,
  TTL_SECONDS
};
