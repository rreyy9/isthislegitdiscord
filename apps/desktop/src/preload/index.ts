import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between renderer and main. Everything network-related the
 * renderer does itself with fetch/socket.io; main owns the persisted server
 * address, the encrypted token, and the two voice pieces that need OS access —
 * the screen-source picker and the global push-to-talk hook.
 */

/** A key or a mouse button, in uiohook's own codes. See voice-main.ts. */
export interface PttBinding {
  type: 'key' | 'mouse';
  code: number;
}

export interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  pushToTalk: boolean;
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
   * bottom-most message they could see. `chatPositions` is merged rather than
   * replaced by `setSettings`, so one channel may be sent on its own.
   */
  chatPositions: Record<string, string>;
  voice: VoiceSettings;
  notifications: NotificationSettings;
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

  /* ------------------------------------------------------- push-to-talk */

  pttAvailable: (): Promise<boolean> => ipcRenderer.invoke('ptt:available'),
  setPtt: (opts: {
    enabled: boolean;
    binding: PttBinding | null;
  }): Promise<{ ok: boolean; label: string | null }> =>
    ipcRenderer.invoke('ptt:set', opts),
  /**
   * Resolves on the next key or mouse button pressed anywhere, or null after
   * ten seconds. Left click is skipped rather than bound, since it is how the
   * settings panel is operated.
   */
  capturePttBinding: (): Promise<{
    binding: PttBinding;
    label: string;
  } | null> => ipcRenderer.invoke('ptt:capture'),
  onPttChange: (cb: (held: boolean) => void): (() => void) => {
    const handler = (_e: unknown, held: boolean) => cb(held);
    ipcRenderer.on('ptt:changed', handler);
    return () => {
      ipcRenderer.off('ptt:changed', handler);
    };
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);

export type DesktopBridge = typeof bridge;
