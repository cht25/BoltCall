/**
 * src/middleware/auth.js
 * ───────────────────────────────────────────────────────────────────────
 * Authentication middleware for BoltCall.
 *
 * There are no user accounts and no database — the only credential is the
 * room password, exchanged once for a signed JWT. On every protected
 * request this middleware verifies the JWT signature + expiry and attaches
 * the member id to req.user. The socket layer applies the same check.
 */

'use strict';

const { extractToken, verifyToken } = require('../services/tokens');
const { unauthorized } = require('../utils/errors');

/** Requires a valid room-member token. */
async function requireAuth(req, res, next) {
  try {
    const { token } = extractToken(req);
    const payload = verifyToken(token);
    if (!payload || !payload.sub) {
      next(unauthorized('Your session has expired — enter the password again', 'session_expired'));
      return;
    }
    req.user = { id: payload.sub };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
