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
  /** Turn down whoever is loudest so the room sits in one band. */
  normalizeVoices: boolean;
  /** 0..1, applied on top of normalisation. */
  outputVolume: number;
}

export interface Settings {
  serverUrl: string;
  voice: VoiceSettings;
}

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
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
