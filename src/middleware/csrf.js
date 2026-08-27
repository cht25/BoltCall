/**
 * src/middleware/csrf.js
 * ───────────────────────────────────────────────────────────────────────
 * CSRF সুরক্ষা — "double submit cookie" পদ্ধতি।
 *
 * কীভাবে কাজ করে: লগইনের সময় সার্ভার দুইটি cookie দেয় —
 *   • nexachat_token (httpOnly, JS পড়তে পারে না)
 *   • nexachat_csrf  (সাধারণ cookie, frontend পড়তে পারে)
 * প্রতিটি state-changing request (POST/PUT/PATCH/DELETE)-এ frontend
 * X-CSRF-Token header-এ csrf cookie-র মান পাঠায়। অন্য কোনো সাইট আমাদের
 * cookie পড়তে পারে না, তাই সেই header বানাতেও পারে না → CSRF আটকে যায়।
 *
 * নোট: Authorization: Bearer দিয়ে আসা request-এ CSRF ঝুঁকি নেই (ব্রাউজার
 * স্বয়ংক্রিয়ভাবে header পাঠায় না), তাই সেগুলো ছাড় পায়।
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

  // Bearer token ব্যবহারকারী API client → CSRF প্রযোজ্য নয়
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const cookieToken = req.cookies ? req.cookies[config.csrfCookieName] : null;
  // লগইন/রেজিস্ট্রেশনের সময় এখনো কোনো সেশন cookie নেই — রক্ষার কিছু নেই
  if (!req.cookies || !req.cookies[config.cookieName]) {
    next();
    return;
  }

  const headerToken = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'];
  if (!cookieToken || !headerToken || String(headerToken) !== String(cookieToken)) {
    next(forbidden('CSRF টোকেন অবৈধ — পেজটি রিফ্রেশ করে আবার চেষ্টা করুন', 'csrf_invalid'));
    return;
  }
  next();
}

module.exports = { csrfProtection };
