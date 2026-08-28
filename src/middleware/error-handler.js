/**
 * src/middleware/error-handler.js
 * ───────────────────────────────────────────────────────────────────────
 * Central error handling.
 *
 * Principles:
 *   • users only see understandable messages ("Upload failed", "Session
 *     expired") — stack traces stay in the server log
 *   • library errors (invalid JSON, oversized body) are converted into
 *     clean API responses
 */

'use strict';

const logger = require('../utils/logger');
const { ApiError } = require('../utils/errors');

/** async route handler-এ throw হওয়া error স্বয়ংক্রিয়ভাবে next()-এ পাঠায় */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found', code: 'not_found' });
    return;
  }
  next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ── Our own expected errors ────────────────────────────────────────
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error('[api]', err.message, err.stack);
    else logger.debug('[api]', err.status, err.code, err.message);
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }

  // ── Malformed JSON body ────────────────────────────────────────────
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON sent', code: 'invalid_json' });
    return;
  }
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large', code: 'payload_too_large' });
    return;
  }

  // ── Unexpected error → generic 500 ─────────────────────────────────
  logger.error('[unhandled]', err && err.message, err && err.stack);
  res.status(500).json({
    error: 'Something went wrong on the server — please try again',
    code: 'internal_error'
  });
}

module.exports = { asyncHandler, notFoundHandler, errorHandler };
