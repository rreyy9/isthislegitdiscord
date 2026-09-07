import { BrowserWindow, app } from 'electron';

/**
 * The window that stands in for the app while it is being replaced.
 *
 * Installing an update means this process has to die: the installer cannot
 * overwrite files that are open, so it kills the app before it extracts
 * anything. That is the whole reason "Restart now" used to look broken --
 * the window went away, several seconds passed with nothing on screen, and
 * the app came back (or, before the fixes in updater.ts, did not).
 *
 * So this is deliberately the *last* thing alive. The main window is hidden,
 * this one is shown in the middle of the screen, and it stays up through the
 * hand-off -- including the UAC prompt, which is the moment somebody most
 * needs to be told what is asking and why. Nothing here decides when it goes:
 * the installer closes this app when it is ready to replace it, and the new
 * build brings its own window back up.
 *
 * It is a data: URL rather than a file: the renderer bundle is one HTML entry
 * point, and adding a second one to the build for forty lines of markup buys
 * nothing. Nothing here is dynamic, either -- every string it shows is pushed
 * in from main, so there is no reason for it to be reachable from the app.
 */

const HTML = `
<meta charset="utf-8">
<style>
  :root {
    --bg: #14161a; --panel: #1c1f26; --line: #2b2f38;
    --text: #e6e8ec; --dim: #99a0ad; --accent: #5b8def;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center;
    user-select: none; cursor: default;
    border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
  }
  .card { width: 100%; padding: 28px 30px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 3px; letter-spacing: .2px; }
  .version { color: var(--dim); font-size: 12.5px; margin: 0 0 20px; }
  /* Indeterminate on purpose. NSIS installs silently and reports nothing back,
     so a percentage here would be a number this window invented. */
  .bar {
    height: 4px; border-radius: 3px; background: var(--panel);
    overflow: hidden; position: relative;
  }
  .bar::after {
    content: ""; position: absolute; inset: 0 auto 0 0; width: 40%;
    border-radius: 3px; background: var(--accent);
    animation: slide 1.35s cubic-bezier(.45,0,.55,1) infinite;
  }
  @keyframes slide {
    0%   { left: -40%; }
    100% { left: 100%; }
  }
  .status { margin: 16px 0 0; font-size: 13px; min-height: 20px; }
  .hint { margin: 5px 0 0; color: var(--dim); font-size: 12px; min-height: 18px; }
</style>
<div class="card">
  <h1>isthislegit</h1>
  <p class="version" id="version"></p>
  <div class="bar"></div>
  <p class="status" id="status"></p>
  <p class="hint" id="hint"></p>
</div>
`;

let win: BrowserWindow | null = null;

/**
 * Put the window up and wait for it to have actually drawn.
 *
 * Awaited rather than fired and forgotten: the next thing that happens is the
 * installer being spawned, and a window that has not painted yet is the same
 * as no window at all to whoever is looking at the screen.
 */
export async function openUpdateWindow(version: string | null): Promise<void> {
  if (win && !win.isDestroyed()) return;

  win = new BrowserWindow({
    width: 420,
    height: 240,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Not dismissable, because dismissing it would not stop anything: the
    // installer is already running and this app is being replaced either way.
    // A window you can close out from under a process that is mid-hand-off is
    // just a way to be left staring at nothing.
    closable: false,
    // Above the app it is replacing, and above whatever else is open: this is
    // the only thing on screen that explains the UAC prompt behind it.
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Updating isthislegit',
    backgroundColor: '#14161a',
    show: false,
    webPreferences: { sandbox: true },
  });

  win.on('closed', () => {
    win = null;
  });

  // Raced against a timer, and the timer is not paranoia: the caller has
  // already committed to closing the app by the time it awaits this, and it
  // refuses `before-quit` until it is done. A `ready-to-show` that never
  // arrived would leave an app that cannot be quit at all -- much worse than
  // a window that shows a frame late.
  const painted = new Promise<void>((resolve) => {
    win?.once('ready-to-show', () => resolve());
    setTimeout(resolve, 2000);
  });

  await win.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(HTML),
  );
  await painted;
  if (win.isDestroyed()) return;

  // Filled in before it is shown, not after: the markup ships with the three
  // lines empty, and showing first puts a card with nothing but a title on
  // screen for a frame.
  await setUpdateWindowStatus(
    version ? `Version ${version}` : `Version ${app.getVersion()}`,
    'Closing the app…',
    null,
  );
  win.show();
}

/**
 * Say what is happening now. All three lines together, because a status
 * without its hint reads as a hint that failed to update.
 */
export async function setUpdateWindowStatus(
  version: string,
  status: string,
  hint: string | null,
): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const text = (s: string) => JSON.stringify(s);
  await win.webContents
    .executeJavaScript(
      `document.getElementById('version').textContent = ${text(version)};
       document.getElementById('status').textContent = ${text(status)};
       document.getElementById('hint').textContent = ${text(hint ?? '')};`,
    )
    .catch(() => undefined);
}

/** Taken down when the install did not happen after all. See `abandon`. */
export function closeUpdateWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
