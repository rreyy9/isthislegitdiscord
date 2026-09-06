# Self-Hosted Discord Alternative — Development Lifecycle

Scope: ~10 friends, one self-hosted box, bare IP and ports, installed desktop app.

**Principle:** every hard part is handled by an existing open-source project you install and
configure. You write the chat app and nothing else — no media code, no NAT traversal, no audio
pipeline, no password hashing, no encryption.

**Second principle, added because I kept violating it:** this is ten friends. It does not need
to be secure against a determined attacker, it does not need to scale, and it does not need
anything clever. If a step feels like infrastructure work rather than app work, it is probably
not needed.

---

## Security: password + invite code. That is all.

- **Better Auth** handles registration, login, password hashing, and sessions. You configure it;
  you do not write it.
- **Registration requires an invite code you issue.** No open signup. This is what makes it "only
  specific people" — an account cannot exist without a code from you.
- Nothing else.

No IP allowlist (breaks constantly on home connections with changing IPs). No certificates, no
CA, no key files. Traffic runs over plain HTTP on your IP.

The honest one-line trade: passwords and messages cross the network unencrypted, so someone
positioned on the network path could read them. Among friends on home connections that is a
reasonable line to draw, and it is the line you have drawn. **Voice audio is encrypted regardless**
— WebRTC has no unencrypted mode, so that part is safe whatever else you do.

> Your key-file idea would have worked, and it was a sound instinct. I dropped it because invite
> codes already give you "only specific people," while keys add a file nobody can lose and force
> your networking into the Electron main process. If you ever want it later it slots in cleanly —
> it is not a decision you are closing off now.

---

## Why Electron, specifically

`getUserMedia` only exists in a **secure context**. In a browser on `http://203.0.113.10:3000`,
`navigator.mediaDevices` is `undefined` — no microphone, no voice, no workaround. A secure context
means HTTPS, `localhost`, or **`file://`** — and an Electron renderer loads from `file://`.

So Electron gives you a working microphone over plain HTTP with no certificate. A web client would
need TLS you do not have. This is the decision the whole plan rests on, and your no-domain
constraint is what confirms it.

---

## What Discord and the alternatives actually do

| Piece | Discord | Revolt | Element | Mattermost | **You** |
|---|---|---|---|---|---|
| Desktop app | Electron | Electron | Electron | Electron | **Electron** |
| UI | React + TS | React + TS | React + TS | React + TS | **React + TS** |
| Events | WebSocket | WebSocket | WebSocket | WebSocket | **Socket.IO** |
| Voice | **SFU** | **LiveKit** | **LiveKit** | SFU | **LiveKit** |
| NAT | their SFU | LiveKit TURN | LiveKit TURN | coturn | **LiveKit TURN** |

Correcting two things from my earlier drafts: **Discord has never used mesh P2P voice** — they run
an SFU and always have — and **coturn is not needed**, because LiveKit has TURN built in. My
original "build mesh WebRTC, add TURN later" plan had you building the one thing nobody builds.
That was most of the risk in the project, and it is now gone.

---

## Stack

TypeScript both sides — the client has no choice, since **LiveKit has no .NET or Blazor client
SDK**, and one language means server and client import the same types instead of you keeping two
copies in sync.

| Layer | Choice |
|---|---|
| Language | TypeScript, Node 22 LTS |
| Repo | pnpm workspace: `apps/server`, `apps/desktop`, `packages/shared` |
| Server | NestJS (`nest g resource` scaffolds most of what you need) |
| Database | Postgres + Prisma |
| Auth | Better Auth |
| Voice / screen share | LiveKit, self-hosted |
| ↳ server side | `livekit-server-sdk` |
| ↳ client side | `livekit-client` + `@livekit/components-react` |
| Desktop | Electron + `electron-vite` |
| Push-to-talk | `uiohook-napi` |
| Files | Local disk |

> **Worth knowing before you start:** Revolt and Spacebar are finished open-source Discord
> alternatives that deploy with Docker Compose in an afternoon. If you want a working chat server
> rather than the experience of building one, use one of those.

---

## Stage 0 — Get the infrastructure up and prove voice works

`docker-compose.yml` with two services: Postgres and LiveKit. That is the whole file.

In `livekit.yaml`: your own API key and secret (**not** `--dev` mode, which hardcodes a
publicly-known key pair), and TURN over UDP enabled. No TLS section.

**One setting that will otherwise cost you an evening:** set `rtc.use_external_ip: true`. On a
bare-IP host this is the top cause of "it connects but nobody can hear anything" — the server
advertises the wrong address and media never flows.

Open the ports listed in your generated `livekit.yaml` — signalling, the WebRTC UDP range, and
TURN.

**Then prove it before writing any code.** Clone `livekit-examples/meet`, run it locally on
`http://localhost:3000`, point it at `ws://YOUR_IP:7880`, and call a friend on another ISP. Not
the hosted `meet.livekit.io` — that is HTTPS and will block a plain `ws://` connection.

This is the most valuable half-hour in the project. Afterwards, every voice problem is in your
code, not your setup, and you never have to wonder which.

**Done when:** you and a friend on different networks hold a call through your server, using
LiveKit's app, not yours.

---

## Stage 1 — Server and login

- pnpm workspace, Prisma schema, first migration
- Better Auth for registration/login/sessions
- Invite codes: a table, an admin route to make one, registration requires one
- `GET /api/config` returning the LiveKit URL, so it is not baked into the shipped app

Three small things to fix now because they are free now and annoying later:

- **UUIDv7 for IDs** — time-sortable, so paging messages is just `ORDER BY id`
- **UTC everywhere**, formatted at the client
- **A permission guard that returns `true`**, applied to every route. Stage 6 fills it in instead
  of you editing every controller.

Call the entity `Guild`, not `Server` — you already have two other things called "server."

---

## Stage 2 — Schema and text chat

Prisma models: `Guild`, `Channel`, `GuildMember`, `Message`, `ChannelReadState`.

Add these fields now even though nothing uses them yet — each is one line today and a migration
plus client changes later: `Channel.kind` (TEXT/VOICE), `GuildMember.role` (ADMIN/MEMBER),
`Message.editedAt`, `Message.deletedAt`, `Message.clientNonce`.

- Socket.IO gateway, payload types from `packages/shared`
- History route paged by cursor: `?before={messageId}&limit=50`. No harder than offset paging, and
  offset breaks as soon as a message arrives while someone is scrolling.
- `clientNonce` lets the client show its own message instantly and drop the duplicate when the
  echo arrives. Without it, every message you send visibly lags.

---

## Stage 3 — The Electron app

- Electron + React + TS via `electron-vite`
- Login screen, session token stored with `safeStorage`
- Channel sidebar, message list, scroll-up to load more
- **Server address configurable in-app**, not hardcoded — with no DNS, an IP change otherwise
  means rebuilding and redistributing the app
- Socket.IO auto-reconnect, **and refetch messages since the last seen ID on reconnect**. Without
  this, closing a laptop lid silently loses messages, and it is a confusing bug to track down later.

---

## Stage 4 — Presence and typing

- Count connections per user rather than storing a boolean — someone running two machines
  otherwise shows as offline when they close one
- Typing indicator, debounced, with a server-side timeout so a crashed client does not leave
  "…is typing" stuck forever

---

## Stage 5 — Attachments

- `Attachment` model with `width`/`height` for images, so the message list reserves space and does
  not jump around while images load
- Upload to disk by UUID; download route checks auth and streams
- Drag-and-drop, and **paste-a-screenshot**, which is the one people actually use

---

## Stage 6 — Voice, roles, invites

**Voice is one route and a component.** Server: check the permission guard, mint a LiveKit token
with `livekit-server-sdk` for a room named after the channel. Client: `livekit-client` plus
`@livekit/components-react`, which give you mute, deafen, device pickers, speaking indicators,
reconnection, and screen share as prebuilt pieces.

No SDP, no ICE, no signalling code, no mesh, no coturn.

Two additions worth making here:

- **Voice presence in the sidebar:** subscribe to LiveKit's webhooks server-side, relay the
  participant list over Socket.IO
- **Push-to-talk:** `uiohook-napi` gives you key-down and key-up globally. Electron's
  `globalShortcut` only reports presses, so it cannot do hold-to-talk.

Then fill in the permission guard for real and add admin actions — create/delete channels, kick,
change roles — plus invite code management. The guard and the `role` field already exist, so this
is one file.

**Done when:** four people are in a voice channel, one is screen sharing, and push-to-talk works
while a game has focus.

---

## Stage 7 — Polish

Message edit and delete, unread markers, emoji reactions, theme following the OS, tray icon,
minimize to tray, start on login, native notifications for mentions, single-instance lock.

---

## Stage 8 — Later, if you want it

Bots and webhooks, Postgres full-text search, video calls (already in LiveKit — it is a layout
problem, not a media problem), auto-update, and TLS.

Distribute updates by hand for now: send the installer, or drop it in a channel. Ten people, and
`electron-updater` over plain HTTP would let anyone on the network path serve a malicious
installer your app runs automatically. Manual is both simpler and safer here.

---

## Operations

- **Backup:** `pg_dump` on a cron plus the uploads folder. Restore it once into a scratch
  container before you invite anyone, so you know it works.
- **Deploy:** `git pull && docker compose up -d --build`.
- Ports open to the internet will be found by scanners within days. Registration is invite-gated
  so they cannot get in, but do not run anything else interesting on that box.

---

## Deliberately not doing

Listed so it stays cut: mesh WebRTC, coturn, a reverse proxy, TLS certificates, a private CA,
client certificates, IP allowlists, refresh token rotation, 2FA, S3/MinIO, an SFU migration path,
a web client, and a mobile client.

---

## Sources

- [Revolt: voice moving to LiveKit](https://github.com/orgs/stoatchat/discussions/593)
- [LiveKit self-hosting](https://docs.livekit.io/transport/self-hosting/deployment/)
- [LiveKit over `ws://` on a LAN, no TLS](https://www.linen.dev/s/livekit-users/t/32816833/i-want-self-hosted-the-livekit-in-my-own-machine-please-guid)
- [LiveKit client SDK list](https://docs.livekit.io/home/client/connect/)
- [MDN: `getUserMedia` secure contexts include `file://`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Lucia deprecated, use Better Auth](https://www.nodejs-security.com/blog/nodejs-authentication-migration-from-lucia-to-better-auth)
