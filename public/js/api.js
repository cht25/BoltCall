/**
 * public/js/api.js
 * ───────────────────────────────────────────────────────────────────────
 * REST API ক্লায়েন্ট।
 *
 * • credentials: 'same-origin' → httpOnly auth cookie স্বয়ংক্রিয়ভাবে যায়
 * • প্রতিটি state-changing request-এ X-CSRF-Token header (double submit)
 * • 401 এলে 'nexachat:session-expired' event পাঠানো হয় → UI লগইন স্ক্রিনে ফেরে
 * • সার্ভারের বোধগম্য error বার্তা ApiError-এ মুড়ে throw করা হয়
 */

import { readCookie } from './utils.js';

const CSRF_COOKIE = 'nexachat_csrf';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, formData, signal, timeout = 20000 } = {}) {
  const headers = {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: formData || (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ApiError('রিকোয়েস্ট সময়সীমা শেষ — সংযোগ পরীক্ষা করুন', { code: 'timeout' });
    }
    throw new ApiError('সার্ভারে সংযোগ করা যাচ্ছে না', { code: 'network' });
  }
  clearTimeout(timer);

  // 204 No Content
  if (response.status === 204) return null;

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('nexachat:session-expired'));
    }
    throw new ApiError((payload && payload.error) || `রিকোয়েস্ট ব্যর্থ (${response.status})`, {
      status: response.status,
      code: (payload && payload.code) || 'error',
      details: payload && payload.details
    });
  }
  return payload;
}

/** multipart আপলোড — progress callback সহ (XHR ব্যবহার করা হয়, fetch-এ progress নেই) */
function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.withCredentials = true;
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent('nexachat:session-expired'));
      reject(
        new ApiError((payload && payload.error) || 'আপলোড ব্যর্থ', {
          status: xhr.status,
          code: (payload && payload.code) || 'upload_failed'
        })
      );
    };
    xhr.onerror = () => reject(new ApiError('আপলোডের সময় নেটওয়ার্ক সমস্যা', { code: 'network' }));
    xhr.ontimeout = () => reject(new ApiError('আপলোডে সময়সীমা শেষ', { code: 'timeout' }));
    xhr.timeout = 120000;
    xhr.send(formData);
  });
}

export const api = {
  request,

  auth: {
    register: (payload) => {
      // avatar থাকলে multipart, নাহলে JSON
      if (payload.avatarBlob) {
        const form = new FormData();
        form.append('phone', payload.phone);
        form.append('name', payload.name);
        form.append('password', payload.password);
        if (payload.about) form.append('about', payload.about);
        form.append('avatar', payload.avatarBlob, 'avatar.jpg');
        return request('/api/auth/register', { method: 'POST', formData: form });
      }
      return request('/api/auth/register', { method: 'POST', body: payload });
    },
    login: (phone, password) => request('/api/auth/login', { method: 'POST', body: { phone, password } }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    me: () => request('/api/auth/me'),
    changePassword: (currentPassword, newPassword) =>
      request('/api/auth/password', { method: 'PATCH', body: { currentPassword, newPassword } })
  },

  users: {
    list: (limit = 50) => request(`/api/users?limit=${limit}`),
    search: (query) => request(`/api/users/search?q=${encodeURIComponent(query)}`),
    get: (id) => request(`/api/users/${encodeURIComponent(id)}`),
    updateMe: (patch) => request('/api/users/me', { method: 'PATCH', body: patch }),
    uploadAvatar: (blob, onProgress) => {
      const form = new FormData();
      form.append('avatar', blob, 'avatar.jpg');
      return uploadWithProgress('/api/users/me/avatar', form, onProgress);
    },
    removeAvatar: () => request('/api/users/me/avatar', { method: 'DELETE' })
  },

  contacts: {
    list: () => request('/api/contacts'),
    sync: (contacts) => request('/api/contacts/sync', { method: 'POST', body: { contacts } }),
    remove: (id) => request(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  conversations: {
    list: () => request('/api/conversations'),
    create: ({ userId, phone }) => request('/api/conversations', { method: 'POST', body: { userId, phone } }),
    messages: (id, { limit = 40, before = 0 } = {}) =>
      request(`/api/conversations/${encodeURIComponent(id)}/messages?limit=${limit}&before=${before}`),
    markRead: (id) => request(`/api/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    search: (id, query) =>
      request(`/api/conversations/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`)
  },

  messages: {
    send: (payload) => request('/api/messages', { method: 'POST', body: payload }),
    edit: (id, content) => request(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { content } }),
    remove: (id, scope = 'me') =>
      request(`/api/messages/${encodeURIComponent(id)}?scope=${scope}`, { method: 'DELETE' }),
    search: (query) => request(`/api/messages/search?q=${encodeURIComponent(query)}`)
  },

  upload: {
    // সার্ভার রেসপন্স আকার: { file: { url, name, size, mime, category } } — ভিতরের file টি রিটার্ন করি
    image: async (blob, filename = 'image.jpg', onProgress) => {
      const form = new FormData();
      form.append('file', blob, filename);
      const payload = await uploadWithProgress('/api/upload/image', form, onProgress);
      return payload && payload.file;
    },
    audio: async (blob, filename = 'voice.webm', onProgress) => {
      const form = new FormData();
      form.append('file', blob, filename);
      const payload = await uploadWithProgress('/api/upload/audio', form, onProgress);
      return payload && payload.file;
    },
    file: async (file, onProgress) => {
      const form = new FormData();
      form.append('file', file, file.name);
      const payload = await uploadWithProgress('/api/upload/file', form, onProgress);
      return payload && payload.file;
    }
  },

  webrtc: {
    iceServers: () => request('/api/webrtc/ice-servers')
  },

  calls: {
    list: () => request('/api/calls')
  },

  health: () => request('/api/health')
};
