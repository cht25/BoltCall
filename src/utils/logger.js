/**
 * src/utils/logger.js
 * ───────────────────────────────────────────────────────────────────────
 * খুব হালকা একটি logger। উদ্দেশ্য দুইটি:
 *   ১) সার্ভার সাইডে টেকনিক্যাল error লগ করা (client-কে stack trace দেখানো হয় না)
 *   ২) লগে যেন ভুলেও secret (API key, token, password) না যায় — তাই
 *      redact() ফাংশন দিয়ে সংবেদনশীল key-গুলোর মান ঢেকে দেওয়া হয়।
 */

'use strict';

const SENSITIVE_KEYS = [
  'password',
  'pin',
  'password_hash',
  'passwordhash',
  'token',
  'authorization',
  'cookie',
  'credential',
  'apikey',
  'api_key',
  'secret',
  'sessionsecret'
];

/** সংবেদনশীল ফিল্ডের মান লগ থেকে সরিয়ে দেয় (recursive) */
function redact(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, val] of Object.entries(value)) {
      output[key] = SENSITIVE_KEYS.includes(key.toLowerCase()) ? '«redacted»' : redact(val, depth + 1);
    }
    return output;
  }
  return value;
}

const stamp = () => new Date().toISOString();

function format(args) {
  return args.map((arg) => (typeof arg === 'object' && arg !== null ? redact(arg) : arg));
}

const logger = {
  info: (...args) => console.log(`[${stamp()}] ℹ️ `, ...format(args)),
  warn: (...args) => console.warn(`[${stamp()}] ⚠️ `, ...format(args)),
  error: (...args) => console.error(`[${stamp()}] ❌`, ...format(args)),
  success: (...args) => console.log(`[${stamp()}] ✅`, ...format(args)),
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') console.log(`[${stamp()}] 🐞`, ...format(args));
  },
  redact
};

module.exports = logger;
