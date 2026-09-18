# isthislegit — Android client

Chat and channels on a phone, against the same server the desktop client talks
to. No Play Store: the APK is built here and served from your own server, over
the same update channel the desktop installer already uses.

## Contents

- [What it does, and what it does not](#what-it-does-and-what-it-does-not)
- [Why it lives outside the workspace](#why-it-lives-outside-the-workspace)
- [Running it while developing](#running-it-while-developing)
- [The toolchain](#the-toolchain)
- [The keystore](#the-keystore)
- [Building an APK](#building-an-apk)
- [Getting it onto a phone](#getting-it-onto-a-phone)
- [Publishing an update](#publishing-an-update)
- [The two version numbers](#the-two-version-numbers)
- [Cleartext and LAN servers](#cleartext-and-lan-servers)
- [Decisions worth not re-litigating](#decisions-worth-not-re-litigating)

---

## What it does, and what it does not

**It does:** sign in (and redeem an invite), list guilds and channels, read a
channel with history paging, send messages, show who is typing and who is
online, render mentions and replies, back-fill what was missed while the phone
was asleep, and offer a newer APK when one is published.

**It does not,** yet:

| Not yet | Why, and what it needs |
|---|---|
| Voice | LiveKit's RN SDK, a foreground service and audio focus. The server side already works — `/api/channels/:id/voice-token` is untouched. |
| Push notifications | The server has no push infrastructure at all. Needs a device-token table, a registration route, and a hook in `notifyMentions`. Until then, notifications only exist while the app is open. |
| Unread badges | The socket event (`channel:activity`) is received and deliberately ignored. A dot that appears and never clears is worse than no dot; it needs read-state reconciliation to go with it. |
| Sending attachments | Needs a picker and multipart upload. Incoming attachments are *listed* so a message that was only a screenshot doesn't render as a blank gap. |
| Composing mentions | Reading them works. Writing them needs the longest-match rules from the desktop client's `mention-utils.ts`, and a half-working version silently sends the wrong person's name as plain text. |
| Watch party, reactions, pins, search, moderation | Desktop only for now. |

---

## Why it lives outside the workspace

The root `package.json` has `workspaces: ["packages/*", "apps/*"]`. This app is
at `mobile/`, which matches neither — deliberately.

npm workspaces hoist dependencies to the root `node_modules`. Metro, React
Native's bundler, resolves modules by walking up from a file and has a long
history of trouble with hoisted and symlinked trees. More to the point: a
change to this app's dependency tree would re-resolve the root lockfile, and
the thing on the other end of that lockfile is the server that ten people
depend on. Keeping them apart means `npm install` here cannot break the server
build, and nothing here is one `npm ci` away from a surprise.

The cost is that this app cannot import `@isthislegit/shared`. That is the
same trade the desktop client already makes — see the note at the top of
`src/types.ts`, and the README's *Decisions worth not re-litigating*. The DTOs
are redeclared and the compatibility rule that makes it safe is the project's
existing one: **every field a newer server adds is optional here, and is read
with `?.` or `?? default`.**

---

## Running it while developing

```bash
cd mobile
npm install
npm start
```

Install **Expo Go** from the Play Store, scan the QR code, and the app runs on
your phone with live reload. This needs no Android SDK and no Gradle — for
everything in *What it does* above, Expo Go is the whole development loop.

Point it at a server on the sign-in screen. The default is the public
deployment; for a server on your desk use your machine's LAN address
(`http://192.168.1.x:3000`), not `localhost` — on a phone, localhost is the
phone.

---

## The toolchain

Only needed once you want a real APK. Expo Go covers development without any
of it.

**Android SDK** — not the whole of Android Studio. Google's `android` CLI is a
single portable binary that manages the SDK, and has replaced the old
`cmdline-tools` zip and its `sdkmanager`:

```bash
winget install --id Google.AndroidCLI -e
```

Then the three pieces this project needs — the versions are not arbitrary,
they are what `expo-root-project` defaults to (`compileSdk` 35, `targetSdk` 35,
`buildTools` 35.0.0, `minSdk` 24):

```bash
android sdk install platform-tools
android sdk install "platforms;android-35"
android sdk install "build-tools;35.0.0"
```

About 260 MB in total, landing in `%LOCALAPPDATA%\Android\Sdk`.

Two quirks of that CLI worth knowing, so neither looks like a failure:

- **It exits non-zero on success.** `android sdk install` and `android sdk list`
  return exit code 9 having done exactly what was asked. Check the SDK
  directory rather than the exit code.
- **`android` is only on `PATH` in a new shell.** winget says so and it is easy
  to miss; the very next command in the same window will not find it.

You do **not** need to set `ANDROID_HOME`. `npm run apk` finds the SDK — from
that variable if you have set it, otherwise at the default path — and writes
`android/local.properties` pointing Gradle at it. That is project-local, takes
effect in the shell already open, and leaves every other Android project on the
machine alone. You will still want `platform-tools` on `PATH` for `adb`.

**JDK 17.** React Native 0.86's Gradle setup targets 17. A newer JDK may work
and is not worth finding out on a release build:

```bash
winget install --id EclipseAdoptium.Temurin.17.JDK -e
```

Point `JAVA_HOME` at it for the build. If you have a newer JDK your other work
depends on, set it in the build shell only rather than system-wide.

`npm run apk` checks both before it starts Gradle, and says which is missing —
Gradle's own answer for an absent SDK is a stack trace phrased as though the
project were misconfigured rather than the machine. A JDK that is not 17 is a
warning rather than a refusal: newer often works, and finding out is cheaper
than being blocked.

> `eas build --local` does **not** run on Windows — it needs macOS or Linux.
> You don't need it. `npm run apk` drives Gradle directly and runs natively.

---

## The keystore

**This is the one decision here that cannot be undone.** Read it before the
first build you give to anybody.

Android identifies an app by its package name *and* the key it was signed
with. Sign a later build with a different key and every phone that has the
earlier one refuses the update — `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. The only
way out is uninstalling, which wipes the app's data including the saved
session, for everybody at once.

There is no Play App Signing here to fall back on. You are the root of trust.

Generate one, once:

```bash
keytool -genkeypair -v -keystore isthislegit-release.keystore -alias isthislegit -keyalg RSA -keysize 4096 -validity 10000
```

Then tell Gradle about it in `~/.gradle/gradle.properties` — **not** in this
repository, which is why `plugins/with-release-signing.js` reads it from there:

```properties
ISTHISLEGIT_STORE_FILE=C:/Users/you/keys/isthislegit-release.keystore
ISTHISLEGIT_STORE_PASSWORD=...
ISTHISLEGIT_KEY_ALIAS=isthislegit
ISTHISLEGIT_KEY_PASSWORD=...
```

Then, and this matters more than any of the commands:

- **Back the keystore up somewhere that is not this laptop.** Losing it is
  unrecoverable in the same way as signing with the wrong one.
- `*.keystore` and `*.jks` are in `.gitignore`. Leave them there.

### Why the plugin exists

`expo prebuild` generates an `android/app/build.gradle` whose **release** build
type is configured with `signingConfig signingConfigs.debug`. A release APK
built out of the box is therefore signed with the *debug* keystore — which
installs, runs, and looks entirely correct.

The debug keystore is generated per machine and regenerated whenever it goes
missing. So the trap springs later: the next build, from another machine or
after a laptop rebuild, is signed with a different key and is refused by every
phone that has the first one.

`plugins/with-release-signing.js` overrides that, and `scripts/build-apk.mjs`
**refuses to build** without signing properties — and then checks the finished
APK's certificate with `keytool` to confirm the override actually applied.
Pass `--allow-debug-signing` only for a build you will not hand to anyone.

---

## Building an APK

```bash
cd mobile
npm run apk
```

That generates `android/` if it is not there, runs `gradlew assembleRelease`,
verifies the signature, and writes to `mobile/release/`:

- `isthislegit-<version>.apk`
- `latest.json` — the manifest the server validates, carrying the version, the
  versionCode, and the APK's sha256

Use `npm run apk -- --clean` after changing `app.json`, `app.config.js` or
anything in `plugins/`, which is what regenerates `android/` from scratch.

### From VS Code

`.vscode/tasks.json` has the whole loop, beside the desktop equivalents:

| Task | What it does |
|---|---|
| **Android app (dev)** | `expo start` — the QR code for Expo Go. No SDK needed. |
| **Typecheck Android client** | `tsc --noEmit`. The packaging task depends on it. |
| **Set Android version** | Prompts, then `npm version` here. |
| **Build and package Android client** | Typecheck, then this APK build. |
| **Rebuild Android project** | `expo prebuild --clean`, for when Gradle fails inexplicably. |
| **Install Android client on a plugged-in phone** | `adb install -r` on whatever is in `release/`. |

`android/` is **not** committed: it is derived from the config, and committing
it would mean every config change had to be made in two places — the second of
which is the one that gets forgotten.

---

## Getting it onto a phone

Over USB, with developer options and USB debugging on:

```bash
adb install -r mobile/release/isthislegit-0.1.0.apk
```

Or publish it (below) and download it from the server in the phone's browser.

Two things to expect, and to warn people about in advance:

- **Play Protect will complain** the first time, because the APK is not signed
  by any store. It can be dismissed; it usually does not come back.
- **"Install unknown apps" is granted per source**, not globally. Allowing it
  for Chrome does not allow it for Files. Whichever app the download lands in
  is the one that needs the toggle.

---

## Publishing an update

The server has an Android channel beside the desktop one:
`AndroidUpdatesService`, at `/updates/android` with staging and publish routes
under `/api/admin/updates/android`. It is a separate service from the desktop
feed on purpose — see the note at the top of that file.

```bash
cd mobile
npm run apk

powershell -ExecutionPolicy Bypass -File ..\infra\publish-android-update.ps1 `
    -ServerUrl https://isthislegit.duckdns.org -Username <an admin>
```

That uploads `latest.json` and the APK to staging, then publishes. On publish
the server emits `android:update-available`, and every connected phone shows a
banner offering it. The banner opens the APK's URL in the browser; the person
taps the finished download to install.

Add `-StageOnly` to upload without publishing. Nothing is served to any phone
until a publish.

The server refuses a publish that does not pass all four checks: the manifest
names an APK that is present, the bytes hash to what the manifest claims, the
version is newer, and the versionCode is higher. The publish script checks the
last two *before* uploading, so a mistake costs a second rather than an
APK-sized upload over a home connection.

### Why the feed is unauthenticated

Same reasoning as the desktop feed. The moment an update matters most is when
somebody's session has lapsed and they are stranded on an old build — a feed
behind a token fails exactly then. The APK carries no secret; it is the same
file everyone running the app already has.

---

## The two version numbers

`version` in `mobile/package.json` is the semver, and the only one you edit —
with `npm version`, from this directory, or the **Set Android version** task:

```bash
cd mobile
npm version 0.2.0 --no-git-tag-version
```

It is deliberately *not* in `app.json`; `app.config.js` reads it from
`package.json` so that `npm version` is the one way to move it. This app is
outside the root `workspaces` glob, so the workspace-wide `npm version
--workspaces` does not reach it — and a second version number that nothing
updated and everything trusted is exactly the failure to design out.

Its number is independent of the desktop client's, which is correct: the two
ship separately, and the server keeps their update feeds and their telemetry
apart for the same reason.

`versionCode` is Android's own monotonic integer, and it is **derived** from
the semver in `app.config.js` (`major * 10000 + minor * 100 + patch`, so 0.1.0
is 100 and 1.0.0 is 10000). It is not stored anywhere, so it cannot drift.

That is not tidiness. Android compares `versionCode` and nothing else when
deciding whether an install is an upgrade, and it refuses one whose code has
not risen. A build with a bumped semver and a forgotten code is rejected by
every phone it reaches, and the message none of them shows says nothing about
why. Deriving it removes the mistake rather than documenting it.

One consequence to know: a prerelease suffix is ignored, so `0.2.0-beta.1` and
`0.2.0` produce the same code. Do not hand out a beta and then the release
without a patch bump.

---

## Cleartext and LAN servers

`app.json` sets `usesCleartextTraffic: true` via `expo-build-properties`.
Android blocks plain HTTP by default, and without this the app could only ever
reach an HTTPS server — which would rule out every self-hosted box that has no
reverse proxy in front of it, and every `http://192.168.x.x:3000` during
development. For a self-hosted application that is too much to give up.

What it costs: the app *can* speak plaintext — but only to a host somebody
typed into the server field, and this is not a browser following links. The
sign-in screen warns in place when the address is `http://`.

The tighter option, if it ever matters, is a network security config that
permits cleartext only to private address ranges. It needs a config plugin
writing the XML, and it was not worth it for the first build.

---

## Decisions worth not re-litigating

- **React Native, not a WebView around the desktop renderer.** Reusing
  `Chat.tsx` looks like the cheap path and is not: it is 3,700 lines of
  desktop shape — hover toolbars, right-click menus, keyboard shortcuts — on
  top of a hard dependency on the Electron preload bridge for settings, token
  storage and notifications. The interaction model would be rewritten anyway,
  and a WebView origin would have to be punched into the server's CORS
  allowlist. A native client sends no `Origin` at all, which `isOriginAllowed`
  already permits, so the server needed no CORS change whatsoever.

- **A stack of two screens, not a drawer.** A drawer is the better shape for a
  chat client and is where this should go. It also brings `reanimated` and
  `gesture-handler`, and every native module is one more thing that can break
  the first Gradle build on a machine that has never built an Android app. The
  back gesture already does the navigating.

- **`FlatList`, not `FlashList`.** Same reasoning — fewer native modules for
  the first APK. A few hundred messages is well within what an inverted
  `FlatList` handles. Revisit when a channel gets slow, not before.

- **Messages are held newest-first.** That is what an inverted list wants and
  the opposite of what the API returns. The conversion happens once, at the
  edge, in the history fetch — doing it per render would copy the whole
  channel every time somebody typed a character.

- **Day separators render first inside each cell, not last.** `inverted`
  reverses the order of cells but flips each one back, so layout *inside* a
  cell is ordinary top-to-bottom. Getting this backwards groups a message with
  the one that follows it, which looks almost right.

- **No manual `scaleY: -1` on the empty/footer components.** VirtualizedList
  already composes its inversion transform onto them; adding another either
  double-flips them or overrides the one that was correcting them. Both land
  upside down, which is why it is tempting to "fix" it twice.

- **The reconnect backfill walks forward from a cursor, and loops.** A phone
  disconnects every time the screen goes off, so this runs many times an hour
  and has to be cheap. It loops because a phone left in a pocket can be more
  than one page behind, and a single call would leave a hole in the middle of
  the conversation with nothing indicating it was there.

- **Every send carries a `clientNonce`, and one function folds messages in.**
  The POST response and the `message:new` broadcast are the same message and
  routinely race. Without one place that reconciles them, the sender sees
  their own message twice — the most obvious possible bug, and one only the
  sender ever sees.

- **The socket handshake reports `platform: 'android'`.** The server keys its
  "oldest connected build" figure on it. Without it a phone on 0.1.0 counts as
  an ancient desktop client, and the console reports that nobody has upgraded
  the desktop app since it shipped — which is the one question that telemetry
  exists to answer.

- **Updates compare `versionCode`, not the semver.** It is the number Android
  itself compares, and the one the server has promised rises with every build.
