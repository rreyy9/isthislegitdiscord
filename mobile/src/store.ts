import * as SecureStore from 'expo-secure-store';

/**
 * The things that have to survive the app being closed: which server, the
 * token for it, and -- if asked for -- the username and password to get a new
 * one.
 *
 * All of it in SecureStore rather than AsyncStorage, and that is not
 * belt-and-braces. SecureStore keeps values in the Android Keystore, which
 * means they are encrypted at rest and are not in the plain-text blob that a
 * `adb backup` or a rooted file browser hands over. The token is a thirty-day
 * session; on a phone that is lost far more often than a desktop is, that is
 * exactly the credential worth putting there.
 *
 * Keeping the server address in the same store is not about secrecy -- it is so
 * there is one place that gets cleared on sign-out and one failure mode to
 * reason about, rather than a token that went and an address that stayed.
 *
 * The remembered password is the one value here that is a real password rather
 * than a revocable session, and it is stored because the alternative on a
 * self-hosted app used by ten people is typing it into a phone keyboard every
 * time a thirty-day token lapses. It is opt-in, it never leaves the keystore,
 * and unticking the box deletes it on the spot.
 *
 * Every read is wrapped: SecureStore throws on a device with no keystore
 * available, and an app that cannot start because it could not read an
 * *optional* setting is a worse outcome than one that starts signed out.
 */

const TOKEN = 'isthislegit.token';
const SERVER = 'isthislegit.serverUrl';
const LOGIN = 'isthislegit.login';

/**
 * The address the app talks to when nothing has been chosen yet.
 *
 * Deliberately the real deployment rather than localhost: this is a
 * single-server application handed to ten people, and the overwhelmingly
 * likely first action is signing in to that server. Anyone pointing it
 * somewhere else edits one field on the sign-in screen.
 */
export const DEFAULT_SERVER_URL = 'https://isthislegit.duckdns.org';

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function write(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // A phone that cannot persist the token still works for this session; it
    // just asks for a password next launch. Refusing to sign in over it would
    // trade a working app for a strictly worse one.
  }
}

async function clear(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Nothing to do. The in-memory copy is dropped by the caller either way.
  }
}

/** Trailing slashes off: an origin has no path, and `${url}${path}` joins them. */
export function normaliseServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** A remembered login. Its presence in the store *is* the "remember me" flag. */
export interface SavedLogin {
  username: string;
  password: string;
}

export const store = {
  getToken: () => read(TOKEN),
  setToken: (token: string) => write(TOKEN, token),
  clearToken: () => clear(TOKEN),

  async getServerUrl(): Promise<string> {
    return (await read(SERVER)) ?? DEFAULT_SERVER_URL;
  },
  setServerUrl: (url: string) => write(SERVER, normaliseServerUrl(url)),

  /**
   * The remembered username and password, or null.
   *
   * One JSON value under one key rather than two keys, so there is no state
   * where the name came back and the password did not -- a half-filled form
   * that fails on submit is worse than an empty one.
   *
   * Malformed JSON is treated as nothing remembered: the only way to get it is
   * a value this app did not write, and there is no better answer than the
   * sign-in screen it would have shown anyway.
   */
  async getLogin(): Promise<SavedLogin | null> {
    const raw = await read(LOGIN);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as SavedLogin).username === 'string' &&
        typeof (parsed as SavedLogin).password === 'string'
      ) {
        return parsed as SavedLogin;
      }
    } catch {
      // Fall through.
    }
    return null;
  },
  setLogin: (login: SavedLogin) => write(LOGIN, JSON.stringify(login)),
  clearLogin: () => clear(LOGIN),
};
