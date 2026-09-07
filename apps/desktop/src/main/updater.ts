import { app, BrowserWindow, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn } from 'node:child_process';
import { appendFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  closeUpdateWindow,
  openUpdateWindow,
  setUpdateWindowStatus,
} from './update-window';

/**
 * Updating the app in place.
 *
 * electron-updater against a `generic` feed the chat server hosts itself, at
 * `<serverUrl>/updates/desktop`.
 *
 * **The feed URL is not baked into the build.** This client hardcodes nothing
 * else -- the server address is a field on the sign-in screen -- so a
 * compiled-in update URL would be the single exception, and it would mean a
 * separate build per deployment. The renderer hands over the address it is
 * actually signed in to, and the feed is set then.
 *
 * **https only.** The NSIS build is unsigned, so electron-updater cannot check
 * a publisher name; what it can check is the sha512 in latest.yml against the
 * file it downloaded. That makes TLS the root of the chain. Over plain http
 * anyone on the path can serve a latest.yml of their own and the hash will
 * match whatever they attached to it, so there is nothing to verify against
 * and the updater is left switched off.
 *
 * **No fallbacks.** If the feed is unreachable, the download fails, or the
 * install is refused, this says so once and the app carries on running the
 * version it has. A second path would be tested a tenth as often as the first,
 * on ten machines that are not this one; the recovery is the installer, by
 * hand.
 */

// electron-updater is CommonJS, and its named exports do not survive the
// interop when this file is bundled as ESM. Reach through the default.
const { autoUpdater } = electronUpdater;

export type UpdateStage =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  /** Handed over to the installer; the app is on its way out. */
  | 'installing'
  | 'error';

export interface UpdateState {
  stage: UpdateStage;
  version: string | null;
  percent: number;
  message: string | null;
  /**
   * True when installing will raise a UAC prompt, so the button can say so
   * before it is pressed. See `installNeedsElevation`.
   */
  elevates: boolean;
  /**
   * True while the renderer is in a voice channel. Not a refusal -- see
   * `leaveVoiceForUpdate` -- but the banner says what will happen to the call
   * before the button is pressed.
   */
  inCall: boolean;
}

let state: UpdateState = {
  stage: 'idle',
  version: null,
  percent: 0,
  message: null,
  elevates: false,
  inCall: false,
};

let feedUrl: string | null = null;

/**
 * The installer on disk, from the `update-downloaded` event.
 *
 * Kept because this installs by spawning it rather than by calling
 * `quitAndInstall`. See `spawnInstaller` for why.
 */
let downloadedFile: string | null = null;

/**
 * True while the renderer is in a voice channel.
 *
 * This used to refuse the install outright. It no longer does: being in a call
 * is an ordinary state to be in when an update lands, and "come back later" is
 * not much of an answer to somebody who sits in a channel all evening. What it
 * does instead is make the call part of the hand-off -- left properly on the
 * way out, and rejoined on the way back in.
 */
let inCall = false;

/**
 * Set once the app has started closing into the installer, so `before-quit`
 * stops letting the process die. See `handOverToInstaller`.
 */
let installing = false;

/* ------------------------------------------------------------------- log */

/**
 * electron-updater's own log, on disk.
 *
 * Its default logger is `electron-log` where that happens to be installed and
 * `console` otherwise, and console output from a packaged Windows build goes
 * nowhere at all. Everything that made the old restart look like it did
 * nothing -- which installer ran, with which arguments, whether it elevated --
 * was being written to that nowhere. This is one file, truncated when it gets
 * long, and it is the first thing to read when an update misbehaves on a
 * machine that is not this one.
 */
const logPath = join(app.getPath('userData'), 'updater.log');

function write(level: string, ...args: unknown[]) {
  const line =
    `[${new Date().toISOString()}] ${level} ` +
    args
      .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
      .join(' ') +
    '\n';
  try {
    // Truncated rather than rotated: nobody is reading the previous quarter
    // megabyte, and a second file is a second thing to explain.
    if (statSync(logPath).size > 256 * 1024) writeFileSync(logPath, '');
  } catch {
    // No file yet, which the append below is about to fix.
  }
  try {
    appendFileSync(logPath, line);
  } catch {
    // A log that cannot be written must not take the update down with it.
  }
}

const logger = {
  info: (...a: unknown[]) => write('info', ...a),
  warn: (...a: unknown[]) => write('warn', ...a),
  error: (...a: unknown[]) => write('error', ...a),
  debug: (...a: unknown[]) => write('debug', ...a),
};

/* -------------------------------------------------------------- elevation */

/**
 * Whether replacing this install needs administrator rights.
 *
 * The NSIS build offers "for me" and "for all users", and the second one puts
 * the app in Program Files -- so whether an update raises UAC is a property of
 * a choice somebody made when they first installed, not of the build. Guessing
 * it wrong is what produced the worst part of the old flow: a UAC prompt that
 * appeared out of nowhere, minutes later, after the app had been closed by
 * hand.
 *
 * Asked by writing a file rather than with `fs.access`: on Windows the access
 * check looks at the read-only attribute and not at the ACL, so it reports
 * Program Files as writable when it is not.
 */
function installNeedsElevation(): boolean {
  const probe = join(
    dirname(app.getPath('exe')),
    `.update-probe-${process.pid}`,
  );
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
    return false;
  } catch {
    return true;
  }
}

function publish(win: () => BrowserWindow | null, patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  win()?.webContents.send('update:state', state);
}

/* ------------------------------------------------------------------ voice */

/** Resolves when the renderer says it is out of the channel. */
let voiceLeft: (() => void) | null = null;

/**
 * Get out of the voice channel before the process dies.
 *
 * Being killed mid-call does not remove anybody from a LiveKit room; it leaves
 * a participant sitting there until the server times the connection out, which
 * is most of a minute of other people talking to somebody who is not there.
 * The renderer's `beforeunload` disconnect is no help either -- it is
 * asynchronous, and nothing waits for it -- and this process is about to be
 * killed outright by the installer, which runs no JavaScript at all.
 *
 * So main asks, and waits. The renderer leaves the room, writes down which
 * channel it was in so the new build can walk back into it, and answers.
 *
 * Capped, because a renderer that has wedged must not be able to hold an
 * update open for ever. Going ahead anyway costs a ghost in the channel for as
 * long as the server takes to notice, which is the same thing that happens
 * today on a crash.
 */
async function leaveVoiceForUpdate(win: () => BrowserWindow | null) {
  const target = win();
  if (!target) return;

  const done = new Promise<void>((resolve) => {
    voiceLeft = resolve;
  });
  target.webContents.send('update:leave-voice');

  await Promise.race([
    done,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn('Renderer did not confirm leaving voice; going ahead');
        resolve();
      }, 4000),
    ),
  ]);
  voiceLeft = null;
}

/* -------------------------------------------------------------- installer */

/**
 * Start the installer, elevated where this install needs it.
 *
 * This is a spawn rather than `autoUpdater.quitAndInstall`, and the reason is
 * specific to the per-machine case. Left to itself, electron-updater launches
 * the installer unelevated and NSIS elevates from the inside -- and the
 * elevated instance it spawns then skips the check that waits for the running
 * app to close (`UAC_IsInnerInstance` in installSection.nsh), so it starts
 * overwriting files while this process is still holding them open. Worse, a
 * declined UAC prompt happens entirely inside a process nobody is watching:
 * electron-updater has already quit the app, and the update simply does not
 * happen, with nothing left running to say so.
 *
 * Launching through `elevate.exe` -- which electron-builder ships in resources
 * for exactly this, and which electron-updater itself uses when a build is
 * marked as needing admin rights -- turns both of those around. The prompt
 * comes up immediately, while the progress window is still on screen to
 * explain it; the installer that follows is a normal outer instance, so it
 * waits for this app and closes it properly; and if the prompt is declined,
 * nothing kills this process, which is what `handOverToInstaller` watches for.
 *
 * The arguments are the ones electron-updater passes: `--updated` so the
 * installer knows this is an upgrade and skips its wizard pages, `/S` for
 * silent -- which is also the only mode in which the assisted installer
 * honours the next one -- and `--force-run` to bring the app back up.
 */
function spawnInstaller(installer: string, elevated: boolean) {
  const args = ['--updated', '/S', '--force-run'];
  const command = elevated
    ? join(process.resourcesPath, 'elevate.exe')
    : installer;
  const argv = elevated ? [installer, ...args] : args;

  logger.info(`Spawning ${command} ${argv.join(' ')}`);
  const child = spawn(command, argv, { detached: true, stdio: 'ignore' });
  // Detached and unreferenced so it outlives this process, which is the whole
  // point: it is going to be the one that ends it.
  child.unref();
  return child;
}

/* ---------------------------------------------------------------- hand-off */

/**
 * Give up the app to the installer, with something on screen the whole way.
 *
 * Every step is here because leaving it out is one of the ways the old restart
 * went wrong:
 *
 * 1. The progress window goes up, and is waited on until it has painted.
 *    Everything after this is invisible, so a window that is not up first
 *    means pressing the button looks like it did nothing.
 * 2. The voice channel is left, and waited for. See `leaveVoiceForUpdate`.
 * 3. The main window is hidden rather than closed, so `window-all-closed` does
 *    not quit the app out from under the rest of this.
 * 4. The installer is spawned -- see `spawnInstaller` -- and then nothing.
 *    This process does not end itself: the installer waits for it, closes it,
 *    and puts the new build up in its place. Which means the progress window
 *    stays on screen for as long as the hand-off actually takes, including
 *    however long somebody spends reading the UAC prompt, rather than for a
 *    number of milliseconds guessed at here.
 * 5. Still running a while later means it did not happen -- the prompt was
 *    declined, or the installer gave up. Nothing else would have left this
 *    process alive. The app comes back rather than being killed off by a timer
 *    into an update that was never installed.
 */
async function handOverToInstaller(win: () => BrowserWindow | null) {
  const version = state.version ?? app.getVersion();
  const elevates = installNeedsElevation();
  const installer = downloadedFile;

  if (!installer) {
    publish(win, {
      stage: 'error',
      message: 'The downloaded installer has gone missing. Download it again.',
    });
    return;
  }

  installing = true;
  publish(win, { stage: 'installing', elevates, message: null });
  logger.info(
    `Handing over to installer: version ${version}, elevates ${elevates}, ` +
      `inCall ${inCall}, file ${installer}`,
  );

  try {
    await openUpdateWindow(version);

    if (inCall) {
      await setUpdateWindowStatus(
        `Version ${version}`,
        'Leaving the voice channel…',
        'You will be put back in it when the app reopens.',
      );
      await leaveVoiceForUpdate(win);
    }

    win()?.hide();

    await setUpdateWindowStatus(
      `Version ${version}`,
      'Installing…',
      elevates
        ? 'Windows will ask for permission — this copy is installed for all users.'
        : 'The app will reopen when this is done.',
    );
    // A beat with that on screen before the prompt lands on top of it. A UAC
    // dialog appearing in the same frame as the app disappearing reads as a
    // crash, which is the last thing anybody should be clicking through
    // without reading.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const child = spawnInstaller(installer, elevates);
    // The one failure that happens before the installer is running at all:
    // elevate.exe missing, or the file no longer where it was downloaded.
    child.on('error', (err) => abandon(win, err.message));

    // Long enough that a slow machine, or somebody who wandered off mid-prompt,
    // is not cut short; short enough that a declined prompt does not leave a
    // progress window sitting there for the rest of the evening.
    installTimeout = setTimeout(() => {
      abandon(win, 'The update was not installed.');
    }, 90_000);
  } catch (err) {
    logger.error('Hand-off failed', err);
    abandon(win, (err as Error)?.message ?? 'Could not start the installer.');
  }
}

/** Where the timer in step 5 lives, so a successful hand-off is not chased. */
let installTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Put the app back, because the update did not happen.
 *
 * Nothing in the hand-off is allowed to leave `installing` set: that flag is
 * the only thing refusing `before-quit`, so a hand-off that fell over halfway
 * would leave an app that cannot be closed at all.
 */
function abandon(win: () => BrowserWindow | null, message: string) {
  if (!installing) return;
  installing = false;
  if (installTimeout) clearTimeout(installTimeout);
  installTimeout = null;
  logger.warn(`Install abandoned: ${message}`);
  closeUpdateWindow();
  const target = win();
  target?.show();
  // Back to `ready`, not `error`: the installer is still downloaded and still
  // good, and the usual reason for being here is somebody having said no to a
  // prompt. Pressing the button again is the whole recovery.
  publish(win, { stage: 'ready', message });
  // Whoever was dropped out of a call for this is owed it back, since the
  // restart they were dropped for is not coming.
  target?.webContents.send('update:rejoin-voice');
}

export function registerUpdater(win: () => BrowserWindow | null): void {
  autoUpdater.logger = logger;
  // Downloading is explicit, and so is installing. An update that installs
  // itself during a conversation is an update that closed the app somebody was
  // typing in.
  autoUpdater.autoDownload = false;
  // Nothing here publishes a web installer, and leaving this false only earns
  // a warning in the log on every download.
  autoUpdater.disableWebInstaller = true;

  /**
   * The passive path: a downloaded update is applied when the app is quit
   * normally -- but only where that is genuinely invisible.
   *
   * On a per-machine install it is not. It is a silent installer that raises
   * UAC seconds after the window has gone, with nothing left on screen to say
   * what is asking; and because that path passes `isForceRunAfter` as false,
   * the app does not come back either. That is exactly the "close the app, get
   * a UAC prompt out of nowhere, then go and open it again yourself" sequence
   * this is meant to be rid of. Where no elevation is needed the install
   * really is silent and instant, so there it stays on.
   */
  const elevates = installNeedsElevation();
  autoUpdater.autoInstallOnAppQuit = !elevates;
  state = { ...state, elevates };
  logger.info(
    `Updater ready: version ${app.getVersion()}, packaged ${app.isPackaged}, ` +
      `install ${dirname(app.getPath('exe'))}, elevates ${elevates}`,
  );

  // Refused while the hand-off is running, so the progress window outlives the
  // app it is standing in for. See handOverToInstaller.
  app.on('before-quit', (event) => {
    if (installing) event.preventDefault();
  });

  autoUpdater.on('checking-for-update', () =>
    publish(win, { stage: 'checking', message: null }),
  );
  autoUpdater.on('update-available', (info) =>
    publish(win, { stage: 'available', version: info.version, message: null }),
  );
  autoUpdater.on('update-not-available', () =>
    publish(win, { stage: 'idle', version: null, message: null }),
  );
  autoUpdater.on('download-progress', (p) =>
    publish(win, { stage: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    // Kept because installing is a spawn here rather than a `quitAndInstall`,
    // and this event is the only public place the path to the downloaded
    // installer is handed out. See spawnInstaller.
    downloadedFile = info.downloadedFile;
    publish(win, { stage: 'ready', version: info.version, percent: 100 });
  });
  autoUpdater.on('error', (err) => {
    // An error raised during the hand-off has nowhere to go: the main window
    // is hidden and the progress window is up. Put the app back on screen
    // first, then let the banner say what happened.
    if (installing) abandon(win, err?.message ?? 'The update failed.');
    publish(win, {
      stage: 'error',
      // Said once, and then the app carries on with the version it has.
      message: err?.message ?? 'The update failed.',
    });
  });

  ipcMain.handle('update:state', () => state);

  /**
   * Point the updater at a server and ask it what it has.
   *
   * Called by the renderer once it knows which server it is signed in to, so
   * the feed follows the address rather than the build.
   */
  ipcMain.handle('update:check', async (_e, serverUrl: string) => {
    if (!app.isPackaged) {
      // A dev build has no version to compare against and no installer to
      // replace. Saying so beats a confusing error from the updater.
      publish(win, {
        stage: 'unsupported',
        message: 'Updates are for installed builds; this one runs from source.',
      });
      return state;
    }

    let origin: string;
    try {
      origin = new URL(serverUrl).origin;
    } catch {
      publish(win, { stage: 'error', message: 'That server address is not a URL.' });
      return state;
    }

    if (!origin.startsWith('https://')) {
      publish(win, {
        stage: 'unsupported',
        message:
          'Updates need an https server address. This build is unsigned, so ' +
          'TLS is the only thing that proves an update came from your server.',
      });
      return state;
    }

    const next = `${origin}/updates/desktop`;
    if (next !== feedUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: next });
      feedUrl = next;
    }

    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      publish(win, {
        stage: 'error',
        message: (err as Error)?.message ?? 'Could not reach the update feed.',
      });
    }
    return state;
  });

  ipcMain.handle('update:download', async () => {
    if (state.stage !== 'available' && state.stage !== 'error') return state;
    publish(win, { stage: 'downloading', percent: 0, message: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      publish(win, {
        stage: 'error',
        message: (err as Error)?.message ?? 'The download failed.',
      });
    }
    return state;
  });

  ipcMain.handle('update:install', async () => {
    // A second press while the first is still working through the hand-off
    // would start a second installer against the same files.
    if (state.stage !== 'ready' || installing) return false;
    await handOverToInstaller(win);
    return true;
  });

  ipcMain.handle('update:in-call', (_e, value: boolean) => {
    inCall = Boolean(value);
    // Published, not just recorded: the banner says what a restart will do to
    // the call before the button is pressed, and it can only know that from
    // here.
    publish(win, { inCall });
    return inCall;
  });

  /** The renderer, answering `update:leave-voice`. See leaveVoiceForUpdate. */
  ipcMain.handle('update:voice-left', () => {
    voiceLeft?.();
    voiceLeft = null;
    return true;
  });
}
