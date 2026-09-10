import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  nativeImage,
  net,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  labelFor,
  registerKeybinds,
  registerScreenShare,
  type Binding,
  type Keybind,
  type KeybindAction,
} from './voice-main';
import { registerUpdater } from './updater';
import {
  clearAttention,
  registerNotifications,
  setNotificationIdentity,
} from './notifications';

/**
 * Main process. Deliberately small: no mTLS in this build, so the renderer can
 * talk to the server directly. Main's jobs are the window, persisting the
 * chosen server address, holding the auth token in encrypted OS storage (there
 * is no localStorage worth trusting for a credential), and the two things a
 * renderer cannot do alone — screen capture and the global keybinding hook,
 * both in voice-main.ts.
 */

const isDev = !app.isPackaged;
const userData = app.getPath('userData');
const settingsPath = join(userData, 'settings.json');
const tokenPath = join(userData, 'token.bin');

interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /**
   * Whether the microphone is gated on a held key at all — the mic policy,
   * not the key. Which keys do the holding lives in `Settings.keybinds`,
   * where an action may have several bindings; this is the switch that says
   * whether to listen to them.
   */
  pushToTalk: boolean;
  /* --- capture constraints, handed straight to getUserMedia --- */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /* --- input sensitivity: gate the mic on level, like push-to-talk on a key --- */
  gateMode: 'off' | 'auto' | 'manual';
  /** dBFS, used only when gateMode is 'manual'. */
  gateThreshold: number;
  /* --- playback --- */
  /**
   * Playback level per person, 0..1, keyed by user id. This replaced a single
   * output slider: turning the whole room down at once is the one adjustment
   * nobody needs from an app, because the system volume already does it. What
   * people actually want is the one person who is twice as loud as the rest.
   */
  userVolumes: Record<string, number>;
  /* --- behaviour --- */
  /** Walk back into `lastVoiceChannelId` once the app has signed in again. */
  rejoinLastChannel: boolean;
}

/**
 * What the app is allowed to do when somebody tags you.
 *
 * Both default on, because a tag that arrives silently is a tag that did not
 * work — but both are switches, because the one thing worse than missing a
 * ping is one you cannot turn off.
 */
interface NotificationSettings {
  /** Raise an OS notification and flash the taskbar. */
  mentions: boolean;
  /** Play the short two-tone blip. Independent: some people want one, not both. */
  sound: boolean;
}

/**
 * Where the window was when it was last closed.
 *
 * `x` and `y` are nullable and start that way: with no saved position Electron
 * centres the window, which is the right thing on a first run and cannot be
 * expressed as a pair of numbers. Size has no such case — there is always a
 * sensible default — so it is always present.
 *
 * `maximized` is kept separately from the rectangle rather than folded into
 * it, because a maximized window still has a rectangle underneath: the one it
 * returns to when somebody restores it. Storing the maximized geometry as the
 * size would mean un-maximizing gave you the full screen again, slightly
 * smaller.
 */
interface WindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

interface Settings {
  serverUrl: string;
  /** Restored on launch; see `restoreBounds` for why it is not trusted blindly. */
  window: WindowBounds;
  /**
   * The voice channel this client was in when it last stopped, or null if it
   * left on purpose. Only acted on when `voice.rejoinLastChannel` is set.
   */
  lastVoiceChannelId: string | null;
  /**
   * The voice channel an update took somebody out of, to be walked back into
   * once the new build is up.
   *
   * Deliberately not `lastVoiceChannelId`, which is a standing record of where
   * this client was and is only acted on when `voice.rejoinLastChannel` is
   * set. This is a promise about one restart: the app closed a call that was
   * in progress, so it owes that call back regardless of what the setting
   * says. Written during the hand-off to the installer and cleared the moment
   * it is honoured -- an id left lying here would rejoin a channel weeks later
   * for no reason anyone could see.
   */
  rejoinAfterUpdate: string | null;
  /** The text channel that was open when the app last closed. */
  lastTextChannelId: string | null;
  /**
   * Where the reader had got to in each text channel, as the id of the
   * bottom-most message they could see. Kept here rather than on the server:
   * it is this machine's scroll position, not a claim about what the account
   * has read, which is what `reads` is for.
   */
  chatPositions: Record<string, string>;
  voice: VoiceSettings;
  notifications: NotificationSettings;
  /**
   * Every global binding, in one flat list.
   *
   * A list rather than a map keyed by action, because the same action may be
   * bound more than once on purpose — push-to-talk on a thumb button and on a
   * keyboard key is the case that drove it — and a map could hold only one of
   * them. Rows carry their own id for that reason.
   *
   * Top-level rather than inside `voice`, because a binding is not a property
   * of the microphone. Today every action happens to be a voice action; that
   * is a fact about which actions have been written, not about where the
   * table belongs.
   */
  keybinds: Keybind[];
}

/** The window's floor, and the size a first run opens at. */
const MIN_WIDTH = 760;
const MIN_HEIGHT = 480;

const defaultSettings: Settings = {
  serverUrl: 'http://localhost:3000',
  window: { x: null, y: null, width: 1100, height: 740, maximized: false },
  lastVoiceChannelId: null,
  rejoinAfterUpdate: null,
  lastTextChannelId: null,
  chatPositions: {},
  notifications: { mentions: true, sound: true },
  // Nothing bound by default. A global input binding that nobody asked for is
  // a key that stops working in every other program on the machine.
  keybinds: [],
  voice: {
    inputDeviceId: null,
    outputDeviceId: null,
    pushToTalk: false,
    // Every new option defaults to exactly what the client did before it
    // existed, so an upgrade cannot change how anyone's call sounds until
    // they go and ask for it.
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    gateMode: 'off',
    gateThreshold: -45,
    userVolumes: {},
    rejoinLastChannel: false,
  },
};

/**
 * Voice keys that no longer exist are dropped on the way in, not merged
 * through. The renderer saves a setting by sending the whole voice object
 * back, so anything removed in an upgrade would otherwise be read from disk
 * and written straight out again, for ever.
 */
function knownVoiceKeys(stored: unknown): Partial<VoiceSettings> {
  const out: Record<string, unknown> = {};
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(defaultSettings.voice)) {
      const value = (stored as Record<string, unknown>)[key];
      if (value !== undefined) out[key] = value;
    }
  }
  return out as Partial<VoiceSettings>;
}

/**
 * A row read off disk is only kept if it is shaped like one.
 *
 * These are matched against every key the machine presses, inside a native
 * hook callback, so a row missing its `binding` is not a cosmetic problem: it
 * throws on the first keypress after launch and takes the hook thread with it.
 * A hand-edited or half-written settings.json costs somebody their bindings
 * here, which is recoverable; the alternative is an app whose keyboard stops
 * working.
 */
function knownKeybinds(stored: unknown): Keybind[] {
  if (!Array.isArray(stored)) return [];
  const actions: KeybindAction[] = [
    'ptt',
    'pushToMute',
    'toggleMute',
    'toggleDeafen',
    'disconnect',
  ];
  return stored.flatMap((row): Keybind[] => {
    if (!row || typeof row !== 'object') return [];
    const r = row as Record<string, unknown>;
    const b = r.binding as Record<string, unknown> | undefined;
    if (typeof r.id !== 'string' || !actions.includes(r.action as KeybindAction)) {
      return [];
    }
    if (!b || (b.type !== 'key' && b.type !== 'mouse') || typeof b.code !== 'number') {
      return [];
    }
    const binding: Binding = {
      type: b.type,
      code: b.code,
      mods: typeof b.mods === 'number' ? b.mods : 0,
    };
    return [
      {
        id: r.id,
        action: r.action as KeybindAction,
        binding,
        label: typeof r.label === 'string' ? r.label : labelFor(binding),
        enabled: r.enabled !== false,
      },
    ];
  });
}

/**
 * Push-to-talk used to be one binding living in `voice`, and before that a
 * bare `pttKeycode` from when only keyboard keys could be bound. Both become
 * an ordinary row in the keybindings table, so anyone upgrading keeps the key
 * they chose instead of finding push-to-talk on with nothing bound to it.
 *
 * The old keys are not written back: they are absent from `defaultSettings`,
 * so `knownVoiceKeys` drops them on the next save. This runs off the raw
 * stored object, which is the only place they still exist by then.
 */
function migrateKeybinds(stored: Record<string, unknown>): Keybind[] {
  if (stored.keybinds !== undefined) return knownKeybinds(stored.keybinds);

  const voice = (stored.voice ?? {}) as Record<string, unknown>;
  const old = voice.pttBinding as Record<string, unknown> | null | undefined;

  let binding: Binding | null = null;
  if (old && (old.type === 'key' || old.type === 'mouse') && typeof old.code === 'number') {
    binding = { type: old.type, code: old.code, mods: 0 };
  } else if (typeof voice.pttKeycode === 'number') {
    binding = { type: 'key', code: voice.pttKeycode, mods: 0 };
  }
  if (!binding) return [];

  return [
    {
      id: randomUUID(),
      action: 'ptt',
      binding,
      label:
        typeof voice.pttLabel === 'string' ? voice.pttLabel : labelFor(binding),
      enabled: true,
    },
  ];
}

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // Merged rather than returned as-is: a settings.json written before voice
    // existed has no `voice` key, and the renderer would read undefined.
    return {
      ...defaultSettings,
      ...stored,
      window: { ...defaultSettings.window, ...(stored.window ?? {}) },
      chatPositions:
        stored.chatPositions && typeof stored.chatPositions === 'object'
          ? stored.chatPositions
          : {},
      voice: {
        ...defaultSettings.voice,
        ...knownVoiceKeys(stored.voice),
      },
      keybinds: migrateKeybinds(stored),
      notifications: {
        ...defaultSettings.notifications,
        ...(stored.notifications ?? {}),
      },
    };
  } catch {
    return defaultSettings;
  }
}

function saveSettings(s: Settings) {
  writeFileSync(settingsPath, JSON.stringify(s, null, 2));
}

/* --------------------------------------------------------- token (safeStorage) */

function saveToken(token: string) {
  if (!token) {
    if (existsSync(tokenPath)) writeFileSync(tokenPath, '');
    return;
  }
  // encryptionAvailable() is false on some Linux setups; fall back to plaintext
  // rather than crashing. On Windows (DPAPI) it is always available.
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from('PLAIN:' + token, 'utf8');
  writeFileSync(tokenPath, buf);
}

function loadToken(): string {
  try {
    const buf = readFileSync(tokenPath);
    if (buf.length === 0) return '';
    if (buf.subarray(0, 6).toString() === 'PLAIN:') {
      return buf.subarray(6).toString('utf8');
    }
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------- window */

let mainWindow: BrowserWindow | null = null;

/**
 * How much of the window has to be visible for a saved position to be used.
 *
 * A saved rectangle is a claim about a desktop that may no longer exist: the
 * laptop was docked to a second monitor and now is not, the screens were
 * rearranged, the resolution changed. Restoring onto a display that is gone
 * opens the app somewhere nobody can see or reach, which looks exactly like
 * the app failing to start. Enough of the title bar to grab is the test.
 */
const VISIBLE_W = 120;
const VISIBLE_H = 40;

/** Do these two rectangles share at least a grabbable corner of window? */
function intersectsEnough(
  area: { x: number; y: number; width: number; height: number },
  win: { x: number; y: number; width: number; height: number },
) {
  const w = Math.min(area.x + area.width, win.x + win.width) - Math.max(area.x, win.x);
  const h = Math.min(area.y + area.height, win.y + win.height) - Math.max(area.y, win.y);
  return w >= VISIBLE_W && h >= VISIBLE_H;
}

/**
 * The saved geometry, made safe to open with.
 *
 * Size is clamped to the minimum and to the screen it is going onto, so a
 * window saved on a 4K monitor does not open larger than the laptop panel it
 * is now on. The screen in question is the one the saved position lands on
 * rather than the primary — clamping a window on a big second monitor to the
 * size of a small built-in display would shrink it for no reason.
 *
 * Position is dropped entirely when it would land off-screen. Omitting x and y
 * is what makes Electron centre the window, which is the right answer for "we
 * no longer know where this should go".
 */
function restoreBounds(saved: WindowBounds) {
  const wanted = {
    x: Math.round(saved.x ?? 0),
    y: Math.round(saved.y ?? 0),
    width: Math.round(saved.width),
    height: Math.round(saved.height),
  };
  // getDisplayMatching picks the screen this rectangle overlaps most, and the
  // nearest one when it overlaps none — so this is a sensible screen to be
  // measured against even when the position is about to be thrown away.
  const area =
    saved.x === null || saved.y === null
      ? screen.getPrimaryDisplay().workArea
      : screen.getDisplayMatching(wanted).workArea;

  const width = Math.max(MIN_WIDTH, Math.min(wanted.width, area.width));
  const height = Math.max(MIN_HEIGHT, Math.min(wanted.height, area.height));

  if (saved.x === null || saved.y === null) return { width, height };

  const rect = { x: wanted.x, y: wanted.y, width, height };
  const onScreen = screen
    .getAllDisplays()
    .some((d) => intersectsEnough(d.workArea, rect));
  return onScreen ? rect : { width, height };
}

/**
 * Write the window's geometry back, coalesced.
 *
 * Dragging a window fires `move` for every frame of the drag, and each one
 * would otherwise be a synchronous rewrite of settings.json. The delay makes
 * that one write when the mouse stops; `close` flushes it, because the last
 * position is the one that matters and a pending timer dies with the process.
 */
let boundsTimer: NodeJS.Timeout | null = null;

function rememberBounds(win: BrowserWindow) {
  if (win.isDestroyed() || win.isMinimized()) return;
  // getNormalBounds, not getBounds: while maximized the latter is the screen,
  // and saving that would leave nothing to un-maximize back to.
  const { x, y, width, height } = win.getNormalBounds();
  const current = loadSettings();
  saveSettings({
    ...current,
    window: { x, y, width, height, maximized: win.isMaximized() },
  });
}

function watchBounds(win: BrowserWindow) {
  const later = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      rememberBounds(win);
    }, 400);
  };

  win.on('resize', later);
  win.on('move', later);
  // Not debounced: these are single deliberate acts, and the flag they change
  // is the one thing `getNormalBounds` cannot tell us later.
  win.on('maximize', () => rememberBounds(win));
  win.on('unmaximize', () => rememberBounds(win));
  win.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = null;
    rememberBounds(win);
  });
}

/**
 * The window and taskbar icon.
 *
 * A packaged build takes its icon from the .exe, which electron-builder stamps
 * from build/icon.ico, so this only has to cover the case Windows cannot: a
 * dev run, where there is no .exe and the window would otherwise wear the
 * default Electron icon. The renderer copy is the one that ships; build/ is a
 * build resource and is not packaged, and in dev the renderer is served from
 * memory so out/renderer does not exist. Hence both paths, first hit wins.
 */
function appIcon() {
  for (const path of [
    join(__dirname, '../renderer/icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
  ]) {
    const image = nativeImage.createFromPath(path);
    if (!image.isEmpty()) return image;
  }
  return undefined;
}

function createWindow() {
  const saved = loadSettings().window;
  const win = new BrowserWindow({
    ...restoreBounds(saved),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#14161a',
    title: 'isthislegit',
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      // Chromium throttles timers to about one a second in a hidden window.
      // The audio itself is unaffected — capture, Opus and the jitter buffer
      // all run on native real-time threads — but the level polling that
      // drives the input gate is a renderer timer, and a gate that stops
      // being evaluated is a microphone stuck open or stuck shut. Someone
      // minimising the app to play a game is the normal case here, not an
      // edge one.
      backgroundThrottling: false,
    },
  });

  // Before the page loads, so the window is never briefly the wrong size in
  // front of somebody.
  if (saved.maximized) win.maximize();

  mainWindow = win;
  watchBounds(win);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Looking at the window is the answer to "somebody wants your attention",
  // so the flashing stops there rather than on a timer.
  win.on('focus', () => clearAttention(win));

  // A link in a message is a URL a friend typed. Handing it to the OS browser
  // keeps it out of this window entirely -- otherwise `window.open` spawns an
  // Electron BrowserWindow with no address bar, which is both a bad way to
  // browse and a good way to be phished. Only http(s) is passed on.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Same rule for anything trying to navigate the window itself away from the
  // app: the renderer should only ever show our own page.
  win.webContents.on('will-navigate', (event, url) => {
    const isApp =
      url.startsWith('file://') ||
      (process.env['ELECTRON_RENDERER_URL'] &&
        url.startsWith(process.env['ELECTRON_RENDERER_URL']));
    if (!isApp) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/* --------------------------------------------------------------------- ipc */

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
  const current = loadSettings();
  saveSettings({
    ...current,
    ...patch,
    // Merged, not replaced: the renderer sends one channel's reading position
    // at a time, and it has no business forgetting the others.
    chatPositions: { ...current.chatPositions, ...(patch.chatPositions ?? {}) },
    // The renderer has no reason to touch geometry — main owns it — but the
    // merge keeps a partial patch from erasing the half it did not send.
    window: { ...current.window, ...(patch.window ?? {}) },
    voice: { ...current.voice, ...(patch.voice ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  });
  return loadSettings();
});
/**
 * The running build's own version.
 *
 * From `app.getVersion()` rather than an import of package.json: that is what
 * the installer wrote and what electron-updater compares against, so it is the
 * one number that cannot disagree with the thing on disk.
 */
ipcMain.handle('app:version', () => app.getVersion());
/**
 * True when this run is the one the installer started for us.
 *
 * NSIS passes `--updated` to the app it relaunches after an update, which is
 * the only way this process can tell "somebody opened the app" from "the app
 * was just replaced and put back". The renderer uses it to confirm the new
 * version once, so an update that worked says so instead of the window simply
 * reappearing.
 */
ipcMain.handle('app:launched-from-update', () =>
  process.argv.includes('--updated'),
);

ipcMain.handle('token:get', () => loadToken());
ipcMain.handle('token:set', (_e, token: string) => {
  saveToken(token);
  return true;
});

/**
 * Copying an image out of a message.
 *
 * It happens here because half of them cannot be reached from the renderer. An
 * uploaded attachment is a blob: URL the renderer owns and can rasterise
 * itself, so it arrives already encoded; an image somebody linked to lives on
 * another origin, where a canvas would be tainted and fetch is a CORS failure.
 * Main is subject to neither rule, so it fetches that one and encodes it.
 */
ipcMain.handle(
  'clipboard:image',
  async (_e, src: { dataUrl?: string; url?: string }) => {
    try {
      let image;
      if (src.dataUrl) {
        image = nativeImage.createFromDataURL(src.dataUrl);
      } else if (src.url && /^https?:\/\//i.test(src.url)) {
        const res = await net.fetch(src.url);
        if (!res.ok) return false;
        image = nativeImage.createFromBuffer(
          Buffer.from(await res.arrayBuffer()),
        );
      } else {
        return false;
      }
      // An unreadable format decodes to an empty image rather than throwing,
      // and writing that would silently wipe whatever was on the clipboard.
      if (image.isEmpty()) return false;
      // Everything is re-encoded as PNG on the way out: a linked JPEG then
      // pastes into applications that only ever look for image/png, which is
      // most of them.
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(image.toPNG())], {
            type: 'image/png',
          }),
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  },
);

/**
 * Save a downloaded attachment.
 *
 * The renderer fetched the bytes, because it is the side that holds the bearer
 * token; main puts up the dialog and writes the file, because it is the side
 * with a window to be modal to and a disk to write to.
 *
 * It saves and stops there. Nothing here opens the file, reveals it, or hands
 * it to the shell: anybody with an invite can upload anything, including a
 * program, and the moment this app opens one of those on the recipient's
 * behalf it is the thing that ran it. Saving is the whole feature.
 */
ipcMain.handle(
  'file:save',
  async (_e, file: { name: string; bytes: ArrayBuffer }) => {
    try {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      // The name is attacker-controlled text that has already been stripped
      // of separators by the server. `basename` again here anyway, because
      // this is the call that turns it into a path.
      const suggested = basename(String(file?.name || 'download'));

      const result = await dialog.showSaveDialog(window!, {
        defaultPath: suggested,
        // The dialog is where somebody decides; a warning after they have
        // decided is a warning nobody reads.
        title: 'Save attachment',
      });
      if (result.canceled || !result.filePath) return null;

      writeFileSync(result.filePath, Buffer.from(file.bytes));
      return result.filePath;
    } catch {
      // A disk that is full or a folder that is not writable. The renderer
      // says so; there is nothing useful to do about it here.
      return null;
    }
  },
);

/** The embed origins `frame-src` in the renderer's CSP allows. */
const EMBED_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://www.tiktok.com',
];

/**
 * Give an embedded player a referrer.
 *
 * A packaged build loads its renderer from file://, and a file:// page sends
 * no Referer at all -- the origin is opaque, so there is nothing to send. The
 * player treats an embed it cannot attribute to a page as a misconfigured one
 * and refuses to start, which is the "Video player configuration error / Error
 * 153" a message with a YouTube link showed. It only ever happened in a
 * packaged build: the dev server is a real http origin, so the same code works
 * there and looks fine in review.
 *
 * The referrer sent is the embed's own origin, not a page on youtube.com.
 * Claiming to be youtube.com gets past 153 and straight into 152 ("This video
 * is unavailable") for every video, embeddable or not -- a referrer that is
 * checked and rejected is worse than none. Its own origin is accepted.
 *
 * TikTok's embed is on the list for the same reason rather than a diagnosed
 * one: it is a third-party player framed from a file:// page, which is the
 * exact shape that produced the YouTube bug, and its own origin is the answer
 * that turned out to be right there.
 *
 * The header is only added when the request has none of its own, which in
 * practice is exactly the frame document requested by our file:// page. Every
 * subresource the player then fetches is issued by the frame itself, from a
 * real https origin, and already carries the referrer YouTube expects -- those
 * are left alone rather than overwritten.
 *
 * Scoped to those origins, so this cannot quietly attach a referrer to
 * anything else the app talks to.
 */
function allowEmbedReferrers() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: EMBED_ORIGINS.map((o) => `${o}/*`) },
    (details, callback) => {
      const headers = details.requestHeaders;
      const has = Object.keys(headers).some(
        (k) => k.toLowerCase() === 'referer',
      );
      const origin = EMBED_ORIGINS.find((o) => details.url.startsWith(o + '/'));
      if (!has && origin) headers['Referer'] = origin + '/';
      callback({ requestHeaders: headers });
    },
  );
}

app.whenReady().then(() => {
  // Microphone and screen capture, and nothing else. Without this the renderer
  // gets whatever Electron's default happens to be; being explicit means a
  // future dependency cannot quietly ask for geolocation or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'display-capture'),
  );

  allowEmbedReferrers();

  registerScreenShare(() => mainWindow);
  registerUpdater(() => mainWindow);
  // Before the first window, because on Windows the identity has to be set
  // before anything tries to raise a toast.
  setNotificationIdentity();
  registerNotifications(() => mainWindow);
  const keys = registerKeybinds(() => mainWindow);
  // The global hook keeps the process alive if it is never stopped.
  //
  // Guarded, because this runs inside the quit sequence: uiohook's stop() is a
  // native call into a hook thread, and if it throws there, Electron abandons
  // the quit and the window just sits there. That is a bad enough outcome for
  // someone closing the app; during an update it is the difference between
  // "restarting" and "nothing happened".
  app.on('before-quit', () => {
    try {
      keys.stopHook();
    } catch {
      // The process is going away regardless, and the hook with it.
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
