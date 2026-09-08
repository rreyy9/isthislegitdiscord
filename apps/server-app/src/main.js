'use strict';

/**
 * isthislegit Server -- a desktop app for administering an installed server.
 *
 * It is a shell around the operator console, not a second implementation of
 * it. The console is the thing that starts and stops the chat server, LiveKit
 * and Caddy, and that holds the configuration and admin UI; this runs it and
 * puts it in a window with a tray icon, so the server box has an application
 * to click rather than a script to remember.
 *
 * Two things follow from being a shell:
 *
 * - The console is spawned with Electron's own Node (ELECTRON_RUN_AS_NODE), so
 *   this app does not need Node on PATH. The chat server still does, but that
 *   is the installer's problem and it says so.
 * - The console is found on disk rather than bundled, because it has to
 *   resolve the server, LiveKit and Caddy folders sitting beside it. A copy
 *   inside this app's asar would be next to nothing.
 */

const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const CONSOLE_PORT = Number(process.env.CONSOLE_PORT || 4000);
const CONSOLE_URL = `http://127.0.0.1:${CONSOLE_PORT}`;

/** Remembered install location, so the folder is picked at most once. */
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

let win = null;
let tray = null;
let consoleChild = null;
let quitting = false;

/* ------------------------------------------------------------- settings */

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
  } catch {
    // A settings file that cannot be written costs a folder prompt next time,
    // and nothing else. Not worth failing the launch over.
  }
  return next;
}

/* -------------------------------------------------------------- locating */

/** A folder is an isthislegit install if the console is inside it. */
function isInstall(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'console', 'src', 'main.mjs'));
}

/** The repo checkout has the same console one level deeper, under apps/. */
function isRepo(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'apps', 'console', 'src', 'main.mjs'));
}

function consoleDirFor(root) {
  if (isInstall(root)) return path.join(root, 'console');
  if (isRepo(root)) return path.join(root, 'apps', 'console');
  return null;
}

/**
 * Where the server is. Checked in the order that needs the fewest questions:
 * what was used last, the installer's default, then the repo this app was
 * built from. Only when all three miss does it ask.
 *
 * `ISTHISLEGIT_ROOT` overrides the lot, and the development task sets it. A
 * checkout and an install look identical once this window is open, so a box
 * with both on it would otherwise start, stop and reconfigure whichever the
 * search happened to reach first -- which is the install, because it is
 * looked for earlier.
 */
function findRoot() {
  // Installed, this app lives at <install>\app\, so the server is two levels
  // up from the executable. That is checked before the default path because it
  // is the answer for a machine with the server installed somewhere else.
  const besideExe = path.dirname(path.dirname(process.execPath));

  const candidates = [
    readSettings().root,
    besideExe,
    'C:\\isthislegit',
    path.resolve(__dirname, '..', '..', '..'),
  ];
  for (const dir of candidates) {
    if (consoleDirFor(dir)) return dir;
  }
  return null;
}

async function promptForRoot() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Where is the isthislegit server installed?',
    properties: ['openDirectory'],
    message: 'Pick the folder holding server\\, console\\ and livekit\\.',
  });
  if (canceled || !filePaths.length) return null;

  const picked = filePaths[0];
  if (!consoleDirFor(picked)) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Not an isthislegit install',
      message: 'No console was found in that folder.',
      detail:
        `Looked for console\\src\\main.mjs under:\n  ${picked}\n\n` +
        'Pick the folder the server installer created -- the one holding ' +
        'server\\, console\\ and livekit\\.',
    });
    return null;
  }
  writeSettings({ root: picked });
  return picked;
}

/* --------------------------------------------------------------- console */

function probe(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

/**
 * Starts the console, unless something already holds its port -- which is the
 * case when it was launched by hand or by a second copy of this app. Adopting
 * it is right: a second bind would fail, and the running one is equally good.
 */
async function startConsole(root) {
  if (await probe(CONSOLE_PORT)) return { adopted: true };

  const dir = consoleDirFor(root);
  if (!dir) return { error: `No console found under ${root}.` };

  consoleChild = spawn(process.execPath, [path.join(dir, 'src', 'main.mjs')], {
    cwd: dir,
    // Electron ships Node; this runs the console on it rather than requiring
    // Node on PATH just to open a window.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });

  consoleChild.stdout.on('data', (d) => process.stdout.write(`[console] ${d}`));
  consoleChild.stderr.on('data', (d) => process.stderr.write(`[console] ${d}`));
  consoleChild.on('exit', (code) => {
    consoleChild = null;
    if (!quitting && code !== 0) {
      dialog.showErrorBox(
        'The operator console stopped',
        `It exited with code ${code}.\n\nThe services it manages keep running; ` +
          'only this window is affected. Close and reopen the app to try again.',
      );
    }
  });

  // Up to fifteen seconds. It only has to bind a port and read three files.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probe(CONSOLE_PORT)) return { started: true };
    if (!consoleChild) return { error: 'The console exited while starting.' };
  }
  return { error: 'The console did not answer within fifteen seconds.' };
}

function stopConsole() {
  if (!consoleChild) return;
  const pid = consoleChild.pid;
  consoleChild = null;
  try {
    // /T so the chat server, LiveKit and Caddy it started go with it only if
    // it owns them -- the console kills its own children on SIGTERM.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } catch {
    // Nothing useful to do while quitting.
  }
}

/* ------------------------------------------------------------------- ui */

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'isthislegit Server',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      // The console is a local page this project ships, but it is still web
      // content: keep it out of the main process regardless.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(CONSOLE_URL);

  // The console page sets its own <title>, which would otherwise replace the
  // app's in the taskbar and window bar. This is an application, not a tab.
  win.on('page-title-updated', (event) => event.preventDefault());

  // Links to anywhere else open in the real browser, never in a window with
  // no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(CONSOLE_URL)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Closing hides rather than quits: the console is managing processes, and
  // an accidental close of the window should not take the admin UI down.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    win = null;
  });
}

function buildTray(root) {
  // A PNG rather than the .ico: the tray wants one bitmap at roughly 16px and
  // picking it here is more predictable than letting Windows choose out of a
  // multi-size icon.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));

  tray = new Tray(icon);
  tray.setToolTip('isthislegit Server');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open console', click: showWindow },
      { type: 'separator' },
      {
        label: 'Open install folder',
        click: () => shell.openPath(root),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

/* ----------------------------------------------------------------- boot */

// A second copy would fail to bind the console's port and then adopt the
// first one's, leaving two windows onto the same thing.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    const override = process.env.ISTHISLEGIT_ROOT;
    // A typo here must not fall through to the search: being told the wrong
    // folder and quietly administering a different one is the whole failure
    // the override exists to prevent.
    if (override && !consoleDirFor(override)) {
      dialog.showErrorBox(
        'ISTHISLEGIT_ROOT does not hold a console',
        `Looked for console\\src\\main.mjs (or apps\\console\\src\\main.mjs) under:\n  ${override}\n\n` +
          'Unset ISTHISLEGIT_ROOT to search the usual places instead.',
      );
      app.quit();
      return;
    }

    let root = override || findRoot();
    if (!root) {
      root = await promptForRoot();
      if (!root) {
        app.quit();
        return;
      }
    }
    // Remembered only when it was found, never when it was dictated: a
    // development override must not become the installed app's default.
    if (!override) writeSettings({ root });

    const result = await startConsole(root);
    if (result.error) {
      dialog.showErrorBox(
        'Could not start the operator console',
        `${result.error}\n\nInstall folder:\n  ${root}\n\n` +
          'If the console has never run from this install, its dependencies ' +
          'may be missing. Run "npm install" in its folder, or reinstall the ' +
          'server with a build from this version onwards.',
      );
      app.quit();
      return;
    }

    buildTray(root);
    showWindow();
  });

  app.on('window-all-closed', () => {
    // Deliberately does not quit: the tray icon is the app now.
  });

  app.on('before-quit', () => {
    quitting = true;
    stopConsole();
  });
}
