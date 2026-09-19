import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between renderer and main. Everything network-related the
 * renderer does itself with fetch/socket.io; main owns the persisted server
 * address, the encrypted token, and the two pieces that need OS access — the
 * screen-source picker and the global keybinding hook.
 */

/* ------------------------------------------------------------- keybindings */

export {
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
} from '../keybinds';
export type {
  Binding,
  Keybind,
  KeybindAction,
} from '../keybinds';
import type { Keybind, Binding, KeybindAction } from '../keybinds';

/** A binding going down or coming back up. See main/voice-main.ts. */
export interface KeybindEvent {
  id: string;
  action: KeybindAction;
  down: boolean;
}

export interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /**
   * Whether the mic is gated on a held key at all. Which keys do the holding
   * is `Settings.keybinds`, where the action may have several bindings.
   */
  pushToTalk: boolean;
  /** How long push-to-talk keeps transmitting after the key comes up, in ms. */
  pttReleaseDelayMs: number;
  /* --- capture constraints, handed straight to getUserMedia --- */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /* --- input sensitivity: gate the mic on level, like push-to-talk on a key --- */
  gateMode: 'off' | 'auto' | 'manual';
  /** dBFS, used only when gateMode is 'manual'. */
  gateThreshold: number;
  /* --- playback --- */
  /** Playback level per person, 0..1, keyed by user id. */
  userVolumes: Record<string, number>;
  /* --- behaviour --- */
  /** Walk back into `lastVoiceChannelId` once the app has signed in again. */
  rejoinLastChannel: boolean;
}

/**
 * What the app may do when somebody tags you. Both default on: a ping that
 * arrives silently did not work. Both are switches, because the only thing
 * worse than a missed ping is one that cannot be turned off.
 */
export interface NotificationSettings {
  mentions: boolean;
  sound: boolean;
}

/**
 * Where the window was when it last closed. Written by main and never by the
 * renderer, which has no view of the desktop it would need to write it
 * sensibly — it is here only because it is part of the settings object.
 */
export interface WindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Settings {
  serverUrl: string;
  window: WindowBounds;
  /** The voice channel this client was in when it last stopped, if any. */
  lastVoiceChannelId: string | null;
  /**
   * The voice channel an update took somebody out of, to be walked back into
   * once the new build is up. See main/index.ts.
   */
  rejoinAfterUpdate: string | null;
  /** The text channel that was open when the app last closed. */
  lastTextChannelId: string | null;
  /**
   * Where the reader had got to in each text channel, as the id of the
   * bottom-most message they could see. A channel read to the end has no
   * entry. `setSettings` replaces this map wholesale, so always send all of it.
   */
  chatPositions: Record<string, string>;
  voice: VoiceSettings;
  notifications: NotificationSettings;
  /**
   * Every global binding, in one flat list. Replaced wholesale by
   * `setSettings` rather than merged — it is an array, and a row removed has
   * to actually go.
   */
  keybinds: Keybind[];
}

/** One tag, on its way to the OS. See main/notifications.ts. */
export interface MentionNotice {
  title: string;
  body: string;
  channelId: string;
  messageId: string;
}

export interface ScreenSource {
  id: string;
  name: string;
  /** Null until the thumbnail pass catches up. */
  thumbnail: string | null;
  isScreen: boolean;
}

/** What the updater is doing. See main/updater.ts. */
export interface UpdateState {
  stage:
    | 'idle'
    | 'unsupported'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    /** Handed over to the installer; the app is on its way out. */
    | 'installing'
    | 'error';
  version: string | null;
  percent: number;
  message: string | null;
  /** True when installing will raise a UAC prompt. See main/updater.ts. */
  elevates: boolean;
  /** True while this client is in a voice channel. */
  inCall: boolean;
}

const bridge = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),
  getToken: (): Promise<string> => ipcRenderer.invoke('token:get'),
  setToken: (token: string): Promise<boolean> =>
    ipcRenderer.invoke('token:set', token),

  /* ------------------------------------------------------------ updates */

  /** The running build, from app.getVersion(). */
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /**
   * True when the installer started this run, rather than a person. Used to
   * confirm an update once, so a restart that worked says so.
   */
  launchedFromUpdate: (): Promise<boolean> =>
    ipcRenderer.invoke('app:launched-from-update'),
  /**
   * Point the updater at the server this client is signed in to and ask what
   * it has. The feed follows the address rather than the build, so one binary
   * serves a LAN deployment and the public one.
   */
  checkForUpdate: (serverUrl: string): Promise<UpdateState> =>
    ipcRenderer.invoke('update:check', serverUrl),
  downloadUpdate: (): Promise<UpdateState> =>
    ipcRenderer.invoke('update:download'),
  /**
   * Restarts into the new version. Works from a call too: main leaves the
   * channel on the way out and the new build walks back into it.
   */
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  /**
   * Tell main whether a call is up. Not a veto: main uses it to leave the
   * channel properly on the way into an update, and to say what a restart
   * will do to the call before the button is pressed.
   */
  setInCall: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('update:in-call', value),
  /**
   * Main, asking for the voice channel to be left before the process is taken
   * away. The handler is expected to call `voiceLeftForUpdate` when it is out
   * -- main waits for that, because being killed mid-call leaves a ghost in
   * the room until the server times it out.
   */
  onLeaveVoiceForUpdate: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('update:leave-voice', handler);
    return () => {
      ipcRenderer.off('update:leave-voice', handler);
    };
  },
  /** The answer to `onLeaveVoiceForUpdate`. */
  voiceLeftForUpdate: (): Promise<boolean> =>
    ipcRenderer.invoke('update:voice-left'),
  /**
   * Main, saying the install did not happen after all -- so whoever was taken
   * out of a call for it is owed it back.
   */
  onRejoinVoiceAfterUpdate: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('update:rejoin-voice', handler);
    return () => {
      ipcRenderer.off('update:rejoin-voice', handler);
    };
  },
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const handler = (_e: unknown, state: UpdateState) => cb(state);
    ipcRenderer.on('update:state', handler);
    return () => {
      ipcRenderer.off('update:state', handler);
    };
  },

  /* ------------------------------------------------------ notifications */

  /**
   * Raise an OS notification and get the taskbar noticed.
   *
   * Whether a tag deserves one is decided in the renderer, which is the only
   * side that knows which channel is on screen — a ping for the message you
   * are reading is noise. Main does the parts a renderer cannot: the toast,
   * the flashing taskbar button, and raising the window on a click.
   */
  notifyMention: (notice: MentionNotice): Promise<boolean> =>
    ipcRenderer.invoke('notify:mention', notice),
  /** Unread tags, for the dock or launcher icon where the OS draws one. */
  setBadgeCount: (count: number): Promise<boolean> =>
    ipcRenderer.invoke('notify:badge', count),
  /** Somebody clicked a notification: go to that message. */
  onNotificationActivate: (
    cb: (target: { channelId: string; messageId: string }) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      target: { channelId: string; messageId: string },
    ) => cb(target);
    ipcRenderer.on('notification:activate', handler);
    return () => {
      ipcRenderer.off('notification:activate', handler);
    };
  },

  /* ------------------------------------------------------- screen share */

  /**
   * Main asks the renderer which screen or window to share; the renderer shows
   * the picker and answers with `chooseScreenSource`. Electron has no built-in
   * picker on Windows, so `getDisplayMedia` simply fails without this exchange.
   */
  onScreenChoose: (cb: (sources: ScreenSource[]) => void): (() => void) => {
    const handler = (_e: unknown, sources: ScreenSource[]) => cb(sources);
    ipcRenderer.on('screen:choose', handler);
    return () => {
      ipcRenderer.off('screen:choose', handler);
    };
  },
  chooseScreenSource: (sourceId: string | null): Promise<boolean> =>
    ipcRenderer.invoke('screen:chose', sourceId),
  /** The pictures, id-keyed, arriving after the list they belong to. */
  onScreenThumbnails: (
    cb: (thumbnails: Record<string, string>) => void,
  ): (() => void) => {
    const handler = (_e: unknown, thumbnails: Record<string, string>) =>
      cb(thumbnails);
    ipcRenderer.on('screen:thumbnails', handler);
    return () => {
      ipcRenderer.off('screen:thumbnails', handler);
    };
  },

  /* -------------------------------------------------------- watch party */

  /**
   * Open the watch party window, or focus the one that is already up.
   *
   * It has to be main that makes it: `setWindowOpenHandler` denies every
   * `window.open` in this app and hands the URL to the system browser, so a
   * renderer opening its own window would open it in Chrome.
   */
  openPartyWindow: (): Promise<boolean> => ipcRenderer.invoke('party:open'),
  /** Used when leaving the party: the window has nothing left to show. */
  closePartyWindow: (): Promise<boolean> => ipcRenderer.invoke('party:close'),
  isPartyWindowOpen: (): Promise<boolean> => ipcRenderer.invoke('party:is-open'),
  /**
   * The party window was closed.
   *
   * Which is putting the video away, not leaving -- the strip in the sidebar
   * stays, with a button to bring the window back. The main window listens so
   * that button can say the right thing.
   */
  onPartyWindowClosed: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('party:window-closed', handler);
    return () => {
      ipcRenderer.off('party:window-closed', handler);
    };
  },

  /* ---------------------------------------------------------- clipboard */

  /**
   * Put an image on the system clipboard. Pass `dataUrl` for something the
   * renderer could encode itself, or `url` for one main has to go and fetch.
   */
  copyImage: (src: { dataUrl?: string; url?: string }): Promise<boolean> =>
    ipcRenderer.invoke('clipboard:image', src),

  /* ------------------------------------------------------------- files */

  /**
   * Ask where to put a downloaded attachment, and write it there.
   *
   * The renderer fetches the bytes — it is the side holding the bearer token —
   * and main owns the dialog and the disk. Resolves to the path written, or
   * null if the save was cancelled, which is not an error.
   *
   * A downloaded file is never opened, only saved. Anyone may upload anything
   * here, including a program; opening one on the recipient's behalf would
   * make this app the thing that ran it.
   */
  saveFile: (file: {
    name: string;
    bytes: ArrayBuffer;
  }): Promise<string | null> => ipcRenderer.invoke('file:save', file),

  /* ------------------------------------------------------------ embeds */

  /**
   * Follow a TikTok share link to the post it points at.
   *
   * `vm.tiktok.com/XXXX` carries no video id, so there is nothing to embed
   * until somebody has asked TikTok. That request is made here, in main, and
   * only when the poster has been clicked -- a link sitting in the scrollback
   * still costs nothing. Resolves to the canonical URL, or null if it could
   * not be followed, in which case the renderer leaves it as a plain link.
   */
  resolveTikTok: (shareUrl: string): Promise<string | null> =>
    ipcRenderer.invoke('tiktok:resolve', shareUrl),

  /* --------------------------------------------------------- keybindings */

  /** False when the native hook could not load; everything else still works. */
  keybindsAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('keybind:available'),

  /**
   * The whole table, every time. Main holds no state worth reconciling
   * against, and a wholesale replacement cannot drift from what the renderer
   * believes is bound.
   */
  setKeybinds: (rows: Keybind[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('keybind:set', rows),

  /**
   * Resolves on the next key or mouse button pressed anywhere, or null after
   * ten seconds. Left click is skipped rather than bound, since it is how the
   * settings panel is operated, and so is a modifier on its own.
   */
  captureBinding: (): Promise<{
    binding: Binding;
    label: string;
  } | null> => ipcRenderer.invoke('keybind:capture'),

  /** Both edges of every bound key. Hold actions read both; toggles ignore the release. */
  onKeybind: (cb: (event: KeybindEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: KeybindEvent) => cb(event);
    ipcRenderer.on('keybind:fired', handler);
    return () => {
      ipcRenderer.off('keybind:fired', handler);
    };
  },

  /** TEMP: deafen debugging. Appends to voice-debug.log in userData. */
  voiceDebugLog: (text: string): void => {
    ipcRenderer.send('voice:debug-log', text);
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);

export type DesktopBridge = typeof bridge;
