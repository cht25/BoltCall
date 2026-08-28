/**
 * src/app.js
 * ───────────────────────────────────────────────────────────────────────
 * Express application factory — middleware, static serving and the tiny
 * REST API. The HTTP server + Socket.IO bootstrap lives in server.js.
 *
 * Middleware order (security-relevant):
 *   helmet → cors → cookie parser → body parser → rate limit → CSRF
 *   → /api routes → static → 404 → error handler
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
const { csrfProtection } = require('./middleware/csrf');
const { generalLimiter } = require('./middleware/rate-limit');
const { notFoundHandler, errorHandler } = require('./middleware/error-handler');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ io }) {
  const app = express();

  // Behind Render/Nginx the client IP & protocol come from proxy headers.
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ═══════════════════════════════════════════════════════════════════
  //  Socket.IO is attached to the same HTTP server BEFORE this Express
  //  app (see server.js), so its request handler runs first. Express
  //  must stay COMPLETELY silent for every /socket.io/* request: the
  //  engine answers asynchronously (polling handshakes write headers on
  //  a later tick), so any Express response here would race it and
  //  produce "headers already sent" errors. Unknown sub-paths get their
  //  4xx from the engine itself.
  // ═══════════════════════════════════════════════════════════════════
  app.use((req, res, next) => {
    if (req.url.startsWith('/socket.io')) return;
    next();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  1) Security headers (Helmet + CSP)
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          // no inline <script> is used anywhere
          scriptSrc: ["'self'"],
          // element.style / style attributes are used → inline styles allowed
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:', 'data:'],
          // Socket.IO (ws/wss) and our own API
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: config.frameAncestors,
          upgradeInsecureRequests: config.isProduction ? [] : null
        }
      },
      // allow iframe embedding (dev preview) outside production
      frameguard: config.isProduction ? { action: 'sameorigin' } : false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  2) CORS — by default the frontend is served from this same origin;
  //     CORS_ORIGIN empty ⇒ origin is reflected.
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    cors({
      // Same-origin by default (no CORS headers needed at all).
      // CORS_ORIGIN enables explicit cross-origin frontends.
      origin: config.corsOrigins.length ? config.corsOrigins : false,
      credentials: true, // cookie-based session
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  3) Body/cookie parsing
  // ═══════════════════════════════════════════════════════════════════
  app.use(cookieParser());
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // ═══════════════════════════════════════════════════════════════════
  //  4) API: rate limit + CSRF + routes
  // ═══════════════════════════════════════════════════════════════════
  app.use('/api', generalLimiter, csrfProtection, createApiRouter({ io }));

  // ═══════════════════════════════════════════════════════════════════
  //  5) PWA manifest (dynamic — works on any domain)
  // ═══════════════════════════════════════════════════════════════════
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').json({
      name: 'BoltCall',
      short_name: 'BoltCall',
      description: 'BoltCall — one shared group call with audio, video, screen sharing and text chat',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#04060d',
      theme_color: '#04070d',
      categories: ['communication'],
      icons: [
        { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6) Frontend static files
  // ═══════════════════════════════════════════════════════════════════
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        // never cache the service worker, or updates get stuck
        if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      }
    })
  );

  // ═══════════════════════════════════════════════════════════════════
  //  7) Shareable call links — /call/:name?={timestamp}
  //     Anyone opening one lands on the app; with a valid session they
  //     drop straight into the call, otherwise they see the join gate.
  // ═══════════════════════════════════════════════════════════════════
  const sendIndex = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) next(err);
    });
  };
  app.get(['/call', '/call/*'], sendIndex);

  // ═══════════════════════════════════════════════════════════════════
  //  8) 404 (API) and SPA fallback
  // ═══════════════════════════════════════════════════════════════════
  app.use(notFoundHandler);
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    sendIndex(req, res, next);
  });

  app.use(errorHandler);

  logger.info('[app] BoltCall Express app ready');
  return app;
}

module.exports = { createApp, PUBLIC_DIR };
