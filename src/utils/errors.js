/**
 * src/utils/errors.js
 * ───────────────────────────────────────────────────────────────────────
 * All "expected" application errors are created with this ApiError class,
 * so the central error handler knows what is safe to show the user
 * (status + message) versus an internal failure (500 → generic message).
 */

'use strict';

class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message user-facing message
   * @param {string} [code] machine-readable code the frontend can match on
   * @param {object} [details] extra info (e.g. validation fields)
   */
  constructor(status, message, code = 'error', details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true; // safe to show this message to the client
  }
}

const badRequest = (message, code = 'bad_request', details) => new ApiError(400, message, code, details);
const unauthorized = (message = 'Your session has expired — please join again', code = 'unauthorized') =>
  new ApiError(401, message, code);
const forbidden = (message = 'Not allowed', code = 'forbidden') => new ApiError(403, message, code);
const notFound = (message = 'Not found', code = 'not_found') => new ApiError(404, message, code);
const conflict = (message, code = 'conflict') => new ApiError(409, message, code);
const payloadTooLarge = (message, code = 'payload_too_large') => new ApiError(413, message, code);
const tooManyRequests = (message = 'Too many requests — try again later', code = 'rate_limited') =>
  new ApiError(429, message, code);

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  payloadTooLarge,
  tooManyRequests
};
