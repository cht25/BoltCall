/**
 * src/app.js
 * ───────────────────────────────────────────────────────────────────────
 * Express অ্যাপ্লিকেশন ফ্যাক্টরি — সব middleware, static serving ও REST
 * route এখানে যুক্ত হয়। HTTP সার্ভার/Socket.IO বুটস্ট্র্যাপ আছে server.js-এ।
 *
 * Middleware ক্রম (ক্রমটি নিরাপত্তার জন্য গুরুত্বপূর্ণ):
 *   helmet → cors → cookie parser → body parser → rate limit → CSRF
 *   → static → /api routes → 404 → error handler
 */

'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./utils/logger');
const { createApiRouter } = require('./routes');
const { requireAuth } = require('./middleware/auth');
const { csrfProtection } = require('./middleware/csrf');
const { generalLimiter } = require('./middleware/rate-limit');
const { notFoundHandler, errorHandler } = require('./middleware/error-handler');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ io }) {
  const app = express();

  // Render/Nginx-এর পেছনে থাকলে client IP ও protocol proxy header থেকে নিতে হয়
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ═══════════════════════════════════════════════════════════════════
  //  ১) নিরাপত্তা হেডার (Helmet + CSP)
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          // কোনো inline <script> ব্যবহার করা হয়নি → 'unsafe-inline' লাগে না
          scriptSrc: ["'self'"],
          // element.style / style attribute ব্যবহারের জন্য inline style অনুমোদিত
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:', 'data:'],
          // Socket.IO (ws/wss) ও নিজের API
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: config.frameAncestors,
          upgradeInsecureRequests: config.isProduction ? [] : null
        }
      },
      // iframe (dev preview) ব্লক না করার জন্য production ছাড়া frameguard বন্ধ
      frameguard: config.isProduction ? { action: 'sameorigin' } : false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  ২) CORS — ডিফল্টভাবে frontend একই origin থেকে serve হয়, তাই
  //     CORS_ORIGIN খালি থাকলে request-এর নিজের origin প্রতিফলিত হয়।
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : true,
      credentials: true, // cookie-based session-এর জন্য অপরিহার্য
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  ৩) Body/cookie parsing
  // ═══════════════════════════════════════════════════════════════════
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' })); // মিডিয়া multipart-এ যায়, JSON-এ নয়
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // ═══════════════════════════════════════════════════════════════════
  //  ৪) API: rate limit + CSRF + route
  // ═══════════════════════════════════════════════════════════════════
  app.use('/api', generalLimiter, csrfProtection, createApiRouter({ io }));

  // ═══════════════════════════════════════════════════════════════════
  //  ৫) আপলোড করা মিডিয়া — শুধু লগইন করা ইউজারের জন্য
  //     (URL অনুমানযোগ্য না হলেও authentication বাড়তি সুরক্ষা)
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    '/uploads',
    requireAuth,
    express.static(config.upload.dir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      immutable: true,
      setHeaders(res, filePath) {
        // ব্রাউজারকে MIME অনুমান করতে দেওয়া হয় না (XSS প্রতিরোধ)
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // ডকুমেন্ট সবসময় ডাউনলোড হিসেবে যায়, কখনো inline render নয়
        if (filePath.includes(`${path.sep}files${path.sep}`)) {
          res.setHeader('Content-Disposition', 'attachment');
        }
      }
    })
  );
  // ফাইল না পেলে SPA fallback-এ না গিয়ে সরাসরি 404
  app.use('/uploads', (req, res) => {
    res.status(404).json({ error: 'ফাইল পাওয়া যায়নি', code: 'file_not_found' });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ৬) PWA manifest (dynamic — যাতে যেকোনো ডোমেইনে কাজ করে)
  // ═══════════════════════════════════════════════════════════════════
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').json({
      name: 'NexaChat',
      short_name: 'NexaChat',
      description: 'NexaChat — real-time messaging with audio & video calling',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#070a13',
      theme_color: '#0bdcc8',
      categories: ['communication', 'social'],
      icons: [
        { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ৭) Frontend static ফাইল
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        // service worker কখনো ক্যাশ করা যাবে না, নাহলে আপডেট আটকে যায়
        if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      }
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  ৮) 404 (API) ও SPA fallback
  // ═══════════════════════════════════════════════════════════════════
  app.use(notFoundHandler);
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  app.use(errorHandler);

  logger.info('[app] Express অ্যাপ্লিকেশন প্রস্তুত');
  return app;
}

module.exports = { createApp, PUBLIC_DIR };
