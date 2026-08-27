/**
 * src/utils/phone.js
 * ───────────────────────────────────────────────────────────────────────
 * ফোন নম্বর নরমালাইজেশন। ডাটাবেসে সবসময় একটি consistent E.164-সদৃশ
 * ফরম্যাটে (+8801712345678) নম্বর সংরক্ষণ করা হয়, যাতে contact sync ও
 * ডুপ্লিকেট রেজিস্ট্রেশন চেক নির্ভুল হয়।
 *
 * নিয়ম:
 *   "+880 1712-345678"  → +8801712345678
 *   "008801712345678"   → +8801712345678   (00 = আন্তর্জাতিক prefix)
 *   "01712345678"       → +8801712345678   (leading 0 = লোকাল নম্বর,
 *                                           DEFAULT_COUNTRY_CODE বসানো হয়)
 *   "8801712345678"     → +8801712345678
 */

'use strict';

const config = require('../config');

/**
 * ইনপুট থেকে শুধু ডিজিট ও শুরুর '+' রাখে
 */
function stripFormatting(input) {
  const raw = String(input || '').trim();
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  return { hasPlus, digits };
}

/**
 * নম্বরকে normalized আন্তর্জাতিক ফরম্যাটে রূপান্তর করে।
 * @returns {string|null} সফল হলে "+<digits>", না হলে null
 */
function normalizePhone(input, defaultCountryCode = config.defaultCountryCode) {
  const { hasPlus, digits: rawDigits } = stripFormatting(input);
  if (!rawDigits) return null;

  const cc = String(defaultCountryCode || '').replace(/\D/g, ''); // "+880" → "880"
  let digits = rawDigits;

  if (!hasPlus) {
    if (digits.startsWith('00')) {
      // 00 = আন্তর্জাতিক dial prefix
      digits = digits.slice(2);
    } else if (digits.startsWith('0')) {
      // লোকাল ফরম্যাট → country code যোগ
      digits = cc + digits.replace(/^0+/, '');
    } else if (cc && digits.length <= 10 && !digits.startsWith(cc)) {
      // country code ছাড়া ছোট নম্বর → default country code ধরে নেওয়া হয়
      digits = cc + digits;
    }
  }

  const normalized = `+${digits}`;
  return isValidPhone(normalized) ? normalized : null;
}

/** E.164 ভ্যালিডেশন: '+' এর পর ৭–১৫ ডিজিট, প্রথম ডিজিট 0 নয় */
function isValidPhone(phone) {
  return /^\+[1-9]\d{6,14}$/.test(String(phone || ''));
}

/**
 * UI-তে দেখানোর জন্য হালকা ফরম্যাটিং: +8801712345678 → +880 17123 45678
 * (কোনো লজিক এর উপর নির্ভর করে না, শুধুই পড়ার সুবিধা)
 */
function formatPhoneForDisplay(phone) {
  const value = String(phone || '');
  if (!isValidPhone(value)) return value;
  const digits = value.slice(1);
  if (digits.length <= 8) return `+${digits}`;
  const cc = digits.slice(0, digits.length - 10) || digits.slice(0, 2);
  const rest = digits.slice(cc.length);
  return `+${cc} ${rest.slice(0, 5)} ${rest.slice(5)}`.trim();
}

module.exports = { normalizePhone, isValidPhone, formatPhoneForDisplay };
