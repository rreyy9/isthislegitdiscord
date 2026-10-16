import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import type { DesktopCapturerSource, Streams } from 'electron';
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BindingCapture,
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
 *    is expected to supply one. The renderer shows ours before it asks.
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
  isScreen: boolean;
}

/**
 * The renderer chooses first and captures second.
 *
 * It used to be the other way round: the renderer called getDisplayMedia, the
 * request landed in the handler below, and only then did the picker open. That
 * put the picker inside a call whose options were already fixed, so there was
 * no way to let somebody pick a quality, and the renderer could not tell
 * "still choosing" from "capture is starting" -- the two had one promise
 * between them. Now the renderer asks for the list, shows the picker, says
 * which source it wants, and only then calls getDisplayMedia, which this
 * answers straight away with the source it was told about.
 */

/** What was last listed, so a choice can be turned back into a source. */
let listed: DesktopCapturerSource[] = [];

/** The renderer's choice, waiting for the getDisplayMedia it is about to make. */
let selected: { id: string; at: number } | null = null;

/**
 * Long enough to cover the renderer's round trip into getDisplayMedia, short
 * enough that a choice nobody acted on cannot answer some later request.
 */
const SELECTION_TTL_MS = 15_000;

/**
 * Thumbnails are the expensive half: asking for them makes desktopCapturer grab
 * a frame of every open window, which on a busy desktop is seconds. So the pass
 * is shared and kept briefly -- started when the pointer goes over the share
 * button, it has usually finished by the time the picker opens.
 */
let thumbPass: { at: number; done: Promise<Record<string, string>> } | null =
  null;
const THUMB_FRESH_MS = 8_000;

function thumbnails(): Promise<Record<string, string>> {
  if (thumbPass && Date.now() - thumbPass.at < THUMB_FRESH_MS) {
    return thumbPass.done;
  }
  const done = desktopCapturer
    .getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    })
    .then((shot) => {
      const out: Record<string, string> = {};
      // An empty picture is a window Windows Graphics Capture refused: a
      // minimised one, one with capture protection, one running as
      // administrator. Said as '' rather than left out, so the picker can tell
      // "refused" from "not here yet" -- sharing one of these is the commonest
      // way for a window share to fail.
      for (const s of shot) {
        out[s.id] = s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL();
      }
      return out;
    });
  const pass = { at: Date.now(), done };
  thumbPass = pass;
  done.catch(() => {
    if (thumbPass === pass) thumbPass = null;
  });
  return done;
}

export function registerScreenShare() {
  // The names and ids are nearly free, so the picker opens on these and the
  // pictures come from `screen:thumbnails` behind them.
  ipcMain.handle('screen:sources', async (): Promise<ScreenSource[]> => {
    listed = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return listed.map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
    }));
  });

  ipcMain.handle('screen:thumbnails', () => thumbnails().catch(() => ({})));

  // Fire and forget: the answer is collected by `screen:thumbnails` later.
  ipcMain.on('screen:warm', () => {
    void thumbnails().catch(() => {});
  });

  ipcMain.handle('screen:select', (_e, sourceId: string) => {
    selected = { id: sourceId, at: Date.now() };
    return true;
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
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
        const choice = selected;
        selected = null;
        if (!choice || Date.now() - choice.at > SELECTION_TTL_MS) {
          return cancel();
        }

        let source = listed.find((s) => s.id === choice.id);
        if (!source) {
          const fresh = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          });
          source = fresh.find((s) => s.id === choice.id);
        }
        if (!source) return cancel();

        callback({
          video: source,
          // Windows can hand over the system audio mix, which is the whole
          // point when sharing a game. Only whole screens, never single
          // windows: Chromium's loopback is the system mix or nothing.
          //
          // And only when the renderer asked for sound. A share in an AFK room
          // asks for none, because its grant carries none, and handing loopback
          // to a request that did not want it is capturing audio nobody meant to.
          audio:
            request.audioRequested && source.id.startsWith('screen:')
              ? 'loopback'
              : undefined,
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
}

/* ------------------------------------------------------------- keybindings */

type Uiohook = typeof import('uiohook-napi');

/**
 * Left click is deliberately not bindable. It is how the settings window is
 * operated, so accepting it would mean the next click anywhere became a
 * keybinding, including the click that dismisses this panel.
 */
const MOUSE_LEFT = 1;

let uiohook: Uiohook | null = null;
let hookRunning = false;
let keybinds: Keybind[] = [];
/** Row ids currently down, so a repeat does not re-fire and a release can. */
const heldRows = new Set<string>();
let captureResolve: ((binding: Binding | null) => void) | null = null;
let capture = new BindingCapture();

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
      // A modifier is undecided until it is released -- see BindingCapture.
      const binding = capture.down({ type, code, mods });
      if (binding) finishCapture(binding);
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

  function finishCapture(binding: Binding) {
    const resolve = captureResolve;
    captureResolve = null;
    resolve?.(binding);
  }

  function onUp(type: 'key' | 'mouse', code: number) {
    // No early return: a binding held when the capture began still needs its
    // release, or it stays held.
    if (captureResolve) {
      const binding = capture.up(type, code);
      if (binding) finishCapture(binding);
    }

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
      capture = new BindingCapture();
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

/* ------------------------------------------------ TEMP: deafen debugging */

/**
 * Temporary. The renderer's snapshots of every remote audio element, written
 * to `voice-debug.log` beside updater.log, because the installed build has no
 * console to read them from. Remove once the deafen bug is found.
 */
export function registerVoiceDebugLog() {
  ipcMain.on('voice:debug-log', (_e, text: unknown) => {
    if (typeof text !== 'string') return;
    const path = join(app.getPath('userData'), 'voice-debug.log');
    try {
      if (statSync(path).size > 1024 * 1024) writeFileSync(path, '');
    } catch {
      // No file yet.
    }
    try {
      appendFileSync(path, `[${new Date().toISOString()}] ${text}\n`);
    } catch {
      // A debug log must never take the call down with it.
    }
  });
}
