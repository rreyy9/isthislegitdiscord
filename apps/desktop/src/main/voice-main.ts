import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import type { Streams } from 'electron';
import {
  matchesDown,
  matchesUp,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  type Binding,
  type Keybind,
} from '../keybinds';

export type { Binding, Keybind, KeybindAction } from '../keybinds';

/**
 * The two parts of voice that a renderer cannot do by itself.
 *
 * 1. Screen capture. In Electron `getDisplayMedia` fails unless the main
 *    process answers the request, because there is no built-in picker: the app
 *    is expected to supply one. Ours asks the renderer to show it.
 * 2. Keybindings. Electron's `globalShortcut` only reports presses, never
 *    releases, so it physically cannot do hold-to-talk. `uiohook-napi` gives
 *    key-down and key-up from a global hook, which is what "hold" needs — and
 *    the point of push-to-talk is that it works while a game has focus, so it
 *    has to be global rather than a window listener. The same hook reports
 *    mouse buttons, so a thumb button binds exactly like a key, and carries
 *    the modifier state on every event, so combinations need no bookkeeping
 *    of their own.
 *
 *    Main matches keys and says which binding fired. What "mute" means is the
 *    renderer's business, and deliberately not known here.
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

/* ------------------------------------------------------------- keybindings */

type Uiohook = typeof import('uiohook-napi');

/**
 * Left click is deliberately not bindable. It is how the settings window is
 * operated, so accepting it would mean the next click anywhere became a
 * keybinding, including the click that dismisses this panel.
 */
const MOUSE_LEFT = 1;

/**
 * The modifier keys themselves, which cannot be the main key of a binding —
 * "Ctrl" alone is not a shortcut, and accepting it would produce a binding
 * that fired as a side effect of every other one.
 */
const MODIFIER_KEYCODES = new Set([
  29, 3613, // Ctrl, CtrlRight
  56, 3640, // Alt, AltRight
  42, 54, // Shift, ShiftRight
  3675, 3676, // Meta, MetaRight
]);

let uiohook: Uiohook | null = null;
let hookRunning = false;
let keybinds: Keybind[] = [];
/** Row ids currently down, so a repeat does not re-fire and a release can. */
const heldRows = new Set<string>();
let captureResolve: ((binding: Binding | null) => void) | null = null;

/**
 * A native module, so it can simply fail to load — a machine without the
 * prebuilt binary for its platform, or a Linux box with no X11. Keybindings
 * then report themselves unavailable and the app keeps working; it is not
 * worth crashing the client over a convenience feature.
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

/**
 * uiohook's codes are its own; this turns one back into something readable.
 *
 * Exported because the settings migration needs it: a push-to-talk key bound
 * before this table existed has a code on disk but no label to go with it.
 */
export function labelFor(binding: Binding): string {
  const parts: string[] = [];
  if (binding.mods & MOD_CTRL) parts.push('Ctrl');
  if (binding.mods & MOD_ALT) parts.push('Alt');
  if (binding.mods & MOD_SHIFT) parts.push('Shift');
  if (binding.mods & MOD_META) parts.push('Meta');

  if (binding.type === 'mouse') {
    parts.push(MOUSE_NAMES[binding.code] ?? `Mouse ${binding.code}`);
  } else {
    const hook = loadUiohook();
    const name = hook
      ? Object.entries(hook.UiohookKey).find(
          ([, code]) => code === binding.code,
        )?.[0]
      : undefined;
    parts.push(name ?? `key ${binding.code}`);
  }
  return parts.join(' + ');
}

export function registerKeybinds(getWindow: () => BrowserWindow | null) {
  const send = (channel: string, ...args: unknown[]) =>
    getWindow()?.webContents.send(channel, ...args);

  /**
   * One event, sent for the press and again for the release. Which of the two
   * matters is the renderer's business: a hold action reads both edges, a
   * toggle acts on the press and ignores the release.
   */
  const fire = (row: Keybind, down: boolean) =>
    send('keybind:fired', { id: row.id, action: row.action, down });

  /** One path for both kinds of input, since a hold is a hold. */
  function onDown(type: 'key' | 'mouse', code: number, mods: number) {
    if (captureResolve) {
      // Left click drives the UI, so it is not offered as a binding; the
      // capture stays open rather than being cancelled by it.
      if (type === 'mouse' && code === MOUSE_LEFT) return;
      // Likewise a bare modifier: the user is part-way through a combination,
      // and taking Ctrl as the binding would end the capture before they had
      // pressed the key they were reaching for.
      if (type === 'key' && MODIFIER_KEYCODES.has(code)) return;
      const resolve = captureResolve;
      captureResolve = null;
      resolve({ type, code, mods });
      return;
    }

    for (const row of keybinds) {
      if (!row.enabled) continue;
      if (!matchesDown(row.binding, { type, code, mods })) continue;
      // Holding a key repeats keydown; only the transition is interesting.
      if (heldRows.has(row.id)) continue;
      heldRows.add(row.id);
      fire(row, true);
    }
  }

  function onUp(type: 'key' | 'mouse', code: number) {
    for (const row of keybinds) {
      if (!heldRows.has(row.id)) continue;
      if (!matchesUp(row.binding, type, code)) continue;
      heldRows.delete(row.id);
      fire(row, false);
    }
  }

  /** uiohook reports the modifier state on every event, keyboard and mouse. */
  const modsOf = (e: {
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }) =>
    (e.ctrlKey ? MOD_CTRL : 0) |
    (e.altKey ? MOD_ALT : 0) |
    (e.shiftKey ? MOD_SHIFT : 0) |
    (e.metaKey ? MOD_META : 0);

  function ensureHook(): boolean {
    const hook = loadUiohook();
    if (!hook) return false;
    if (hookRunning) return true;

    hook.uIOhook.on('keydown', (e) => onDown('key', e.keycode, modsOf(e)));
    hook.uIOhook.on('keyup', (e) => onUp('key', e.keycode));

    // `button` is typed `unknown` by uiohook-napi and arrives as a number.
    const button = (e: { button: unknown }) => Number(e.button);
    hook.uIOhook.on('mousedown', (e) => onDown('mouse', button(e), modsOf(e)));
    hook.uIOhook.on('mouseup', (e) => onUp('mouse', button(e)));

    hook.uIOhook.start();
    hookRunning = true;
    return true;
  }

  function stopHook() {
    if (!hookRunning || !uiohook) return;
    uiohook.uIOhook.stop();
    hookRunning = false;
    heldRows.clear();
  }

  ipcMain.handle('keybind:available', () => loadUiohook() !== null);

  /**
   * The whole table at once, rather than a row at a time. There is no state
   * here worth reconciling against — the list is short and main holds no
   * opinion about it — and a wholesale replacement cannot drift from what the
   * renderer thinks is bound.
   */
  ipcMain.handle('keybind:set', (_e, rows: Keybind[]) => {
    const next = Array.isArray(rows) ? rows : [];

    /**
     * Anything that was down and is now gone gets its release.
     *
     * Without this, unbinding push-to-talk mid-hold would leave the renderer
     * believing the key was still down: the microphone stays open, or stays
     * shut, and nothing will ever say otherwise because the keyup has nothing
     * left to match. Deleted, disabled, and rebound elsewhere are one case.
     */
    for (const row of keybinds) {
      if (!heldRows.has(row.id)) continue;
      const still = next.find((r) => r.id === row.id);
      const survives =
        still !== undefined &&
        still.enabled &&
        matchesUp(still.binding, row.binding.type, row.binding.code);
      if (survives) continue;
      heldRows.delete(row.id);
      fire(row, false);
    }

    keybinds = next;

    // The hook is a global input tap and a thread of its own; it has no
    // business running for a table with nothing enabled in it.
    if (next.some((r) => r.enabled)) return { ok: ensureHook() };
    stopHook();
    return { ok: true };
  });

  /**
   * Bind by pressing — a key or a mouse button, anywhere, since the hook is
   * global. Null means nothing was pressed before the wait ran out.
   *
   * The hook starts for the capture whether or not anything is enabled, and is
   * left running afterwards: the table is about to gain a row, and if it does
   * not, the next `keybind:set` stops it again.
   */
  ipcMain.handle('keybind:capture', async () => {
    if (!ensureHook()) return null;
    const binding = await new Promise<Binding | null>((resolve) => {
      captureResolve = resolve;
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
