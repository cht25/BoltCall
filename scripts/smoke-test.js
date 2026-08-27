/**
 * scripts/smoke-test.js
 * ───────────────────────────────────────────────────────────────────────
 * সার্ভার নিজেই স্পন করে (PORT=3999) এবং মূল API এন্ডপয়েন্টগুলো চেক করে।
 *
 *   npm test
 *
 * চেক করা হয়: health, register, /auth/me, ice-servers, users/search,
 * conversation তৈরি, মেসেজ পাঠানো (REST fallback), মেসেজ হিস্ট্রি, mark-read।
 * শেষে সার্ভার বন্ধ করে পাস/ফেইল অনুযায়ী exit code দেয়।
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.SMOKE_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function parseCookies(response) {
  const headers = response.headers;
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
  return raw
    .map((c) => c.split(';')[0])
    .join('; ');
}

function csrfTokenFromCookie(cookie) {
  const match = /nexachat_csrf=([^;]+)/.exec(cookie || '');
  return match ? decodeURIComponent(match[1]) : null;
}

async function api(method, route, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) {
    headers.Cookie = cookie;
    // double-submit CSRF: client reads the csrf cookie and echoes it as a header
    const token = csrfTokenFromCookie(cookie);
    if (token) headers['X-CSRF-Token'] = token;
  }
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, cookie: parseCookies(res) };
}

function randomPhone() {
  const n = Math.floor(100000000 + Math.random() * 899999999);
  return `+1${n}`;
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* এখনও রেডি নয় */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function run() {
  console.log(`\nNexaChat smoke test → ${BASE}\n`);

  const server = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const healthy = await waitForHealth();
  if (!healthy) {
    console.error('Server did not become healthy in time.');
    server.kill('SIGKILL');
    process.exit(1);
  }
  console.log('  ✓ server started & /api/health responds\n');

  try {
    // 1) health
    const health = await api('GET', '/api/health');
    check('GET /api/health', health.status === 200 && health.json?.app === 'NexaChat', `status ${health.status}`);

    // 2) register user A
    const phoneA = randomPhone();
    const regA = await api('POST', '/api/auth/register', {
      body: { phone: phoneA, name: 'Smoke A', password: 'smokepass' }
    });
    check('POST /api/auth/register', regA.status === 201 && regA.json?.user?.id, `status ${regA.status}`);
    const cookieA = regA.cookie;
    check('register sets auth cookie', !!cookieA, 'no Set-Cookie');

    // 3) /auth/me
    const me = await api('GET', '/api/auth/me', { cookie: cookieA });
    check('GET /api/auth/me', me.status === 200 && me.json?.user?.phone === phoneA, `status ${me.status}`);

    // 4) ice-servers (never exposes Metered API key / apiKey field)
    const ice = await api('GET', '/api/webrtc/ice-servers', { cookie: cookieA });
    check('GET /api/webrtc/ice-servers', ice.status === 200 && Array.isArray(ice.json?.iceServers), `status ${ice.status}`);
    check('ice-servers never exposes apiKey field', !JSON.stringify(ice.json).includes('apiKey'), '');

    // 5) users/search
    const search = await api('GET', '/api/users/search?q=a', { cookie: cookieA });
    check('GET /api/users/search', search.status === 200 && Array.isArray(search.json?.users), `status ${search.status}`);

    // 6) register user B then create conversation A→B
    const phoneB = randomPhone();
    const regB = await api('POST', '/api/auth/register', { body: { phone: phoneB, name: 'Smoke B', password: 'smokepass' } });
    const cookieB = regB.cookie;
    const conv = await api('POST', '/api/conversations', { cookie: cookieA, body: { userId: regB.json.user.id } });
    check('POST /api/conversations', conv.status === 201 && conv.json?.conversation?.id, `status ${conv.status}`);
    const conversationId = conv.json?.conversation?.id;

    // 7) send message via REST (socket fallback path)
    const send = await api('POST', '/api/messages', {
      cookie: cookieA,
      body: { conversationId, type: 'text', content: 'Hello from smoke test 👋' }
    });
    check('POST /api/messages', send.status === 201 && send.json?.message?.id, `status ${send.status}`);

    // 8) fetch history
    const history = await api('GET', `/api/conversations/${conversationId}/messages`, { cookie: cookieA });
    check(
      'GET /api/conversations/:id/messages',
      history.status === 200 && Array.isArray(history.json?.messages) && history.json.messages.length >= 1,
      `status ${history.status}`
    );

    // 9) mark read
    const read = await api('POST', `/api/conversations/${conversationId}/read`, { cookie: cookieB });
    check('POST /api/conversations/:id/read', read.status === 200, `status ${read.status}`);

    // 10) unauthenticated request is rejected
    const noAuth = await api('GET', '/api/conversations');
    check('unauthenticated request rejected', noAuth.status === 401, `status ${noAuth.status}`);
  } catch (err) {
    check('test harness ran without throwing', false, err.message);
  } finally {
    server.kill('SIGKILL');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('All smoke tests passed ✅\n');
  process.exit(0);
}

run();
