import { app, BrowserWindow, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';

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
  | 'error';

export interface UpdateState {
  stage: UpdateStage;
  version: string | null;
  percent: number;
  message: string | null;
}

let state: UpdateState = {
  stage: 'idle',
  version: null,
  percent: 0,
  message: null,
};

let feedUrl: string | null = null;

/**
 * True while the renderer is in a voice channel.
 *
 * Restarting into an update mid-call drops everybody else's audio with no
 * warning, so `quitAndInstall` refuses while this is set. The passive path --
 * install on next quit -- is unaffected, because quitting is already leaving
 * the call.
 */
let inCall = false;

function publish(win: () => BrowserWindow | null, patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  win()?.webContents.send('update:state', state);
}

export function registerUpdater(win: () => BrowserWindow | null): void {
  // Downloading is explicit, and so is installing. An update that installs
  // itself during a conversation is an update that closed the app somebody was
  // typing in.
  autoUpdater.autoDownload = false;
  // The passive path: whenever the app is quit normally, a downloaded update
  // gets applied. Nobody is interrupted by it.
  autoUpdater.autoInstallOnAppQuit = true;

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
  autoUpdater.on('update-downloaded', (info) =>
    publish(win, { stage: 'ready', version: info.version, percent: 100 }),
  );
  autoUpdater.on('error', (err) =>
    publish(win, {
      stage: 'error',
      // Said once, and then the app carries on with the version it has.
      message: err?.message ?? 'The update failed.',
    }),
  );

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

  ipcMain.handle('update:install', () => {
    if (state.stage !== 'ready') return false;
    if (inCall) {
      publish(win, {
        message: 'Leave the voice channel first — restarting would drop the call.',
      });
      return false;
    }
    // isSilent false so the installer's own progress is visible; the second
    // argument restarts the app afterwards.
    autoUpdater.quitAndInstall(false, true);
    return true;
  });

  ipcMain.handle('update:in-call', (_e, value: boolean) => {
    inCall = Boolean(value);
    return inCall;
  });
}
