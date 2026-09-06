# isthislegit

A small self-hosted chat and voice server for about ten friends.

Plan and reasoning: [discord-alternative-dev-lifecycle-v2.md](discord-alternative-dev-lifecycle-v2.md)

**Status:** working end to end — auth, invites, guilds, channels, real-time text chat, and
voice with screen share and push-to-talk. An operator console (start/stop the server, manage
accounts, invites and channels) and an Electron desktop client are both built. Voice needs
the LiveKit server running; see [infra/livekit](infra/livekit/README.md).

## Layout

```
packages/shared     Zod schemas + socket event types, imported by server and client
apps/server         NestJS + Prisma + Better Auth + Socket.IO
apps/console        Operator console: supervises the server, admin UI (no build step)
apps/desktop        Electron + React + TypeScript client (chat and voice)
infra/livekit       LiveKit config, start script, and how to install the binary
infra/allow-lan.ps1 Firewall rules so other machines on your network can connect
```

## Requirements

Node 22+ and PostgreSQL 17 (`winget install PostgreSQL.PostgreSQL.17`), which installs as a
Windows service that starts on boot. No Docker.

Voice additionally needs the LiveKit server — one downloaded binary, no Docker either.
[infra/livekit/README.md](infra/livekit/README.md) has the install and the ports to open.

## The console

The easiest way to run and administer everything:

```bash
npm run console
```

Then open **http://127.0.0.1:4000**. It can start, stop and restart the server, run
migrations and seeds, stream the server's logs, and — after signing in as an admin — manage
accounts, invites and channels.

Two things worth knowing:

- **It binds to 127.0.0.1 only, deliberately.** It spawns processes, so exposing it to the
  network would be remote code execution. Do not change the bind address.
- **It runs the server as a child process**, so closing the console stops the server.

### Stopping things

The **Stop things** card acts on whatever holds a port, rather than only on the child the
console started — so it can also clear a server left running in another terminal, which the
plain *Stop* button cannot. It covers the chat server (`:3000`), LiveKit (`:7880`), and the
PostgreSQL service, plus a *Stop everything* that does all three in dependency order.

**Processes are matched by port and killed by pid, never by image name.** A
`taskkill /IM node.exe` would take out the console itself and every other Node process on the
machine; `pidsOnPort()` also explicitly excludes the console's own pid. Keep it that way.

The database is a Windows service, so it is stopped with `net stop` rather than by killing its
pid — killing it would leave the service manager thinking it is up, and force recovery on the
next start. That needs an elevated terminal; without one the console says so instead of failing
quietly.

## Running it by hand

```bash
npm install
npm run build --workspace @isthislegit/shared
cd apps/server
npm run setup        # generate client, migrate, build, seed
npm start
```

PostgreSQL runs as a service, so there is no database to start by hand. One-time role and
database setup (only needed on a fresh machine) is in `apps/server/prisma/setup-postgres.sql`.

`npm run setup` prints an invite code. The **first account to register with it becomes the
admin** — that avoids the chicken-and-egg where issuing invites needs an admin and becoming
an admin needs an invite.

Then `apps/server/requests.http` walks the whole API, or:

```bash
curl -X POST http://localhost:3000/api/register -H 'Content-Type: application/json' \
  -d '{"username":"you","password":"a-long-password","inviteCode":"THE_CODE"}'
```

For day-to-day work use `npm run dev` (watch mode) instead of `build` + `start`.

## Building the client installer

```bash
cd apps/desktop && npm run dist
```

Produces `apps/desktop/release/isthislegit-<version>-setup.exe` (~111 MB, which is just what
an Electron app weighs). It is a per-user NSIS install, so it needs no administrator, and it
lets people choose the install directory. `npm run dist:dir` skips the installer and leaves a
runnable folder in `release/win-unpacked` for quick checks.

Two things about this build are load-bearing:

- **`asarUnpack` covers `uiohook-napi`.** A native `.node` binary cannot be loaded from inside
  an asar archive, so without this push-to-talk fails in the packaged app while working
  perfectly in dev. It fails *silently*, because the renderer's call that loads it is
  fire-and-forget — so this is not a thing you would notice until someone told you.
- **`electronVersion` is pinned in the build config.** Electron is hoisted to the workspace
  root, so electron-builder cannot resolve the `^` range from `apps/desktop`. Bump it when you
  bump Electron.

There is deliberately no auto-update. Over plain HTTP, `electron-updater` would let anyone on
the network path serve an installer the app then runs. Hand the file over yourself.

## Voice quality

Set once, for everyone, in `apps/server/.env`:

```bash
VOICE_QUALITY="balanced"
```

| | Opus | Notes |
|---|---|---|
| `voice` | 24 kbps mono | DTX on — stops sending in silence. For a bad or metered link |
| `balanced` | 48 kbps mono | The default |
| `high` | 96 kbps mono | Audibly better, still echo-cancelled |
| `studio` | 128 kbps stereo | **Headphones only** — see below |

It lives on the server rather than in each client because the bitrate everyone publishes at is
what the host's upload has to carry: ten people choosing "studio" for themselves is a decision
about someone else's bandwidth. Clients receive it with their join token, so a change reaches
everyone on their next join — but the server has to be restarted to reread `.env`, which the
console does in one click. An unrecognised value logs a warning and falls back to `balanced`.

`RED` (redundant audio) is on for every mono preset. It resends recent frames alongside new
ones so a dropped packet is usually repaired without a retransmit, which matters far more on a
bad connection than the bitrate does. LiveKit only offers it on mono, so `studio` goes without.

`studio` is stereo, and Chromium will not run its echo canceller on a two-channel capture — no
echo canceller anywhere is stereo, this is not an Electron limitation. The client will not
actually switch to stereo until echo cancellation is turned off in its voice settings, and on
speakers that combination will feed back. It is a headphones mode.

### What the client controls

Per person, in the app's voice settings, and all defaulting to how it behaved before they
existed:

- **Echo cancellation / noise suppression / automatic gain** — Chromium's own, applied at
  capture. Changing any of them restarts the microphone
- **Sensitivity** — off, automatic, or a manual threshold with a live meter. Automatic measures
  the room for 300ms on join and sits a fixed margin above whatever it heard, so a noisy room
  raises its own bar. It works by muting and unmuting the published track, exactly as
  push-to-talk does; push-to-talk overrides it
- **Even out how loud people are** — turns down whoever is much louder than the rest, over a
  couple of seconds. It only attenuates; the other direction is automatic gain doing the same
  job on each person's own microphone before it is encoded

None of this processes the audio. The meters are analyser taps wired to nothing, so a bug in
them can produce a wrong number but not a degraded call.

## Letting other machines connect

The server already listens on `0.0.0.0`; the parts that need changing are the addresses it
hands out and the firewall.

1. **`LIVEKIT_URL` in `apps/server/.env`** must be an address the *client* can reach.
   `localhost` points at whatever machine the client is on, so it only ever works for a client
   on this box. Use `ws://<lan-ip>:7880`, or the public IP over the internet.
2. **`rtc` in `infra/livekit/livekit.yaml`** must advertise the matching address — `node_ip`
   for a LAN, `use_external_ip: true` over the internet. Both modes are written out in the
   file; pick one. Getting this wrong is silent: everyone connects and nobody hears anything.
3. **Firewall**, once, elevated:

```bash
powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1
```

   Every rule is scoped to `LocalSubnet`, so the ports stay shut to anything outside your own
   network. `-Remove` undoes them, and `-Internet` widens them — see below.

Then on the other machine, install the client and set the server address on the login screen to
`http://<lan-ip>:3000` — it is a field in the app, not a compiled-in constant, so nobody has to
rebuild anything when the address changes.

### Over the internet

Same three settings, pointed at the public address instead of the LAN one, plus the router.
**This deployment is currently configured this way** — `livekit.yaml` is in its
`use_external_ip: true` mode and `LIVEKIT_URL` holds the public IP.

1. **Forward these ports** on the router to this box (`192.168.1.230`), *same numbers on both
   sides*. LiveKit advertises the port it believes it is on, so a router that translates 7880
   to something else breaks voice in the usual silent way.

   | Port | Protocol | What |
   |---|---|---|
   | 3000 | TCP | Chat server: HTTP API and Socket.IO |
   | 7880 | TCP | LiveKit signalling, the `ws://` the client connects to |
   | 7881 | TCP | WebRTC over TCP, the fallback when UDP is blocked |
   | 3478 | UDP | TURN, the relay for anyone UDP-blocked entirely |
   | 50000-50100 | UDP | The media itself |

   Skipping 7881 and 3478 does not look like a mistake, because voice keeps working for most
   people. It fails for the one on hotel or office wifi, and it fails looking like a bug in
   the app.

   **Do not forward 4000 or 5432.** The operator console spawns processes, so exposing it to
   anything is remote code execution, and the database has no business being reachable at all.

2. **`use_external_ip: true`** in `livekit.yaml`, with `node_ip` commented out. LiveKit then
   finds the public address over STUN at startup instead of advertising a `192.168.x.x` that
   nobody outside can route to.

3. **`LIVEKIT_URL`** in `apps/server/.env` set to `ws://<your-public-ip>:7880`.

4. **Firewall**, once, elevated — the LAN rules are scoped to `LocalSubnet` and will keep
   outsiders out no matter what the router does:

```bash
powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1 -Internet
```

   It prints the public address it found and what is left to do. `-Remove` closes the ports
   again, and re-running without `-Internet` narrows them back to the LAN.

Friends then set their server address to `http://<your-public-ip>:3000`.

Two things worth knowing before leaving this up:

- **The public address is a lease and it will move.** When it does, everyone outside the house
  stops being able to connect, and voice stays broken even after they find the new address
  until `LIVEKIT_URL` is updated too. A dynamic DNS hostname in both places costs nothing and
  removes the whole failure mode.
- **There is no TLS anywhere in this** — plain HTTP and plain `ws://`, which is why the
  client authenticates with a bearer token rather than a cookie. Passwords and messages cross
  the internet in the clear, and anyone who finds port 3000 reaches the login and register
  endpoints; registration is only as closed as your invite codes. That is a reasonable trade
  for testing with ten friends and a bad one for anything you would mind being read.

## Database

PostgreSQL 17 runs as a Windows service (`postgresql-x64-17`) on `localhost:5432`. It starts
on boot, so nothing needs starting by hand.

The app connects as a dedicated **`chat_app`** role to a dedicated **`chat`** database — never
the `postgres` superuser. Both are created by `apps/server/prisma/setup-postgres.sql`, which
you run once as the superuser on a fresh machine:

```bash
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -f prisma\setup-postgres.sql
```

The role's password lives in `apps/server/.env` (`DATABASE_URL`). It is a local credential;
change it there and in the SQL for a real deployment.

> A previous iteration used `prisma dev` for a Docker-free database. It lost data twice and
> once left the tables referentially inconsistent, so it was replaced with the real service
> above. Do not go back to it.

## API

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | Also checks the database |
| GET | `/api/config` | LiveKit URL, upload limit — so the client hardcodes nothing |
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
| GET | `/api/guilds/:id/invites` | Admins only |
| POST | `/api/guilds/:id/members/:userId/mute` | `{ durationMinutes }`, null for indefinite |
| POST | `/api/guilds/:id/members/:userId/unmute` | Admins only |
| POST | `/api/guilds/:id/members/:userId/kick` | Removed; can return with a new invite |
| POST | `/api/guilds/:id/members/:userId/ban` | Removed, signed out, cannot rejoin |
| GET | `/api/guilds/:id/bans` | Admins only |
| DELETE | `/api/guilds/:id/bans/:userId` | Lifts the ban; does not restore membership |
| POST | `/api/channels/:id/voice-token` | LiveKit token, voice channels only |
| GET | `/api/voice/state` | Who is in which voice channel, right now |
| POST | `/api/livekit/webhook` | Called by LiveKit, not by clients; JWT-signed |
| — | `/api/auth/*` | Better Auth's own routes |

Moderation lives on the guild routes above, not under `/api/admin`: those answer "an admin of
anything?" for the operator console, whereas kicking someone has to ask "an admin of *this*
guild?". Muting, kicking and banning all refuse to act on yourself or on another admin — roles
are flat, so there is no hierarchy to rank two admins by; demote one from the console instead.

Admin routes, all requiring the ADMIN role:

| Method | Route |
|---|---|
| GET | `/api/admin/stats` |
| GET/POST | `/api/admin/users` |
| PATCH/DELETE | `/api/admin/users/:id` |
| POST | `/api/admin/users/:id/password` |
| GET | `/api/admin/invites` |
| POST | `/api/admin/invites/:id/revoke` |
| GET/POST | `/api/admin/guilds` |
| POST | `/api/admin/guilds/:id/channels` |
| PATCH/DELETE | `/api/admin/channels/:id` |
| GET | `/api/admin/channels/:id/messages` |
| DELETE | `/api/admin/messages/:id` |

Socket.IO events are declared in `packages/shared/src/index.ts`.

## Decisions worth not re-litigating

- **Ids are UUIDv7.** Time-sortable, so `ORDER BY id` is chronological and message paging needs
  no extra column. Generated in application code (`src/common/ids.ts`).
- **Cursor paging, never offset.** Offset breaks the moment a message arrives mid-scroll.
- **`clientNonce`** is echoed back so the client can render its own message instantly and drop
  the duplicate when the echo lands.
- **Socket auth is Socket.IO middleware, not `handleConnection`.** Nest does not await
  `handleConnection`, so an early `channel:join` can arrive before the session resolves.
- **Schema fields that nothing uses yet** — `editedAt`, `deletedAt`, `ChannelReadState`,
  `Channel.kind`, `GuildMember.role`, attachment `width`/`height` — are deliberate. Each is one
  line now and a migration plus client changes later.
- **`PermissionService` is called by every route** but currently only checks guild membership.
  Real rules land in that one file rather than a sweep through every controller.
- **Auth is bearer-token based**, not cookies. The desktop client will render from `file://`
  and a web dev server runs on another port; neither can carry a `SameSite` cookie without
  TLS. Cookies still work same-origin, so the `.http` file is unaffected.
- **Creating an account from the console still mints and consumes an invite** behind the
  scenes. That keeps one invariant — no account exists without an invite — instead of adding
  a second way in.
- **Better Auth owns its four tables.** Their shape came from Better Auth's own runtime, not
  guesswork; re-check with `getAuthTables()` after upgrading it or changing plugins.

### Voice

- **A LiveKit room per channel**, named `channel-<channelId>`, and the join token's `identity`
  is the user id. That means a LiveKit participant maps to a user with no lookup table.
- **Voice presence comes from LiveKit's webhooks**, not from the client. A LiveKit client only
  sees participants of rooms it has joined, so without the webhooks nobody could see who is
  sitting in a channel they have not entered.
- **Each webhook re-reads the room's participant list** instead of incrementing a counter. One
  localhost round trip, and in exchange a dropped, duplicated or out-of-order webhook cannot
  strand a ghost in a channel forever. LiveKit is the source of truth; the server caches.
- **The webhook route is mounted with a raw body parser** ahead of `express.json`, because the
  signature is over the raw bytes. Parsing first silently breaks verification.
- **Join tokens live ten minutes.** Signalling is plaintext, so a sniffed token should stop
  being useful quickly; it only has to survive the join.
- **The client uses core `livekit-client`, not `@livekit/components-react`.** The prebuilt
  components carry their own theme and the client is 120 lines of hand-written CSS. Swapping
  them in later is a UI change, not an architectural one.
- **Push-to-talk is `uiohook-napi`, not Electron's `globalShortcut`.** `globalShortcut` reports
  presses but never releases, so it cannot express "hold". If the native module fails to load,
  push-to-talk reports itself unavailable and everything else still works.
- **Screen capture needs the main process.** Electron has no built-in picker on Windows, so
  `getDisplayMedia` fails unless the app answers the request; `src/main/voice-main.ts` asks the
  renderer to show one. Whole screens are captured with the system audio mix, windows without.

## Not done yet

Emoji reactions, a theme toggle, non-image attachments, and auto-update.
