/**
 * Pure helpers for turning message text into links and embeds.
 *
 * Split out from the component so they can be exercised directly — URL parsing
 * is the kind of thing that looks right and quietly is not.
 */

/**
 * Deliberately conservative: http(s) only, so `javascript:` and `data:` never
 * match and never become an href in the first place. Trailing punctuation is
 * excluded so "see https://x.com/a." does not swallow the full stop.
 */
export const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/gi;

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

/**
 * A linked file this build will put in a `<video>`.
 *
 * The same two formats the server accepts as inline uploads, for the same
 * reason: they are what Chromium plays without a codec question. `.m4v` is
 * an MP4 under another name and is common enough to be worth matching.
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

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
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
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/* ------------------------------------------------------------- tiktok */

/**
 * The numeric video id from a TikTok URL, or null.
 *
 * Only the shapes that carry the id in the path. A `vm.tiktok.com/XXXX` or
 * `tiktok.com/t/XXXX` share link is a redirect and nothing but a request to
 * TikTok can turn it into an id -- which would mean this app reaching out to
 * a third party for every link that scrolls past, before anybody has asked to
 * watch anything. Those stay plain links.
 *
 * The id is digits only (a snowflake, 19 digits today), and that is checked
 * rather than assumed: it is interpolated into the embed URL, and a path
 * segment from a stranger's message is not something to paste into a URL
 * unexamined.
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
