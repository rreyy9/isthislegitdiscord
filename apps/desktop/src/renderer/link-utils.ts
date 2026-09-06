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
