/**
 * scripts/smoke-test.js — end-to-end smoke test for BoltCall.
 *
 * Boots the real server on an ephemeral port and drives it with two
 * Socket.IO clients + fetch, verifying the full room flow:
 *
 *   1. REST: room info, wrong-password rejection, join, session, CSRF
 *   2. Socket: authenticated connection, room:init snapshot, roster sync
 *   3. Signaling relay: offer/answer/ICE between two members
 *   4. Media state broadcast
 *   5. Text chat broadcast + history replay for newcomers
 *   6. Peer-left cleanup
 *
 * Run with:  npm test
 */

'use strict';

// Set the room password BEFORE config is loaded (config reads env once).
process.env.ROOM_PASSWORD = 'boltcall-test-pass';

const assert = require('assert');
const http = require('http');
const { io: createClient } = require('socket.io-client');
const { Server } = require('socket.io');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { attachSocketServer } = require('../src/sockets');

const PORT = 4311 + Math.floor(Math.random() * 1000);

let io;
let base;

function once(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function fetchJson(path, { method = 'GET', body, token, csrf, cookie, csrfCookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) {
    headers.Cookie = `${config.cookieName}=${cookie}${csrfCookie ? `; ${config.csrfCookieName}=${csrfCookie}` : ''}`;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload, res };
}

function readCookie(res, name) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const cookie of setCookies) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.split(';')[0].slice(name.length + 1);
    }
  }
  return null;
}

function makeClient(cookie) {
  // default transports (polling first, upgrade to websocket) — this
  // exercises the polling handshake path on the server as well
  return createClient(base, {
    reconnection: false,
    forceNew: true,
    extraHeaders: cookie ? { Cookie: `${config.cookieName}=${cookie}` } : {}
  });
}

async function run() {
  console.log(`\n▶ BoltCall smoke test on port ${PORT}\n`);

  // ══════════════════════════ boot ════════════════════════════════════
  const httpServer = http.createServer();
  io = new Server(httpServer, { cors: { origin: false } });
  httpServer.on('request', createApp({ io }));
  attachSocketServer(io);
  await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${PORT}`;

  try {
    // ── 1) public room info ───────────────────────────────────────────
    let r = await fetchJson('/api/room/info');
    assert.equal(r.status, 200);
    assert.equal(r.payload.memberName, 'thamjj13');
    assert.equal(r.payload.name, config.room.name);
    assert.ok('devPassword' in r.payload, 'room info must expose the devPassword field');
    assert.equal(r.payload.devPassword, null, 'dev hint must not leak when a password is set');
    console.log('✅ room info (memberName = thamjj13)');

    // ── 1b) shareable call link serves the app ────────────────────────
    const page = await fetch(`${base}/call/thamjj13?=1724947200000`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('id="appLoader"'), 'call link must serve the app shell');
    console.log('✅ share link /call/thamjj13?={ts} serves the app');

    // ── 2) wrong password rejected ────────────────────────────────────
    r = await fetchJson('/api/auth/join', { method: 'POST', body: { password: 'wrong-password' } });
    assert.equal(r.status, 401);
    assert.equal(r.payload.code, 'invalid_password');
    console.log('✅ wrong password → 401');

    // ── 3) correct password joins ─────────────────────────────────────
    r = await fetchJson('/api/auth/join', { method: 'POST', body: { password: 'boltcall-test-pass' } });
    assert.equal(r.status, 200);
    const cookieA = readCookie(r.res, config.cookieName);
    const csrfA = readCookie(r.res, config.csrfCookieName);
    assert.ok(cookieA, 'auth cookie set');
    assert.ok(csrfA, 'csrf cookie set');
    assert.equal(r.payload.member.name, 'thamjj13');
    console.log('✅ member A joined (cookie + csrf issued)');

    // ── 4) /me validates the session ──────────────────────────────────
    r = await fetchJson('/api/auth/me', { token: cookieA });
    assert.equal(r.status, 200);
    assert.equal(r.payload.member.name, 'thamjj13');
    console.log('✅ /me returns the session');

    // ── 5) CSRF enforced for state-changing requests ──────────────────
    r = await fetchJson('/api/auth/logout', {
      method: 'POST',
      csrf: 'bogus',
      cookie: cookieA,
      csrfCookie: csrfA
    });
    assert.equal(r.status, 403, 'logout with a session cookie but invalid CSRF must be rejected');
    console.log('✅ CSRF protection active');

    // ── 6) ICE servers require the session ────────────────────────────
    r = await fetchJson('/api/webrtc/ice-servers');
    assert.equal(r.status, 401);
    r = await fetchJson('/api/webrtc/ice-servers', { token: cookieA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload.iceServers));
    console.log('✅ ICE servers gated by session');

    // ── 7) socket A connects and gets the room snapshot ───────────────
    const a = makeClient(cookieA);
    const initA = once(a, 'room:init');
    await once(a, 'connect');
    const initData = await initA;
    assert.equal(initData.memberName, 'thamjj13');
    assert.equal(initData.snapshot.participants.length, 1);
    const memberA = initData.selfId;
    console.log('✅ socket A in room (roster size 1)');

    // ── 8) unauthenticated socket is rejected ─────────────────────────
    const intruder = createClient(null);
    const intruderError = once(intruder, 'connect_error');
    await intruderError;
    intruder.close();
    console.log('✅ unauthenticated socket rejected');

    // ── 9) member B joins; both sockets see the roster grow ───────────
    r = await fetchJson('/api/auth/join', { method: 'POST', body: { password: 'boltcall-test-pass' } });
    const cookieB = readCookie(r.res, config.cookieName);
    const b = makeClient(cookieB);
    // subscribe to A's roster update BEFORE B connects (the broadcast
    // can arrive at A while B's own init is still in flight)
    const stateOnA = once(a, 'room:state');
    const initB = once(b, 'room:init');
    await once(b, 'connect');
    const initDataB = await initB;
    assert.equal(initDataB.snapshot.participants.length, 2);
    const memberB = initDataB.selfId;
    assert.notEqual(memberA, memberB);

    const roster = (await stateOnA).snapshot.participants;
    assert.equal(roster.length, 2);
    console.log('✅ B joined — both rosters show 2 participants');

    // ── 10) signaling relay A → B (offer / answer / ice) ──────────────
    const offerOnB = once(b, 'webrtc:offer');
    a.emit('webrtc:offer', { target: memberB, sdp: { type: 'offer', sdp: 'v=0 test' } });
    const offer = await offerOnB;
    assert.equal(offer.from, memberA);
    assert.equal(offer.sdp.type, 'offer');

    const answerOnA = once(a, 'webrtc:answer');
    b.emit('webrtc:answer', { target: memberA, sdp: { type: 'answer', sdp: 'v=0 test' } });
    const answer = await answerOnA;
    assert.equal(answer.from, memberB);

    const iceOnB = once(b, 'webrtc:ice');
    a.emit('webrtc:ice', { target: memberB, candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host' } });
    await iceOnB;
    console.log('✅ signaling relayed in both directions');

    // ── 11) media state broadcast ─────────────────────────────────────
    const mediaOnB = once(b, 'media:state');
    a.emit('media:state', { mic: false, cam: true, screen: true });
    const mediaUpdate = await mediaOnB;
    assert.equal(mediaUpdate.memberId, memberA);
    assert.equal(mediaUpdate.mic, false);
    assert.equal(mediaUpdate.screen, true);
    console.log('✅ media state broadcast');

    // ── 12) chat broadcast + history replay ───────────────────────────
    const chatOnB = once(b, 'chat:receive');
    a.emit('chat:send', { text: 'hello everyone' });
    const chatMessage = await chatOnB;
    assert.equal(chatMessage.text, 'hello everyone');
    assert.equal(chatMessage.senderName, 'thamjj13');
    assert.equal(chatMessage.senderId, memberA);
    console.log('✅ chat broadcast (sender = thamjj13)');

    // empty message rejected
    const rejected = once(a, 'chat:rejected');
    a.emit('chat:send', { text: '   ' });
    await rejected;
    console.log('✅ empty chat message rejected');

    // third member sees history on join
    r = await fetchJson('/api/auth/join', { method: 'POST', body: { password: 'boltcall-test-pass' } });
    const cookieC = readCookie(r.res, config.cookieName);
    const c = makeClient(cookieC);
    // subscribe to A's roster update BEFORE C connects
    const stateOnJoin = once(a, 'room:state');
    const initC = once(c, 'room:init');
    await once(c, 'connect');
    const initDataC = await initC;
    assert.equal(initDataC.snapshot.participants.length, 3);
    assert.ok(initDataC.snapshot.history.some((m) => m.text === 'hello everyone'));
    console.log('✅ history replayed to a late joiner');

    // consume the room:state broadcast C's join caused on A
    await stateOnJoin;

    // ── 13) peer leaves → everyone is notified ────────────────────────
    const leftOnA = once(a, 'peer:left');
    const stateAfter = once(a, 'room:state');
    c.close();
    const left = await leftOnA;
    assert.equal(left.memberId, initDataC.selfId);
    const rosterAfter = (await stateAfter).snapshot.participants;
    assert.equal(rosterAfter.length, 2);
    console.log('✅ peer-left cleanup');

    // ── 14) a second tab of member A takes over the connection ────────
    const a2 = makeClient(cookieA);
    const kickedReason = once(a, 'disconnect');
    const initA2 = once(a2, 'room:init');
    await once(a2, 'connect');
    const reason = await kickedReason;
    assert.equal(reason, 'io server disconnect', 'the older tab must be kicked');
    const rosterA2 = (await initA2).snapshot.participants;
    assert.equal(rosterA2.length, 2, 'the roster must still count the member once');
    a.close();
    a2.close();
    console.log('✅ second tab takes over cleanly');

    // ── 15) logout clears the session cookie ──────────────────────────
    r = await fetchJson('/api/auth/logout', {
      method: 'POST',
      csrf: csrfA,
      cookie: cookieA,
      csrfCookie: csrfA
    });
    assert.equal(r.status, 200);
    const cleared = r.res.headers.getSetCookie().some((c) =>
      c.startsWith(`${config.cookieName}=;`) || c.includes('Expires=Thu, 01 Jan 1970')
    );
    assert.ok(cleared, 'logout must clear the auth cookie');
    console.log('✅ logout clears the session');

    a.close();
    b.close();

    console.log('\n🎉 All smoke tests passed.\n');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n❌ Smoke test failed:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

run();
