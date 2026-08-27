/**
 * public/js/utils.js
 * ───────────────────────────────────────────────────────────────────────
 * ছোট ছোট সাধারণ হেল্পার: DOM নির্বাচন, নিরাপদ HTML escape, সময়/সাইজ
 * ফরম্যাটিং, debounce/throttle ইত্যাদি।
 *
 * XSS নিরাপত্তা: ব্যবহারকারীর লেখা কোনো টেক্সট কখনো সরাসরি innerHTML-এ
 * বসানো হয় না — হয় textContent ব্যবহার করা হয়, নয়তো escapeHtml() দিয়ে
 * escape করা হয়। linkify() ও escape করার পরেই লিঙ্ক তৈরি করে।
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** HTML-এ বিপজ্জনক ক্যারেক্টার escape করে */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * টেক্সটের ভেতরের URL গুলোকে ক্লিকযোগ্য লিঙ্ক বানায়।
 * ⚠️ আগে escape, পরে লিঙ্ক — উল্টো করলে XSS হতে পারত।
 */
export function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/((https?:\/\/|www\.)[^\s<]+)/gi, (match) => {
    const href = match.startsWith('http') ? match : `https://${match}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${match}</a>`;
  });
}

/** নাম থেকে ইনিশিয়াল (সর্বোচ্চ ২ অক্ষর) */
export function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** avatar element-এ ছবি বা ইনিশিয়াল বসায় */
export function setAvatar(element, user) {
  if (!element) return;
  element.dataset.initials = initials(user?.name);
  if (user?.avatar) {
    element.style.backgroundImage = `url("${encodeURI(user.avatar)}")`;
    element.classList.add('has-image');
  } else {
    element.style.backgroundImage = '';
    element.classList.remove('has-image');
  }
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

export const formatTime = (ts) => (ts ? timeFormatter.format(new Date(ts)) : '');
export const formatFull = (ts) => (ts ? fullFormatter.format(new Date(ts)) : '');

export function isSameDay(a, b) {
  const dateA = new Date(a);
  const dateB = new Date(b);
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

/** চ্যাট লিস্টের সময়: আজ হলে ঘড়ি, গতকাল হলে "Yesterday", নাহলে তারিখ */
export function formatListTime(ts) {
  if (!ts) return '';
  const now = new Date();
  const date = new Date(ts);
  if (isSameDay(now, date)) return timeFormatter.format(date);
  const yesterday = new Date(now.getTime() - 86400000);
  if (isSameDay(yesterday, date)) return 'Yesterday';
  return dateFormatter.format(date);
}

/** মেসেজ গ্রুপের দিন-বিভাজক লেবেল */
export function formatDayLabel(ts) {
  const now = new Date();
  const date = new Date(ts);
  if (isSameDay(now, date)) return 'Today';
  const yesterday = new Date(now.getTime() - 86400000);
  if (isSameDay(yesterday, date)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** "5m ago" ধরনের আপেক্ষিক সময় */
export function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return dateFormatter.format(new Date(ts));
}

/**
 * presence টেক্সট — privacy সেটিং সার্ভারেই প্রয়োগ হয়েছে; presenceHidden
 * true হলে কিছুই দেখানো হয় না।
 */
export function presenceText(user) {
  if (!user) return '';
  if (user.presenceHidden) return '';
  if (user.isOnline) return 'online';
  if (!user.lastSeen) return 'offline';
  const diff = Date.now() - user.lastSeen;
  if (diff < 120000) return 'last seen recently';
  if (isSameDay(Date.now(), user.lastSeen)) return `last seen today at ${formatTime(user.lastSeen)}`;
  const yesterday = new Date(Date.now() - 86400000);
  if (isSameDay(yesterday, user.lastSeen)) return `last seen yesterday at ${formatTime(user.lastSeen)}`;
  return `last seen ${formatRelative(user.lastSeen)}`;
}

/** সেকেন্ড → 1:05 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** নির্দিষ্ট সময় নিষ্ক্রিয় থাকার পর একবার চালায় (search input-এ ব্যবহৃত) */
export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** নির্দিষ্ট বিরতিতে সর্বোচ্চ একবার চালায় (typing ইভেন্টে ব্যবহৃত) */
export function throttle(fn, wait = 1500) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    }
  };
}

/** optimistic UI-র জন্য সাময়িক id */
export const tempId = () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ফোন নম্বর UI-তে দেখানোর জন্য হালকা ফরম্যাট */
export function prettyPhone(phone) {
  const value = String(phone || '');
  if (!value.startsWith('+') || value.length < 9) return value;
  const digits = value.slice(1);
  const cc = digits.slice(0, digits.length - 10) || digits.slice(0, 2);
  const rest = digits.slice(cc.length);
  return `+${cc} ${rest.slice(0, 5)} ${rest.slice(5)}`.trim();
}

/** ব্রাউজার-সাইড ফোন নরমালাইজেশন (সার্ভারই চূড়ান্ত, এটি শুধু UX-এর জন্য) */
export function normalizePhoneClient(input, defaultCc = '+880') {
  const raw = String(input || '').trim();
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  const cc = defaultCc.replace(/\D/g, '');
  if (!hasPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = cc + digits.replace(/^0+/, '');
    else if (digits.length <= 10 && !digits.startsWith(cc)) digits = cc + digits;
  }
  return `+${digits}`;
}

/**
 * ছবি ক্লায়েন্ট সাইডে ছোট করা (avatar ও বড় ছবি আপলোডের আগে) —
 * ব্যান্ডউইথ বাঁচে এবং সার্ভারে image processing লাইব্রেরি লাগে না।
 */
export async function downscaleImage(fileOrBlob, maxSize = 1280, quality = 0.86) {
  const bitmap = await createImageBitmapSafe(fileOrBlob);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  if (scale >= 1 && fileOrBlob.type === 'image/jpeg') return fileOrBlob;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  const type = fileOrBlob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || fileOrBlob), type, quality));
}

/** createImageBitmap না থাকলে (পুরনো Safari) <img> fallback */
export async function createImageBitmapSafe(source) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(source);
    } catch {
      /* নিচের fallback ব্যবহার হবে */
    }
  }
  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('ছবি পড়া যায়নি'));
      element.src = url;
    });
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

/** cookie পড়া (CSRF token-এর জন্য) */
export function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Clipboard API — সাপোর্ট না থাকলে fallback */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback নিচে */
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}
