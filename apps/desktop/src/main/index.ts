import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { registerPushToTalk, registerScreenShare } from './voice-main';

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
  /** A uiohook keycode, not a DOM key — the hook is global, so DOM codes do not apply. */
  pttKeycode: number | null;
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
  /** Turn down whoever is loudest so the room sits in one band. */
  normalizeVoices: boolean;
  /** 0..1, applied on top of normalisation. */
  outputVolume: number;
}

interface Settings {
  serverUrl: string;
  voice: VoiceSettings;
}

const defaultSettings: Settings = {
  serverUrl: 'http://localhost:3000',
  voice: {
    inputDeviceId: null,
    outputDeviceId: null,
    pushToTalk: false,
    pttKeycode: null,
    pttLabel: null,
    // Every new option defaults to exactly what the client did before it
    // existed, so an upgrade cannot change how anyone's call sounds until
    // they go and ask for it.
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    gateMode: 'off',
    gateThreshold: -45,
    normalizeVoices: false,
    outputVolume: 1,
  },
};

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // Merged rather than returned as-is: a settings.json written before voice
    // existed has no `voice` key, and the renderer would read undefined.
    return {
      ...defaultSettings,
      ...stored,
      voice: { ...defaultSettings.voice, ...(stored.voice ?? {}) },
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
    voice: { ...current.voice, ...(patch.voice ?? {}) },
  });
  return loadSettings();
});
ipcMain.handle('token:get', () => loadToken());
ipcMain.handle('token:set', (_e, token: string) => {
  saveToken(token);
  return true;
});

app.whenReady().then(() => {
  // Microphone and screen capture, and nothing else. Without this the renderer
  // gets whatever Electron's default happens to be; being explicit means a
  // future dependency cannot quietly ask for geolocation or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'display-capture'),
  );

  registerScreenShare(() => mainWindow);
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
