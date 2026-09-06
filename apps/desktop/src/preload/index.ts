import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between renderer and main. Everything network-related the
 * renderer does itself with fetch/socket.io; main owns the persisted server
 * address, the encrypted token, and the two voice pieces that need OS access —
 * the screen-source picker and the global push-to-talk hook.
 */

export interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  pushToTalk: boolean;
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
  voice: VoiceSettings;
}

export interface ScreenSource {
  id: string;
  name: string;
  /** Null until the thumbnail pass catches up. */
  thumbnail: string | null;
  isScreen: boolean;
}

const bridge = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),
  getToken: (): Promise<string> => ipcRenderer.invoke('token:get'),
  setToken: (token: string): Promise<boolean> =>
    ipcRenderer.invoke('token:set', token),

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
    keycode: number | null;
  }): Promise<{ ok: boolean; label: string | null }> =>
    ipcRenderer.invoke('ptt:set', opts),
  /** Resolves on the next key pressed anywhere, or null after ten seconds. */
  capturePttKey: (): Promise<{ keycode: number; label: string } | null> =>
    ipcRenderer.invoke('ptt:capture'),
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
