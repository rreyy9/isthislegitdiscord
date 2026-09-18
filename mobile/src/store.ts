import * as SecureStore from 'expo-secure-store';

/**
 * The two things that have to survive the app being closed: which server, and
 * the token for it.
 *
 * Both in SecureStore rather than AsyncStorage, and that is not belt-and-braces
 * for the address. SecureStore keeps values in the Android Keystore, which
 * means they are encrypted at rest and are not in the plain-text blob that a
 * `adb backup` or a rooted file browser hands over. The token is a thirty-day
 * session; on a phone that is lost far more often than a desktop is, that is
 * exactly the credential worth putting there.
 *
 * Keeping the server address in the same store is not about secrecy -- it is so
 * there is one place that gets cleared on sign-out and one failure mode to
 * reason about, rather than a token that went and an address that stayed.
 *
 * Every read is wrapped: SecureStore throws on a device with no keystore
 * available, and an app that cannot start because it could not read an
 * *optional* setting is a worse outcome than one that starts signed out.
 */

const TOKEN = 'isthislegit.token';
const SERVER = 'isthislegit.serverUrl';

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

export const store = {
  getToken: () => read(TOKEN),
  setToken: (token: string) => write(TOKEN, token),
  clearToken: () => clear(TOKEN),

  async getServerUrl(): Promise<string> {
    return (await read(SERVER)) ?? DEFAULT_SERVER_URL;
  },
  setServerUrl: (url: string) => write(SERVER, normaliseServerUrl(url)),
};
