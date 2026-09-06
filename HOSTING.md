# Running this in public

Written the day it first worked over the internet. Everything below is about what changed
that day, in the order it will matter.

Nothing here is a reason to take it down. It is ten friends on a home connection, and the
threat model is mostly "someone's port scanner finds it" rather than "someone wants in".
But the day it went public, three things became true that were not true before: strangers
can reach it, other people's data lives on it, and the failures are now other people's
problem too.

## The short version

| | |
|---|---|
| Do this week | Rotate `BETTER_AUTH_SECRET`. Tighten the login rate limit. |
| Do before you forget | A backup. Any backup. |
| Do if this stays up | TLS, via a reverse proxy and a real hostname. |
| Do not do | Forward port 4000 or 5432. Hand anyone the server installer as-is. |

---

## 1. Do these first

### Rotate `BETTER_AUTH_SECRET`

[apps/server/.env](apps/server/.env) still holds:

```
BETTER_AUTH_SECRET="dev-only-secret-change-me-0123456789abcdef"
```

That value signs every session token the server issues. Anyone who knows it can forge a
token for any account, including an admin one, without touching a password. It is a
placeholder — the kind of string that ends up in scrapers' wordlists precisely because it
looks like this — and it was fine while nothing outside the house could reach port 3000.

Replace it with 32+ random bytes. Every existing session is invalidated when you do, so
everyone signs in again once; that is the entire cost.

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

While you are there: `BETTER_AUTH_URL` is still `http://localhost:3000`, and that is
deliberate. The client authenticates with a bearer token rather than a cookie, so this
value never has to match what anyone types. Leave it.

### Do not hand anyone the server installer

[infra/livekit/livekit.yaml](infra/livekit/livekit.yaml) contains this deployment's real
LiveKit API key and secret in plaintext, and the built installer bundles it:

```
release/staging/isthislegit-server-0.1.0/livekit/livekit.yaml
```

Anyone holding that pair can mint join tokens for any voice room on your server. The
server side of the package correctly ships `.env.example` rather than `.env`, so that half
is right — `livekit.yaml` is the half that leaks.

Also note `.gitignore` covers `.env` and `.env.local` but **not** `livekit.yaml`. This
directory is not a git repository today, so nothing has leaked. The moment you run
`git init` and push anywhere public, that file goes with it. Add it to `.gitignore` first
and commit a `livekit.example.yaml` instead.

If you rotate the pair, remember it lives in two places and they must match: `keys:` in
`livekit.yaml` and `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `apps/server/.env`.
Mismatched, voice fails with a token error rather than silence, so at least this one tells
you.

### Tighten the rate limit on login

[apps/server/src/app.module.ts:23](apps/server/src/app.module.ts) sets one global limit:

```ts
ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])
```

300 requests per minute per IP, applied equally to fetching messages and to guessing
passwords. For message fetching it is about right. For a login endpoint it allows 432,000
attempts a day from a single address, against an 8-character minimum password with no
lockout and no delay. That was unreachable yesterday and is reachable today.

A `@Throttle` decorator on `/api/login` and `/api/register` — something like 10 a minute —
costs nothing and closes it. Everything else can keep the global limit.

**One thing to verify while you are in there.** [main.ts:24](apps/server/src/main.ts)
mounts Better Auth directly on the Express instance:

```ts
http.all('/api/auth/*splat', toNodeHandler(auth));
```

That is raw Express middleware, registered outside Nest's routing. `ThrottlerGuard` is
installed as an `APP_GUARD`, and `APP_GUARD` applies to Nest route handlers. So
`/api/login` is throttled, but `/api/auth/sign-in/email` — which reaches the same
authentication path — may not be throttled at all. Rate limiting the controller while the
underlying endpoint stays open would be worse than not having it, because it looks solved.

Worth ten minutes with `curl` in a loop to find out for certain before relying on either
limit.

### Invite codes use `Math.random()`

[apps/server/src/common/ids.ts:13](apps/server/src/common/ids.ts) generates the codes that
are now the *entire* perimeter around registration:

```ts
const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
out += alphabet[Math.floor(Math.random() * alphabet.length)];
```

`Math.random()` is not a cryptographic generator. V8's implementation is seeded per
process and its internal state can be reconstructed from a run of outputs, which means
someone holding several codes could in principle predict the next ones rather than guess
them.

Keeping this in proportion: nobody is brute-forcing an 8-character code out of a 31-symbol
alphabet, and an attacker only ever sees codes you personally gave them. This is a
sharp-edge finding, not a hole. But the fix is one line — `crypto.randomInt` instead of
`Math.random` — and it makes the perimeter something you never have to reason about again.

The alphabet, incidentally, is well chosen: no `I`, `L`, `O`, `0`, or `1`, so nobody
mistypes a code read aloud. Keep that.

---

## 2. The one you cannot fix with a config change

**There is no TLS anywhere in this.** Plain HTTP and plain `ws://`, over the open
internet.

What that concretely means:

- Passwords cross the network readable, at registration and at every sign-in.
- Bearer tokens cross readable, and sessions last 30 days
  ([auth.factory.ts:58](apps/server/src/auth/auth.factory.ts)). Someone who captures one
  token on a shared network has a month of access to that account, and rotating the
  password does not obviously revoke it.
- Every message, and every image, is readable in transit.
- Anyone in a position to *modify* traffic can serve your friends different content
  entirely.

Who is actually in that position? Whoever runs the wifi your friends use, anyone else on
it, and the network operators between them and you. Not a large group, and mostly not a
hostile one. But "my friend used the café wifi" is an ordinary Tuesday, not a contrived
scenario.

Three honest options:

1. **Leave it.** Defensible if this is a few weeks of testing among people who know, and
   if everyone picks a password they use nowhere else. Say that last part out loud to
   them — it is the mitigation that actually matters.

2. **A reverse proxy in front of it.** A hostname (dynamic DNS is fine) plus Caddy gets
   you an automatic Let's Encrypt certificate and terminates TLS for both the chat server
   and LiveKit's signalling. This is the real fix and it is a weekend, not a rewrite. The
   client already carries the server address as a field, so `https://` and `wss://` need
   no rebuild. LiveKit's media path is separately encrypted by WebRTC regardless, so it is
   the signalling and the HTTP API that need covering.

3. **Skip the public internet entirely.** Tailscale or similar puts all ten of you on one
   encrypted network, and you close every forwarded port. You lose "just install it and
   type an address" — everyone installs a VPN client first — and you gain not having to
   think about any of this section. For ten friends this is a genuinely reasonable answer,
   not a cop-out.

Whichever you pick, pick it deliberately. The current state is option 1 whether or not it
was chosen.

---

## 3. Things that will break on their own

### The public IP will move

It is a DHCP lease from your ISP. When it changes, two things break at once and they look
different: friends cannot reach `http://<old-ip>:3000` at all, and — after they find the
new address — voice connects and stays silent, because `LIVEKIT_URL` still advertises the
old one.

That second failure is the expensive one. It looks like a bug in the app, it presents
identically to the `use_external_ip` mistake, and there is nothing in the logs that says
"wrong address".

Dynamic DNS in both places removes it entirely. Until then, when voice breaks for everyone
outside at once, check `LIVEKIT_URL` before anything else.

### The disk will fill

Uploads go to `data/` on the same disk as PostgreSQL, capped at 26 MB each
([`MAX_UPLOAD_BYTES`](apps/server/.env)) with no per-user quota, no total cap, and no
cleanup. Ten people sharing screenshots will take a long time to matter. Ten people who
discover they can use it as a file host will not.

The failure mode is worth knowing because it is not "uploads stop working": Postgres
shares that disk, and Postgres on a full disk stops accepting writes. The whole server goes
down, and it goes down in a way that takes a moment to diagnose.

A disk-space check is a five-line addition to the operator console, which already has the
right shape for it.

### There is no backup

There is no backup of the database and no backup of `data/`. Yesterday that risked your own
test messages. Today it risks nine other people's conversations and images, and they have
no idea it is unbacked.

`pg_dump` on a schedule, written somewhere that is not this machine, plus a copy of
`data/`. Any backup beats the current state, and the current state is none.

Worth doing before you tell anyone this is permanent, because "we lost everything" reads
very differently once people have relied on it.

### LiveKit advertises three addresses, two of them useless

From the startup log:

```
using external IPs {"ips": ["192.168.56.1/192.168.56.1", "192.168.224.1/192.168.224.1", "220.253.133.172/192.168.1.230"]}
```

Your VirtualBox and Hyper-V adapters are being offered to every client as ICE candidates.
It works — ICE tries every pair and keeps the one that connects — at the cost of a slower
connect while the dead ones time out.

The real risk is a collision: if a friend's own network uses `192.168.56.x`, their client
tries to reach a device on their LAN instead of you. Home routers rarely use that range.
Office and hotel networks use it more often, and that is exactly where a friend will be
when it fails.

This build supports `rtc.ips.excludes` and `rtc.ips.external_ip_only`, and
`rtc.interfaces.excludes` (confirmed against the binary, not assumed). Any of them trims
the list to the address that actually works.

---

## 4. Things you now owe other people

Not security, but the part that is easy to skip and awkward to retrofit.

- **Their data is on your disk.** Messages, images, password hashes, and whatever nine
  people decide to type into a chat they think is private. The backup point above is
  really this point.
- **Deletion.** `DELETE /api/admin/users/:id` exists. It is worth knowing now, not when
  someone asks, whether it removes their messages and uploaded images too or only the
  account.
- **Availability is now a promise.** Rebooting your machine drops everyone mid-call. That
  is fine — just make sure people understand this is a box in your house, not a service,
  so nobody plans anything important around it.
- **Content on a residential connection.** You are hosting other people's material on an
  ISP account in your name, and many residential terms prohibit running servers at all.
  Enforcement is rare, and it is worth a glance at your ISP's terms so you are not learning
  it from a letter.
- **Moderation tooling already exists** — mute, kick, ban, message deletion. Knowing it is
  there before you need it is the whole point.

---

## 5. What is already right

Worth listing so you do not undo it later:

- **The operator console binds to `127.0.0.1` only.** It spawns processes, so exposing it
  on any interface is remote code execution with no authentication in front of it. Not
  forwarded, and it must stay that way.
- **PostgreSQL is not forwarded either**, and connects as a dedicated `chat_app` role
  rather than a superuser.
- **Attachment handling is genuinely careful.** MIME allowlist on the way in, path
  resolved and checked against the upload directory on the way out, plus an extension
  check so a bad database row cannot turn the route into a general file server. That is
  the exact bug this kind of code usually has.
- **LiveKit's `--dev` mode is not used.** Its key pair is published in LiveKit's own
  repository; anyone who could reach 7880 could mint themselves a token.
- **Registration requires an invite code**, enforced in a Better Auth `before` hook rather
  than only in the controller, so calling the underlying endpoint directly does not bypass
  it. The invite is consumed in an `after` hook, so a failed sign-up does not burn a code.
- **Admin routes check a database role**, not a flag on the session.
- **The firewall script defaults to `LocalSubnet`** and required an explicit `-Internet` to
  open up. Keep that default.

---

## 6. Keeping it running

- **Updates matter now.** LiveKit, Node, and the dependency tree were internal-only
  yesterday. `npm audit` occasionally, and watch LiveKit releases, since it is the one
  process deliberately exposed to the internet on five ports.
- **You have no idea if anyone is attacking it.** Logs go to the console and nowhere else.
  You would not notice a hundred thousand failed logins. If you add one thing, make it a
  count of failed sign-ins per hour somewhere you will actually look.
- **The console's timestamps are UTC while everything it wraps is local time.** When a
  friend says "it broke around 3pm", that hour of arithmetic is avoidable.
- **Close the ports when you are done testing:**

```bash
powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1 -Remove
```

  Or narrow them back to the LAN by re-running without `-Internet`.

## Ports, for reference

Forwarded on the router to `192.168.1.230`, same numbers both sides:

| Port | Protocol | What |
|---|---|---|
| 3000 | TCP | Chat server: HTTP API and Socket.IO |
| 7880 | TCP | LiveKit signalling |
| 7881 | TCP | WebRTC over TCP, the fallback when UDP is blocked |
| 3478 | UDP | TURN, for anyone UDP-blocked entirely |
| 50000-50100 | UDP | Voice and screen-share media |

Never forwarded: **4000** (operator console — remote code execution) and **5432**
(PostgreSQL).

LiveKit's TURN relay range, 30000-40000 UDP, appears in the startup log and does **not**
need forwarding. The embedded TURN server relays to the SFU on the same machine, so that
traffic never leaves the box.
