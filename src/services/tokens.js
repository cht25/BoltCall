/**
 * src/services/tokens.js
 * ───────────────────────────────────────────────────────────────────────
 * Session handling for BoltCall: JWT create/verify + cookie helpers.
 *
 * BoltCall has no user accounts. When a client enters the correct room
 * password the server issues a short-lived signed JWT that identifies the
 * participant INSIDE the room (sub = random member id) and nothing else.
 * The token is stored in an httpOnly cookie (not readable by JavaScript),
 * with a readable CSRF cookie alongside (double-submit pattern).
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const TTL_SECONDS = config.sessionTtlDays * 24 * 60 * 60;

/** Signed JWT for a room member: { sub: memberId } */
function signToken(memberId) {
  return jwt.sign({ sub: String(memberId) }, config.sessionSecret, {
    expiresIn: TTL_SECONDS,
    issuer: 'boltcall'
  });
}

/** @returns {{sub:string}|null} */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, config.sessionSecret, { issuer: 'boltcall' });
  } catch {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Production runs behind HTTPS; WebRTC requires a secure context anyway.
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: TTL_SECONDS * 1000,
    path: '/'
  };
}

/** Auth cookie + CSRF cookie, issued together after a successful join. */
function setAuthCookies(res, token) {
  res.cookie(config.cookieName, token, cookieOptions());
  res.cookie(config.csrfCookieName, crypto.randomBytes(24).toString('hex'), {
    httpOnly: false, // frontend reads it and echoes it in X-CSRF-Token
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

/** Token from cookie or Authorization: Bearer header. */
function extractToken(req) {
  const fromCookie = req.cookies ? req.cookies[config.cookieName] : null;
  if (fromCookie) return { token: fromCookie, source: 'cookie' };

  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { token: header.slice(7).trim(), source: 'bearer' };

  return { token: null, source: null };
}

/** Socket.IO handshake carries a raw cookie header (no cookie-parser there). */
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
