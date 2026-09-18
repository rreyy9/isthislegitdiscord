/**
 * Pure helpers for turning message text into links and embeds.
 *
 * A port of the desktop client's `link-utils.ts`, kept deliberately identical
 * rather than adapted. Two clients against one server that disagree about
 * which links are worth embedding is how somebody ends up posting a link on
 * the desktop, checking the phone, and concluding one of the two is broken.
 * Every pattern and every id check below is the same string as over there; if
 * one changes, change both.
 *
 * Split out from the component for the reason it is on the desktop: URL
 * parsing is the kind of thing that looks right and quietly is not.
 */

/**
 * Deliberately conservative: http(s) only, so `javascript:` and `data:` never
 * match and never reach `Linking.openURL`. Trailing punctuation is excluded so
 * "see https://x.com/a." does not swallow the full stop.
 */
export const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/gi;

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

/**
 * A linked file this build will put in a player.
 *
 * The same three the desktop client plays, which are the same the server
 * accepts as inline uploads. `.m4v` is an MP4 under another name and is common
 * enough to be worth matching. ExoPlayer, which is what `expo-video` is on
 * Android, handles all of them.
 */
export const VIDEO_EXT_RE = /\.(mp4|m4v|webm)(\?.*)?$/i;

/** The 11-character video id from any YouTube URL shape, or null. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1);
    return /^[\w-]{11}$/.test(id) ? id : null;
  }

  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v') ?? '';
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (m) return m[1];
  }
  return null;
}

/** Seconds to start at, from `?t=90`, `?t=1m30s` or `?start=90`. */
export function youtubeStart(url: string): number | null {
  let t: string | null;
  try {
    const u = new URL(url);
    t = u.searchParams.get('t') ?? u.searchParams.get('start');
  } catch {
    return null;
  }
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);

  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return null;

  const [, hours, minutes, seconds] = m;
  // Every group is optional, so the pattern also matches an empty string.
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  return (
    Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  );
}

/**
 * The numeric video id from a TikTok URL, or null.
 *
 * Only the shapes that carry the id in the path. A `vm.tiktok.com/XXXX` or
 * `tiktok.com/t/XXXX` share link is a redirect and nothing but a request to
 * TikTok can turn it into an id -- which would mean this app reaching out to a
 * third party for every link that scrolls past, before anybody has asked to
 * watch anything. Those stay plain links.
 *
 * The id is digits only, and that is checked rather than assumed: it is
 * interpolated into the embed URL, and a path segment from a stranger's
 * message is not something to paste into a URL unexamined.
 */
export function tiktokId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host !== 'tiktok.com') return null;

  // /@someone/video/123, /@someone/photo/123 (a slideshow, which the player
  // also handles), and the embed URL somebody may paste as-is.
  const m = u.pathname.match(
    /^\/(?:@[^/]+\/(?:video|photo)|embed(?:\/v\d+)?)\/(\d{6,32})/,
  );
  return m ? m[1] : null;
}

/**
 * The last path segment of a URL, which is the only name a link ever has.
 *
 * Used for the caption under a linked image and for the title of the viewer it
 * opens into -- on a phone there is no address bar to read the name off, so a
 * picture with no caption is a picture with no name at all.
 */
export function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
  } catch {
    return url;
  }
}

/** What kind of embed a link earns, if any. One answer per URL. */
export type Embed =
  | { kind: 'youtube'; id: string; start: number | null; url: string }
  | { kind: 'tiktok'; id: string; url: string }
  | { kind: 'image'; url: string }
  | { kind: 'video'; url: string };

/**
 * The first link in a message worth drawing something for, or null.
 *
 * One embed per message, matching the desktop client: a message that is a wall
 * of links is a list to read, not four players to load, and on a phone four
 * players is the whole screen.
 *
 * Returning a description rather than a component keeps this file free of
 * React, which is what lets the pattern matching be exercised on its own.
 */
export function firstEmbed(content: string): Embed | null {
  for (const match of content.matchAll(URL_RE)) {
    const url = match[0];

    const yt = youtubeId(url);
    if (yt) return { kind: 'youtube', id: yt, start: youtubeStart(url), url };

    const tt = tiktokId(url);
    if (tt) return { kind: 'tiktok', id: tt, url };

    if (IMAGE_EXT_RE.test(url)) return { kind: 'image', url };
    if (VIDEO_EXT_RE.test(url)) return { kind: 'video', url };
  }
  return null;
}
