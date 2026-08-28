# ⚡ BoltCall

**One password. One group call. Everyone together.**

BoltCall is a single shared group-call room — not a messenger, not a
WhatsApp-style contact app. Anyone who knows the room password is dropped
**straight into the group call** with everyone else. There are no
accounts, no contact lists, and **no names**: every participant appears
as **`thamjj13`**.

Built on WebRTC (full mesh) + Socket.IO + Express. No database — the room
lives in memory.

## Features

- 🔑 **Password gate** — enter the room password and you're in. No
  signup, no name field, no "start call" button.
- 🎙️ **Voice calling, both directions** — full-duplex audio over P2P.
- 📹 **Video calling, both directions** — see everyone, everyone sees you.
- 🖥️ **Screen sharing, both directions** — camera and screen are
  independent tracks, so you can share your screen *and* keep your camera
  on, and receive other people's screens the same way.
- 💬 **Text chat** — a room chat panel; late joiners receive the session
  history.
- 🏷️ **Everyone is "thamjj13"** — the name is server-enforced; the local
  tile gets only a small *you* badge so you can find yourself in the grid.
- 🔒 Hardened basics: bcrypt-able room password, JWT httpOnly session
  cookie, CSRF double-submit, rate limiting, helmet/CSP, authenticated
  sockets, no TURN secrets in the browser.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

In development the default room password is **`boltcall`** (shown as a
hint on the join screen). To set your own:

```bash
cp .env.example .env
# set ROOM_PASSWORD (plain) or ROOM_PASSWORD_HASH (bcrypt)
npm start
```

Open the URL in two browsers (or a regular + incognito window), enter the
password in both, and you'll see each other instantly — audio, video,
screen share and chat all work in both directions.

> 📷 Camera, microphone and screen capture require a **secure context**:
> HTTPS, or localhost. For friends on other networks, set up TURN (below).

## How it works

```
┌─────────┐   signaling + chat + presence (Socket.IO)   ┌─────────┐
│ Member  │ ──────────────────────────────────────────▶ │ Server  │
│   A     │ ◀────────────────────────────────────────── │ (room)  │
└────┬────┘                                             └────┬────┘
     │                 WebRTC media (P2P mesh)              │
     ├────────────── audio / video / screen ───────────────▶│
     │◀─────────────────────────────────────────────────────┤
     │                     …to every other member…         │
     └──────────────────────────┬───────────────────────────┘
                                ▼
                        ┌─────────────┐
                        │  Member B   │
                        └─────────────┘
```

- **Join flow** — `POST /api/auth/join` checks the password
  (constant-time) and issues a signed JWT in an httpOnly cookie. The
  client then connects the socket, grabs the microphone/camera and
  immediately joins the room — no extra steps.
- **Mesh** — every pair of participants holds one `RTCPeerConnection`.
  Transceiver order is fixed (`0` audio · `1` camera · `2` screen), which
  makes track routing unambiguous in both directions. Negotiation uses the
  *perfect negotiation* pattern with the smaller member id initiating the
  first connection; watchdogs re-arm lost offers and rebuild failed
  connections.
- **Room state** — the server keeps the roster + media flags
  (`mic`/`cam`/`screen`) + the last chat messages in memory and broadcasts
  snapshots on every change, so joining late still shows everyone and the
  history.
- **Signaling** — the server only relays SDP/ICE between members
  (validated, rate-limited). Media never touches the server.

## Configuration

All settings live in `.env` — see [`.env.example`](.env.example). The
important ones:

| Variable | Purpose |
| --- | --- |
| `ROOM_PASSWORD` / `ROOM_PASSWORD_HASH` | the room password (plain or bcrypt hash; required in production) |
| `ROOM_NAME` | displayed room name (default `boltcall-room`) |
| `MEMBER_NAME` | the label shown for **every** participant (default `thamjj13`) |
| `MAX_PARTICIPANTS` | soft cap for the mesh (default 24) |
| `SESSION_SECRET` | JWT signing secret (required in production) |
| `METERED_API_KEY` + `METERED_DOMAIN` | TURN for reliable calls across strict NATs |
| `MAX_MESSAGE_LENGTH`, `CHAT_HISTORY_SIZE` | chat policy |

Generate a bcrypt hash for the password:

```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

## Testing

```bash
npm test
```

The smoke test boots the real server and verifies the whole flow with
socket clients: room info, wrong-password rejection, join + cookies,
CSRF, ICE gating, authenticated sockets, roster sync, signaling relay in
both directions, media-state broadcast, chat broadcast + history replay,
peer-left cleanup and logout.

## Deploying

- **Render**: the repo ships a [`render.yaml`](render.yaml) blueprint.
  Set `ROOM_PASSWORD` (or `ROOM_PASSWORD_HASH`), `SESSION_SECRET` and
  optionally Metered TURN credentials in the dashboard.
- **Anywhere**: it's a plain Node app — `npm start` behind any HTTPS
  reverse proxy. WebSockets (`/socket.io/*`) must be proxied through.
- **Single instance only** — the roster is in-memory. If you need to
  scale out, swap `src/services/room.js` for a Redis-backed
  implementation and keep the same interface.
- For reliable calls across strict firewalls/NATs, configure TURN
  ([Metered.ca](https://www.metered.ca/tools/openrelay/) has a free tier).
  Without it, calls work on most networks via STUN/host candidates but
  may fail between hardened networks.

## Project layout

```
server.js                  entry point (HTTP + Socket.IO, graceful shutdown)
src/
  config.js                all env vars, validated once
  app.js                   Express factory (helmet/CSP, CSRF, routes)
  routes/
    auth.js                join (password → JWT), me, logout
    webrtc.js              GET /api/webrtc/ice-servers
    index.js               health, room info, wiring
  sockets/index.js         room lifecycle: roster, signaling relay, chat,
                           media-state broadcast
  services/
    room.js                in-memory room: participants, media flags, history
    ice.js                 Metered STUN/TURN credentials (never leaked)
    tokens.js              JWT session helpers
  middleware/              auth, csrf, rate-limit, error-handler
public/
  index.html · style.css   join screen + call room UI
  js/
    app.js                 orchestration (join → media → socket → mesh)
    peers.js               WebRTC mesh (perfect negotiation + watchdogs)
    media.js               mic/cam/screen devices, toggles
    ui.js                  tiles, chat, toasts, controls
    api.js · utils.js      REST + small helpers
scripts/smoke-test.js      end-to-end tests (npm test)
```

## Notes & limits

- The mesh costs `n × (n−1)` peer connections in total — fine for a
  group of friends, a class or a standup. Very large rooms (> 12–16
  participants) are better served by an SFU; the room cap exists for that
  reason.
- Chat history and roster reset when the server restarts. JWT sessions
  survive restarts (same `SESSION_SECRET`).
- Browsers label shared-tab audio as unavailable in this build (screen is
  shared as video; voice keeps flowing through the microphone).
