# Progress

_Last updated: 2026-09-04_

Build log for the self-hosted chat/voice app. Plan and reasoning live in
[discord-alternative-dev-lifecycle-v2.md](discord-alternative-dev-lifecycle-v2.md);
setup and API reference live in [README.md](README.md). This file tracks what is actually
built and working.

---

## Where it stands

Text chat and voice are both built. The **server**, the **operator console** and the
**desktop client** all run, and voice — join, mute, deafen, device pickers, screen share,
push-to-talk, and occupants shown in the sidebar — is written end to end.

LiveKit is installed and runs (v1.13.6, single binary, no Docker) via
[infra/livekit/start.ps1](infra/livekit/start.ps1). **Voice works** — a real two-client call
was made on 2026-09-04: both participants joined, both published microphone tracks, and the
webhooks reached the chat server (`200 OK`) so occupants appeared in the sidebar.

**Working across two machines on the LAN** as of 2026-09-04: chat and voice both, from the
packaged installer on a second box pointed at `http://192.168.1.230:3000`.

Voice audio settings (server-set Opus quality, capture toggles, input sensitivity, incoming
levelling) are written and their logic is unit-tested, but they have not yet been through a
real two-machine call — see the check on echo below.

Still untested: anything over the internet. A LAN has no NAT between peers, so TURN,
`use_external_ip` and router port forwarding have still never been exercised — that is the
last real unknown in the voice work.

```
packages/shared     Zod schemas + Socket.IO event types, imported by server and client
apps/server         NestJS + Prisma + Better Auth + Socket.IO      ✅ working
apps/console        Operator console (supervise server + admin UI) ✅ working
apps/desktop        Electron + React + TypeScript client           ✅ working
infra/livekit       LiveKit 1.13.6 + config + start script         ✅ running
```

Stack, all locked and running: **TypeScript** everywhere · **PostgreSQL 17** (native Windows
service, not Docker) · **NestJS** · **Prisma 7** · **Better Auth** (bearer tokens) ·
**Socket.IO** · **Electron + React** · **LiveKit** for voice.

---

## Done

### Server (`apps/server`)
- Auth via Better Auth: register, login, sessions, password hashing, lockout
- **Invite-gated registration** — no account can exist without a code; first account to use a
  guild's code becomes its admin (self-bootstrapping)
- **Bearer-token auth** (not cookies) so the `file://` desktop renderer and any web dev server
  can authenticate without TLS-bound cookies
- Guilds, channels (TEXT/VOICE), members, roles (ADMIN/MEMBER)
- Real-time text chat over a strongly-typed Socket.IO gateway
- Cursor-paged message history (`?before=<id>&limit=50`), ordered by UUIDv7 id
- `clientNonce` echo for optimistic send + de-duplication
- Presence (connection-counted, not boolean) and typing indicators with server-side TTL
- LiveKit voice-token endpoint: one room per channel (`channel-<id>`), token identity is the
  user id, ten-minute TTL
- **Voice presence from LiveKit webhooks** — `POST /api/livekit/webhook`, JWT-signature
  verified over the raw body, relayed to clients as `voice:participants`; `GET /api/voice/state`
  gives a client the snapshot it needs on connect
- **Message edit and delete** — `PATCH`/`DELETE` on a message. Only the author can edit
  (an admin may delete what you said, never rewrite it); the author or a guild admin can
  delete. Deletion is soft and records `deletedById`
- **Moderation: mute, kick, ban** on `/api/guilds/:id/members/:userId/*`. A mute is a
  deadline (`GuildMember.mutedUntil`), so it lifts itself with no timer and no sweeper; it
  blocks sending, editing and voice, and drops the person from any call they are in.
  Kick removes the membership; ban removes it and leaves a `GuildBan` row that blocks the
  way back, kills their sessions, and is listed and liftable from the client
- **The permission seam is now real** — `PermissionService` holds the action matrix
  (admin-only actions, and what a mute takes away) instead of only checking membership
- Admin API: stats, user CRUD + password reset, invite create/revoke, guild/channel
  create/rename/delete, message soft-delete — all behind an admin guard
- Safeguards: cannot demote the last admin, delete a guild's last channel, delete your own
  account, or moderate yourself or another admin — roles are flat, so demote first
- `@nestjs/throttler` rate limiting; Serilog-style logging; `/api/health`, `/api/config`
- `requests.http` exercises the whole API

### Operator console (`apps/console`)
- Separate supervisor process (a web UI can't start the server that serves it)
- **Binds to 127.0.0.1 only** — it spawns processes, so it must never be network-reachable
- Start / stop / restart the server; run build, migrate, seed, generate as tasks
- Live log streaming from the server's stdout/stderr
- Admin UI (after signing in): accounts, invites, channels, guilds, live stats
- **Stop things**: kill the chat server, LiveKit or the Postgres service — or all three.
  Acts on whatever holds the port, so it clears instances the console did not start; matches
  processes by port and never by image name, so it cannot kill itself or unrelated Node
  processes. Stopping the database needs an elevated terminal and says so when it lacks one
- Status pills for server, database and voice
- No build step — one HTML file
- Verified by driving the real UI in a browser

### Desktop client (`apps/desktop`)
- Electron + React + TypeScript via electron-vite
- Login / register with invite codes; configurable server address
- Token stored via **`safeStorage`** (DPAPI-encrypted on Windows), through an IPC bridge —
  never plaintext; stays signed in across restarts
- Channel sidebar, live message list, members panel with online/offline
- **Optimistic send** reconciled with the server echo by `clientNonce`
- Typing indicators; connection-status dot (live / reconnecting / offline)
- **Reconnect backfill** — refetches messages missed while the socket was down, so a slept
  laptop doesn't silently lose messages
- Infinite scroll upward through history, holding scroll position
- **Clickable links**, opened in the real browser via `setWindowOpenHandler` — never in an
  Electron window, which has no address bar and is a good way to be phished
- **YouTube embeds**: a still image with a play button, swapped for a
  `youtube-nocookie.com` player only when clicked, so scrolling past a link loads no
  third-party frame. Honours `?t=` timestamps
- **Paste or drag an image** (Ctrl+V a screenshot) — staged as thumbnails in the composer,
  removable before sending, shown optimistically before the server echo
- **Unread markers** per channel, from the `ChannelReadState` table that had sat unused
- **Date separators** — Today / Yesterday / the date, and a day boundary always starts a new
  message block
- **Edit and delete your own messages** — hover a message for the toolbar; enter saves,
  escape cancels, and emptying a message offers to delete it, the way Discord behaves.
  Edited messages carry an "(edited)" mark
- **Moderation from the member list** — admins get a ⋯ menu per member: mute for 5 minutes,
  an hour, a day, a week or indefinitely; unmute; kick; ban. Kick and ban ask first. Admins
  can delete anyone's message from the same hover toolbar. A ban list modal lifts bans
- **Being moderated is visible** — a mute marker beside the name, the composer disabled with
  the deadline in its placeholder (and it re-enables itself when the mute expires), and a
  modal that explains it and signs you out if you are kicked or banned

### Voice (`apps/desktop` + `apps/server` + `infra/livekit`)
- Click a voice channel to join, click again to leave; a connected panel above the account
  footer with mute, deafen, screen share, settings and leave
- **Occupants under every voice channel**, including channels you have not joined — that is
  what the webhooks buy — with a speaking ring, a muted icon and a sharing icon for the room
  you are actually in
- **Screen share** with a source picker built from `desktopCapturer` (Electron ships none on
  Windows); whole screens carry the system audio mix, so a shared game is audible
- Shared screens render in a band above the message list; double-click to expand
- **Push-to-talk** via `uiohook-napi`, so it works while a game has focus; bind a key by
  pressing it. Degrades to "unavailable" rather than crashing if the native module will not load
- Microphone and output device pickers, persisted in `settings.json` and applied to a live call
- One rule decides whether the mic is open: manual mute beats everything, and with
  push-to-talk on the mic is live only while the key is held
- Reconnect, TURN fallback and echo cancellation are LiveKit's, not ours
- **Opus quality set on the server**, not per client — `VOICE_QUALITY` in `apps/server/.env`
  picks one of voice/balanced/high/studio, and it rides along with the join token so a change
  reaches everyone on their next join. It belongs to the deployment because the bitrate
  everyone publishes at is what the host's uplink carries. RED (packet-loss repair) on for
  every mono preset; DTX only on the lowest, since it clips word onsets
- **Capture toggles** in voice settings — echo cancellation, noise suppression, automatic gain.
  All three are Chromium's, applied at `getUserMedia`, so changing one restarts the microphone
- **Input sensitivity** — off, automatic, or a manual threshold with a live meter and the
  threshold drawn on it. Automatic listens to the room for 300ms on join and sits a fixed
  margin above what it heard; guessing a floor and creeping toward it instead meant ~8 seconds
  of broadcasting a noisy room before it caught up
- **Incoming voices levelled** — whoever is much louder than the rest is turned down over a
  couple of seconds, recovering over about fifteen. Attenuation only: without `webAudioMix` a
  remote track's volume is an HTMLMediaElement `volume`, which caps at 1.0, and turning
  `webAudioMix` on to get a gain node would put every remote stream through Web Audio and
  inherit a Chromium quirk about the echo canceller's reference signal. The other direction is
  each person's own automatic gain, before their audio is ever encoded
- **None of the above touches the media.** Every analyser is a tap connected to no destination;
  the gate mutes the same published track push-to-talk does. Worst case for a bug in any of it
  is a wrong number on a meter, never a degraded call
- The gate meters a *clone* of the microphone track. Metering the published one would read
  silence the moment the gate muted it, and the mic would never open again
- `backgroundThrottling: false` on the window — Chromium throttles timers to ~1/sec when a
  window is hidden, and the level polling that drives the gate is a renderer timer. Audio
  itself was never at risk; capture, Opus and the jitter buffer are all native real-time
  threads

### Packaging (`apps/desktop`)
- **electron-builder** produces `release/isthislegit-0.1.0-setup.exe` (~111 MB), a per-user
  NSIS install needing no administrator
- `asarUnpack` covers `uiohook-napi` — a `.node` binary cannot load from inside an asar, and
  the failure is silent, so push-to-talk would break only in packaged builds
- `electronVersion` pinned in the build config, because Electron is hoisted to the workspace
  root and electron-builder cannot resolve a range from `apps/desktop`
- Verified: native module lands in `app.asar.unpacked` with the `win32-x64` prebuild, the
  renderer is inside the asar at the path main loads, and the packaged exe launches and stays up

### Infrastructure
- Migrated off `prisma dev` (it lost data twice) to a real **PostgreSQL 17** Windows service
- App connects as a dedicated `chat_app` role to a `chat` database — never the superuser;
  one-time setup in `prisma/setup-postgres.sql`
- Data verified to survive full server restarts
- **LAN access**: LiveKit advertises `node_ip: 192.168.1.230` (explicit, because this box has
  four IPv4 interfaces and picking the wrong one is silent breakage), `LIVEKIT_URL` points at
  the same address, and `infra/allow-lan.ps1` adds firewall rules scoped to `LocalSubnet`

---

## Known bugs fixed along the way
- **Better Auth `Account.issuer`** — schema was missing a required field; found the correct
  shape from Better Auth's own `getAuthTables()` runtime rather than guessing
- **Prisma 7 ESM `.ts` imports** broke after compile → `moduleFormat=cjs` + `importFileExtension=js`
- **Socket.IO auth race** — Nest doesn't await `handleConnection`, so `channel:join` could beat
  the session; moved auth into awaited Socket.IO middleware
- **`prisma dev` template1 trap** — new DBs (incl. the migrate shadow DB) clone from template1,
  colliding migrations; resolved by moving to real Postgres
- **electron-vite dev crash (`Missing field moduleType`)** — `@vitejs/plugin-react@6` pulls
  Vite 8 (rolldown) while electron-vite uses Vite 7; pinned plugin-react to v5 and added a root
  `overrides: { vite: ^7.3.6 }`
- **`start.ps1` would not parse** — the file was UTF-8 without a BOM and contained an em dash.
  Windows PowerShell 5.1 reads a BOM-less `.ps1` as Windows-1252, so those bytes became `â€”`,
  and the trailing `”` is a smart quote the parser treats as a string delimiter. Script is now
  ASCII-only *and* BOM'd. Keep `.ps1` files ASCII
- **Duplicate React keys in the members panel** — `/api/members` returns one row per
  *membership*, so anyone in two guilds arrived twice and collided on `key={user.id}`. It only
  showed up once a second guild existed. The panel lists people, not memberships, so the client
  now dedupes by user id (keeping the ADMIN row if they hold it in any guild)
- **URL regex swallowed trailing punctuation** — `https://example.com/a.` linked the full stop
  as part of the address. Caught by unit-testing the parser rather than by reading it; the
  helpers live in `link-utils.ts` precisely so they can be exercised
- **CSP would have blocked both new features silently** — iframes fall back to `default-src`
  (no YouTube) and `img-src` had no `blob:` (no attachments). Widened to exactly the two
  YouTube origins and `blob:`, nothing more

---

## Not done yet
- **Confirm the new audio settings on a real two-machine call.** The logic is tested; the
  behaviour is not. Specifically worth checking, in this order: that echo cancellation still
  works on speakers (nothing here should have changed it, since remote audio still plays
  through its own element rather than Web Audio); that automatic sensitivity opens fast enough
  not to clip the first word; and that `high` actually sounds better than `balanced` before
  anyone pays the bandwidth for it
- **Going live on the internet** — port forwarding, `use_external_ip: true`, a public
  `LIVEKIT_URL`, and firewall rules widened past `LocalSubnet`. This is where TURN and NAT
  traversal finally get exercised
- **Surviving a reboot** — Postgres is a service and starts on boot, but the chat server and
  LiveKit are both started by hand. Ten people relying on this means it cannot need a person
  after every power cut
- **Backups** — nothing exists. `pg_dump` on a schedule, and a restore actually tried once
- **`BETTER_AUTH_SECRET` is still the placeholder** from `.env.example`. Regenerate it before
  the server is reachable from the internet; changing it invalidates existing sessions
- **Port forwarding** — LiveKit found the external IP via STUN but could not validate it
  (the router does not hairpin). Fine locally; 7880/7881 TCP, 3478 UDP and 50000-50100 UDP
  have to be forwarded before anyone outside can connect
- **Non-image attachments** — only images are accepted today. A general file host that anyone
  with an invite can write to, over plain HTTP, is a bigger thing to own than a screenshot pipe
- **Emoji reactions**, theme toggle
- **Auto-update** — deliberately not done; hand the installer over instead
- **Real deployment** — run the server on the actual box with the public IP, open ports

---

## How to run everything (dev)

PostgreSQL runs as a service, so there's nothing to start for the database.

```bash
# 1. server + admin console (one process, supervises the server)
cd C:\Users\kreso\isthislegitdiscord && npm run console
#    -> open http://127.0.0.1:4000, click "Start server"

# 2. LiveKit, for voice (runs in the foreground; leave the window open)
powershell -ExecutionPolicy Bypass -File infra\livekit\start.ps1

# 3. desktop client, with hot reload
cd C:\Users\kreso\isthislegitdiscord\apps\desktop && npm run dev
```

Test accounts on the current database: `kreso` (admin) and `dave` (member). Passwords are
deliberately not written down here — this file is in git, next to `.env`. Reset either from
the console's Accounts tab, and make fresh invite codes from its Invites tab.

**Never `taskkill /IM node.exe`** — it kills Postgres too. Stop things by port instead.
