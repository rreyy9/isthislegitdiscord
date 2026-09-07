import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  ipcMain,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
} from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  registerPushToTalk,
  registerScreenShare,
  type PttBinding,
} from './voice-main';
import { registerUpdater } from './updater';

/**
 * Main process. Deliberately small: no mTLS in this build, so the renderer can
 * talk to the server directly. Main's jobs are the window, persisting the
 * chosen server address, holding the auth token in encrypted OS storage (there
 * is no localStorage worth trusting for a credential), and the two pieces of
 * voice a renderer cannot do alone — screen capture and the global push-to-talk
 * hook, both in voice-main.ts.
 */

const isDev = !app.isPackaged;
const userData = app.getPath('userData');
const settingsPath = join(userData, 'settings.json');
const tokenPath = join(userData, 'token.bin');

interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  pushToTalk: boolean;
  /**
   * The key or mouse button to hold. uiohook's own codes, not DOM ones — the
   * hook is global, so DOM codes do not apply.
   */
  pttBinding: PttBinding | null;
  pttLabel: string | null;
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

interface Settings {
  serverUrl: string;
  /**
   * The voice channel this client was in when it last stopped, or null if it
   * left on purpose. Only acted on when `voice.rejoinLastChannel` is set.
   */
  lastVoiceChannelId: string | null;
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
}

const defaultSettings: Settings = {
  serverUrl: 'http://localhost:3000',
  lastVoiceChannelId: null,
  lastTextChannelId: null,
  chatPositions: {},
  voice: {
    inputDeviceId: null,
    outputDeviceId: null,
    pushToTalk: false,
    pttBinding: null,
    pttLabel: null,
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
 * `pttKeycode` was a bare keyboard code, from before mouse buttons could be
 * bound. Anyone upgrading keeps the key they chose instead of finding
 * push-to-talk on with nothing bound to it.
 */
function migrateVoice(stored: unknown): unknown {
  if (!stored || typeof stored !== 'object') return stored;
  const voice = stored as Record<string, unknown>;
  if (voice.pttBinding !== undefined || typeof voice.pttKeycode !== 'number') {
    return voice;
  }
  return {
    ...voice,
    pttBinding: { type: 'key', code: voice.pttKeycode } satisfies PttBinding,
  };
}

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // Merged rather than returned as-is: a settings.json written before voice
    // existed has no `voice` key, and the renderer would read undefined.
    return {
      ...defaultSettings,
      ...stored,
      chatPositions:
        stored.chatPositions && typeof stored.chatPositions === 'object'
          ? stored.chatPositions
          : {},
      voice: {
        ...defaultSettings.voice,
        ...knownVoiceKeys(migrateVoice(stored.voice)),
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#14161a',
    title: 'isthislegit',
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

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

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
    voice: { ...current.voice, ...(patch.voice ?? {}) },
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

app.whenReady().then(() => {
  // Microphone and screen capture, and nothing else. Without this the renderer
  // gets whatever Electron's default happens to be; being explicit means a
  // future dependency cannot quietly ask for geolocation or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'display-capture'),
  );

  registerScreenShare(() => mainWindow);
  registerUpdater(() => mainWindow);
  const ptt = registerPushToTalk(() => mainWindow);
  // The global hook keeps the process alive if it is never stopped.
  app.on('before-quit', () => ptt.stopHook());

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
