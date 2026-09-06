# Self-Hosted Discord Alternative — Development Lifecycle

Scope: ~10 users, single self-hosted server, .NET/C# stack. Stages are ordered so
each one produces something runnable before adding the next layer of complexity.

---

## Stage 0 — Project Setup

**Goal:** Empty skeleton that runs.

- Create solution: one ASP.NET Core Web API project, one client project (Blazor or Avalonia)
- Set up SQLite connection + EF Core, create initial (empty) DbContext
- Set up git repo, basic README
- Docker Compose file stub (server + Coturn, added to later)

**Done when:** API project runs locally, client project runs locally, they can hit a health-check endpoint.

---

## Stage 1 — Auth & Core Schema

**Goal:** Users can register/log in; core data model exists.

- Tables: `Users`, `Servers` (guilds), `Channels`, `ServerMembers`
- Register/login endpoints, JWT issuing
- `BCrypt.Net-Next` for password hashing
- Seed one default server + a couple of channels

**Tools:** EF Core, `Microsoft.AspNetCore.Authentication.JwtBearer`, `BCrypt.Net-Next`

**Done when:** Can register a user via API, log in, get a JWT back.

---

## Stage 2 — Text Chat (Real-Time)

**Goal:** Messages sent by one user appear live for others.

- `Messages` table (channel id, author id, content, timestamp)
- SignalR hub: `JoinChannel`, `SendMessage`, `ReceiveMessage`
- REST endpoint to fetch message history on channel load

**Tools:** `Microsoft.AspNetCore.SignalR`

**Done when:** Two logged-in clients in the same channel see each other's messages in real time.

---

## Stage 3 — Client Shell

**Goal:** A real UI wraps Stage 1–2, not just API calls.

- Login screen
- Server/channel list sidebar
- Chat window: message list + input box
- Wire client SignalR connection to the hub

**Tools:** Avalonia + `CommunityToolkit.Mvvm`, or Blazor

**Done when:** You can log in, pick a channel, and chat with a friend from two separate machines.

---

## Stage 4 — Presence & Typing

**Goal:** See who's online and who's typing.

- Track connection state in the SignalR hub (`OnConnectedAsync` / `OnDisconnectedAsync`)
- Broadcast presence changes (online/offline) to relevant clients
- Broadcast typing start/stop events, debounced client-side

**Done when:** Sidebar shows accurate online/offline status; a "user is typing…" indicator appears.

---

## Stage 5 — File & Image Attachments

**Goal:** Send images/files in a channel.

- Upload endpoint: save to disk (`/data/uploads/{guid}`), store metadata (filename, size, uploader, message id) in DB
- Download endpoint: auth-checked, streams file back
- Client: attach-file button, inline image preview in chat

**Done when:** You can drag an image into a channel and it renders inline for everyone.

---

## Stage 6 — Voice Signaling

**Goal:** Clients can negotiate a voice connection through the server (no audio yet).

- Add `JoinVoiceChannel`, `LeaveVoiceChannel`, `SendSignal` (SDP offer/answer, ICE candidates) methods to the SignalR hub
- Track who's "in" which voice channel (in-memory or DB)
- Client: voice channel list, join/leave buttons, log signaling messages to console for now

**Done when:** Two clients can exchange SDP/ICE messages through the server and log them correctly.

---

## Stage 7 — P2P Voice (Mesh)

**Goal:** Actual audio between two people.

- Integrate WebRTC peer connection: `SIPSorcery` (C# client) or native browser WebRTC (if Blazor)
- Wire local mic capture → peer connection → remote audio playback
- Extend to full mesh for 3+ participants in one voice channel

**Tools:** `SIPSorcery`, `SIPSorceryMedia.*` (or browser-native WebRTC)

**Done when:** You and a friend can talk to each other live; a 3-person channel works too.

---

## Stage 8 — TURN/STUN Fallback

**Goal:** Voice works even when direct P2P connection fails (symmetric NAT, strict firewalls).

- Deploy **Coturn** alongside your server (Docker Compose)
- Configure ICE servers list (STUN + TURN with credentials) on the client
- Test with a friend on a different network/ISP

**Done when:** Voice still connects for the "problem" friend whose direct connection previously failed.

---

## Stage 9 — Roles, Permissions & Invites

**Goal:** Basic server management.

- `Roles` table: Admin / Member is enough to start
- Permission checks: who can create channels, kick/ban, manage roles
- Invite links: generate a code, redemption endpoint adds user to server

**Done when:** A non-admin can be invited, joins, and correctly cannot access admin-only actions.

---

## Stage 10 — Polish

**Goal:** Quality-of-life features that make it feel like a finished app.

- Mute/deafen controls, visual "speaking" indicator per user
- Message editing/deletion
- Read receipts or unread-message markers
- Basic emoji reactions
- Dark/light theme

**Done when:** It's pleasant to use day-to-day, not just functional.

---

## Stage 11 — Stretch Goals (optional, only if it feels worth it)

- Screen sharing (extend the WebRTC connection to a second video track)
- Bots/webhooks (simple HTTP callback system for channel events)
- Swap mesh voice for a self-hosted SFU (LiveKit/mediasoup) if a channel ever needs more than ~8 simultaneous speakers
- Mobile client
- Message search
