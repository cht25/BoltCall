/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  BoltCall — server.js (entry point)                                  ║
 * ║  Express + Socket.IO + WebRTC signaling (single group-call room)     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Boot order:
 *   1) HTTP server + Socket.IO (same port)
 *   2) Express app attached
 *   3) listen on PORT (process.env.PORT first — Render requires it),
 *      falling back to 3000, host 0.0.0.0
 *   4) graceful shutdown on SIGTERM/SIGINT
 *
 * There is no database: the room lives in memory. Deploy as a single
 * instance (render.yaml already sets numInstances: 1).
 */

'use strict';

const http = require('http');
const { Server } = require('socket.io');

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { createApp } = require('./src/app');
const { attachSocketServer } = require('./src/sockets');

function bootstrap() {
  // ── 1+2) HTTP + Socket.IO ────────────────────────────────────────────
  const httpServer = http.createServer();

  const io = new Server(httpServer, {
    // Frontend is served from the same origin, so cross-origin requests are
    // not needed (Socket.IO rejects foreign origins by default). CORS_ORIGIN
    // overrides when the frontend is hosted elsewhere.
    cors: {
      ...(config.corsOrigins.length ? { origin: config.corsOrigins } : {}),
      credentials: true
    },
    // signaling payloads are small (SDP/ICE/candidates/chat)
    maxHttpBufferSize: 1e6,
    pingTimeout: 25000,
    pingInterval: 20000,
    // reconnect quickly and reliably
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false
    }
  });

  const app = createApp({ io });
  httpServer.on('request', app);

  attachSocketServer(io);

  // ── 3) listen ───────────────────────────────────────────────────────
  httpServer.listen(config.port, '0.0.0.0', () => {
    logger.success(`BoltCall running → http://0.0.0.0:${config.port}  (env: ${config.env})`);
    logger.info(`Room: ${config.room.name} · member name: ${config.room.memberName} · max ${config.room.maxParticipants} participants`);
    if (!config.metered.apiKey && !config.metered.turnUsername) {
      logger.warn(
        'No Metered TURN credentials — calls will only connect on easy NAT. Set METERED_API_KEY + METERED_DOMAIN in .env.'
      );
    }
  });

  // ── 4) Graceful shutdown ────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[server] ${signal} — shutting down...`);

    io.close();
    httpServer.close(() => {
      logger.success('[server] clean shutdown complete');
      process.exit(0);
    });

    // force-exit if something refuses to close within 10s
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── unexpected errors: log, keep the process alive (uptime) ─────────
  process.on('unhandledRejection', (reason) => {
    logger.error('[process] unhandledRejection:', reason && (reason.stack || reason.message || reason));
  });
  process.on('uncaughtException', (err) => {
    logger.error('[process] uncaughtException:', err && (err.stack || err.message));
  });

  return { app, io, httpServer };
}

// Boot when run directly (not when required — for tests)
if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap };
