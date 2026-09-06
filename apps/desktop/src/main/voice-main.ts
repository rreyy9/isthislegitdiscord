import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import type { Streams } from 'electron';

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
 *    has to be global rather than a window listener. The same hook reports
 *    mouse buttons, so a thumb button binds exactly like a key.
 */

/* ------------------------------------------------------------ screen share */

export interface ScreenSource {
  id: string;
  name: string;
  /** Null until the thumbnail pass catches up — see registerScreenShare. */
  thumbnail: string | null;
  isScreen: boolean;
}

/** Resolves when the renderer's picker comes back; null means cancelled. */
let pendingChoice: ((sourceId: string | null) => void) | null = null;

export function registerScreenShare(getWindow: () => BrowserWindow | null) {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      /**
       * Cancelling is `callback(null)`, not `callback({})`.
       *
       * Electron reads an object with no `video` as a promise to supply one
       * that was then broken: it throws "Video was requested, but no video
       * stream was provided" inside this handler, which surfaces as an
       * unhandled rejection in main and reaches the renderer as the useless
       * "Invalid capture constraints". Null is the documented way to say the
       * request is off, and the renderer gets an ordinary permission-denied
       * rejection instead.
       */
      const cancel = () => (callback as (s: Streams | null) => void)(null);

      void (async () => {
        const win = getWindow();
        if (!win) return cancel();

        // Two passes, because the thumbnails are the whole cost. Asking for
        // them makes desktopCapturer grab a frame of every open window, which
        // on a busy desktop is seconds of nothing happening after the button
        // is clicked. The names and ids are nearly free, so the list goes out
        // first and the pictures fill in behind it.
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });

        // A second request while a picker is open cancels the first.
        pendingChoice?.(null);
        win.webContents.send(
          'screen:choose',
          sources.map<ScreenSource>((s) => ({
            id: s.id,
            name: s.name,
            thumbnail: null,
            isScreen: s.id.startsWith('screen:'),
          })),
        );

        const chosen = new Promise<string | null>((resolve) => {
          pendingChoice = resolve;
        });

        // Deliberately not awaited. Picking a window before its picture has
        // arrived is an ordinary thing to do, and the choice must not be made
        // to wait on a pass that exists only to make the list look nicer.
        void desktopCapturer
          .getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: false,
          })
          .then((shot) => {
            if (!pendingChoice) return; // already picked, or cancelled
            const thumbnails: Record<string, string> = {};
            for (const s of shot) thumbnails[s.id] = s.thumbnail.toDataURL();
            getWindow()?.webContents.send('screen:thumbnails', thumbnails);
          })
          .catch(() => {});

        const chosenId = await chosen;
        pendingChoice = null;

        const source = sources.find((s) => s.id === chosenId);
        if (!source) return cancel();

        callback({
          video: source,
          // Windows can hand over the system audio mix, which is the whole
          // point when sharing a game. Only whole screens, never single
          // windows — per-window audio is not a thing the OS offers.
          audio: source.id.startsWith('screen:') ? 'loopback' : undefined,
        });
      })().catch(() => {
        // Nothing in here is worth taking the app down for, and a request left
        // unanswered hangs getDisplayMedia for ever, so failure is a cancel.
        cancel();
      });
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

/**
 * What has to be held. Keyboard keys are uiohook keycodes; mouse buttons are
 * uiohook's own numbering (1 left, 2 right, 3 middle, then whatever else the
 * mouse has). The two spaces overlap — keycode 2 is the "1" key — so the kind
 * has to travel with the number.
 */
export interface PttBinding {
  type: 'key' | 'mouse';
  code: number;
}

/**
 * Left click is deliberately not bindable. It is how the settings window is
 * operated, so accepting it would mean the next click anywhere became the
 * push-to-talk button, including the click that dismisses this panel.
 */
const MOUSE_LEFT = 1;

let uiohook: Uiohook | null = null;
let hookRunning = false;
let pttBinding: PttBinding | null = null;
let pttHeld = false;
let captureResolve: ((binding: PttBinding) => void) | null = null;

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

const MOUSE_NAMES: Record<number, string> = {
  1: 'Mouse Left',
  2: 'Mouse Right',
  3: 'Mouse Middle',
};

/** uiohook's codes are its own; this turns one back into something readable. */
function labelFor(binding: PttBinding): string {
  if (binding.type === 'mouse') {
    return MOUSE_NAMES[binding.code] ?? `Mouse ${binding.code}`;
  }
  const hook = loadUiohook();
  if (!hook) return `key ${binding.code}`;
  const name = Object.entries(hook.UiohookKey).find(
    ([, code]) => code === binding.code,
  )?.[0];
  return name ?? `key ${binding.code}`;
}

function sameBinding(a: PttBinding | null, b: PttBinding): boolean {
  return a !== null && a.type === b.type && a.code === b.code;
}

export function registerPushToTalk(getWindow: () => BrowserWindow | null) {
  const send = (channel: string, ...args: unknown[]) =>
    getWindow()?.webContents.send(channel, ...args);

  /** One path for both kinds of input, since a hold is a hold. */
  function onDown(binding: PttBinding) {
    if (captureResolve) {
      // Left click drives the UI, so it is not offered as a binding; the
      // capture stays open rather than being cancelled by it.
      if (binding.type === 'mouse' && binding.code === MOUSE_LEFT) return;
      const resolve = captureResolve;
      captureResolve = null;
      resolve(binding);
      return;
    }
    // Holding a key repeats keydown; only the transition is interesting.
    if (sameBinding(pttBinding, binding) && !pttHeld) {
      pttHeld = true;
      send('ptt:changed', true);
    }
  }

  function onUp(binding: PttBinding) {
    if (sameBinding(pttBinding, binding) && pttHeld) {
      pttHeld = false;
      send('ptt:changed', false);
    }
  }

  function ensureHook(): boolean {
    const hook = loadUiohook();
    if (!hook) return false;
    if (hookRunning) return true;

    hook.uIOhook.on('keydown', (e) => onDown({ type: 'key', code: e.keycode }));
    hook.uIOhook.on('keyup', (e) => onUp({ type: 'key', code: e.keycode }));

    // `button` is typed `unknown` by uiohook-napi and arrives as a number.
    const button = (e: { button: unknown }) => Number(e.button);
    hook.uIOhook.on('mousedown', (e) =>
      onDown({ type: 'mouse', code: button(e) }),
    );
    hook.uIOhook.on('mouseup', (e) => onUp({ type: 'mouse', code: button(e) }));

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
    (_e, opts: { enabled: boolean; binding: PttBinding | null }) => {
      pttBinding = opts.binding;
      if (opts.enabled && opts.binding) {
        const ok = ensureHook();
        return { ok, label: ok ? labelFor(opts.binding) : null };
      }
      stopHook();
      // Releasing the mic on the way out: otherwise disabling push-to-talk
      // mid-hold leaves the microphone muted with no obvious way back.
      send('ptt:changed', false);
      return {
        ok: true,
        label: opts.binding ? labelFor(opts.binding) : null,
      };
    },
  );

  /**
   * Bind by pressing — a key or a mouse button, anywhere, since the hook is
   * global. Null means nothing was pressed before the wait ran out.
   */
  ipcMain.handle('ptt:capture', async () => {
    if (!ensureHook()) return null;
    const binding = await new Promise<PttBinding | null>((resolve) => {
      captureResolve = resolve as (binding: PttBinding) => void;
      setTimeout(() => {
        if (captureResolve) {
          captureResolve = null;
          resolve(null);
        }
      }, 10_000);
    });
    return binding === null ? null : { binding, label: labelFor(binding) };
  });

  return { stopHook };
}
