/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  BoltCall — WebRTC Signaling Server                         ║
 * ║  Express + Socket.IO + JWT Auth + PWA                       ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * এই সার্ভারটি WebRTC signaling, room management, file uploads,
 * password-based authentication, এবং PWA manifest serve করে।
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ─── Express অ্যাপ ও HTTP সার্ভার তৈরি ───────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Socket.IO তৈরি ─────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 20 * 1024 * 1024
});

const PORT = process.env.PORT || 3000;

// ─── Environment variables ───────────────────────────────────────
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'boltcall2024';
const JWT_SECRET      = process.env.JWT_SECRET      || 'fallback_secret_change_me';
const METERED_USERNAME   = process.env.METERED_USERNAME   || '';
const METERED_CREDENTIAL = process.env.METERED_CREDENTIAL || '';

// ─── In-memory token store (production-এ Redis ব্যবহার করুন) ─────
const validTokens = new Map();  // token → { createdAt }

// ═══════════════════════════════════════════════════════════════════
//  SIMPLE JWT-LIKE TOKEN SYSTEM (no external dependency needed)
// ═══════════════════════════════════════════════════════════════════

/**
 * একটি signed token তৈরি করে
 */
function createToken() {
  const payload = {
    id: uuidv4(),
    iat: Date.now()
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig    = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  const token  = `${header}.${body}.${sig}`;

  validTokens.set(token, { createdAt: Date.now() });
  return token;
}

/**
 * Token verify করে
 */
function verifyToken(token) {
  if (!token || !validTokens.has(token)) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${parts[0]}.${parts[1]}`).digest('base64url');

  return parts[2] === expectedSig;
}

// ═══════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Auth middleware — protected routes-এ token চেক করে
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized — অনুগ্রহ করে login করুন' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/login — Password দিয়ে login
 * Body: { password: string }
 * Returns: { token: string }
 */
app.post('/api/login', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password প্রয়োজন' });
  }

  if (password !== ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'ভুল password' });
  }

  const token = createToken();
  console.log('✅ নতুন login session তৈরি');
  res.json({ token });
});

/**
 * GET /api/verify — Token verify করে
 */
app.get('/api/verify', requireAuth, (req, res) => {
  res.json({ valid: true });
});

// ═══════════════════════════════════════════════════════════════════
//  PWA MANIFEST & SERVICE WORKER ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /manifest.json — PWA manifest dynamically serve করে
 */
app.get('/manifest.json', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  res.json({
    name: 'BoltCall',
    short_name: 'BoltCall',
    description: 'Encrypted P2P Video Calling & Chat',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#050510',
    theme_color: '#00f0ff',
    categories: ['communication', 'social'],
    icons: [
      {
        src: `${host}/icon-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: `${host}/icon-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ]
  });
});

/**
 * GET /pwa — Manual PWA install page
 */
app.get('/pwa', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pwa.html'));
});

// ═══════════════════════════════════════════════════════════════════
//  FILE UPLOAD
// ═══════════════════════════════════════════════════════════════════

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
    cb(null, true);
  } else {
    cb(new Error('শুধুমাত্র image ও audio ফাইল অনুমোদিত'), false);
  }
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024 } });

app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'কোনো ফাইল পাওয়া যায়নি' });
    const base64 = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;
    res.json({ success: true, dataUri, fileName: req.file.originalname, size: req.file.size });
  } catch (err) {
    res.status(500).json({ error: 'ফাইল আপলোড ব্যর্থ' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

const rooms = new Map();
const MAX_USERS_PER_ROOM = 6;

function createRoom() {
  const roomId = uuidv4().substring(0, 8);
  rooms.set(roomId, { id: roomId, createdAt: new Date(), users: new Map() });
  console.log(`🏠 নতুন room: ${roomId}`);
  return roomId;
}

// ── Protected API routes ──
app.post('/api/create-room', requireAuth, (req, res) => {
  const roomId = createRoom();
  res.json({ roomId });
});

app.get('/api/room/:id', requireAuth, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room পাওয়া যায়নি' });
  res.json({ roomId: room.id, userCount: room.users.size, createdAt: room.createdAt });
});

app.get('/api/ice-servers', requireAuth, (req, res) => {
  res.json(getIceServers());
});

// ═══════════════════════════════════════════════════════════════════
//  ICE SERVERS
// ═══════════════════════════════════════════════════════════════════

function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80',        username: METERED_USERNAME, credential: METERED_CREDENTIAL },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp',  username: METERED_USERNAME, credential: METERED_CREDENTIAL },
    { urls: 'turn:global.relay.metered.ca:443',       username: METERED_USERNAME, credential: METERED_CREDENTIAL },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: METERED_USERNAME, credential: METERED_CREDENTIAL }
  ];
}

// ═══════════════════════════════════════════════════════════════════
//  SOCKET.IO — Auth + Signaling + Chat
// ═══════════════════════════════════════════════════════════════════

/**
 * Socket.IO connection-level auth middleware
 * Client handshake-এ token পাঠাবে
 */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token && verifyToken(token)) {
    return next();
  }
  next(new Error('Authentication failed'));
});

io.on('connection', (socket) => {
  console.log(`🔌 সংযুক্ত: ${socket.id}`);

  let currentRoom = null;
  let currentUser = null;

  // ── Room Join ──
  socket.on('join-room', ({ roomId, userName: name }) => {
    let room = rooms.get(roomId);
    if (!room) {
      roomId = createRoom();
      room = rooms.get(roomId);
    }
    if (room.users.size >= MAX_USERS_PER_ROOM) {
      socket.emit('room-full', { roomId });
      return;
    }

    socket.join(roomId);
    currentRoom = roomId;
    currentUser = { id: socket.id, name: name || `User-${socket.id.substring(0, 4)}`, joinedAt: new Date() };
    room.users.set(socket.id, currentUser);

    console.log(`👤 ${currentUser.name} → Room ${roomId} (${room.users.size})`);

    socket.emit('room-joined', {
      roomId, userId: socket.id,
      users: Array.from(room.users.values()),
      iceServers: getIceServers()
    });

    socket.to(roomId).emit('user-joined', {
      userId: socket.id, userName: currentUser.name,
      users: Array.from(room.users.values())
    });
  });

  // ── WebRTC Signaling ──
  socket.on('offer',  ({ to, offer })  => { io.to(to).emit('offer',  { from: socket.id, offer }); });
  socket.on('answer', ({ to, answer }) => { io.to(to).emit('answer', { from: socket.id, answer }); });
  socket.on('ice-candidate', ({ to, candidate }) => { io.to(to).emit('ice-candidate', { from: socket.id, candidate }); });

  // ── Call Control ──
  socket.on('end-call',     ({ roomId }) => { socket.to(roomId).emit('call-ended', { from: socket.id }); });
  socket.on('audio-toggle', ({ roomId, muted })  => { socket.to(roomId).emit('user-audio-toggle', { userId: socket.id, muted }); });
  socket.on('video-toggle', ({ roomId, enabled }) => { socket.to(roomId).emit('user-video-toggle', { userId: socket.id, enabled }); });

  // ── Chat Messages ──
  socket.on('chat-message', ({ roomId, message, userName: name }) => {
    io.to(roomId).emit('chat-message', {
      id: uuidv4(), type: 'text', from: socket.id,
      userName: name || 'Anonymous', message,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('voice-message', ({ roomId, audioData, userName: name, duration }) => {
    io.to(roomId).emit('chat-message', {
      id: uuidv4(), type: 'voice', from: socket.id,
      userName: name || 'Anonymous', audioData,
      duration: duration || 0, timestamp: new Date().toISOString()
    });
  });

  socket.on('image-message', ({ roomId, imageData, caption, userName: name }) => {
    io.to(roomId).emit('chat-message', {
      id: uuidv4(), type: 'image', from: socket.id,
      userName: name || 'Anonymous', imageData,
      caption: caption || '', timestamp: new Date().toISOString()
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', (reason) => {
    console.log(`🔌 বিচ্ছিন্ন: ${socket.id} (${reason})`);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.users.delete(socket.id);
        socket.to(currentRoom).emit('user-left', { userId: socket.id, userName: currentUser?.name, users: Array.from(room.users.values()) });
        if (room.users.size === 0) {
          setTimeout(() => {
            const r = rooms.get(currentRoom);
            if (r && r.users.size === 0) rooms.delete(currentRoom);
          }, 5 * 60 * 1000);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PERIODIC CLEANUP
// ═══════════════════════════════════════════════════════════════════

setInterval(() => {
  const now = Date.now();
  // পুরনো rooms পরিষ্কার
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && (now - room.createdAt.getTime()) > 30 * 60 * 1000) {
      rooms.delete(id);
    }
  }
  // পুরনো tokens পরিষ্কার (24 ঘণ্টা)
  for (const [token, data] of validTokens) {
    if (now - data.createdAt > 24 * 60 * 60 * 1000) {
      validTokens.delete(token);
    }
  }
}, 10 * 60 * 1000);

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), rooms: rooms.size });
});

// ═══════════════════════════════════════════════════════════════════
//  SERVER START
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  ⚡ BoltCall Server চালু হয়েছে!             ║
  ║  🌐 Port: ${String(PORT).padEnd(36)}║
  ║  🔐 Auth: Password-protected                ║
  ║  📱 PWA:  /pwa                              ║
  ╚══════════════════════════════════════════════╝
  `);
});

// ── Graceful shutdown ──
process.on('SIGTERM', () => { io.close(() => server.close(() => process.exit(0))); });
process.on('SIGINT',  () => { io.close(() => server.close(() => process.exit(0))); });
