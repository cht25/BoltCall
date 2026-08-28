/**
 * public/js/api.js — REST helpers for the tiny BoltCall API.
 *
 * State-changing requests carry the CSRF double-submit header
 * (X-CSRF-Token = value of the readable boltcall_csrf cookie).
 */

import { readCookie } from './utils.js';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = readCookie('boltcall_csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, payload.code);
  }
  return payload;
}

export const api = {
  /** POST /api/auth/join — exchange the room password for a session. */
  join: (password) => request('/api/auth/join', { method: 'POST', body: { password } }),

  /** GET /api/auth/me — is there still a valid session? */
  me: () => request('/api/auth/me'),

  /** POST /api/auth/logout — clear the session cookie. */
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  /** GET /api/webrtc/ice-servers — STUN/TURN config for the mesh. */
  iceServers: () => request('/api/webrtc/ice-servers'),

  /** GET /api/room/info — public room info for the join screen. */
  roomInfo: () => request('/api/room/info')
};
