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
- [Updating the client](#updating-the-client) · [Older clients](#older-clients)
- [Configuration](#configuration) · [Going public](#going-public) · [Database](#database) · [Backups](#backups) · [Retention](#retention)
- [Voice quality](#voice-quality) · [Mentions](#mentions) · [Pinned messages](#pinned-messages)
- [Replies and forwards](#replies-and-forwards)
- [Search](#search) · [Attachments](#attachments) · [API](#api) · [Tests](#tests) · [Logs](#logs)
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
infra/backup.ps1     pg_dump + uploads, verified, on a schedule
infra/restore.ps1    Puts one back -- into a scratch database by default
infra/allow-lan.ps1  Firewall rules
infra/publish-desktop-update.ps1  Uploads a built client to the server and publishes it
data/uploads         Uploaded images on disk, named by id
data/updates/desktop Published client builds: latest.yml, the installer, its blockmap
data/updates/staging An uploaded build, before it is published
data/logs            server-YYYY-MM-DD.log, 30 days
```

Everything is TypeScript except the console, which is plain ESM with no build step.
Tests are Vitest, run from the root with `npm test` -- see [Tests](#tests).

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

**Process control has two backends, and picks per action.** In a development checkout the
console spawns the server, LiveKit and Caddy as its own children. On an installed box it
drives the three SYSTEM scheduled tasks the installer registered — because that is what is
actually running there, and what will be running again after the next reboot. Spawning a
child instead would give a server that dies with the console and a task that fights it for
the port.

> This is why it is two backends and not one. The console only ever managed its own
> children, so on every installed box **Stop** and **Restart** were greyed out over a
> status line reading *"running, but not started by this console — stop it in its own
> terminal to manage it here"*. There is no terminal: the task scheduler started it before
> anybody logged in. Stopping is now layered — end the task, wait for the port to go quiet,
> and force-kill whatever still holds it, which also clears a copy somebody left running
> elsewhere.

The tasks run as SYSTEM, so **starting and stopping them needs an elevated console.** It
checks with `fltmc` and says so on the Process card before anything is clicked, rather than
letting the first press come back "Access is denied"; either way the error carries the
`schtasks` command to run by hand.

**Start server** starts the chat server, LiveKit, and — in internet mode only — Caddy.
**Start database** starts the PostgreSQL service. The rest of it is build, migrate, seed,
the invite code, accounts, guilds and channels, storage, retention, updates, and the
deployment configuration.

### The VS Code tasks

Two things to run, two things to compile, and [the two installers](#the-two-installers).

| Task | What it is |
|---|---|
| **Console** | The isthislegit Server window, and everything above |
| **Desktop app (dev)** | `electron-vite dev` — the client, against `localhost:3000` |
| **Compile server** | `packages/shared` then `apps/server`. The fast inner loop |
| **Typecheck client** | `tsc --noEmit` over `apps/desktop` |
| **Set version** | Asks for a version and writes it to every `package.json` and the lockfile |
| **Build and package server** | → `release\isthislegit-server-<v>-setup.exe`, for the server machine |
| **Build and package client** | → `apps\desktop\release\isthislegit-<v>-setup.exe`, for everyone else |

Nothing else is a task, because everything else is a button in the console — and a button
also tells you whether the thing worked.

**The two packaging tasks are here because the console cannot do either.** It administers
the box it runs on, and both installers are built on a development machine and carried
somewhere else — the server's to the server box by hand, the client's to the server over
the network by [the publish script](#updating-the-client). Neither is a thing the machine
receiving it can build for itself.

**Compile server is not one of them.** It is the same `npm run build` the console's Build
button runs, kept as a task because it is what catches a type error without leaving the
editor. The console's version can Restart the server afterwards, which this cannot.

**The client typecheck is a separate step on purpose.** electron-vite strips types with
esbuild and never checks them, so packaging alone will happily ship code that does not
compile. Packaging the client depends on the typecheck rather than trusting the bundler to
notice.

**Every package in the workspace shares one version number**, and **Set version** is how it
moves — `npm version <v> --workspaces --include-workspace-root`, so the six `package.json`
files and `package-lock.json` cannot drift apart. Do it before packaging a client: the
client's copy of that number is what electron-builder stamps into `latest.yml`, publishing
refuses a version that is not newer than the published one, and an installed client only
offers an update when the published version is higher than its own. The server's copy is
what `/api/config` reports as `appVersion`.

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

Both are VS Code tasks — **Build and package server** and **Build and package client**.
The client one produces the three files an update is made of: the installer, its
`.blockmap` and `latest.yml`. That is the same build [publishing](#updating-the-client)
sends to the server, so somebody's first install and every update after it come out of one
command.

The server installer needs `livekit-server.exe` and `caddy.exe` to be present in
`infra/livekit/bin` and `infra/caddy/bin`. Both are gitignored downloads — see
[Requirements](#requirements) — and the build **warns and carries on** rather than failing
if one is missing, so an installer built without them looks finished and arrives on the
server box with no voice or no TLS.

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
- **The client has no auto-update yet.** Hand the installer over yourself. There is a
  design for one below, and because it reverses what this document used to say flatly, the
  reasoning is written out there rather than argued again here.

---

## Updating the client

Ten friends on ten machines, and every fix used to reach them as a 90 MB file handed over
by hand. The client now notices a new build and offers it; nobody is ever made to take it.

**`electron-updater` against a feed the chat server hosts itself.** It is the provider
electron-builder already ships with, and it wants a directory holding three files per
release: `latest.yml`, `isthislegit-<v>-setup.exe`, and the `.exe.blockmap` that turns the
second update into a delta rather than another full download.

**The feed URL is set at runtime, not baked into the build.** The client hardcodes nothing
else — the server address is a field on the sign-in screen, and `/api/config` exists so that
constants live on the server — and a compiled-in update URL would be the single exception.
So the app points the updater at whichever server it is signed in to:

```js
autoUpdater.setFeedURL({ provider: 'generic', url: `${serverAddress}/updates/desktop` })
```

One build then serves a LAN deployment and the public one, and nobody maintains a
per-deployment binary.

**The files are served without authentication.** The build already refuses to ship a `.env`
or a real key pair, so the installer carries no secret; and the moment auto-update matters
most is when somebody's session has lapsed and they are stranded on an old build. A feed
that needs a token is a feed that fails exactly then.

**TLS is the whole integrity guarantee, so auto-update is https-only.** The NSIS build is
unsigned, which means `electron-updater` cannot verify a publisher name. What it can verify
is the sha512 in `latest.yml` against the file it downloaded — so the chain is TLS
authenticating `latest.yml`, and `latest.yml` authenticating the executable. Over plain
`http` that chain has no root: anyone on the path can serve a `latest.yml` of their own and
the hash will match whatever they attached to it. The client therefore enables updates only
when its server address is `https:`, and says updates are unavailable over an unencrypted
connection rather than checking a feed it has no way to trust.

**The build happens here; the server is somewhere else, so the build has to travel.** That
is the whole shape of publishing. The client is built on a development machine, the server
runs on the box at the end of the DuckDNS name, and nothing on that box has ever seen
`apps/desktop/release`.

So there is a script, run from the machine that built the client:

```bash
powershell -ExecutionPolicy Bypass -File infra\publish-desktop-update.ps1 -ServerUrl https://isthislegit.duckdns.org -Username kreso
```

It reads `latest.yml`, finds the installer *that file names* rather than whatever `.exe` is
lying around in a folder full of old builds, checks against the server what is already
published before spending ten minutes uploading, asks for the password, uploads each file,
and publishes. `-StageOnly` stops after the upload so the last step can be a button in the
console instead.

**Uploads land in `data/updates/staging` and are served to nobody until they are published.**
A feed assembled in place would mean clients downloading an installer whose last few
megabytes were still in flight. A failed upload takes the whole staging set with it, because
a half-written installer is one whose sha512 cannot match and whose presence is worse than
its absence.

**The upload is a raw body, not multipart, and streams straight to disk.** The installer is
most of two hundred megabytes: buffering it would be silly, and `Invoke-WebRequest -InFile`
sends a raw body from Windows PowerShell 5.1 without anybody hand-rolling a multipart
encoder. Size is counted as it arrives rather than read from `Content-Length`, which is the
sender's claim about a body it has not finished writing.

**The server does the copying, and the promoting, and the telling.** It owns the feed
directory, so one definition of where updates live beats two that can disagree; and it is
the only party that can reach everyone — publishing emits `client:update-available`, and
both the script and the console report how many connected clients heard it. Building and
publishing stay two steps throughout, so a half-finished build cannot reach ten machines
merely by landing in the right folder.

The console's **Updates** tab shows what is published, what is uploaded and waiting, and who
is running what.

It used to also offer *publish from a folder on this machine*, which is gone. It was only
ever useful in a development checkout where the client and the server live in one tree, and
on the box this actually runs on the release folder is not there — so what it really was is
a route that took a filesystem path from the network and read files from it, for a
convenience that applied on one machine. Uploading is now the only way in, which is the way
that works everywhere. `UpdatesService.publish(sourceDir)` stayed: `publishStaged()` is that
method pointed at the staging directory.

**`electron-builder` needs a `publish` block or it writes no `latest.yml` at all.** There is
one in `apps/desktop/package.json`, pointing at the public deployment. That URL is never
used at runtime — the client sets its own feed from the server address — and it is there
purely because its presence is what makes the build emit a feed to publish.

**The server tells the client, and the client tells the user.** `/api/config` carries
`latestClientVersion`, so an app learns on connect that it is behind; and publishing a build
broadcasts `client:update-available` over the socket, so an app that has been open all
evening finds out without reconnecting. Either way it is a notice and not an interruption —
a pill in the corner, and the update installs when the user chooses to restart. Nobody is
stopped from chatting because a newer build exists; what happens in the meantime is
[Older clients](#older-clients).

**There is no fallback path, on purpose.** If the feed is unreachable, the download fails,
or the install is refused, the client says so once and carries on running the version it
has. It does not retry against a second host and it does not degrade into some other
mechanism. The recovery is the one that already works: hand somebody the `.exe`. Every
fallback would be a second update path, tested a tenth as often as the first, running on
ten machines that are not this one.

**Nothing restarts into an update during a call.** `autoDownload` is off and installing is a
button, so an update never closes a window somebody is typing in. The passive path is
`autoInstallOnAppQuit`: quit normally and the downloaded update is applied, which interrupts
nobody because quitting is already leaving. `quitAndInstall` refuses outright while the app
is in a voice channel — the renderer reports that state to main whenever it changes — since
restarting mid-call drops everybody else's audio with no warning.

**The server box keeps its manual installer.** Auto-updating the server app means the
process that serves the updates replacing itself while running, on the one machine that
also has three SYSTEM scheduled tasks pointing into its install directory. That installer
is already idempotent, it is one machine, and you are standing in front of it.

---

## Older clients

Updating is a notice rather than a gate, so somebody is always a version behind for a few
days. The app has to keep working for them.

**Most of this is already true, by construction.** The client never validates what the
server sends: a REST response is `JSON.parse` and a TypeScript type, and a socket payload is
a typed interface with no runtime check at all. Every schema in `packages/shared` is a plain
`z.object()`, which *strips* unknown keys instead of rejecting them. So a new field on an
existing response is invisible to an old client, and a new socket event it never registered
a handler for is dropped on the floor. **Forward compatibility is the current default, and
the work is keeping it rather than building it.**

Four rules keep it true:

- **Add; never rename, never remove.** A rename is a removal with extra steps — the old
  client reads `undefined` and draws a blank where a name used to be. Deprecate in place and
  delete once nobody is on a version that reads it.
- **No `.strict()`, ever, on a schema either side parses.** Strict turns "the other end
  added a field" into a 400. Plain `z.object()` is the compatible default and every schema
  in `packages/shared` is one today; that is worth not undoing by habit.
- **A new request field is optional, and the server decides what its absence means.** An old
  client cannot send a field it has never heard of, so a newly required one is a 400 on
  every message they try to post.
- **Prefer a new event to a changed one.** An old client ignores what it did not subscribe
  to, which makes "emit it and let old clients not see it" the cheapest way to ship
  anything.

**What still breaks comes in three shapes**, and only the middle one is worth building for:

- **A new field the old client does not draw.** Nothing breaks; the feature is merely
  invisible. This is the intended outcome, and it needs no work.
- **A message the old client draws *wrongly*.** The one worth spending on. When the server
  starts marking messages in a way an old client has no idea about — a reaction, a thread
  parent, an attachment that is not an image — drawing nothing is a lie about what was said.
  `MessageContent` now checks each attachment's `contentType` against the four image types
  it can actually render and draws *"This message has a &lt;type&gt; attachment this version
  cannot show — update to see it"* for anything else. One branch, written once, so the
  version that predates a feature already knows how to admit it. Silent is the failure mode
  this document keeps warning about, and this is the cheapest place to refuse it.
- **A change that cannot be made compatible.** Rare, and it means the rules above were not
  followed. That is what `minClientVersion` is for, below.

**The client says what it is, and that alone is most of the value.** `clientVersion` rides
in the socket handshake beside the token — `auth: { token, clientVersion }`, which the
gateway middleware already reads — and in an `X-Client-Version` header on REST calls. The
server clamps it to something short and printable and keeps it on the connection, in memory
and nowhere else: this is telemetry, not a record worth a table.

That costs almost nothing and buys the thing that is otherwise unknowable: the console's
**Updates** tab lists who is running what, and `GET /api/admin/clients` is where it comes
from. Which is precisely what says when a deprecated field is safe to delete. Without it,
compatibility code added for one release lives forever, because nobody can demonstrate it is
unused. Someone on two machines running two builds reports as the older one, since that is
the build constraining what the server can drop.

**If gating is ever needed, gate on capability rather than version number.** Comparing
versions means the server keeps a table of what every past release could do, which grows
without end and is wrong the moment somebody runs a dev build. A list of feature strings in
the same handshake lets the server ask the direct question — does this connection understand
reactions? — and answer it for a build that has no version number at all. Not needed on day
one. Worth knowing before the first event that would mislead an old client.

**`minClientVersion` is a floor, not a plan.** A server that blocks old clients has
converted a compatibility problem into ten people who cannot use the app until each of them
notices a dialog, which is strictly worse than the thing it was avoiding. It is for the
change that genuinely cannot be made compatible — an auth change, a security fix — and
reaching for it is evidence the additive rules were not followed. It exists: set
`MIN_CLIENT_VERSION` in `apps/server/.env` and a client under it gets an Update required
screen instead of the app. It is unset, and the expectation is that it stays that way.

**Skew has a ceiling here anyway.** Ten friends, one server, and a notice on every launch:
the window where somebody is behind is days, not quarters. Size the compatibility budget for
that and not for a public API.

---

## Configuration

Everything lives in three files that have to agree with each other, and the console's
**Configuration** tab edits all three together rather than one at a time.

| File | Holds |
|---|---|
| `apps/server/.env` | Database URL, secrets, `LIVEKIT_URL`, port, voice quality, upload limit, CORS and login limits |
| `infra/livekit/livekit.yaml` | The key pair, and which address LiveKit advertises |
| `infra/caddy/Caddyfile` | The two public hostnames |

Not everything is a file. [Retention](#retention) is policy somebody edits from the console
rather than deployment shape, so it lives in a `ServerSetting` table — editable live, inside
the database backup, and not a fourth file that has to agree with the other three. Two more
paths and a version floor are `.env` because the installer writes them: `UPLOAD_DIR`,
`UPDATES_DIR` and `MIN_CLIENT_VERSION`, all documented in `.env.example`.

**Two things that used to be wide open are now lists, and both default to the clients this
repo ships**, so neither needs setting for the deployment described here:

| Variable | Default, and why |
|---|---|
| `CORS_ORIGINS` | `null` plus the dev renderer on `:5173`. `null` is not a placeholder — it is the literal origin Chromium sends for a packaged client, which renders from `file://`. A request with no `Origin` header at all is always allowed: that is the console, curl and every health probe, and a browser always sends one when it matters. Matching is exact, never by prefix. |
| `LOGIN_RATE_LIMIT` / `LOGIN_RATE_WINDOW_MS` | Ten failures per address per five minutes, across `/api/login`, `/api/register` and the raw Better Auth credential endpoints **together** — one budget, so picking the other door gains nothing. Only failures count and a success clears the address, so a client that merely keeps reconnecting is never locked out. |

The limiter is Express middleware rather than a Nest guard, and that is the fix rather than
a detail. `ThrottlerGuard` is an `APP_GUARD`, and Better Auth is mounted straight onto the
Express instance in `main.ts`, upstream of Nest's router — so `/api/auth/sign-in/email` was
never in its pipeline and was completely unlimited, while `/api/login` sat under a
300-per-minute limit meant for socket reconnects. A limit on one of two doors onto the same
password check is worse than none, because the console reads as though the question has been
settled. `LOG_DIR` and `LOG_KEEP_DAYS` are the other two new ones — see [Logs](#logs).

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

**A dev checkout uses `chat_dev`, not `chat`.** The two used to be one database, which is
fine while testing and miserable the moment it is not: the failure is not a crash, it is
running a migration, a `prisma db push` or a seed against the data ten people are actually
using, from a checkout you are in the middle of changing. The SQL takes the name as a
variable and defaults to `chat`, so the installer and the console are unaffected:

```bash
psql -U postgres -v db_name=chat_dev -f apps\server\prisma\setup-postgres.sql
cd apps\server && npx prisma db push
```

Both databases are owned by the same role, so nothing else changes. The role deliberately
has **no `CREATEDB`** — it never needs it, and the only things that do are these scripts and
[restore.ps1](#restoring-and-the-drill), which fall back to the superuser and let *psql*
prompt for that password rather than handling one.

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

### Size, and what is using it

Uploads are 26 MB a file, uncapped, on the same volume as PostgreSQL, so without this the
first sign of trouble is the database refusing writes.

One read-only endpoint, `GET /api/admin/storage`, behind the console's **Storage** tab:

- **Per table** — rows, total bytes, index bytes, from `pg_class` and
  `pg_total_relation_size`. The row counts are **exact**, via `query_to_xml` running one
  `count(*)` per table inside the single query. `reltuples` and `n_live_tup` are the usual
  answer and both are estimates maintained by ANALYZE — which on a small quiet database may
  simply never have run, so it reported *zero accounts* on a server with four of them. A
  wrong number in an operator console is worse than a slow one, and counting fourteen small
  tables costs milliseconds.
- **The database total** — `pg_database_size(current_database())`.
- **Uploads** — file count and bytes from a walk of `data/uploads`, cached for a minute.
- **Free space on the volume** — `fs.statfs`, which works on Windows under Node 22, so there
  is no shelling out to `wmic`.
- **Orphans, in both directions** — attachment rows whose file is missing, and files with no
  row. This is the number that says whether a cleanup is safe to run, and it is the one
  nothing currently knows.

Then one action: **Empty the bin**. It counts first, shows the real numbers — *"Permanently
remove 27 deleted message(s) and 4 picture(s), freeing about 1.1 MB?"* — and only then
deletes those messages, their files on disk, and any file left behind by one, before running
`VACUUM ANALYZE` so the space is actually handed back rather than left inside the tables.

That is deliberately the whole tab. It used to offer four buttons — orphaned files, orphaned
rows, tombstones older than *n* days, and a bare Vacuum — which is an accurate description of
four internal states and no help at all to the person looking at it, who has one question:
*I deleted things, why is the disk still full.* The other purge kinds still exist on
`POST /api/admin/storage/purge` and the retention sweeper still uses them; they are no
longer four decisions asked of somebody at eleven at night.

The endpoint defaults to a dry run and the caller has to pass `dryRun: false` on purpose; a
destructive endpoint whose safe mode is opt-in is one that eventually runs by accident. The
vacuum is plain, never `FULL` — `VACUUM FULL` takes an exclusive lock on every table it
touches, which belongs in a maintenance window rather than behind a button.

**The orphan sweep ignores anything written in the last hour.** A file is written before the
row that points at it exists, so a sweep landing in that window would delete somebody's
upload mid-post and leave them looking at a broken image. An orphan is still an orphan an
hour later.

**And it knows about avatars, which it did not at first.** An avatar is written by the same
`store()` into the same directory, but its only reference is `user.image` — never an
`Attachment` row, deliberately, because it belongs to a person rather than to a message.
The sweep built its list of live files from attachment rows alone, so every avatar was a
stray: counted as waste in the report, deleted by the cleanup button, and deleted by every
nightly retention run. Both the report and the sweep now ask one shared question that
includes `user.image`. Anything else that ever lands in that directory has to be added to
it too.

**A deleted message is still a row, and its images are still on the disk.** `deletedAt` is
a tombstone: the row survives so that a deletion can be looked into later, and the
attachment rows and their files survive with it. Every image anyone has ever deleted is
still there. Purging tombstones is the safest cleanup available and probably the one that
recovers the most space today.

**Rows first, then files.** Delete the database rows, let them commit, and afterwards sweep
the files that no longer have a row. A crash in that order leaves wasted bytes for the next
sweep to collect. The reverse leaves a row pointing at a file that is gone — a permanently
broken image in somebody's scrollback — and no sweep repairs that.

Destructive actions want an audit trail. An `AdminAudit` table is a few columns, and the
day something is missing and nobody remembers pressing anything is the day it pays for
itself.

---

## Backups

> **This is the thing retention was waiting for.** Until it existed, every message, image
> and password hash on this server had exactly one copy, on a home box, with a feature whose
> job is to delete things on purpose sitting built and switched off next to it.

```powershell
infra\backup.ps1 -Destination D:\backups\isthislegit          # once, by hand
infra\backup.ps1 -Destination D:\backups\isthislegit -Install # nightly, from then on
```

`-Install` registers a scheduled task at **03:30**, half an hour ahead of the retention
sweeper's 4am cron. That order is the whole point and is not a detail to tidy later: the
backup has to hold the night's data before anything is allowed to start deleting it.

**What it writes.** A dated directory per run holding `database.dump` — `pg_dump -Fc`, so it
is compressed and restorable table by table — beside a single `uploads/` tree shared by
every run. `-Keep` (default 14) prunes old dumps, **after** the new one has succeeded, never
before: deleting yesterday's good backup before today's is proven is how one bad night costs
two.

**Uploads are copied additively, not mirrored.** Retention deletes uploads on purpose, and a
true mirror would faithfully delete them from the backup too — which turns the safety net
into a second copy of the same policy. `-PurgeUploads` opts into mirroring for when the
backup disk fills and that trade becomes worth making.

**Every dump is read back before the run is called a success.** `pg_restore --list` on the
file it just wrote, plus a check that this application's tables are actually in it. An
unreadable dump otherwise fails at exactly the moment there is nothing else left. A failed
dump is deleted rather than kept, along with the empty directory it would have sat in —
a half-written file that looks like a backup is worse than no file at all.

It cannot check row counts, and does not pretend to: `pg_dump` lists a `TABLE DATA` entry for
every table whether or not it holds rows, so the listing cannot tell a full database from an
empty one. Only a restore can.

### Restoring, and the drill

```powershell
infra\restore.ps1 -From D:\backups\isthislegit\2026-09-08-033000 -Into chat_restore_test
```

**Do this once now, not for the first time when you need it.** `-Into` restores to a scratch
database, prints the row counts it landed, leaves the live one untouched, and tells you how
to drop it afterwards. That is the whole drill, and it is the only thing that turns the
paragraph above from a claim into a fact.

Restoring over the live database takes two deliberate acts — naming it *and* passing
`-Force` — and is refused outright while the server is still listening on :3000, because a
restore into a database being written to produces neither the old data nor the new.

The application role has no `CREATEDB`, deliberately; it never needs it. When the target
database does not exist the script falls back to the `postgres` superuser and lets *psql*
prompt for that password rather than handling one itself.

---

## Retention

> **Built, and switched off.** `enabled` defaults to false and every limit defaults to
> "keep", so a fresh install deletes nothing and an upgrade changes nothing. **Do not turn
> it on until [backups](#backups) are running and one restore has actually been tried** —
> the script exists now, which is not the same as it having run. This feature's entire job
> is to permanently destroy other people's messages, and one mistyped number with nothing
> behind it is unrecoverable. The console says so on the tab, in as many words.

Age-based cleanup so the disk does not fill, set once on the server rather than per client,
for the same reason the voice bitrate is: it is a decision about shared resources.

**The policy lives in a `ServerSetting` table** — `key`, a JSON `value`, `updatedAt` —
rather than in `.env`. `.env` holds the secrets and needs a restart to be reread; this is
policy somebody adjusts from the console at eleven at night. In a table it is editable
live, it is already inside the database backup, and the admin API already knows how to
serve it.

| Setting | Notes |
|---|---|
| `attachments.maxAgeDays` | Media is nearly all of the bytes. Expiring images while text lives forever is the policy most people actually want, and it is not the same knob as messages. |
| `messages.maxAgeDays` | Null means forever, and probably stays null. |
| `softDeleted.maxAgeDays` | Tombstones. **The one field that defaults to a number** — thirty days. A tombstone is a message somebody already chose to delete, kept only so the deletion can be looked into, and a month is longer than anyone looks. It still does nothing until `enabled` is on: this is what the switch does when it is thrown, not something that happens by itself. |
| `uploads.maxTotalBytes` | The one that actually bounds the disk. Oldest-first eviction once over the cap. |

Both kinds are needed. Age is the policy; the cap is the safety net. An age limit bounds
nothing if ten people paste two hundred screenshots in a week.

Expiring uploads are **not** part of this. The 48-hour deadline on a non-image attachment is
a promise made to the uploader at the moment of upload, not a policy an operator opted into,
so its sweeper runs hourly regardless of `enabled` — see [Attachments](#attachments).

**The sweeper is a nightly `@Cron`** from `@nestjs/schedule` at 4am, deleting in batches of
500 with a pause between them — a home box should not spend the night holding a lock on
`message`. It re-reads the policy on every run rather than caching it, so switching
retention off from the console takes effect without a restart. Cascades take the attachment
rows with them; the file sweep above runs afterwards, in that order and for the reason given
there.

**Attachments a doomed message would take with it are counted once, not twice.** The
message pass and the attachment pass overlap, and adding both totals overstates what will be
freed — which is exactly the number somebody is deciding on.

**Saving a policy shows what it would delete first.** *"Would remove 4,182 message(s) and
906 attachment(s), freeing about 3.1 GB"*, in a confirm dialog, before anything is stored —
and `PUT /api/admin/retention` returns the same figure for what the next nightly run will
do. The preview runs the real selection logic rather than an approximation of it, which is
the whole difference between an irreversible setting and a reviewed one.

Nothing is broadcast when the sweeper runs. A client scrolled back to a ninety-day-old
message at four in the morning would watch it vanish; nobody is, and a socket event for
that is machinery bought for a case that does not arise.

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
settings, and on speakers that combination will feed back. Clients on a stereo server say
so under Input, beside the echo cancellation switch.

### What each person controls

Settings open on a two-pane screen — Devices, Input, Behaviour — because the single 360px
column had microphone choice and every other switch in the same scroll. There is no
Quality pane: the bitrate is the server's to set and nobody's to change from here, so a
tab of read-only numbers was a tab nobody had a reason to open. The one part of it that
did depend on a local setting — stereo needing echo cancellation off — now sits under
Input next to the switch it is about, and only when the server is actually set to stereo.

- **Echo cancellation / noise suppression / automatic gain** (Input) — Chromium's own,
  applied at capture. Changing any of them restarts the microphone.
- **Push-to-talk** (Input) — bind a keyboard key or a mouse button (a thumb button, the
  middle button, anything but left click, which has to stay usable for clicking). The
  binding and what it overrides only appear once the switch is on, since neither means
  anything while it is off. If the global hook could not load, the switch is disabled and
  says why instead.
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

### Cancelling the picker is `callback(null)`

`setDisplayMediaRequestHandler` reads `callback({})` as a promise of a video stream that
was then broken, not as a refusal: it throws *"Video was requested, but no video stream was
provided"* inside the handler — an unhandled rejection in main — and the renderer's
`getDisplayMedia` rejects with the unrelated-sounding *"Invalid capture constraints"*,
which the app then showed as a red error for closing a dialog. `callback(null)` is the
documented refusal and rejects with an ordinary permission error instead.

The client does not read that message to decide, though. The picker is a component and the
request comes from the voice hook, so cancelling sets a module flag on its way out —
synchronously, and therefore strictly before the rejection it explains — and the hook
trusts that over whatever string Chromium chose that week.

**A cancelled share fails twice, and only one of them is a rejection.** LiveKit also emits
`RoomEvent.MediaDevicesError` for the same failure, and it fires *first* — so a handler
that put every device error on screen showed the banner no matter how carefully the caller
filtered the rejection it got back. Both paths now ask the same question before saying
anything. Microphone failures still come through that event and are still worth showing,
which is why it is a filter rather than a removed listener. The banner is clickable to
dismiss, since nothing else clears it until the next attempt.

**`Failed to start capture: -2147024809` in the console is not this.** That is
`E_INVALIDARG` from Windows Graphics Capture, logged once per window that refuses to be
captured while the thumbnail pass runs — a minimised window, or one with capture
protection. Those windows list without a picture and the rest of the picker is unaffected;
Chromium logs it and there is nothing above it to catch. Likewise `Binding request timed
out` from a `192.168.56.x` or `172.24.64.x` address is ICE trying a VirtualBox or WSL
adapter that cannot reach the STUN server, and it stops mattering the moment a real
candidate works.

---

## Mentions

Type `@` in the composer and a list of members opens. Arrow keys move, Enter or Tab
picks, Escape closes, and the list narrows as you type — display name or handle, and
names with spaces work because the search does not stop at one. Whoever you tag gets a
desktop notification, a sound, a red count on the channel in the sidebar, and their
message highlighted when they open it.

**Tags travel as ids, not names.** Message text stores `<@userId>`; the client resolves
it to a name at the moment it draws the message. That is the whole reason for the
format: somebody changes their display name and every message that ever tagged them says
the new one, with nothing rewritten and no migration. Storing the typed name would leave
old messages tagging a string that now belongs to nobody — or worse, to whoever has
since taken it.

**The composer is still a plain textarea.** It holds names, exactly as they read, and
the conversion to markers happens once on the way out (`renderer/mention-utils.ts`,
pure and tested the same way `link-utils.ts` is). A rich editor would carry the ids
invisibly and need no conversion, but it would also mean re-implementing selection, undo
and paste. Two people who answer to the same string are settled by which one you clicked
in the list; type the name by hand and the tie breaks the same way every time.

**An id in the text is a claim, not a fact.** Anyone can type angle brackets, so the
server checks every id against the guild before it stores or notifies anything. A marker
naming somebody who is not a member is left in the text and tags nobody — it draws as
`@unknown` rather than as a raw id, since hiding it would quietly rewrite what was said.
Tagging yourself is not a tag: nothing is stored and nothing is sent.

**Notifications go per user, not per channel.** `mention:new` is emitted to the
`user:<id>` room, because a client only joins the room for the channel on screen — which
is exactly the case a tag has to reach past. The message rides along, so the toast can
say what was said without fetching a channel that client has never opened. The sound
plays whenever tags are audible at all, including for the channel you are looking at;
the OS notification is held back for a message already in front of you. Both are
switches under Settings → Notifications, because the only thing worse than a missed ping
is one that cannot be turned off.

**Unread tags are a table, not a text search.** `MessageMention` stores nothing that
could not be recovered by reading every message ever sent — it is an index. "How many
unread tags in each channel" is asked on every launch and after every read, and against
the text that is a full scan with a `LIKE` in it. Unread is `messageId >
lastReadMessageId` and nothing else: ids are UUIDv7, so id order is time order and no
timestamp is involved. Editing a message re-resolves its tags and notifies only the
people the edit *added*, so fixing a typo does not ping the room twice.

**On Windows, toasts need an identity.** They are addressed to an AppUserModelID, and
one that does not match an installed Start Menu shortcut is dropped silently — no error,
no toast. The installed build uses its own id; a build run from source borrows
Electron's, which has a shortcut. This is the whole explanation for "notifications do
not work on Windows", and it is set in `main/notifications.ts` before the first window.

The migration adds one table. After pulling this, run:

```bash
npm run db:migrate
```

---

## Pinned messages

An admin hovers a message and clicks the pin. It gets a small **Pinned** mark in the
channel, and a pin icon sits beside the channel name in the header — always, whether or
not anything is pinned yet. Clicking it opens the board: every pinned message in that
channel, newest post first, each stamped with when it was *posted*. Admins can take one
off from the board itself; everybody can read it.

**Pinning is an admin action, reading is not.** It is the one thing in a channel that
everybody is shown whether they asked for it or not, which makes it the same kind of
decision as an announcement. It has its own permission (`message.pin`) rather than
riding on `message.moderate`, because the two are opposites — moderation takes a message
away, a pin puts it in front of the room — and separate names are what let the rules
move apart later. Letting members pin is a plausible setting; letting them delete each
other's messages is not.

**Two nullable columns on `Message`, not a join table.** A message is pinned at most
once and the pin has no life of its own: nobody wants a record of an unpin, and deleting
a message has to take its pin with it — which this way it does, with no cascade to
write. `pinnedById` is a plain id like `deletedById`: an audit note for somebody looking
into it later, not something the app joins on.

**Ordered by when it was said, not by when it was pinned.** A board is a reading list,
and what people look for on it is the message, so pinning last March's thread this
morning must not land it above something from an hour ago. Sorting by id gives that for
free — ids are UUIDv7 — and it is why the panel stamps every row with its own date
rather than leaning on a separator.

**Fifty per channel.** A board of two hundred messages is just the channel again, which
is the real argument; the useful side effect is that the whole list is one unpaged query
with a bounded answer. Hitting the cap says so and asks for one to come off first.

**A deleted message is off the board.** The pin columns survive on the tombstone, but
both the list query and every client filter on `deletedAt` — nothing an admin removed
should come back on the one list everybody reads.

**`pin:changed` goes to the channel room.** Unlike a deletion, which is broadcast to
everyone because a client caches messages for channels it is not looking at, a pin only
changes what is drawn for the channel on screen — and that is the one room a client
joins. The event carries the state, not the message: everyone in that room already has
it, and anyone scrolled too far back to have it asks for the board when they open it.
The board is re-fetched rather than patched, since an unpin can remove a row this client
never had and a pin can add one a thousand messages further back.

The migration adds two columns and an index. After pulling this, run:

```bash
npm run db:migrate
```

---

## Replies and forwards

Hover a message and the row gains two more buttons. **↩** puts a bar over the composer
saying who you are answering; send, and the reply carries a one-line strip above it naming
the message it answers. Click that strip and you land on the original, wherever it is —
including a thousand messages back, which is a fetch rather than a scroll. **↪** opens a
dialog listing the text channels on the server; pick one, optionally say something about
it, and the message arrives there drawn as a card under your own name and words.

**Replying tags them.** That is what replying is for; a reply nobody hears about is a
message that happens to sit under another one. The bar has an **@ on / @ off** switch for
the third message of a back-and-forth, where the other person is plainly already reading.

**A reply ping is a `MessageMention` row, not a second mechanism.** Everything downstream
of a tag — the red count on the channel, the tint on the message, the toast, the sound,
the clearing when the channel is read — already exists and already works, and a reply is a
tag by another route. What differs is one sentence: the toast says "replied to you in
#general" rather than "in #general", carried by a `kind` on `mention:new` that an older
client drops. Replying to yourself pings nobody, exactly as tagging yourself does not.

**An edit never changes who was pinged.** Sending answered the question, and re-asking it
would let somebody ping a person by editing a reply they had deliberately sent quietly. So
`MentionsService.sync` takes `alsoPing` on the way in and `keepPinged` on an edit: one
creates the row, the other only declines to sweep it away when the re-resolved text does
not name that person. There is no column for the switch — the row is the record.

**A quote is a join, never a copy.** `MessageRef` is built on every read from
`replyToId` / `forwardedFromId`, both plain nullable self-references on `Message`. Storing
the text at send time would quote what a message used to say the moment it was edited, and
would keep a name its author has since changed — the same argument that makes tags travel
as ids. The parent is a primary-key lookup, so there is nothing to denormalise for.

**One type for both, and it cannot nest.** A reply's strip and a forward's card are the
same idea — one message showing another — so they are one `MessageRef`, and the select
that builds it does not include `replyTo` or `forwardedFrom`. A chain of replies eight
deep is eight messages each carrying exactly one quote. That is a property of the shape
rather than a depth check somebody has to remember.

**Forwarding follows the chain once, at the moment of sending.** Forwarding a forward
stores the original, so nothing ever points at another forward.

**`SET NULL`, not `CASCADE`.** Deleting an account cascades every message that account
sent. A reply somebody else wrote has to survive the message it was answering, losing its
quote and not itself. The two indexes on those columns are for the constraint rather than
for any query: Postgres does not index a foreign key on its own, and without them a
cascade that removes ten thousand messages is ten thousand scans of the message table.

**A deleted original keeps its pointer and loses everything else.** The server sends empty
content with `deleted: true`, and the strip becomes "Original message was deleted" — drawn,
not hidden, because a reply whose quote silently vanished reads as an answer to nothing.
Clients patch their own loaded copies on `message:deleted` and `message:updated` for the
same reason the pin board does: nothing a moderator removed should sit on screen inside
somebody else's message until the next reload.

**Forwarding is bounded to one guild, and that is a permission decision.** Every member of
a guild can already read every channel in it, so a forward inside one puts nothing in
front of anyone that they could not have opened themselves, and the card's link to the
original always leads somewhere they can go. Neither is true across guilds, so the server
refuses it — checked rather than assumed from the fact that this deployment has one guild.

**Nothing new on the wire.** A forward is `POST /api/channels/:id/messages` with one more
field, because that is what it is: a message in the target channel. Same broadcast, same
nonce, same optimistic echo. `replyPing` is preprocessed to accept `"true"`/`"false"`
because a reply with a screenshot on it is multipart, where every field is a string.

**It does not move you.** Forwarding happens mid-conversation; being taken to another
channel for it would lose the place of whoever did it. A green line says where it went.

The migration adds two columns, two foreign keys and two indexes. After pulling this, run:

```bash
npm run db:migrate
```

---

## Search

A magnifying glass next to the pin in the channel header. Type two characters and results
appear under it: who, which channel, when, and the message. Click one and the app goes
there.

**Matching is Postgres full-text**, on a `tsvector` column generated from `content` with a
GIN index over it. Generated rather than maintained by us: Postgres recomputes it on every
insert and every edit, so it cannot drift from the text, and nothing in the application has
to remember to write it.

**The configuration is `simple`, not `english`.** English stemming makes "running" find
"ran", which demonstrates well and behaves badly here — what people search a chat server for
is a username, a filename, a link, a version number, and stemming mangles all four. It is
`websearch_to_tsquery`, so quoted phrases, `or`, and a leading `-` to exclude all work, and
malformed input cannot throw the way `to_tsquery` does.

**Permissions are resolved once, not per result.** The caller's readable channels become the
`IN` list, so the database never considers a message they cannot read — rather than searching
everything and filtering after, which is a query per row. **Deleted messages are excluded,
and that is load-bearing:** somebody removed them on purpose, and a search that returned them
would be a way to read everything a moderator has ever deleted.

Ordered by id, not by rank. Chat search is a chronological question, ids are UUIDv7, and
ranking would need a second sort key to page stably.

> Prisma has no `tsvector` type, so the column is `Unsupported("tsvector")` and the `@@`
> comparison runs as raw SQL that returns ids only; Prisma then loads those rows. If a
> future `prisma migrate dev` offers to alter that column, it is wrong — the definition,
> including the `GENERATED ALWAYS`, lives in the migration.

### Landing on a message

Search results, pinned messages, and clicking a notification all do the same thing, and none
of them could before: **`GET /api/channels/:id/messages?around=<id>`** returns a window
centred on one message — half the page older, half newer — which is what `before` cannot
express. Paging backwards to reach something said in March means fetching March through
today to get there.

The window is the only page with both cursors set, because it is the only one with history
above it *and* live messages below it. While parked in one, two things are suppressed: the
reading position is not overwritten (look up a message from March, close the app, and you
come back to where you were reading), and the channel is not marked read to the newest
loaded message, because everything below the window is still unseen. The jump-to-latest
button lifts both, and reloads the newest page rather than only scrolling.

---

## Attachments

Anything can be sent — paperclip, paste, or drag. **Pictures are kept. Everything else is
deleted after 48 hours**, and the message says how long is left. The point is handing a file
to somebody, not becoming the place that file lives.

Two rules make accepting arbitrary bytes safe on a box with ports open, and neither can be
relaxed without the other:

1. **Nothing is stored under an extension the server did not choose.** A picture keeps a real
   one; everything else is `.bin`, with the real name and type in the database row. The file
   layer checks that extension before opening or deleting anything, and that check is what
   stops a bad row turning the download route into a general file server.
2. **Nothing but a picture is served in a form a browser would render.** Pictures go out
   inline as themselves; everything else goes out as `application/octet-stream` with
   `Content-Disposition: attachment`, `nosniff`, and a `default-src 'none'; sandbox` CSP. An
   uploaded HTML page handed back inline would be script running against this API's own
   origin.

The client matches: a file is **saved and never opened**. No preview, no reveal-in-folder,
no shell. Anyone with an invite can upload a program, and an app that opens one on the
recipient's behalf is the thing that ran it. Uploaded filenames are stripped of path
separators, control characters and the bidirectional overrides — one of those is how a file
genuinely named `annexe<RLO>txt.exe` draws in a list as `annexe.exe.txt`.

**The expiry sweeper is hourly, and deliberately outside the retention policy.** Retention is
an operator's decision, switched off until somebody turns it on; this is the deal the
uploader was shown at the moment they sent the file, and a promise that only happens if an
administrator opted in is not one. Hourly rather than nightly because nightly makes "48
hours" mean anything from 48 to 72, and the client is showing a countdown.

**The file goes, the row stays**, stamped `expiredAt`. Deleting the row would leave a message
that was only a file rendering as a blank gap; instead it reads *"build.zip — no longer on
the server"*. Asking for the bytes then gets a 410, not a 404: the difference between "there
was never such a file" and "its time ran out" is the thing the reader wants to know.

Avatars are the one upload path that still takes pictures only — they are drawn inline for
every signed-in member, which is exactly what rule 2 forbids for anything else.

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
| GET | `/api/channels/:id/messages` | Cursor paged: `?before=<id>&limit=50`. Also `?after=<id>` and `?around=<id>`, which is what jumping to a message uses |
| GET | `/api/search` | `?q=&guildId=&channelId=&before=&limit=`. Only channels the caller can read; never deleted messages |
| POST | `/api/channels/:id/messages` | Broadcasts over Socket.IO |
| PATCH | `/api/channels/:id/messages/:msgId` | Edit — the author only, never an admin |
| DELETE | `/api/channels/:id/messages/:msgId` | Delete — the author, or a guild admin |
| GET | `/api/channels/:id/messages/pinned` | The pin board, newest post first. Capped, never paged |
| POST | `/api/channels/:id/messages/:msgId/pin` | Pin — admins only |
| DELETE | `/api/channels/:id/messages/:msgId/pin` | Unpin — admins only |
| POST | `/api/guilds/:id/invites` | Admins only |
| POST | `/api/guilds/:id/members/:userId/mute` | `{ durationMinutes }`, null for indefinite |
| POST | `/api/guilds/:id/members/:userId/kick` | Removed; can return with a new invite |
| POST | `/api/guilds/:id/members/:userId/ban` | Removed, signed out, cannot rejoin |
| GET/DELETE | `/api/guilds/:id/bans[/:userId]` | List and lift |
| POST | `/api/channels/:id/voice-token` | LiveKit token, voice channels only |
| GET | `/api/voice/state` | Who is in which voice channel, right now |
| GET | `/api/mentions` | Unread tags per channel, for the sidebar badges |
| POST | `/api/livekit/webhook` | Called by LiveKit, not by clients; JWT-signed |
| — | `/api/auth/*` | Better Auth's own routes |
| — | `/api/admin/*` | Stats, users, invites, guilds, channels, messages — ADMIN role |

Storage, retention and updates:

| Method | Route | Notes |
|---|---|---|
| GET | `/api/admin/storage` | Table sizes, uploads, free space, orphan and tombstone counts |
| POST | `/api/admin/storage/purge` | One named purge. Dry run unless `dryRun: false` |
| POST | `/api/admin/storage/vacuum` | `VACUUM ANALYZE` |
| GET/PUT | `/api/admin/retention` | The policy. PUT returns what the next run would remove |
| POST | `/api/admin/retention/preview` | What a policy *would* remove, without saving it |
| GET | `/api/admin/clients` | Who is connected and which build they are running |
| GET | `/api/admin/updates` | What is published, what is staged, and where both live |
| PUT | `/api/admin/updates/staging/:file` | Upload one file of a release. Raw body, streamed |
| DELETE | `/api/admin/updates/staging` | Throw away an upload |
| POST | `/api/admin/updates/publish` | Promote the upload — or a `sourceDir` — and tell everyone |
| GET | `/updates/desktop/:file` | `latest.yml`, the installer, the blockmap. **No auth** |

`/api/config` also carries `latestClientVersion` and a `minClientVersion` that stays null.
The socket handshake carries `clientVersion` beside the token, REST calls carry an
`X-Client-Version` header, and `client:update-available` is a server-to-client event.

Moderation lives on the guild routes rather than under `/api/admin`: those answer "an admin
of anything?" for the console, whereas kicking someone has to ask "an admin of *this*
guild?". Muting, kicking and banning all refuse to act on yourself or another admin — roles
are flat, so there is no hierarchy to rank two admins by; demote one from the console first.

Socket.IO events are declared in `packages/shared/src/index.ts`.
`apps/server/requests.http` exercises the whole API.

---

## Tests

```powershell
npm test          # once
npm run test:watch
```

Vitest, one config at the repo root rather than one per package. The things worth testing
here are pure modules that happen to sit on both sides of the client/server line — the URL
parser and the noise gate are in the desktop app, the image header parser and the permission
matrix are in the server — and three runners to keep in step buys nothing at this size.

`environment: node` throughout, including for the desktop modules. Nothing under test
touches the DOM: `audio-levels.ts` exports an `audioContext()` that does, but the gate and
the detector are arithmetic over `Float32Array`, and arithmetic is the part that has ever
been wrong.

| Module | What it pins down |
|---|---|
| `link-utils.ts` | That a URL does not swallow the full stop after it, and that only `http(s)` ever becomes an href — `javascript:` and `data:` must never match. YouTube and TikTok ids are checked against lookalike hosts, because both get interpolated into an embed URL. |
| `audio-levels.ts` | Silence floors at −100 rather than −Infinity; the gate stays shut while it measures the room, holds through the gaps between words, and takes less to stay open than to open. |
| `chat-format.ts` | Byte sizes worded the way the server words them, "Yesterday" decided by the calendar and not by elapsed hours, and `lastSeenLabel` refusing to go negative when a clock is a few seconds ahead. |
| `image-size.ts` | All four headers, a Huffman table not being mistaken for a JPEG frame header, and — the reason this code is not a dependency — that a malformed stream terminates instead of looping. Every truncation of every header is asserted not to throw. |
| `permission.guard.ts` | The admin-only set, and that **a mute denies nothing**. It used to deny `channel.write` and `voice.join`, which was three punishments delivered under one name. |
| `audio-config.ts` | RED on everywhere but studio, DTX only on `voice`, and a typo in `VOICE_QUALITY` falling back rather than refusing to start. |
| `cors.ts` | That the allowlist does not prefix-match, so `https://good.example.evil.example` is refused. |
| `login-throttle.ts` | That the window slides rather than resetting in a block, and that a success clears the address. A second file mounts it on a real Express app the way `main.ts` does — one route on the router, one straight on the app above it — and asserts that two failures on the second plus one on the first exhausts a budget of three. That is the bug, reproduced. |
| `ids.ts` | UUIDv7 sorting chronologically as a string, and the invite alphabet being drawn from evenly. |
| `file-logger.ts` | That the pruner removes only files it could have written. |

Nothing renders a React tree and nothing touches a database — `PermissionService` is
exercised against a two-row fake. That is a deliberate ceiling, not an oversight: these run
on a checkout that has never had PostgreSQL installed, which is what makes running them
free enough to actually do.

---

## Logs

Everything Nest logs now also lands in `data/logs/server-YYYY-MM-DD.log`, rolled at midnight
and kept for 30 days (`LOG_DIR`, `LOG_KEEP_DAYS`). Console output is unchanged.

This is a log file, not observability. There is no metric, no alert, and nothing that
reaches a phone. What it buys is the ability to answer *"what happened last Tuesday"* at
all: each service runs in its own window on purpose, which is fine for watching something
happen and no use for anything that happened while nobody was watching. A hundred thousand
failed logins overnight looked exactly like a quiet night, and still would after a restart
cleared the scrollback. It is also why [the login limiter](#configuration) bothers to log a
blocked address.

The pruner matches on the date in the filename rather than on mtime, and only ever removes
files it could have written — the file sweeper's lesson in miniature. When a directory has
more than one kind of owner, the sweep has to ask all of them; this one asks none, because
it removes nothing it cannot prove is its own.

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
  reports presses but never releases, so it cannot express "hold", and it does not see the
  mouse at all. The same hook reports both, so a key and a mouse button bind through one
  path; the saved binding carries its kind, because the two code spaces overlap. If the
  native module fails to load, push-to-talk reports itself unavailable and everything else
  still works.
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

**Storage and updates**

- **Rows are deleted before their files, never the other way round.** An orphaned file is
  wasted bytes the next sweep collects; an orphaned row is a broken image nothing repairs.
- **The retention policy lives in a table, not `.env`.** It is edited live from the console
  and it belongs inside the backup.
- **The update feed is unauthenticated, and https only.** The installer holds no secret, and
  a feed needing a token fails precisely when a lapsed session has stranded somebody on an
  old build. Unsigned builds make TLS the root of the integrity chain, so the client will
  not check a feed it reached over plain http.
- **The feed URL comes from the server address at runtime**, not from the build. The client
  hardcodes nothing else, and this would be the one exception.
- **Builds are uploaded to the server, not read from beside it.** The machine that builds the
  client is not the machine that runs the server, and it never will be.
- **An upload is staged, and a failed one is discarded whole.** A half-written installer in
  the feed is worse than no installer: its hash cannot match, so every client that tries it
  fails, and none of them can say why.
- **The server box updates by hand.** Self-updating the process that serves the updates, on
  the machine holding the SYSTEM scheduled tasks, buys nothing on a one-machine deployment.
- **An out-of-date client is notified, never blocked.** Ten people locked out until each
  notices a dialog is worse than the skew it was avoiding. `minClientVersion` exists as a
  floor and is expected to stay null.
- **One update path, no fallbacks.** A second one would be tested a tenth as often as the
  first, on ten machines that are not this one. When it fails, the recovery is the `.exe`.
- **The API is additive: fields and events are added, never renamed or removed.** The client
  runtime-validates nothing the server sends and every shared schema is a plain `z.object()`,
  so unknown keys already strip and unheard-of events already drop. That compatibility is
  free until somebody renames something or reaches for `.strict()`.
- **Unrecognised content renders as a placeholder**, never as nothing. An old client drawing
  a blank where a message has a reaction is lying about what was said. Non-image
  attachments used to hit this branch and now have a real one — see
  [Attachments](#attachments).
- **The orphan sweep has an hour's grace.** A file exists before its row does, and sweeping
  that window deletes a live upload.
- **Row counts are counted, not estimated.** `n_live_tup` reads zero on a database that has
  never been analysed, and a console reporting no accounts is worse than a slow query.
- **A prerelease sorts below its release.** `1.2.3-beta.1` is older than `1.2.3`; treating
  the suffix as more numbers reverses that, which would offer a beta as an upgrade over the
  final build and then refuse to publish the final build over the beta.
- **`compareVersions` is duplicated in the desktop client on purpose.** That app imports
  nothing from `packages/shared` — it redeclares the DTOs it needs — and a workspace
  dependency for twelve pure lines is a worse trade than the copy. Change one, change both.

**Deliberately not done**

Federation, mobile clients, custom emoji, threads, video calls, a web client.
Ten friends and one box is the whole design.

---

## Bugs that cost real time

Kept because each one failed silently, and the next person to hit the same shape deserves
the shortcut.

**The file sweeper deleted every avatar.** An avatar is written by the same `store()` into
the same directory as message attachments, but it is referenced only by `user.image` and
never by an `Attachment` row — which is deliberate and was documented, and which the sweeper
did not know. Building the live-file list from attachment rows alone made every avatar a
stray: reported as waste, removed by the console's cleanup, and removed by every nightly
retention run. It failed silently in the worst way available — the console said *"safe to
sweep"* about it. **When a directory has more than one kind of owner, the sweep has to ask
all of them.**

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

1. **Run the backup, and try a restore.** [Backups](#backups) are written, scheduled and
   verified-on-write, and `infra\restore.ps1` exists. None of that is the same as having
   done it. Until `-Install` has run against a real destination and one
   `-Into chat_restore_test` has printed row counts, this line stays here and
   [retention](#retention) stays off. The destination should not be this machine.
2. **The dev checkout still has no `chat_dev` to point at.** `.env` and
   `setup-postgres.sql` now expect one — `psql -U postgres -v db_name=chat_dev -f
   prisma\setup-postgres.sql`, then `npx prisma db push` — but that needs the postgres
   superuser password, so it has not been run. The server will not start against a database
   that does not exist, which is the loud kind of broken and the reason this is second
   rather than fifth.
3. **Verify the login limiter against the running server.** A test mounts it on a real
   Express app in the same order `main.ts` does and proves one budget covers both doors, so
   what is left is narrow but not nothing: that the live server's mount order matches. Eleven
   wrong passwords against `/api/auth/sign-in/email` should return 429 with a `Retry-After`,
   and a twelfth against `/api/login` should too.

**Should do soon**

4. **Disk fill takes PostgreSQL down, not just uploads.** Visible and clearable — see
   [Size, and what is using it](#size-and-what-is-using-it) — but not *bounded* until
   somebody sets a [retention](#retention) policy, which now waits only on item 1. There is
   still no per-user quota.
5. **Confirm the CORS allowlist against a packaged client.** `origin: true` is gone from
   both the HTTP API and the socket, and the default list carries `null` because a packaged
   Electron renderer loads from `file://`. That is reasoned rather than observed. A build
   that fails to connect after this change is this line.
6. **`Chat.tsx` is 3,557 lines and went up, not down.** It was 3,270 after the first split
   — the formatting helpers, the shared types, both message panels and all the modals live in
   `chat-format.ts`, `chat-types.ts`, `ChatPanels.tsx` and `ChatModals.tsx`, and replies and
   forwards put their own presentation in `MessageRefs.tsx` and their dialog in
   `ChatModals.tsx` rather than here. The component body still grew by about 290 lines, which
   is the point: **everything that goes in it stays in it**, because the message list, the
   composer, editing, moderation, attachments, unread markers, embeds and the volume popup
   are one function sharing one closure. Reactions go on top of that unless the message list
   comes out first, and that extraction needs a props interface nobody has designed yet.
   Replies were the last feature that could be added without one.
7. **`rtc.ips.excludes` is set but unproven.** VirtualBox, Hyper-V and link-local ranges are
   now excluded in `livekit.yaml`. Whether LiveKit stops advertising them has not been
   watched on the wire. Also note `livekit.yaml` is still in **LAN mode** (`node_ip`
   pinned, `use_external_ip: false`) while the Status line at the top of this file describes
   the internet deployment; one of the two is out of date.
8. **Logs are a file, not observability.** [Logs](#logs) means last Tuesday is answerable
   at all. Nothing counts anything, nothing alerts, and a hundred thousand failed logins now
   leave a large file rather than no trace — which is progress and is not detection.

**Product**

9. Emoji reactions and a theme toggle. Non-image attachments, mentions and notifications,
   search, and replies and forwards are done — see [Attachments](#attachments) and [Search](#search). Images in a
   message open full size on click and copy on right-click — the copy goes through main,
   because an uploaded image is a `blob:` URL the renderer can rasterise but a linked one is
   another origin, where a canvas is tainted and `fetch` is a CORS failure.
10. Client error surfaces: what a user sees on a 500. "Server is not there" is done —
    `fetch` rejects with "Failed to fetch" for every address that never reached a server, and
    devtools shows those with provisional headers, which reads as a cross-origin block and is
    not one. `api.ts` names the origin that did not answer, and says that a server with no
    proxy in front of it is `http://` on its own port. The 429 from item 3 is the newest
    thing with no dedicated surface: it arrives with a `message`, so it renders, but it is
    worded by the server and never rate-limits the person reading it.

**Done since this list was written**

Replies with a ping and a jump-to-original, and forwarding a message to another channel —
see [Replies and forwards](#replies-and-forwards).

Backups and restore, a Vitest suite over ten pure modules ([Tests](#tests)), the login rate
limiter, a CORS allowlist on both the API and the socket, `crypto.randomInt` for invite
codes, `rtc.ips.excludes`, a separate dev database, file [logs](#logs), and the first pass
at splitting `Chat.tsx`.

**Both Electron apps have icons**, which this list used to claim neither did:
`apps/desktop/build/icon.ico` and `icon.png` are picked up by electron-builder through
`buildResources`, `appIcon()` sets the window icon, and `apps/server-app` points `win.icon`
at its own. That entry was stale rather than outstanding.
