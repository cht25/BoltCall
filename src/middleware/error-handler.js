/**
 * src/middleware/error-handler.js
 * ───────────────────────────────────────────────────────────────────────
 * কেন্দ্রীয় error handling।
 *
 * নীতি:
 *   • ব্যবহারকারী শুধু বোধগম্য বার্তা দেখে ("আপলোড ব্যর্থ", "সেশন শেষ")
 *   • stack trace কখনো ব্রাউজারে যায় না — শুধু সার্ভার লগে থাকে
 *   • Multer/JSON parse ইত্যাদি লাইব্রেরি error গুলোকেও বোধগম্য বার্তায়
 *     রূপান্তর করা হয়
 */

'use strict';

const multer = require('multer');
const config = require('../config');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/errors');

/** async route handler-এ throw হওয়া error স্বয়ংক্রিয়ভাবে next()-এ পাঠায় */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint পাওয়া যায়নি', code: 'not_found' });
    return;
  }
  next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ── রেসপন্স ইতিমধ্যেই পাঠানো হয়ে গেছে? ───────────────────────────
  // (যেমন: res.sendFile stream শুরু হওয়ার পরে error, বা অন্য কোনো
  //  handler আগেই respond করে ফেলেছে)। এ অবস্থায় আবার হেডার/বডি লিখলে
  //  ERR_HTTP_HEADERS_SENT হয় — তাই Express-এর ডিফল্ট handler-এ দিয়ে
  //  দেওয়া হয়, যা কানেকশনটি নিরাপদে বন্ধ করে।
  if (res.headersSent) {
    logger.error('[unhandled:after-response]', err && err.message, err && err.stack);
    next(err);
    return;
  }

  // ── Multer (আপলোড) error ─────────────────────────────────────────
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `ফাইল সর্বোচ্চ ${config.upload.maxFileSizeMb}MB হতে পারে`,
      LIMIT_FILE_COUNT: 'একবারে একটি ফাইলই আপলোড করা যাবে',
      LIMIT_UNEXPECTED_FILE: 'অপ্রত্যাশিত ফাইল ফিল্ড'
    };
    logger.warn('[upload] Multer error:', err.code);
    res.status(400).json({ error: messages[err.code] || 'ফাইল আপলোড ব্যর্থ', code: err.code });
    return;
  }

  // ── আমাদের নিজের প্রত্যাশিত error ────────────────────────────────
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error('[api]', err.message, err.stack);
    else logger.debug('[api]', err.status, err.code, err.message);
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }

  // ── অবৈধ JSON body ───────────────────────────────────────────────
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'অবৈধ JSON পাঠানো হয়েছে', code: 'invalid_json' });
    return;
  }
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'রিকোয়েস্ট বডি অনেক বড়', code: 'payload_too_large' });
    return;
  }

  // ── অপ্রত্যাশিত error → generic 500 ──────────────────────────────
  logger.error('[unhandled]', err && err.message, err && err.stack);
  res.status(500).json({
    error: 'সার্ভারে সমস্যা হয়েছে — একটু পরে আবার চেষ্টা করুন',
    code: 'internal_error'
  });
}

module.exports = { asyncHandler, notFoundHandler, errorHandler };
