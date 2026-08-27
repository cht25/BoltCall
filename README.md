# NexaChat

> Fast, private, WhatsApp-style real-time messaging with **1-on-1 WebRTC audio/video calls**, voice notes, an in-browser image editor, and document sharing — built as a single production-ready full-stack app.

NexaChat is a complete from-scratch implementation: phone-number registration with bcrypt-hashed credentials, JWT-in-cookie session auth, a SQLite database (swappable to MongoDB), a REST API, real-time Socket.IO messaging (typing, delivery/read receipts, reply, edit, delete-for-me/everyone), validated media upload, clipboard-paste + Canvas image editing, `MediaRecorder` voice messages, and peer-to-peer calling over Metered.ca STUN/TURN.

The UI is a dark cyberpunk glassmorphism SPA — no framework, no build step. All code is plain ES modules served statically; all important sections carry Bengali comments while identifiers stay in English.

---

## Table of contents

- [Features](#features)
- [Architecture overview](#architecture-overview)
- [Project tree](#project-tree)
- [Requirements](#requirements)
- [Environment variables](#environment-variables)
- [Local setup](#local-setup)
- [Demo accounts](#demo-accounts)
- [How calling works (WebRTC)](#how-calling-works-webrtc)
- [Security model](#security-model)
- [REST & Socket API summary](#rest--socket-api-summary)
- [Deploying to Render](#deploying-to-render)
- [Production storage note (read this)](#production-storage-note-read-this)
- [Testing](#testing)
- [Swapping the database](#swapping-the-database)
- [License](#license)

---

## Features

- **Auth** — phone-number registration, bcrypt-hashed passwords (cost 10), JWT in an `HttpOnly` cookie + double-submit CSRF, rate-limited login, "change password" that revokes all other sessions.
- **Real-time messaging** — Socket.IO for send/deliver/read, optimistic UI with temp IDs, reply, edit (within a window), delete-for-me and delete-for-everyone.
- **Presence** — online/last-seen via Socket.IO; privacy-aware (you control who sees your last-seen/photo). Only contacts + chat partners receive your presence changes.
- **Media** — image upload with server-side magic-byte validation (rejects disguised executables), voice messages via `MediaRecorder`, document sharing, clipboard-paste images, and a **Canvas image editor** (draw / highlight / arrow / rect / circle / text / crop, undo/redo).
- **Calling** — 1-on-1 audio/video WebRTC calls initiated **directly by user ID / phone** (no room links), with a strict signaling order, ICE candidate queueing, a full call state machine, and graceful cleanup.
- **Privacy & safety** — server-side serialization decides what each viewer may see; the client never makes privacy decisions. Uploads are served with `nosniff` + `attachment` and never executed.

---

## Architecture overview

```
                ┌─────────────────────────────────────────────┐
   Browser ───► │  public/  (SPA: index.html, style.css,       │
   (you)        │            script.js + js/* ES modules)      │
                └───────────────┬───────────────┬──────────────┘
                                │ HTTPS/JSON     │ WebSocket (Socket.IO)
                                ▼                ▼
                ┌─────────────────────────────────────────────┐
                │  Express app (src/app.js)                     │
                │   • helmet CSP, CORS, cookie+body parse       │
                │   • /api rate limit + CSRF                    │
                │   • REST routers (src/routes/*)               │
                │   • Socket.IO (src/sockets/*, JWT-verified)   │
                └───────┬───────────────────────┬──────────────┘
                        ▼                       ▼
                ┌──────────────┐        ┌──────────────────────┐
                │ Repository   │        │ Services              │
                │ (src/db/*)   │        │ tokens, serialize,    │
                │ SQLite /     │        │ ice (Metered),        │
                │ MongoDB-stub  │        │ presence, uploads,    │
                │               │        │ call-manager, ...     │
                └──────────────┘        └──────────┬───────────┘
                                                    ▼
                                          Metered.ca (STUN/TURN)
                                          — API key stays server-side
```

Key design decisions:

- **No room links.** Calls are placed directly to a `targetUserId` / `targetPhone`. The forbidden "room-link" pattern from the original BoltCall was removed entirely.
- **Server is the source of truth.** Membership, privacy, message edit/delete windows, and presence fan-out are all enforced server-side. The client is never trusted for user identity (`senderId` always comes from the verified JWT, never the payload).
- **ICE credentials never reach the browser.** `METERED_API_KEY` is used only on the server to mint short-lived TURN credentials, served via `GET /api/webrtc/ice-servers`.
- **Strict WebRTC order.** Local tracks are added to the `RTCPeerConnection` *before* `createOffer`/`createAnswer`; ICE candidates received before the remote description is set are queued and flushed afterwards.

---

## Project tree

```
NexaChat/
├─ package.json
├─ .env.example
├─ render.yaml
├─ README.md
├─ server.js                      # bootstrap: DB, dirs, http+Socket.IO, graceful shutdown
├─ database.js                    # initDatabase / getDb / closeDatabase (sqlite | mongodb-stub)
├─ public/
│  ├─ index.html                  # SPA shell (auth, sidebar, chat, call overlays, modals)
│  ├─ style.css                   # dark cyberpunk glassmorphism
│  ├─ script.js                   # client app (ES module): auth, chat, calls, editor
│  ├─ assets/
│  │  ├─ logo.svg
│  │  ├─ icon-192.png
│  │  └─ icon-512.png
│  └─ js/
│     ├─ utils.js                 # DOM/format/security helpers (escapeHtml, linkify, …)
│     ├─ state.js                 # client store (Maps + localStorage settings)
│     ├─ api.js                   # REST client + CSRF + multipart upload
│     ├─ ui.js                    # toast / modal / confirm / screen helpers
│     └─ media.js                 # WebRTC peer connection + MediaRecorder voice
├─ src/
│  ├─ config.js                   # central env config (frozen)
│  ├─ app.js                      # Express app factory (middleware order matters)
│  ├─ db/
│  │  ├─ sqlite-driver.js         # openDatabase (better-sqlite3 → node:sqlite fallback)
│  │  ├─ schema.js                # SQL schema (users, contacts, conversations, messages, calls)
│  │  └─ sqlite-adapter.js        # repository layer (async, maps domain objects)
│  ├─ services/
│  │  ├─ tokens.js                # JWT sign + cookie set/clear
│  │  ├─ serialize.js             # publicUser/Message/Conversation/Call (privacy applied here)
│  │  ├─ ice.js                   # Metered STUN/TURN (3-tier fallback, API key server-only)
│  │  ├─ presence.js              # in-memory online/offline registry
│  │  ├─ message-service.js       # send/edit/delete/system helpers
│  │  ├─ uploads.js               # multer + magic-byte validation
│  │  ├─ call-manager.js          # call state machine + ring timeout
│  │  └─ visibility.js            # presentUser(s) privacy resolution
│  ├─ middleware/
│  │  ├─ auth.js                  # requireAuth / optionalAuth
│  │  ├─ csrf.js                  # double-submit CSRF
│  │  ├─ rate-limit.js            # express + socket limiters
│  │  └─ error-handler.js         # mapped, non-leaky errors
│  ├─ routes/
│  │  ├─ index.js                 # mounts all sub-routers under /api
│  │  ├─ auth.js  users.js  contacts.js
│  │  ├─ conversations.js  messages.js  upload.js
│  │  ├─ webrtc.js  calls.js
│  ├─ sockets/
│  │  ├─ index.js                 # attachSocketServer: JWT auth, presence, handlers
│  │  ├─ emitters.js              # broadcast helpers (user rooms)
│  │  ├─ chat-handlers.js
│  │  └─ call-handlers.js
│  └─ utils/                      # logger, errors, phone, validate, sniff
├─ scripts/
│  ├─ seed.js                     # idempotent demo-account seeding
│  └─ smoke-test.js               # spawns server, exercises the API
├─ data/                          # SQLite file lives here (gitignored)
└─ uploads/                       # avatars/images/audio/files (gitignored)
```

---

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module if `better-sqlite3` is absent).
- A modern browser with **HTTPS or localhost** for camera/microphone access.

---

## Environment variables

See `.env.example` for a copy-paste template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (Render injects this automatically). |
| `NODE_ENV` | `development` | `production` requires `SESSION_SECRET`. |
| `SESSION_SECRET` | — | JWT signing secret; **required in production** (≥16 chars). Auto-generated in dev. |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mongodb`. |
| `DATABASE_PATH` | `./data/nexachat.sqlite` | SQLite file path. |
| `UPLOAD_DIR` | `./uploads` | Upload root (subdirs created automatically). |
| `MAX_FILE_SIZE_MB` | `10` | Max upload size. |
| `METERED_API_KEY` | — | Metered.ca API key (**server-only**, never sent to client). |
| `METERED_DOMAIN` | — | Metered.ca domain (e.g. `yourname.metered.ca`). |
| `METERED_TURN_USERNAME` | — | Static TURN username fallback. |
| `METERED_TURN_CREDENTIAL` | — | Static TURN credential fallback. |
| `CALL_RING_TIMEOUT_SECONDS` | `35` | Ring timeout before a call auto-cancels. |
| `CORS_ORIGIN` | — | Comma-separated allowed origins (omit for same-origin). |
| `SEED_DEMO_PIN` | `nexa1234` | PIN used by `npm run seed`. |
| `TRUST_PROXY` | production | Trust `X-Forwarded-*` (set behind Render/Nginx). |

---

## Local setup

```bash
# 1) install dependencies
npm install

# 2) configure environment
cp .env.example .env
#   edit .env and set SESSION_SECRET (any 32+ char random string)

# 3) create demo accounts (optional but handy)
npm run seed

# 4) start the server
npm run dev          # or: npm start

# 5) open the app
#   http://localhost:3000
```

> Camera/microphone require a secure context. `localhost` counts as secure, so local dev works. On a LAN IP or a hosted domain you must use **HTTPS**.

---

## Demo accounts

After `npm run seed`, log in with any of:

| Phone | Name | PIN |
| --- | --- | --- |
| `+8801700000001` | Rahim | `nexa1234` |
| `+8801700000002` | Karim | `nexa1234` |
| `+8801700000003` | Nusrat | `nexa1234` |

These are fictional numbers. Open two browsers (or one normal + one incognito) and log in as different demo users to try real-time messaging and calls.

---

## How calling works (WebRTC)

1. **Caller** clicks call → `call:request { targetUserId, callType }`. The server verifies the target is online (and not already busy) and emits `call:incoming` to the receiver and `call:ringing` to the caller.
2. **Receiver** accepts → `call:accept { callId }`. Server emits `call:accepted` to the caller.
3. **Caller** (on `call:accepted`) grabs `getUserMedia`, **adds local tracks to the `RTCPeerConnection`, then** `createOffer` → sends `call:offer`.
4. **Receiver** sets the remote description, creates an answer, and sends `call:answer`.
5. Both sides relay `call:ice-candidate` events. Candidates that arrive before the remote description is set are queued and flushed afterward.
6. Media flows P2P. When connected, `call:connected` starts the call timer.
7. Either side can `call:end`. The server writes a system message ("Missed call", "Audio call · 1:05", etc.) into the chat, so call history is visible in both the Calls tab and the conversation.

**Why Metered credentials stay server-side:** `src/services/ice.js` contacts Metered with `METERED_API_KEY` to obtain short-lived TURN credentials, then returns only those (plus STUN) to the client. The API key is never included in any response or client bundle.

---

## Security model

- Passwords are hashed with **bcrypt (cost 10)**; plaintext is never stored or logged.
- Sessions use a signed JWT in an `HttpOnly`, `SameSite` cookie; state-changing requests require a matching `X-CSRF-Token` (double-submit).
- The client never asserts user identity — `socket.data.user` is set only from the verified JWT, and message `senderId` is always the server's value.
- Uploads are validated by **magic-byte sniffing** (not just extension/MIME), capped in size, stored with random filenames (no path traversal), and served with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` for documents.
- Rate limiters protect auth, search, messaging, uploads, and socket signaling.
- Privacy (last-seen, profile photo, read receipts) is resolved **server-side** in `serialize.js` / `visibility.js`.

---

## REST & Socket API summary

**REST** (all under `/api`, all authenticated unless noted):

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | multipart or JSON; optional avatar |
| POST | `/auth/login` | returns `{ user, token }` |
| POST | `/auth/logout` | clears cookies |
| GET | `/auth/me` | session check; refreshes token |
| PATCH | `/auth/password` | revokes other sessions |
| GET | `/users` · `/users/search` · `/users/:id` | directory + search |
| PATCH | `/users/me` | name/about/privacy |
| POST/DELETE | `/users/me/avatar` | avatar upload/remove |
| GET/POST | `/contacts` · POST `/contacts/sync` · DELETE `/contacts/:id` | contact sync |
| GET/POST | `/conversations` | list / open (by `userId` or `phone`) |
| GET | `/conversations/:id/messages` | paginated (`?limit&before`) |
| POST | `/conversations/:id/read` | mark read |
| GET | `/conversations/:id/search` | in-conversation search |
| POST/PATCH/DELETE | `/messages` | send / edit / delete (`?scope=me\|everyone`) |
| GET | `/messages/search` | global message search |
| POST | `/upload/image` `/upload/audio` `/upload/file` | validated uploads |
| GET | `/webrtc/ice-servers` | STUN/TURN (no API key) |
| GET | `/calls` | call history |

**Socket.IO** (JWT-verified; events in `src/sockets/*`):

- Client → server: `chat:send`, `chat:typing`, `chat:stopTyping`, `message:delivered`, `message:read`, `message:edit`, `message:delete`, `presence:get`, `call:request`, `call:accept`, `call:reject`, `call:offer`, `call:answer`, `call:ice-candidate`, `call:connected`, `call:end`.
- Server → client: `chat:receive`, `chat:typing`, `chat:stopTyping`, `message:delivered`, `message:read`, `message:edited`, `message:deleted`, `user:online/offline`, `presence:update`, `user:updated`, `conversation:created`, `call:incoming/ringing/accepted/offer/answer/ice-candidate/connected/end/timeout/busy/handled`, `notification:missed-call`.

---

## Deploying to Render

1. Push this repo to GitHub.
2. In Render, create a **Blueprint** instance and select the repo (the included `render.yaml` provisions the web service).
3. Set `SESSION_SECRET` (Render can generate one), and paste your Metered credentials if you want calls to traverse hard NAT.
4. Deploy. Render runs `npm install` then `node server.js` on the injected `PORT`.

For demo accounts on the server, run `npm run seed` in the Render shell once (or wire it into a release step).

---

## Production storage note (read this)

⚠️ **The default disk on Render web services is ephemeral.** Files written to `./data` (the SQLite database) and `./uploads` are **deleted on every deploy and restart**. NexaChat does not pretend otherwise.

For a durable production deployment, choose one (or more):

1. **Persistent disk** — mount a Render Disk and point `DATABASE_PATH` and `UPLOAD_DIR` at the mount path (see the commented `disk:` block in `render.yaml`).
2. **Managed database** — set `DB_DRIVER=mongodb` + `MONGO_URI`. The repository layer (`src/db/sqlite-adapter.js`) is the only DB-touching code, so the API is unaffected.
3. **Object storage** — send uploads to S3/R2 instead of local disk (replace `src/services/uploads.js`).

The README, `.env.example`, and `render.yaml` all document this honestly.

---

## Testing

```bash
npm test
```

`scripts/smoke-test.js` spawns the server on `PORT 3999`, waits for `/api/health`, then exercises registration, `/auth/me`, ICE servers (asserting the Metered key is **not** leaked), user search, conversation creation, message send (REST fallback path), history, and mark-read. It prints pass/fail and exits non-zero on failure.

---

## Swapping the database

The app talks to the database only through the repository layer in `src/db/sqlite-adapter.js` (returned by `getDb()`). To move to MongoDB, implement the same method surface against Mongo and switch `DB_DRIVER` — no API or frontend changes are needed. (A `mongodb-stub` branch exists in `database.js` to make the seam explicit.)

---

## License

MIT.
