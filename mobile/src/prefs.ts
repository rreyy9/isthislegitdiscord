import * as SecureStore from 'expo-secure-store';

/**
 * The settings that belong to this phone rather than to the account.
 *
 * The desktop client keeps its equivalents in the main process's settings
 * file: notifications, the ping sound, audio devices, keybinds. Most of that
 * list has no meaning here -- there are no audio devices to choose between and
 * no global hotkeys on a phone -- so what is left is the part that is really
 * about *this device*, plus two that only a phone needs at all.
 *
 * Stored as one JSON blob in SecureStore, next to the token and the server
 * address. Not because any of it is secret, but for the reason the server
 * address is there: one place that gets cleared on sign-out, and one failure
 * mode to reason about. AsyncStorage would be a second native module and a
 * second thing to go wrong in the Gradle build for a few dozen bytes.
 *
 * Every read is wrapped and every field is optional with a default, so a
 * partial or corrupted blob -- including one written by a *newer* build of this
 * app -- loads as "the defaults, plus whatever was recognisable". An app that
 * refused to start because it could not parse its preferences would be trading
 * a working app for a strictly worse one.
 */

const KEY = 'isthislegit.prefs';

export interface Prefs {
  /** Show a strip at the top of the screen when somebody tags you. */
  mentionAlerts: boolean;
  /**
   * Buzz with it. The desktop client plays a sound; a phone in a pocket has
   * neither a speaker anybody is listening to nor a window to flash, and
   * `Vibration` is in React Native itself -- no module, no permission on
   * Android beyond the one the manifest already grants.
   */
  vibrate: boolean;
  /**
   * Draw link embeds at all: players, pictures, the YouTube still.
   *
   * Off is a data-saver switch, and it is here because this is the one client
   * that might be on a metered connection. Off still draws the link, so
   * nothing is hidden -- it is the difference between a tappable URL and a
   * thumbnail fetched from a third party.
   */
  showEmbeds: boolean;
  /**
   * Load a YouTube or TikTok player the moment the message draws, instead of
   * waiting for a tap on the still.
   *
   * Default off, matching the desktop client's click-to-play, and for the same
   * reason doubled: a player is a third-party frame, and on a phone a screen
   * of them is a screen of WebViews.
   */
  autoplayEmbeds: boolean;
  /**
   * The return key sends instead of inserting a newline.
   *
   * Default off, which is the opposite of the desktop client -- and
   * deliberately so. On a hardware keyboard Shift+Enter is right there; on a
   * soft keyboard there is no shift for the return key, so an app that sends on
   * return is an app in which a two-line message cannot be typed at all.
   */
  enterSends: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  mentionAlerts: true,
  vibrate: true,
  showEmbeds: true,
  autoplayEmbeds: false,
  enterSends: false,
};

/** One boolean, read defensively. Anything that is not a boolean is absent. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (!data || typeof data !== 'object') return DEFAULT_PREFS;

  return {
    mentionAlerts: bool(data.mentionAlerts, DEFAULT_PREFS.mentionAlerts),
    vibrate: bool(data.vibrate, DEFAULT_PREFS.vibrate),
    showEmbeds: bool(data.showEmbeds, DEFAULT_PREFS.showEmbeds),
    autoplayEmbeds: bool(data.autoplayEmbeds, DEFAULT_PREFS.autoplayEmbeds),
    enterSends: bool(data.enterSends, DEFAULT_PREFS.enterSends),
  };
}

export const prefsStore = {
  async read(): Promise<Prefs> {
    try {
      return parsePrefs(await SecureStore.getItemAsync(KEY));
    } catch {
      return DEFAULT_PREFS;
    }
  },
  async write(prefs: Prefs): Promise<void> {
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify(prefs));
    } catch {
      // A phone that cannot persist a preference still honours it for this
      // session. Refusing the change would be the worse outcome.
    }
  },
};
