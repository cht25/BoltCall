/**
 * src/middleware/csrf.js
 * ───────────────────────────────────────────────────────────────────────
 * CSRF protection — the "double submit cookie" pattern.
 *
 * How it works: joining issues two cookies —
 *   • boltcall_token (httpOnly, JavaScript cannot read it)
 *   • boltcall_csrf  (readable cookie, the frontend echoes it back)
 * Every state-changing request (POST/PUT/PATCH/DELETE) must carry
 * X-CSRF-Token: <value of the csrf cookie>. Another site cannot read our
 * cookies, so it cannot forge that header → CSRF is blocked.
 *
 * Note: requests authenticated with Authorization: Bearer are exempt —
 * browsers never attach that header automatically, so no CSRF risk.
 */

'use strict';

const config = require('../config');
const { forbidden } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Bearer-authenticated API clients → CSRF does not apply
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const cookieToken = req.cookies ? req.cookies[config.csrfCookieName] : null;
  // No session cookie yet (e.g. during /auth/join) → nothing to protect
  if (!req.cookies || !req.cookies[config.cookieName]) {
    next();
    return;
  }

  const headerToken = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'];
  if (!cookieToken || !headerToken || String(headerToken) !== String(cookieToken)) {
    next(forbidden('CSRF token invalid — refresh the page and try again', 'csrf_invalid'));
    return;
  }
  next();
}

module.exports = { csrfProtection };
