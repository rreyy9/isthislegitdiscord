# Polish roadmap

_Created 2026-09-06. Ordered by what hurts soonest, not by effort._

Companion to [PROGRESS.md](PROGRESS.md) (what is built) and [HOSTING.md](HOSTING.md)
(what changed the day it went public). This file is what is left.

The ordering assumption: the server is reachable from the internet, ten people who are
not you have data on it, and the repository is public at
`github.com/rreyy9/isthislegitdiscord`. That last fact is new and it re-ranks everything.

---

## P0 — Live exposure — **done 2026-09-06** (commit `9f4fc12`)

`HOSTING.md` said: "This directory is not a git repository today... The moment you run
`git init` and push anywhere public, that file goes with it." That happened, and this
section is what it cost. All three are fixed; the write-ups are kept because the reasoning
is the part worth not relearning.

**One thing did not go away.** Force-pushing rewrote `main`, but GitHub still serves the
old commit `67fa395` to anyone who asks for it by SHA — unreachable objects are only
garbage-collected on request to GitHub Support. Forks, clones and scrapers may also hold
it. That is why rotating the pair was the actual fix and the purge was only tidying.
Both old secrets are dead, so what remains is a historical record rather than a live key.

### 1. LiveKit API key and secret are published — done

[infra/livekit/livekit.yaml](infra/livekit/livekit.yaml) holds this deployment's real key
pair in plaintext. It is tracked in commit `67fa395` and that commit is on `origin/main`.
The repository answers an unauthenticated API request, so it is public.

Anyone holding the pair can mint a join token for any voice room on the server.

- Rotate the pair. It lives in two places and they must match: `keys:` in `livekit.yaml`
  and `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `apps/server/.env`. Mismatched, voice
  fails with a token error rather than silence, so this one tells you.
- Add `livekit.yaml` to `.gitignore` and commit a `livekit.example.yaml` instead.
- Purge the file from git history and force-push.
- Treat the old pair as burned regardless of the purge. It was public; assume it was read.

### 2. `BETTER_AUTH_SECRET` is still the placeholder, and the placeholder is public — done

`apps/server/.env` still holds `dev-only-secret-change-me-0123456789abcdef`, and
[apps/server/.env.example](apps/server/.env.example) publishes that exact string to
anyone who clones the repo.

That value signs every session token. Public repo + unrotated placeholder + a server
reachable from the internet is a complete auth bypass: forge a token for any account,
including an admin one, without touching a password.

`HOSTING.md` ranked this "do this week". Publishing the repo moved it to "do first".

Replace with 32+ random bytes. Every existing session is invalidated, so everyone signs
in again once. That is the entire cost.

### 3. The server installer bundles the live LiveKit key — done

`release/staging/isthislegit-server-0.1.0/livekit/livekit.yaml` contains the real pair.
The server half of the package correctly ships `.env.example` rather than `.env`;
`livekit.yaml` is the half that leaks. Fix
[infra/installer/build-server-installer.ps1](infra/installer/build-server-installer.ps1)
to template it, and do not hand the current build to anyone.

Done, plus a check that fails the build if the payload ever carries a real key pair,
a `devkey`, or a `.env`. `release/staging/` was deleted; the built `.exe` and `.zip`
in `release/` still embed the old (now revoked) pair, so rebuild before distributing
either.

---

## P1 — Hardening, before more people join

### 4. There is no TLS anywhere

Plain HTTP and plain `ws://` over the open internet. Passwords cross readable at every
sign-in; bearer tokens cross readable and sessions last 30 days
([auth.factory.ts:58](apps/server/src/auth/auth.factory.ts)). One captured token is a
month of access.

Three honest options, from `HOSTING.md` section 2: leave it deliberately, put Caddy and a
dynamic-DNS hostname in front (a weekend, and the client already carries the server
address as a field so `https://` needs no rebuild), or skip the public internet entirely
with Tailscale (an afternoon, and every forwarded port closes). Pick one on purpose —
the current state is "leave it" whether or not that was chosen.

### 5. Verify the login rate limit actually covers login

[main.ts:24](apps/server/src/main.ts) mounts Better Auth as raw Express middleware,
registered outside Nest's routing:

```ts
http.all('/api/auth/*splat', toNodeHandler(auth));
```

`ThrottlerGuard` is installed as an `APP_GUARD`, which applies to Nest route handlers.
So `/api/auth/sign-in/email` — which reaches the same authentication path the controller
does — is plausibly not throttled at all. Rate limiting the controller while the
underlying endpoint stays open is worse than not having it, because it looks solved.

Confirm with curl in a loop, then throttle at the Express mount rather than only with a
`@Throttle` decorator. The global limit is
[300/min](apps/server/src/app.module.ts) regardless — right for fetching messages,
432,000 password guesses a day against an 8-character minimum.

### 6. CORS reflects any origin with credentials

`app.enableCors({ origin: true, credentials: true })` at
[main.ts:18](apps/server/src/main.ts). Bearer tokens limit the blast radius, but Better
Auth still sets cookies. Pin to the origins that actually exist.

### 7. Invite codes use `Math.random()`

[ids.ts:13](apps/server/src/common/ids.ts). Not a cryptographic generator, and invite
codes are now the entire perimeter around registration. One line to `crypto.randomInt`.

Keep the alphabet — no `I`, `L`, `O`, `0` or `1`, so nobody mistypes a code read aloud.

---

## P2 — Things that break on their own

### 8. There is no backup

None of the database, none of `data/`. Nine other people's messages, images and password
hashes, zero copies. `pg_dump` on a schedule written somewhere that is not this machine,
plus a copy of `data/` — and a restore actually tried once. Do this before telling anyone
the server is permanent.

### 9. The disk filling takes Postgres down, not just uploads

Uploads land in `data/` on the same disk as the database, capped at 26 MB each with no
per-user quota, no total cap and no cleanup. Postgres on a full disk stops accepting
writes, so the whole server goes down and does it in a way that takes a moment to
diagnose. A disk-space check is a five-line addition to the operator console.

### 10. Surviving a reboot

`install.ps1` registers scheduled tasks for installed servers, but the actual host starts
the chat server and LiveKit by hand. Ten people relying on this means it cannot need a
person after every power cut.

### 11. The public IP will move

It is a DHCP lease. When it changes, chat becomes unreachable and — once friends find the
new address — voice connects and stays silent, because `LIVEKIT_URL` still advertises the
old one. That second failure looks like an app bug and nothing in the logs says otherwise.
Dynamic DNS in both places removes it.

### 12. LiveKit advertises VirtualBox and Hyper-V addresses

Every client is offered `192.168.56.1` and `192.168.224.1` as ICE candidates. It works,
at the cost of a slow connect while the dead ones time out. The real risk is a collision:
a friend whose own network uses `192.168.56.x` tries to reach a device on their LAN
instead of the server. Home routers rarely use that range; office and hotel networks do,
and that is exactly where it will fail. `rtc.ips.excludes` trims the list.

### 13. There is no observability

Logs go to the console and nowhere else — a hundred thousand failed logins would pass
unnoticed. A failed-signin count per hour somewhere visible, and a rotating log file.
Also: the console renders UTC while everything it wraps is local time, so "it broke
around 3pm" costs an hour of arithmetic.

---

## P3 — Confidence in the code

### 14. There is no test infrastructure at all

No vitest, no jest, no `test` script in any of the four packages, and zero `*.test.ts`
files in the tree. `PROGRESS.md` describes the audio settings and the link parser as
unit-tested; that is not true of the current code.

Start with the modules that are already shaped for it — pure functions, no I/O:
`link-utils.ts`, `audio-levels.ts`, `image-size.ts`, `audio-config.ts`, and the
permission matrix in `PermissionService`.

### 15. No lint, no formatter, no typecheck script, no CI

A GitHub Action running build plus typecheck on push is an hour, and it catches the class
of bug that only appears in packaged builds — the `asarUnpack` and `electronVersion`
failures were both of that kind.

### 16. The audio settings have never been through a real two-machine call

Still open from `PROGRESS.md`, worth checking in its stated order: that echo cancellation
still works on speakers, that automatic sensitivity opens fast enough not to clip the
first word, and that `high` actually sounds better than `balanced` before anyone pays the
bandwidth for it.

---

## P4 — Product polish

### 17. `Chat.tsx` is 1250 lines

[apps/desktop/src/renderer/components/Chat.tsx](apps/desktop/src/renderer/components/Chat.tsx)
holds the message list, editing, moderation, attachments, unread markers and embeds.
Split it before adding reactions on top.

### 18. Features not built

Emoji reactions, theme toggle, non-image attachments, auto-update (deliberately skipped
so far), mentions and notifications, search.

### 19. Client error surfaces

What a user sees when the server returns 500, or is simply not there. Worth an
intentional answer rather than whatever currently happens.

### 20. Account deletion semantics

`DELETE /api/admin/users/:id` exists. Worth knowing now, not when someone asks, whether it
removes their messages and uploaded images or only the account row.

---

## P5 — Hygiene

### 21. The two docs disagree

`PROGRESS.md` is dated 2026-09-04 and describes a LAN-only deployment; `HOSTING.md` was
written the day it first worked over the internet. Reconcile them.

### 22. `livekit.yaml` has an uncommitted change

It flips back from `use_external_ip: true` to the LAN `node_ip`. This file silently
decides whether voice works at all — decide and commit it.

### 23. Version drift

Desktop is 0.2.0, server and workspace root are 0.1.0, and `/api/config` falls back to a
hardcoded `'0.1.0'` when `npm_package_version` is unset — which it is when the server runs
as a bare `node dist/main.js` rather than through an npm script.
