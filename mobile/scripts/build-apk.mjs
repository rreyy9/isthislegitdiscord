#!/usr/bin/env node
/**
 * Build a release APK and the manifest that publishes it.
 *
 * Everything the server's publish gate checks is produced here, so a build
 * that gets this far is one the server will accept: the version, the
 * versionCode Android compares, the file, and the sha256 of its bytes.
 *
 *   node scripts/build-apk.mjs              build, sign, write the manifest
 *   node scripts/build-apk.mjs --clean      regenerate android/ first
 *   node scripts/build-apk.mjs --allow-debug-signing
 *
 * Output lands in `mobile/release/`. Upload it with
 * `infra/publish-android-update.ps1`.
 *
 * The one thing this refuses to do is produce a publishable APK signed with
 * the debug keystore. See `plugins/with-release-signing.js` for why that is
 * worth a hard stop rather than a warning: the debug key is per machine, and
 * the first rebuild elsewhere locks every phone out of upgrading.
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const ANDROID_DIR = path.join(ROOT, 'android');

const args = new Set(process.argv.slice(2));
const clean = args.has('--clean');
const allowDebugSigning = args.has('--allow-debug-signing');

const say = (m) => process.stdout.write(`  ${m}\n`);
const warn = (m) => process.stdout.write(`  ! ${m}\n`);
function die(m) {
  process.stderr.write(`  x ${m}\n`);
  process.exit(1);
}

/**
 * The Expo CLI's entry script, run with this same Node rather than through
 * `npx`.
 *
 * Not a preference. Node 20.12 and later refuse to `spawn` a `.cmd` or `.bat`
 * file without a shell -- it is the fix for CVE-2024-27980, where an argument
 * could break out into a command through cmd.exe's parsing. `npx` on Windows
 * *is* `npx.cmd`, so `execFileSync('npx.cmd', ...)` now fails outright with
 * `EINVAL`, which reads like a missing binary and is not one.
 *
 * Passing `shell: true` would satisfy the check and put the arguments back
 * through cmd.exe, which is the thing that was dangerous. Resolving the CLI
 * and handing it to `process.execPath` skips the shim, the shell and the
 * quoting rules in one go, and starts faster besides.
 */
const EXPO_CLI = createRequire(import.meta.url).resolve('expo/bin/cli');

/** Run the Expo CLI, inheriting stdio so its output is the task's output. */
function expo(args, cwd = ROOT) {
  execFileSync(process.execPath, [EXPO_CLI, ...args], { cwd, stdio: 'inherit' });
}

/* ------------------------------------------------------- the two numbers */

/**
 * Ask Expo for the resolved config rather than reading app.json.
 *
 * `versionCode` is computed in app.config.js, so app.json does not contain it.
 * Asking the CLI is what guarantees the number written into the manifest is
 * the number the build actually compiled in -- a second derivation here could
 * drift from that one, which is precisely the failure this whole arrangement
 * exists to prevent.
 */
function resolvedConfig() {
  const raw = execFileSync(
    process.execPath,
    [EXPO_CLI, 'config', '--json', '--type', 'public'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // The CLI prints warnings above the JSON on some versions, so the object is
  // taken from the first brace rather than by parsing the whole stream.
  const json = raw.slice(raw.indexOf('{'));
  return JSON.parse(json);
}

/* ----------------------------------------------------------- toolchain */

/**
 * Where the Android SDK is, or null.
 *
 * Checked here rather than left to Gradle, which fails this case with "SDK
 * location not found. Define a valid SDK location with an ANDROID_HOME
 * environment variable or by setting the sdk.dir path in your project's
 * local.properties" -- after a Gradle daemon has started, buried in a stack
 * trace, and phrased as though the project were misconfigured rather than the
 * machine. It is one of the first things anybody hits and it is worth two
 * lines to say plainly.
 */
function androidSdk() {
  const fromEnv = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // The path both Android Studio and the standalone command-line tools use by
  // default, which is where it is even when nobody set the variable.
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
    : null;
  if (local && existsSync(local)) return local;

  return null;
}

/**
 * The JDK's major version, or null if java could not be asked.
 *
 * `spawnSync` and not `execFileSync`, because `java -version` writes its
 * version banner to **stderr** and then exits 0 -- every JDK has done this for
 * twenty years. `execFileSync` returns stdout and only exposes stderr on the
 * error it throws, so on a successful call the banner is simply discarded:
 * this read as "java is not on PATH" on a machine with a perfectly good JDK,
 * which is a worse answer than not checking at all.
 */
function javaMajor() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (result.error) return null;

  // stderr in practice, stdout defensively -- the split is not guaranteed
  // anywhere, it is just what every implementation happens to do.
  const banner = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  const m = /version "(\d+)/.exec(banner);
  return m ? Number(m[1]) : null;
}

/** React Native 0.86's Gradle setup targets this. */
const WANTED_JDK = 17;

/**
 * Point this project's Gradle at the SDK we just found.
 *
 * Gradle locates the SDK from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or
 * `local.properties` — and `expo prebuild` writes none of them. Writing the
 * file is better than telling somebody to set an environment variable: it is
 * project-local, it takes effect in the shell that is already open rather than
 * the next one, and it does not change the machine for every other Android
 * project on it.
 *
 * `android/` is generated and gitignored, so this is rewritten after every
 * prebuild and never committed. Backslashes are escaped because a
 * `.properties` file is Java's format, where a lone backslash is an escape
 * character and a Windows path would silently become nonsense.
 */
function writeLocalProperties(sdk) {
  const file = path.join(ANDROID_DIR, 'local.properties');
  const escaped = sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  writeFileSync(
    file,
    `# Written by scripts/build-apk.mjs. Generated, not committed.\n` +
      `sdk.dir=${escaped}\n`,
  );
}

/** Returns the SDK path, having refused to continue without one. */
function checkToolchain() {
  const sdk = androidSdk();
  if (!sdk) {
    die(
      'No Android SDK found.\n' +
        '    Gradle needs it, and neither ANDROID_HOME nor the default\n' +
        '    %LOCALAPPDATA%\\Android\\Sdk exists. Android Studio is not\n' +
        "    required — Google's android CLI manages the SDK on its own:\n" +
        '\n' +
        '      winget install --id Google.AndroidCLI -e\n' +
        '      android sdk install platform-tools\n' +
        '      android sdk install "platforms;android-36"\n' +
        '      android sdk install "build-tools;36.0.0"\n' +
        '\n' +
        '    Open a new shell after the winget install, or android will not\n' +
        '    be on PATH yet. That CLI exits non-zero even when it succeeds,\n' +
        '    so judge it by the SDK directory rather than the exit code.\n' +
        '    See mobile/README.md.',
    );
  }
  say(`Android SDK: ${sdk}`);

  const java = javaMajor();
  if (java === null) {
    warn('java is not on PATH, so Gradle will almost certainly fail.');
  } else if (java !== WANTED_JDK) {
    // A warning and not a refusal: a newer JDK often works, and refusing the
    // build over "often" would be worse than saying so and letting Gradle
    // answer. If Gradle then fails with something about class file versions
    // or an unsupported Gradle/JVM combination, this line is the reason.
    warn(
      `JDK ${java} is on PATH; React Native 0.86 targets JDK ${WANTED_JDK}.`,
    );
    warn(
      'It may work. If Gradle fails with a class file version or an ' +
        'unsupported JVM error, install Temurin 17 and point JAVA_HOME at it ' +
        'for this build.',
    );
  } else {
    say(`JDK ${java}`);
  }

  return sdk;
}

/* ------------------------------------------------------------- signing */

/**
 * Whether Gradle has been told about a real keystore.
 *
 * Read from the user's own gradle.properties, which is where these belong --
 * a keystore password in the repository is a keystore password in the git
 * history, and this one cannot be rotated without locking everybody out.
 */
function hasSigningProperties() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return false;
  const file = path.join(home, '.gradle', 'gradle.properties');
  if (!existsSync(file)) return false;
  return /^\s*ISTHISLEGIT_STORE_FILE\s*=/m.test(readFileSync(file, 'utf8'));
}

/**
 * Read the certificate an APK was actually signed with.
 *
 * Belt and braces over the property check above: the properties could be set
 * and the Gradle block could still have failed to apply -- a prebuild that
 * regenerated `android/` without the plugin, say. This looks at the artefact
 * rather than at the intent, which is the only check that cannot be wrong.
 */
function signerOf(apk) {
  try {
    return execFileSync('keytool', ['-printcert', '-jarfile', apk], {
      encoding: 'utf8',
    });
  } catch {
    // No keytool on PATH. Not fatal -- the property check already passed --
    // but say so, because it means the last line of defence is not running.
    return null;
  }
}

function assertNotDebugSigned(apk) {
  const cert = signerOf(apk);
  if (cert === null) {
    warn(
      'keytool is not on PATH, so the signing certificate was not verified. ' +
        'It is in the JDK bin directory.',
    );
    return;
  }
  // The debug keystore's certificate is always this, on every machine that
  // has ever generated one.
  if (/CN=Android Debug/i.test(cert)) {
    die(
      'That APK is signed with the Android debug keystore.\n' +
        '    It would install, and then the next build from any other machine\n' +
        '    would be refused by every phone that has it — recoverable only by\n' +
        '    uninstalling, which wipes everybody\'s saved session.\n' +
        '    Set up a release keystore (see mobile/README.md), or pass\n' +
        '    --allow-debug-signing for a build you will not hand to anyone.',
    );
  }
}

/* ------------------------------------------------------------------ main */

const config = resolvedConfig();
const version = config.version;
const versionCode = config.android?.versionCode;

if (!version || typeof versionCode !== 'number') {
  die('Could not read version and versionCode from the Expo config.');
}

say(`Building isthislegit ${version} (versionCode ${versionCode})`);

const sdkPath = checkToolchain();

const signed = hasSigningProperties();
if (!signed && !allowDebugSigning) {
  die(
    'No release keystore configured.\n' +
      '    Gradle needs ISTHISLEGIT_STORE_FILE, ISTHISLEGIT_STORE_PASSWORD,\n' +
      '    ISTHISLEGIT_KEY_ALIAS and ISTHISLEGIT_KEY_PASSWORD in\n' +
      '    ~/.gradle/gradle.properties. See mobile/README.md — this is the one\n' +
      '    setup step that cannot be undone later.',
  );
}
if (!signed) {
  warn('Building debug-signed because --allow-debug-signing was passed.');
  warn('Do not publish this APK or give it to anybody.');
}

/* ------------------------------------------------------------- prebuild */

if (clean || !existsSync(ANDROID_DIR)) {
  say(clean ? 'Regenerating android/ ...' : 'No android/ yet - generating it ...');
  expo(['prebuild', '--platform', 'android', ...(clean ? ['--clean'] : [])]);
}

/* -------------------------------------------------------------- gradle */

// After the prebuild, not before: a `--clean` throws the directory away and
// would take the file with it.
writeLocalProperties(sdkPath);

say('Running Gradle (first run downloads a lot and takes a while) ...');

// `execSync` and not `execFileSync`: the wrapper on Windows is `gradlew.bat`,
// and a batch file genuinely does need a shell to run -- which is what the
// Node change above refuses to do implicitly. Doing it explicitly is safe
// here and not above, because every part of this command is a path this
// script computed. Nothing from the config or the command line reaches it.
//
// An absolute path, and not the bare name with `cwd` set. cmd.exe does not
// search the working directory for an executable -- that behaviour is off by
// default and is what `NoDefaultCurrentDirectoryInExePath` governs -- so
// `gradlew.bat assembleRelease` fails with "not recognized as an internal or
// external command", which reads as a missing Gradle rather than a lookup
// rule. Quoted because the path runs through a user profile directory and
// those contain spaces more often than not.
const gradlew = path.join(
  ANDROID_DIR,
  process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
);
execSync(`"${gradlew}" assembleRelease`, {
  cwd: ANDROID_DIR,
  stdio: 'inherit',
});

const built = path.join(
  ANDROID_DIR,
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk',
);
if (!existsSync(built)) {
  die(`Gradle finished but there is no APK at ${built}.`);
}

if (!allowDebugSigning) assertNotDebugSigned(built);

/* ------------------------------------------------------ name and hash it */

// A fresh directory every time. A release folder that accumulates old builds
// is how the wrong APK gets uploaded, and the manifest names exactly one file.
rmSync(RELEASE_DIR, { recursive: true, force: true });
mkdirSync(RELEASE_DIR, { recursive: true });

const apkName = `isthislegit-${version}.apk`;
const apkPath = path.join(RELEASE_DIR, apkName);
copyFileSync(built, apkPath);

const bytes = readFileSync(apkPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');

/**
 * The manifest, in the shape `AndroidUpdatesService` validates.
 *
 * `publishedAt` is deliberately not written here: the server stamps it on
 * publish and overwrites whatever an upload claims, because it is a fact about
 * publishing rather than about the build.
 */
const manifest = {
  version,
  versionCode,
  apk: apkName,
  sha256,
  size: bytes.length,
};

writeFileSync(
  path.join(RELEASE_DIR, 'latest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const mb = (bytes.length / 1024 / 1024).toFixed(1);
say('');
say(`Built ${apkName} (${mb} MB)`);
say(`  sha256 ${sha256}`);
say(`  in     ${RELEASE_DIR}`);
say('');
say('Install it on a phone plugged in over USB:');
say(`  adb install -r "${apkPath}"`);
say('');
say('Publish it to the server:');
say(
  '  powershell -ExecutionPolicy Bypass -File ..\\infra\\publish-android-update.ps1 `',
);
say('      -ServerUrl https://isthislegit.duckdns.org -Username <admin>');
