/**
 * src/utils/validate.js
 * ───────────────────────────────────────────────────────────────────────
 * সার্ভার-সাইড ইনপুট ভ্যালিডেশন হেল্পার।
 * ⚠️ Frontend validation কখনোই যথেষ্ট নয় — প্রতিটি endpoint এখানকার
 * ফাংশনগুলো দিয়ে ইনপুট যাচাই করে, তারপরই ডাটাবেসে যায়।
 */

'use strict';

const { badRequest } = require('./errors');

/** কন্ট্রোল ক্যারেক্টার সরিয়ে (newline/tab রেখে) স্ট্রিং পরিষ্কার করে */
function sanitizeText(value, maxLength = 4000) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.slice(0, maxLength);
}

/** নাম/টাইটেল টাইপ ফিল্ড: একাধিক স্পেস কমিয়ে trim করা হয় */
function sanitizeLine(value, maxLength = 120) {
  return sanitizeText(value, maxLength).replace(/\s+/g, ' ').trim();
}

function requireString(value, field, { min = 1, max = 500 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw badRequest(`${field} দিতে হবে`, 'validation', { field });
  if (text.length > max) throw badRequest(`${field} সর্বোচ্চ ${max} অক্ষরের হতে পারে`, 'validation', { field });
  return text;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw badRequest(`${field} অবৈধ`, 'validation', { field, allowed });
  }
  return value;
}

/** password/PIN নীতি: কমপক্ষে ৪ অক্ষর (ডেমো-বান্ধব), সর্বোচ্চ ১২৮ */
function requirePassword(value, field = 'পাসওয়ার্ড/PIN') {
  if (typeof value !== 'string' || value.length < 4) {
    throw badRequest(`${field} কমপক্ষে ৪ অক্ষরের হতে হবে`, 'validation', { field: 'password' });
  }
  if (value.length > 128) {
    throw badRequest(`${field} খুব বড়`, 'validation', { field: 'password' });
  }
  return value;
}

/** ?limit=  ?before= ধরনের সংখ্যা প্যারামিটার */
function parseInteger(value, { fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** UUID v4-সদৃশ id যাচাই (route param spoofing আটকাতে) */
function isId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
}

function requireId(value, field = 'id') {
  if (!isId(value)) throw badRequest(`${field} অবৈধ`, 'validation', { field });
  return value;
}

module.exports = {
  sanitizeText,
  sanitizeLine,
  requireString,
  requireOneOf,
  requirePassword,
  parseInteger,
  isId,
  requireId
};
