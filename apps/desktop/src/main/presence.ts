import { BrowserWindow, powerMonitor } from 'electron';

/**
 * Whether somebody is at their computer, for the away dot.
 *
 * Discord and Teams both decide this from the machine rather than the app: a
 * person playing a game or working in a spreadsheet is still there, and
 * should not turn yellow because they have not touched this window. So the
 * question asked is the operating system's -- how long since the last key or
 * mouse movement anywhere -- which is a number of seconds and nothing more.
 * No hook, no permissions, and no idea which keys were pressed.
 *
 * Main only says what it saw. Throttling and the socket are the renderer's,
 * in socket.ts, next to the voice reports that work the same way.
 */

/**
 * How often the idle time is checked. Short, because this is also how long
 * coming back from away can take; the check itself is one cheap OS call.
 */
const POLL_MS = 5_000;

export function registerPresence(getWindow: () => BrowserWindow | null) {
  const send = (channel: string) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };

  // Seconds, rounded down: anything under the poll interval means there was
  // input since the last look.
  setInterval(() => {
    if (powerMonitor.getSystemIdleTime() < POLL_MS / 1000) send('presence:input');
  }, POLL_MS);

  // Locking the screen or closing the lid is leaving, and says so now rather
  // than ten minutes from now. Not every platform has the lock events; the
  // idle timer covers those.
  powerMonitor.on('lock-screen', () => send('presence:away'));
  powerMonitor.on('suspend', () => send('presence:away'));
}
