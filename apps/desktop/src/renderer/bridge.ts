import type { DesktopBridge } from '../preload';

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}

export const bridge = window.desktop;
