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

export interface Settings {
  serverUrl: string;
  /** The voice channel this client was in when it last stopped, if any. */
  lastVoiceChannelId: string | null;
  /** The text channel that was open when the app last closed. */
  lastTextChannelId: string | null;
  /**
   * Where the reader had got to in each text channel, as the id of the
   * bottom-most message they could see. `chatPositions` is merged rather than
   * replaced by `setSettings`, so one channel may be sent on its own.
   */
  chatPositions: Record<string, string>;
  voice: VoiceSettings;
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
    | 'error';
  version: string | null;
  percent: number;
  message: string | null;
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
   * Point the updater at the server this client is signed in to and ask what
   * it has. The feed follows the address rather than the build, so one binary
   * serves a LAN deployment and the public one.
   */
  checkForUpdate: (serverUrl: string): Promise<UpdateState> =>
    ipcRenderer.invoke('update:check', serverUrl),
  downloadUpdate: (): Promise<UpdateState> =>
    ipcRenderer.invoke('update:download'),
  /** Restarts into the new version. Refused while a call is up. */
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  /**
   * Tell main whether a call is up, so it can refuse to restart into an
   * update mid-conversation.
   */
  setInCall: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('update:in-call', value),
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const handler = (_e: unknown, state: UpdateState) => cb(state);
    ipcRenderer.on('update:state', handler);
    return () => {
      ipcRenderer.off('update:state', handler);
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
