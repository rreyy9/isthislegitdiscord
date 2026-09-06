import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';

/**
 * The two parts of voice that a renderer cannot do by itself.
 *
 * 1. Screen capture. In Electron `getDisplayMedia` fails unless the main
 *    process answers the request, because there is no built-in picker: the app
 *    is expected to supply one. Ours asks the renderer to show it.
 * 2. Push-to-talk. Electron's `globalShortcut` only reports presses, never
 *    releases, so it physically cannot do hold-to-talk. `uiohook-napi` gives
 *    key-down and key-up from a global hook, which is what "hold" needs — and
 *    the point of push-to-talk is that it works while a game has focus, so it
 *    has to be global rather than a window listener.
 */

/* ------------------------------------------------------------ screen share */

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  isScreen: boolean;
}

/** Resolves when the renderer's picker comes back; null means cancelled. */
let pendingChoice: ((sourceId: string | null) => void) | null = null;

export function registerScreenShare(getWindow: () => BrowserWindow | null) {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        const win = getWindow();
        if (!win) return callback({});

        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
        });

        // A second request while a picker is open cancels the first.
        pendingChoice?.(null);
        win.webContents.send(
          'screen:choose',
          sources.map<ScreenSource>((s) => ({
            id: s.id,
            name: s.name,
            thumbnail: s.thumbnail.toDataURL(),
            isScreen: s.id.startsWith('screen:'),
          })),
        );

        const chosenId = await new Promise<string | null>((resolve) => {
          pendingChoice = resolve;
        });
        pendingChoice = null;

        const source = sources.find((s) => s.id === chosenId);
        // An empty object cancels: getDisplayMedia rejects and the renderer
        // treats that as "user changed their mind", not as an error.
        if (!source) return callback({});

        callback({
          video: source,
          // Windows can hand over the system audio mix, which is the whole
          // point when sharing a game. Only whole screens, never single
          // windows — per-window audio is not a thing the OS offers.
          audio: source.id.startsWith('screen:') ? 'loopback' : undefined,
        });
      })();
    },
    // Our own picker, not the OS one: the OS picker exists on macOS 15+ only.
    { useSystemPicker: false },
  );

  ipcMain.handle('screen:chose', (_e, sourceId: string | null) => {
    pendingChoice?.(sourceId);
    return true;
  });
}

/* ------------------------------------------------------------ push-to-talk */

type Uiohook = typeof import('uiohook-napi');

let uiohook: Uiohook | null = null;
let hookRunning = false;
let pttKeycode: number | null = null;
let pttHeld = false;
let captureResolve: ((code: number) => void) | null = null;

/**
 * A native module, so it can simply fail to load — a machine without the
 * prebuilt binary for its platform, or a Linux box with no X11. Push-to-talk
 * then reports itself unavailable and the app keeps working; it is not worth
 * crashing the client over a convenience feature.
 */
function loadUiohook(): Uiohook | null {
  if (uiohook) return uiohook;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    uiohook = require('uiohook-napi') as Uiohook;
    return uiohook;
  } catch {
    return null;
  }
}

/** uiohook's keycodes are its own; this turns one back into something readable. */
function labelFor(keycode: number): string {
  const hook = loadUiohook();
  if (!hook) return `key ${keycode}`;
  const name = Object.entries(hook.UiohookKey).find(
    ([, code]) => code === keycode,
  )?.[0];
  return name ?? `key ${keycode}`;
}

export function registerPushToTalk(getWindow: () => BrowserWindow | null) {
  const send = (channel: string, ...args: unknown[]) =>
    getWindow()?.webContents.send(channel, ...args);

  function ensureHook(): boolean {
    const hook = loadUiohook();
    if (!hook) return false;
    if (hookRunning) return true;

    hook.uIOhook.on('keydown', (e) => {
      if (captureResolve) {
        const resolve = captureResolve;
        captureResolve = null;
        resolve(e.keycode);
        return;
      }
      // Holding a key repeats keydown; only the transition is interesting.
      if (e.keycode === pttKeycode && !pttHeld) {
        pttHeld = true;
        send('ptt:changed', true);
      }
    });

    hook.uIOhook.on('keyup', (e) => {
      if (e.keycode === pttKeycode && pttHeld) {
        pttHeld = false;
        send('ptt:changed', false);
      }
    });

    hook.uIOhook.start();
    hookRunning = true;
    return true;
  }

  function stopHook() {
    if (!hookRunning || !uiohook) return;
    uiohook.uIOhook.stop();
    hookRunning = false;
    pttHeld = false;
  }

  ipcMain.handle('ptt:available', () => loadUiohook() !== null);

  ipcMain.handle(
    'ptt:set',
    (_e, opts: { enabled: boolean; keycode: number | null }) => {
      pttKeycode = opts.keycode;
      if (opts.enabled && opts.keycode !== null) {
        const ok = ensureHook();
        return { ok, label: ok ? labelFor(opts.keycode) : null };
      }
      stopHook();
      // Releasing the mic on the way out: otherwise disabling push-to-talk
      // mid-hold leaves the microphone muted with no obvious way back.
      send('ptt:changed', false);
      return { ok: true, label: opts.keycode ? labelFor(opts.keycode) : null };
    },
  );

  /** Bind a key by pressing it — anywhere, since the hook is global. */
  ipcMain.handle('ptt:capture', async () => {
    if (!ensureHook()) return null;
    const keycode = await new Promise<number | null>((resolve) => {
      captureResolve = resolve as (code: number) => void;
      setTimeout(() => {
        if (captureResolve) {
          captureResolve = null;
          resolve(null);
        }
      }, 10_000);
    });
    return keycode === null ? null : { keycode, label: labelFor(keycode) };
  });

  return { stopHook };
}
