import { app, BrowserWindow, ipcMain, Notification } from 'electron';

/**
 * Desktop notifications for tags.
 *
 * The renderer decides *whether* something is worth a notification — it is the
 * only side that knows which channel is on screen, and a ping for the message
 * you are already looking at is noise. Main's job is the parts a renderer
 * cannot reach: the OS notification itself, the taskbar asking for attention,
 * and raising the window when somebody clicks through.
 */

export interface MentionNotice {
  /** Usually "Name in #channel". */
  title: string;
  body: string;
  /** Where clicking through should land. */
  channelId: string;
  messageId: string;
}

/**
 * Windows will not show a notification from an application it cannot name.
 *
 * Toasts are addressed to an AppUserModelID, and one that does not match an
 * installed Start Menu shortcut is dropped silently — no error, no toast,
 * which is exactly the failure that gets diagnosed as "notifications do not
 * work on Windows". The installed build has a shortcut, so it uses its own id;
 * a build run from source has none, so it borrows Electron's own, which does.
 */
export function setNotificationIdentity() {
  if (process.platform !== 'win32') return;
  app.setAppUserModelId(
    app.isPackaged ? 'com.isthislegit.desktop' : process.execPath,
  );
}

export function registerNotifications(getWindow: () => BrowserWindow | null) {
  /**
   * Raise one notification, and get the window noticed.
   *
   * Three separate things, because they fail separately: a machine with
   * notifications switched off still gets the taskbar flash, and one where the
   * badge is meaningless still gets the toast.
   */
  ipcMain.handle('notify:mention', (_e, notice: MentionNotice) => {
    const win = getWindow();

    if (Notification.isSupported()) {
      const toast = new Notification({
        title: notice.title,
        body: notice.body,
        // The message is already on screen for anyone with the app open; the
        // toast is for the person who is not looking at it.
        silent: false,
      });
      toast.on('click', () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        // Told after the window is up, so the channel switch lands on a
        // renderer that is actually being looked at.
        win.webContents.send('notification:activate', {
          channelId: notice.channelId,
          messageId: notice.messageId,
        });
      });
      toast.show();
    }

    // The taskbar button, flashing until the window is looked at. This is the
    // one that survives a machine with toasts disabled, and on Windows it is
    // the conventional way an application says it wants attention.
    if (win && !win.isFocused()) win.flashFrame(true);
    return true;
  });

  /**
   * The number on the dock or launcher icon.
   *
   * macOS and most Linux launchers draw it; Windows has no equivalent that
   * does not involve rendering an overlay image per count, and the flashing
   * taskbar button above already says the same thing there. Calling it
   * everywhere is harmless — where it is not supported it does nothing.
   */
  ipcMain.handle('notify:badge', (_e, count: number) => {
    app.setBadgeCount(Math.max(0, Math.floor(count)));
    return true;
  });
}

/** Stop the taskbar flashing once the window is being looked at. */
export function clearAttention(win: BrowserWindow) {
  win.flashFrame(false);
}
