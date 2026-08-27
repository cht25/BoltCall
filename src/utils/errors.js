/**
 * src/utils/errors.js
 * ───────────────────────────────────────────────────────────────────────
 * অ্যাপ্লিকেশনের সব "প্রত্যাশিত" error এই ApiError ক্লাস দিয়ে তৈরি হয়।
 * এতে করে error handler middleware সহজে বুঝতে পারে কোন error ব্যবহারকারীকে
 * দেখানো নিরাপদ (status + message) আর কোনটি internal (500 → generic message)।
 */

'use strict';

class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message ব্যবহারকারীকে দেখানোর উপযোগী বার্তা
   * @param {string} [code] মেশিন-রিডেবল কোড, frontend শর্ত মেলাতে পারে
   * @param {object} [details] অতিরিক্ত তথ্য (validation ফিল্ড ইত্যাদি)
   */
  constructor(status, message, code = 'error', details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true; // এই বার্তা client-কে দেখানো যাবে
  }
}

const badRequest = (message, code = 'bad_request', details) => new ApiError(400, message, code, details);
const unauthorized = (message = 'সেশন শেষ হয়ে গেছে, আবার লগইন করুন', code = 'unauthorized') =>
  new ApiError(401, message, code);
const forbidden = (message = 'এই কাজটি করার অনুমতি নেই', code = 'forbidden') => new ApiError(403, message, code);
const notFound = (message = 'পাওয়া যায়নি', code = 'not_found') => new ApiError(404, message, code);
const conflict = (message, code = 'conflict') => new ApiError(409, message, code);
const payloadTooLarge = (message, code = 'payload_too_large') => new ApiError(413, message, code);
const tooManyRequests = (message = 'অনেক বেশি রিকোয়েস্ট — কিছুক্ষণ পর চেষ্টা করুন', code = 'rate_limited') =>
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
