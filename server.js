/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  NexaChat — server.js (এন্ট্রি পয়েন্ট)                              ║
 * ║  Express + Socket.IO + SQLite + WebRTC signaling                    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * বুট ক্রম:
 *   ১) ডাটাবেস init (স্কিমা তৈরি — হাতে কোনো SQL চালাতে হয় না)
 *   ২) আপলোড ডিরেক্টরি তৈরি
 *   ৩) Express অ্যাপ তৈরি (src/app.js)
 *   ৪) HTTP সার্ভার + Socket.IO সংযুক্ত (একই পোর্টে)
 *   ৫) PORT-এ listen — process.env.PORT অগ্রাধিকার পায় (Render-এর জন্য
 *      অপরিহার্য), না থাকলে 3000। host 0.0.0.0 যাতে কনটেইনারের বাইরে থেকে
 *      অ্যাক্সেস করা যায়।
 *   ৬) SIGTERM/SIGINT-এ graceful shutdown (socket বন্ধ, DB বন্ধ)
 */

'use strict';

const http = require('http');
const { Server } = require('socket.io');

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { initDatabase, getDb, closeDatabase } = require('./database');
const { createApp } = require('./src/app');
const { ensureUploadDirs } = require('./src/services/uploads');
const { attachSocketServer } = require('./src/sockets');

async function bootstrap() {
  // ── ১) ডাটাবেস ─────────────────────────────────────────────────
  await initDatabase();

  // ── ২) মিডিয়া ডিরেক্টরি ────────────────────────────────────────
  ensureUploadDirs();

  // ── ৩+৪) HTTP + Socket.IO ─────────────────────────────────────
  const httpServer = http.createServer();

  const io = new Server(httpServer, {
    // frontend একই origin থেকে আসে; CORS_ORIGIN দিলে সেগুলোই অনুমোদিত
    cors: {
      origin: config.corsOrigins.length ? config.corsOrigins : true,
      credentials: true
    },
    // signaling ছোট payload; বড় মিডিয়া HTTP আপলোডে যায়
    maxHttpBufferSize: 1e6,
    pingTimeout: 25000,
    pingInterval: 20000,
    // reconnect যেন দ্রুত ও নির্ভরযোগ্য হয়
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false
    }
  });

  const app = createApp({ io });
  httpServer.on('request', app);

  attachSocketServer(io);

  // ── ৫) listen ─────────────────────────────────────────────────
  await new Promise((resolve) => httpServer.listen(config.port, '0.0.0.0', resolve));

  logger.success(`NexaChat চলছে → http://0.0.0.0:${config.port}  (env: ${config.env})`);
  logger.info(`ডাটাবেস: ${config.db.path}`);
  logger.info(`আপলোড ডিরেক্টরি: ${config.upload.dir} (সর্বোচ্চ ${config.upload.maxFileSizeMb}MB)`);
  if (!config.metered.apiKey && !config.metered.turnUsername) {
    logger.warn(
      'Metered TURN credential নেই — কল শুধু সহজ NAT-এ কাজ করবে। .env-এ METERED_API_KEY + METERED_DOMAIN দিন।'
    );
  }
  if (!config.isProduction) {
    logger.info('ডেমো অ্যাকাউন্ট তৈরি করতে: npm run seed');
  }

  // ── ৬) Graceful shutdown ──────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[server] ${signal} — বন্ধ করা হচ্ছে...`);

    // সব socket ইউজারকে offline চিহ্নিত করা (presence পরিষ্কার রাখা)
    try {
      await getDb().users.markAllOffline();
    } catch (err) {
      logger.warn('[server] presence রিসেট ব্যর্থ:', err.message);
    }

    io.close();
    httpServer.close(async () => {
      await closeDatabase();
      logger.success('[server] পরিষ্কারভাবে বন্ধ হয়েছে');
      process.exit(0);
    });

    // ১০ সেকেন্ডেও বন্ধ না হলে জোর করে বন্ধ
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── অপ্রত্যাশিত error: লগ করা হয়, প্রসেস টিকে থাকে (uptime রক্ষা) ──
  process.on('unhandledRejection', (reason) => {
    logger.error('[process] unhandledRejection:', reason && (reason.stack || reason.message || reason));
  });
  process.on('uncaughtException', (err) => {
    logger.error('[process] uncaughtException:', err && (err.stack || err.message));
  });

  return { app, io, httpServer };
}

// সরাসরি চালানো হলে বুট করা হয় (require করলে নয় — টেস্টের সুবিধা)
if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error('[server] বুট ব্যর্থ:', err && (err.stack || err.message));
    process.exit(1);
  });
}

module.exports = { bootstrap };
