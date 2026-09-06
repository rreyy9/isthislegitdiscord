# isthislegit

A self-hosted chat and voice server for about ten friends. Text chat, voice with screen
share and push-to-talk, invite-gated registration, moderation, and a desktop client for
each side — one for chatting, one for administering the server.

This is the only document. Setup, operations, the decisions worth not re-litigating, the
bugs that cost real time, and what is left are all below.

**Status.** Running on the internet over TLS, on a home connection, at
`https://isthislegit.duckdns.org`. Certificates are real and renew themselves. Voice media
goes direct to the box; only signalling and the HTTP API go through the proxy.

---

## Contents

- [Layout](#layout) · [Requirements](#requirements)
- [Running it](#running-it) · [The two installers](#the-two-installers)
- [Configuration](#configuration) · [Going public](#going-public) · [Database](#database)
- [Voice quality](#voice-quality) · [API](#api)
- [Decisions worth not re-litigating](#decisions-worth-not-re-litigating)
- [Bugs that cost real time](#bugs-that-cost-real-time)
- [What is left](#what-is-left)

---

## Layout

```
packages/shared      Zod schemas + socket event types, imported by server and client
apps/server          NestJS + Prisma + Better Auth + Socket.IO
apps/console         Operator console: supervises the services, config and admin UI
apps/server-app      Electron shell around the console -- the server box's app
apps/desktop         Electron + React chat client -- what friends install
infra/livekit        LiveKit config and start script
infra/caddy          Caddyfile and start script: TLS for the API and signalling
infra/installer      Builds the server installer
infra/start-all.ps1  Start, stop and status for all three services
infra/allow-lan.ps1  Firewall rules
```

Everything is TypeScript except the console, which is plain ESM with no build step.

## Requirements

**Node 22+** and **PostgreSQL 17** (`winget install --source winget --interactive
PostgreSQL.PostgreSQL.17` — use `--interactive`, or it installs silently with a superuser
password you never chose). No Docker anywhere.

Two binaries are downloaded rather than committed, both gitignored:

- **LiveKit** — `livekit_<version>_windows_amd64.zip` from
  <https://github.com/livekit/livekit/releases>, unzipped to `infra/livekit/bin/livekit-server.exe`
- **Caddy** — `caddy_windows_amd64.zip` from
  <https://github.com/caddyserver/caddy/releases>, renamed to `infra/caddy/bin/caddy.exe`

`livekit.yaml` is also gitignored, because it holds this deployment's real API key pair.
Copy `infra/livekit/livekit.example.yaml` to `livekit.yaml` and fill in a pair.

---

## Running it

**The operator console starts everything and administers it.** It is the launcher, and the
**isthislegit Server** app is how you open it — in development as well as on the server
box, so both are running the same thing:

```bash
npm run server-app       # window + tray, and it starts the console itself
npm run console          # just the console, headless, at http://127.0.0.1:4000
```

The app spawns the console and adopts one already listening on 4000, so the two commands
do not conflict. It is a shell, not a second implementation: closing the window hides it to
the tray, and **Quit** from the tray stops the console and everything the console started.

**Start server** starts the chat server, LiveKit, and — in internet mode only — Caddy.
**Start database** starts the PostgreSQL service. The rest of it is build, migrate, seed,
the invite code, accounts, guilds and channels, and the deployment configuration. VS Code
has one task for it, and one for the desktop client; there is deliberately nothing else in
that list, because everything else is a button here.

**`ISTHISLEGIT_ROOT` tells the app which tree to administer**, and the VS Code task sets it
to the checkout. Without it the app searches — last used, beside its own executable,
`C:\isthislegit`, then the repo — and on a machine with a server *installed* as well as
checked out it would find the install first. The two are indistinguishable once the window
is open, which is the whole reason the override exists. Set to a folder with no console in
it, the app says so and quits rather than falling back to the search.

The console binds `127.0.0.1` only, deliberately — it spawns processes, so exposing it to
the network is remote code execution with no authentication in front of it. Do not change
the bind address, and never forward port 4000.

**Without the console**, the same three services in their own windows:

```bash
powershell -ExecutionPolicy Bypass -File infra\start-all.ps1
```

Starts PostgreSQL if it is not already up, then the chat server, LiveKit and Caddy — each
in its own window, so a crash stays visible and the logs stay readable. `-Status` reports
without changing anything, `-Stop` stops them, `-NoCaddy` skips the proxy for LAN work.

It works in a repo checkout and in an installed copy, working out which from whether
`apps/server` exists beside it.

**Processes are matched by the port they listen on, never by image name.** Three of them
are `node.exe`, and so is anything else on the machine — `taskkill /IM node.exe` is how you
kill PostgreSQL by accident.

**Working on the server itself** needs watch mode, which the console has no way to offer —
it runs `apps/server/dist/main.js`, so a code change there means Build then Restart in the
console. Stop the console's server first; both want port 3000.

```bash
npm install
npm run build
cd apps/server && npm run dev      # watch mode
```

### Signing in on a fresh local checkout

The chat server has no sign-up without an invite, and the first account to register into a
guild becomes its admin. All of it is on one screen:

1. Run the **Console** task. The isthislegit Server window opens on the console.
2. **Status → Start database.** If the `chat` database does not exist yet, **Database →
   Create role and database** makes it, using the postgres superuser password.
3. **Maintenance → Run migrations**, then **Build**, then **Seed.** Seeding creates the
   *Home* guild with `#general`, `#random` and a Voice channel, and prints an invite code
   — the console reads it back on the **Invites** tab.
4. **Accounts → Create the first admin**, with that invite code. That account is the admin.
5. **Status → Start server.**
6. Run the **Desktop app (dev)** task and sign in with the same username and password.

The desktop client talks to `http://localhost:3000` unless you change **Server address** at
the bottom of the sign-in screen; that address is remembered in `settings.json`, not
compiled in. Voice is separate: the client is told where LiveKit is by `LIVEKIT_URL` in
`apps/server/.env`, which must be this machine's **LAN** address rather than `localhost`,
or it will work here and for nobody else. The console's **Configuration** tab writes it
along with the two files that have to agree with it.

---

## The two installers

```bash
powershell -ExecutionPolicy Bypass -File infra\installer\build-server-installer.ps1
npm run dist --workspace @isthislegit/desktop
```

| | What it is | Where it goes |
|---|---|---|
| `isthislegit-server-<v>-setup.exe` | Server, LiveKit, Caddy, console **and** the admin app | The server box |
| `isthislegit-<v>-setup.exe` | The chat client | Everyone's machines |

**Run the server installer as administrator.** Without elevation it skips the database
setup and the boot tasks, and you get a half-finished install that starts nothing.

It is idempotent — re-run it to upgrade, and the database, `.env` and LiveKit key pair are
kept. It registers three scheduled tasks that run as SYSTEM at startup with
restart-on-failure, so the server survives a reboot without a human.

The server installer also builds the Electron admin app and stages it as `app\`, with Start
Menu and desktop shortcuts. `-NoServerApp` leaves it out and saves roughly 200 MB.

### Things about these builds that are load-bearing

- **The staged manifest pins exact dependency versions**, resolved from what is installed
  in this repo. Shipping the `^` ranges means the target resolves whatever is newest at
  install time, and an installed server then runs dependencies nobody has tested. That is
  not hypothetical — see [Bugs that cost real time](#bugs-that-cost-real-time).
- **The build refuses to run** if the payload contains a real key pair, a `devkey`, or a
  `.env`. It ships `.env.example` and `livekit.example.yaml`, never the live files.
- **`asarUnpack` covers `uiohook-napi`** in the desktop client. A native `.node` binary
  cannot load from inside an asar, and it fails *silently*, so push-to-talk would break
  only in packaged builds.
- **`electronVersion` is pinned** in both Electron apps' build configs. Electron is hoisted
  to the workspace root and electron-builder cannot resolve a `^` range from a workspace.
- **There is deliberately no auto-update.** Hand the installer over yourself.

---

## Configuration

Everything lives in three files that have to agree with each other, and the console's
**Configuration** tab edits all three together rather than one at a time.

| File | Holds |
|---|---|
| `apps/server/.env` | Database URL, secrets, `LIVEKIT_URL`, port, voice quality, upload limit |
| `infra/livekit/livekit.yaml` | The key pair, and which address LiveKit advertises |
| `infra/caddy/Caddyfile` | The two public hostnames |

The tab exposes a deployment **mode** — LAN or internet — rather than the individual
fields, because `LIVEKIT_URL` and `use_external_ip` are two halves of one decision and
editing them separately is how they drift apart. When they disagree the failure is silent:
everyone joins the voice channel, the UI shows them sitting in it, and no audio ever
arrives.

Secrets are deliberately not editable there. A UI that can rewrite `BETTER_AUTH_SECRET` is
a UI that can quietly sign everyone out. They are generated once, by the installer, and the
console only reads them far enough to warn if one is still a placeholder.

**The first admin** is created from the console's Accounts tab. Administering anything
needs an ADMIN account, and the only way to get one is to register through an invite —
so the tab has a card that registers and signs in, with the code prefilled from the file
the seed writes. Everyone after that is created from the card above it, no invite needed.

If `livekit.yaml` ever loses its key pair, or it drifts from `.env`:

```bash
powershell -ExecutionPolicy Bypass -File infra\repair-livekit-keys.ps1 -InstallDir C:\isthislegit
```

---

## Going public

The current deployment: **DuckDNS** for the hostnames, **Caddy** for TLS, **Let's Encrypt**
for the certificates. All free.

Two DuckDNS names, both pointing at the same connection, told apart by SNI so it is still
one forwarded port:

```
isthislegit.duckdns.org      ->  chat server   127.0.0.1:3000
isthislegit-lk.duckdns.org   ->  LiveKit       127.0.0.1:7880
```

LiveKit gets its own hostname because its client SDK opens a socket at the root of whatever
host it is given.

**Caddy runs on 443 only.** It would normally also bind 80 for the ACME challenge and an
HTTP→HTTPS redirect; neither earns a forwarded port here, because the client is a desktop
app with a server-address field rather than a browser someone types a bare hostname into.
Certificates come over TLS-ALPN-01, which runs entirely on 443.

### Ports

| Port | Protocol | Forwarded? | What |
|---|---|---|---|
| 443 | TCP | **yes** | Caddy: HTTPS API, Socket.IO, LiveKit signalling |
| 7881 | TCP | **yes** | WebRTC over TCP, the fallback when UDP is blocked |
| 3478 | UDP | **yes** | TURN, for anyone UDP-blocked entirely |
| 50000-50100 | UDP | **yes** | Voice and screen-share media |
| 3000, 7880 | TCP | **no** | Caddy reaches both over loopback |
| 4000 | TCP | **never** | Operator console — remote code execution |
| 5432 | TCP | **never** | PostgreSQL |

Same numbers on both sides of the router: LiveKit advertises the port it believes it is on,
so translating one breaks voice and nothing else.

**Media does not go through Caddy and does not need to.** WebRTC media is DTLS-SRTP
encrypted end to end regardless. What TLS buys here is the chat server's HTTP and
WebSocket traffic — which carries passwords and 30-day session tokens — and LiveKit's
signalling, which carries a ten-minute room-scoped join token.

Firewall, once, elevated:

```bash
powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1 -Internet
```

3000 and 7880 stay scoped to `LocalSubnet` even in `-Internet` mode, because Caddy reaches
them over loopback and both would be exposed in plaintext otherwise.

### The one that will still catch you

DuckDNS follows your ISP's lease, so the hostnames survive an address change. **LiveKit
does not.** It discovers the public address by STUN once at startup and advertises it in
ICE candidates, so after the address moves, chat recovers on its own and voice stays silent
until LiveKit is restarted. When voice breaks for everyone outside at once, restart LiveKit
before debugging anything else.

---

## Database

PostgreSQL 17 as a Windows service (`postgresql-x64-17`) on `localhost:5432`. It starts on
boot, so there is nothing to start by hand.

The app connects as a dedicated **`chat_app`** role to a dedicated **`chat`** database,
never the superuser. Both are created by `apps/server/prisma/setup-postgres.sql`, which the
installer runs. The role's password is **generated per install** and written into
`DATABASE_URL`; run the SQL by hand with no `-v app_password=...` and it falls back to a
development password that is published in this repository, which is only ever right for a
local dev database.

```bash
# Wipe everything, including the schema and migration history
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U chat_app -d chat -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO chat_app;"
```

Stop the chat server first or it will hold connections open. Rebuilding the schema
afterwards is `prisma migrate deploy` plus the seed, which an install does for you.

**Deleting a user cascades to everything they touched** — sessions, credentials, guild
membership, messages, attachments, read states, and any invite codes they created. It is
not just removing a login.

> A previous iteration used `prisma dev` for a Docker-free database. It lost data twice and
> once left the tables referentially inconsistent. Do not go back to it.

---

## Voice quality

Set once, for everyone, in `apps/server/.env`:

| | Opus | Notes |
|---|---|---|
| `voice` | 24 kbps mono | DTX on — stops sending in silence. For a bad or metered link |
| `balanced` | 48 kbps mono | The default |
| `high` | 96 kbps mono | Audibly better, still echo-cancelled |
| `studio` | 128 kbps stereo | **Headphones only** — see below |

It lives on the server rather than in each client because the bitrate everyone publishes at
is what the host's upload has to carry: ten people choosing "studio" for themselves is a
decision about someone else's bandwidth. Clients receive it with their join token, so a
change reaches everyone on their next join. An unrecognised value logs a warning and falls
back to `balanced`.

**RED** (redundant audio) is on for every mono preset. It resends recent frames alongside
new ones, so a dropped packet is usually repaired without a retransmit — which matters far
more on a bad connection than the bitrate does. LiveKit only offers it on mono, so `studio`
goes without.

**`studio` is stereo, and Chromium will not run its echo canceller on a two-channel
capture.** No echo canceller anywhere is stereo; this is not an Electron limitation. The
client will not switch to stereo until echo cancellation is turned off in its voice
settings, and on speakers that combination will feed back.

### What each person controls

Settings open on a two-pane screen — Devices, Input, Behaviour, Quality — because the
single 360px column had microphone choice and codec bitrate in the same scroll.

- **Echo cancellation / noise suppression / automatic gain** (Input) — Chromium's own,
  applied at capture. Changing any of them restarts the microphone.
- **Push-to-talk** (Input) — the key and what it overrides only appear once the switch is
  on, since neither means anything while it is off. If the global hook could not load, the
  switch is disabled and says why instead.
- **Sensitivity** (Input) — off, automatic, or a manual threshold with a live meter.
  Automatic measures the room for 300 ms on join and sits a fixed margin above what it
  heard, so a noisy room raises its own bar. It mutes and unmutes the published track
  exactly as push-to-talk does; push-to-talk overrides it.
- **Per-person volume** (right-click somebody in a voice channel) — remembered per user id,
  applied whenever they are in the room. This is the whole of playback control, and it
  replaced both a single output slider and an automatic leveller: turning the whole room
  down at once is what the volume knob on the desk is for, and the problem worth an app
  control is the one person who is twice as loud as everyone else, which is per person by
  definition. **It only turns people down** — without `webAudioMix` a remote track's level
  is an `HTMLMediaElement.volume`, which the spec caps at 1.0. Boosting would mean routing
  everyone through Web Audio and putting a question mark over echo cancellation, which is a
  bad trade in a voice app. The quiet direction is each person's own automatic gain,
  applied before their audio is ever encoded.
- **Rejoin the last voice channel** (Behaviour, off by default) — the channel is written
  down on join and cleared on leave, so this only fires if the app stopped while you were
  still in one. Leaving on purpose is remembered as leaving.

**None of this processes the audio.** Every meter is an analyser tap wired to no
destination, so the worst a bug in any of it can do is show a wrong number.

### Who is talking, and how fast the light says so

The speaking ring is measured in the client, not taken from LiveKit.
`ActiveSpeakersChanged` is computed by the SFU from the audio it is forwarding and
broadcast on its own clock, so it lagged at both ends — on after somebody had started, off
after they had stopped. Every track already carries a meter for the gate, so the timely
answer was in the room all along: remote tracks are polled at 50 ms and the
local microphone at 20 ms, through a small hysteretic detector. `isSpeaking` stays the
fallback for anybody not yet metered.

### The screen picker draws before its pictures exist

`desktopCapturer.getSources` with a thumbnail size captures a frame of every open window,
which is seconds on a busy desktop — and that was the whole of the delay between clicking
share and seeing anything. It now runs twice: once with `thumbnailSize: { width: 0, height:
0 }` for the names, which is nearly free and is what the picker opens with, and once for
the pictures, which arrive on a second IPC message and fill in behind them. Picking a
window before its thumbnail has landed is allowed and does not wait.

---

## API

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | Also checks the database |
| GET | `/api/config` | LiveKit URL, upload limit, voice quality — the client hardcodes nothing |
| POST | `/api/register` | Requires a valid invite code |
| POST | `/api/login` | Username + password |
| GET | `/api/me` | Current session |
| GET | `/api/guilds` | Guilds with their channels |
| GET | `/api/members` | Members, with online state |
| GET | `/api/channels/:id/messages` | Cursor paged: `?before=<id>&limit=50` |
| POST | `/api/channels/:id/messages` | Broadcasts over Socket.IO |
| PATCH | `/api/channels/:id/messages/:msgId` | Edit — the author only, never an admin |
| DELETE | `/api/channels/:id/messages/:msgId` | Delete — the author, or a guild admin |
| POST | `/api/guilds/:id/invites` | Admins only |
| POST | `/api/guilds/:id/members/:userId/mute` | `{ durationMinutes }`, null for indefinite |
| POST | `/api/guilds/:id/members/:userId/kick` | Removed; can return with a new invite |
| POST | `/api/guilds/:id/members/:userId/ban` | Removed, signed out, cannot rejoin |
| GET/DELETE | `/api/guilds/:id/bans[/:userId]` | List and lift |
| POST | `/api/channels/:id/voice-token` | LiveKit token, voice channels only |
| GET | `/api/voice/state` | Who is in which voice channel, right now |
| POST | `/api/livekit/webhook` | Called by LiveKit, not by clients; JWT-signed |
| — | `/api/auth/*` | Better Auth's own routes |
| — | `/api/admin/*` | Stats, users, invites, guilds, channels, messages — ADMIN role |

Moderation lives on the guild routes rather than under `/api/admin`: those answer "an admin
of anything?" for the console, whereas kicking someone has to ask "an admin of *this*
guild?". Muting, kicking and banning all refuse to act on yourself or another admin — roles
are flat, so there is no hierarchy to rank two admins by; demote one from the console first.

Socket.IO events are declared in `packages/shared/src/index.ts`.
`apps/server/requests.http` exercises the whole API.

---

## Decisions worth not re-litigating

**Data and transport**

- **Ids are UUIDv7.** Time-sortable, so `ORDER BY id` is chronological and message paging
  needs no extra column.
- **Cursor paging, never offset.** Offset breaks the moment a message arrives mid-scroll.
- **`clientNonce`** is echoed back so the client renders its own message instantly and drops
  the duplicate when the echo lands.
- **Socket auth is Socket.IO middleware, not `handleConnection`.** Nest does not await
  `handleConnection`, so an early `channel:join` can beat the session.
- **Auth is bearer tokens, not cookies.** The desktop renderer runs from `file://` and a web
  dev server runs on another port; neither can carry a `SameSite` cookie without TLS.
- **`trust proxy` is `loopback`, never `true`.** Behind Caddy every request arrives from
  127.0.0.1, and `true` would trust an `X-Forwarded-For` from anyone — letting a client name
  its own address and step around rate limiting.
- **Better Auth owns its four tables.** Their shape came from its own runtime, not
  guesswork; re-check with `getAuthTables()` after upgrading it.

**Voice**

- **A LiveKit room per channel**, named `channel-<channelId>`, with the join token's
  `identity` set to the user id — so a participant maps to a user with no lookup table.
- **Voice presence comes from LiveKit's webhooks**, not the client. A LiveKit client only
  sees participants of rooms it has joined, so without webhooks nobody could see who is
  sitting in a channel they have not entered.
- **Each webhook re-reads the room's participant list** rather than incrementing a counter.
  One localhost round trip, and in exchange a dropped, duplicated or out-of-order webhook
  cannot strand a ghost in a channel forever.
- **The webhook route is mounted with a raw body parser** ahead of `express.json`, because
  the signature is over the raw bytes. Parsing first silently breaks verification.
- **Join tokens live ten minutes.** They only have to survive the join.
- **Push-to-talk is `uiohook-napi`, not Electron's `globalShortcut`.** `globalShortcut`
  reports presses but never releases, so it cannot express "hold". If the native module
  fails to load, push-to-talk reports itself unavailable and everything else still works.
- **Screen capture needs the main process.** Electron ships no picker on Windows, so
  `getDisplayMedia` fails unless the app answers the request.
- **`--dev` mode is never used.** Its key pair is published in LiveKit's own repository.

**Client**

- **Links open in the real browser**, via `setWindowOpenHandler` — never in an Electron
  window, which has no address bar and is a good way to be phished.
- **YouTube embeds are a still image until clicked**, so scrolling past a link loads no
  third-party frame.
- **The token is stored with `safeStorage`** (DPAPI on Windows) through an IPC bridge, never
  in plaintext.
- **`backgroundThrottling: false`.** Chromium throttles timers to ~1/sec in a hidden window,
  and the level polling that drives the noise gate is a renderer timer. Audio itself was
  never at risk — capture, Opus and the jitter buffer are native real-time threads.
- **The gate meters a *clone* of the microphone track.** Metering the published one would
  read silence the moment the gate muted it, and the mic would never open again.

**Deliberately not done**

Federation, mobile clients, custom emoji, threads, video calls, a web client, auto-update.
Ten friends and one box is the whole design.

---

## Bugs that cost real time

Kept because each one failed silently, and the next person to hit the same shape deserves
the shortcut.

**Encoding and regex, three times in the same files**

- **A BOM-less `.ps1` with an em dash.** Windows PowerShell 5.1 reads it as Windows-1252, so
  the bytes became mojibake and a smart quote ended a string early. **Keep `.ps1` files
  ASCII-only and BOM'd.**
- **`Get-Content -Raw` on a BOM-less UTF-8 YAML** did the same thing in reverse: read as
  1252, written back as UTF-8, every em dash mangled. Read with an explicit
  `UTF8Encoding($false)` to match the write.
- **A multiline regex anchored with `[ \t]*$` against a CRLF file** matched nothing, because
  `[ \t]` does not cover the `\r`. It failed silently: the LiveKit placeholder key shipped
  and the error surfaced much later as LiveKit refusing to start. The test written for that
  change asserted the *shape* of the line, which the placeholder satisfied too. Prefer
  splitting on newlines and matching per line, so no pattern ever sees a line ending.

**Packaging and layout**

- **The console imported `express` but declared no dependencies.** It worked in the repo
  because npm workspaces hoists a copy to the root; an installed console sits beside the
  server rather than inside a workspace, so it died on `ERR_MODULE_NOT_FOUND` before
  printing anything — which looks exactly like a console that opens to nothing.
- **`SERVER_DIR` was resolved three levels up with no fallback**, which lands outside the
  install directory entirely. Every process-control button pointed at a path that did not
  exist. Both layouts are now checked, the way LiveKit's already was.
- **The staged manifest shipped `^` ranges**, so `better-auth ^1.7.2` resolved to 1.7.3 on
  the target while the repo had 1.7.2 — and 1.7.3 stopped sending a field the schema
  required. Registration failed on a box where identical code worked. Exact versions now.
- **CSP has caught three features on the way in** — `frame-src` and YouTube, `blob:` and
  attachments, and `https:`/`wss:` and TLS. A CSP refusal is not a network error and
  surfaces nowhere in the UI. Check it whenever the client reaches somewhere new.

**Schema and data**

- **`account.issuer` was `NOT NULL`.** Better Auth only has an issuer for providers that
  have one; a credential account has none. Worse, the error is a
  `PrismaClientValidationError` — raised by the *generated client* before a query is sent —
  so fixing the database column alone changes nothing without regenerating and rebuilding.
- **Duplicate React keys in the members panel.** `/api/members` returns one row per
  *membership*, so anyone in two guilds arrived twice. It only appeared once a second guild
  existed.
- **A URL regex swallowed trailing punctuation**, linking the full stop in
  `https://example.com/a.` Caught by unit-testing the parser rather than by reading it.

**Secrets**

- **`livekit.yaml` was committed and pushed to a public repository**, with this deployment's
  live API key pair. Force-pushing does not remove it: GitHub still serves the old commit by
  SHA until Support garbage-collects it. **Rotation is the fix; the purge is tidying.** Both
  the key pair and `BETTER_AUTH_SECRET` were rotated, and the build now refuses to ship a
  payload containing either.

---

## What is left

Ordered by what hurts soonest.

**Should do next**

1. **No backups.** Not of the database, not of `data/`. Other people's messages, images and
   password hashes, zero copies. `pg_dump` on a schedule written somewhere that is not this
   machine, and a restore actually tried once.
2. **No tests, and no test runner in any package.** Start with the pure modules, which are
   already shaped for it: `link-utils.ts`, `audio-levels.ts`, `image-size.ts`,
   `audio-config.ts`, and the permission matrix.
3. **Verify the login rate limit covers login.** Better Auth is mounted as raw Express
   outside Nest's routing, so `ThrottlerGuard` — an `APP_GUARD` — may not see
   `/api/auth/sign-in/email` at all. Rate limiting the controller while the underlying
   endpoint stays open is worse than not having it, because it looks solved.

**Should do soon**

4. **Disk fill takes PostgreSQL down, not just uploads.** 26 MB per file, no per-user quota,
   no total cap, no cleanup, same disk as the database.
5. **CORS reflects any origin** with credentials. Pin it to the origins that exist.
6. **Invite codes use `Math.random()`** — one line to `crypto.randomInt`, and invites are the
   entire perimeter around registration.
7. **No observability.** Logs go to the console and nowhere else; a hundred thousand failed
   logins would pass unnoticed.
8. **LiveKit advertises VirtualBox and Hyper-V addresses** as ICE candidates. Harmless until
   a friend's own network uses `192.168.56.x` — which is an office or hotel, exactly where
   you cannot debug it. `rtc.ips.excludes` trims the list.
9. **The dev checkout and the installed server share one database.** Fine while testing,
   miserable mid-debug. Point dev at `chat_dev`.

**Product**

10. `Chat.tsx` is past 1300 lines and holds the message list, editing, moderation,
    attachments, unread markers, embeds and now the per-person volume popup. Split it
    before adding reactions.
11. Emoji reactions, theme toggle, non-image attachments, mentions and notifications, search.
    Images in a message now open full size on click and copy on right-click — the copy goes
    through main, because an uploaded image is a blob: URL the renderer can rasterise but a
    linked one is another origin, where a canvas is tainted and `fetch` is a CORS failure.
12. Neither Electron app has an icon — both ship with Electron's default.
13. Client error surfaces: what a user sees on a 500. "Server is not there" is done —
    `fetch` rejects with "Failed to fetch" for every address that never reached a server,
    and devtools shows those with provisional headers, which reads as a cross-origin block
    and is not one. `api.ts` now names the origin that did not answer, and says that a
    server with no proxy in front of it is `http://` on its own port.
