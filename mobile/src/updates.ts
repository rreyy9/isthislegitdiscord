import { Linking } from 'react-native';
import { getServerUrl } from './api';

/**
 * Offering a new build, without a store.
 *
 * The app does not install anything itself. It opens the APK's URL, Android's
 * browser downloads it, and the person taps the finished download to install.
 * That is three steps rather than one, and it is the right trade for now:
 *
 * Installing in-app needs the `REQUEST_INSTALL_PACKAGES` permission, a
 * `FileProvider` to hand the downloaded file across, and an `ACTION_VIEW`
 * intent to launch the package installer. That permission is one Play Protect
 * treats as significant, it has to be declared whether or not anybody ever
 * updates, and all of it buys is skipping a tap on a notification. The browser
 * already knows how to resume an interrupted download over a phone connection,
 * which is the part that actually goes wrong.
 *
 * The URL is a path on the same server the app is already signed in to, and
 * the feed is deliberately unauthenticated -- see the note on
 * `AndroidUpdatesService`. So this works even when the session that would have
 * fetched it has lapsed, which is exactly when somebody is most likely to need
 * a newer build.
 */

/** Where the feed lives on the server. Matches the server's controller. */
const FEED = '/updates/android';

export const manifestUrl = () => `${getServerUrl()}${FEED}/latest.json`;

/**
 * The APK's address.
 *
 * Read from the manifest rather than built from the version, because the file
 * name is the server's business: it is whatever was uploaded, and a client
 * guessing at `isthislegit-0.2.0.apk` would break the first time somebody
 * renamed a build.
 */
export async function apkUrl(): Promise<string> {
  const res = await fetch(manifestUrl(), {
    // The manifest is small and changes rarely, but a cached one is precisely
    // the thing that would keep offering a version that is no longer there.
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`The server has no Android build published.`);

  const manifest = (await res.json()) as { apk?: unknown };
  if (typeof manifest.apk !== 'string' || !manifest.apk) {
    throw new Error('The update manifest names no APK.');
  }
  return `${getServerUrl()}${FEED}/${encodeURIComponent(manifest.apk)}`;
}

/**
 * Hand the download to the browser.
 *
 * Errors are returned rather than thrown so the banner can say what went
 * wrong in place. Somebody who cannot download an update is not in an error
 * state -- they are on the version they were on a moment ago, which still
 * works.
 */
export async function downloadUpdate(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const url = await apkUrl();
    await Linking.openURL(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
