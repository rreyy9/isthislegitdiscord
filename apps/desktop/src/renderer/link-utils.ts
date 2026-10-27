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

/* -------------------------------------------------------- reddit video */

/**
 * The id out of a `v.redd.it` link, or null.
 *
 * `v.redd.it/<id>` is what Reddit's share button hands out. A link straight to
 * one of the files under it (`v.redd.it/<id>/CMAF_720.mp4`) is matched too,
 * because that file is picture only -- Reddit keeps the sound in a file of its
 * own -- and played as an ordinary linked video it would be silently mute.
 *
 * A `reddit.com/r/.../comments/...` post link is not matched. Getting from one
 * of those to a video id means asking reddit.com, which refuses requests that
 * do not come from a signed-in browser.
 *
 * The id is lowercase letters and digits, 13 of them today, and is checked
 * rather than assumed: it is interpolated into the URLs this app fetches.
 */
export function redditVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== 'v.redd.it') return null;
  const m = u.pathname.match(/^\/([a-z0-9]{6,20})(?:\/[\w.-]*)?$/);
  return m ? m[1] : null;
}

/** Where a clip's files live. Built from a checked id only. */
export function redditVideoBase(id: string): string | null {
  return /^[a-z0-9]{6,20}$/.test(id) ? `https://v.redd.it/${id}` : null;
}

/** What `DASHPlaylist.mpd` says about a clip. */
export interface RedditManifest {
  /** File name of the picture-only MP4 to show, relative to the clip's base. */
  video: string;
  width: number;
  height: number;
  /** Whether the clip has a sound track at all. */
  audio: boolean;
}

/** The tallest rendition worth fetching for a box no bigger than 420px. */
const REDDIT_MAX_HEIGHT = 720;

/**
 * Read the parts of a clip's DASH manifest that decide how it is drawn.
 *
 * The manifest is the only reliable way to know the file names: they have been
 * `DASH_720`, then `DASH_720.mp4`, and are `CMAF_720.mp4` today, and the old
 * names 403 on new clips. It also says whether there is any sound, which is
 * what separates a clip that loops like a GIF from one that waits for a click.
 *
 * String matching rather than an XML parser, so it runs the same under test as
 * in the renderer. The manifest is a few kilobytes of a fixed shape and only a
 * handful of attributes are read. Every file name is checked before it is
 * returned: it came from somebody else's server and is about to become part of
 * a URL.
 */
export function parseRedditManifest(xml: string): RedditManifest | null {
  const sets = xml.split(/<AdaptationSet\b/).slice(1);
  let audio = false;
  let best: { video: string; width: number; height: number } | null = null;

  for (const set of sets) {
    const head = set.slice(0, set.indexOf('>'));
    if (/contentType="audio"|mimeType="audio\//.test(set)) {
      audio = true;
      continue;
    }
    const setIsVideo = /contentType="video"|mimeType="video\//.test(head);

    for (const rep of set.split(/<Representation\b/).slice(1)) {
      const attrs = rep.slice(0, rep.indexOf('>'));
      if (!setIsVideo && !/mimeType="video\//.test(attrs)) continue;

      const width = Number(attrs.match(/\bwidth="(\d+)"/)?.[1]);
      const height = Number(attrs.match(/\bheight="(\d+)"/)?.[1]);
      const video = rep.match(/<BaseURL>\s*([^<\s]+)\s*<\/BaseURL>/)?.[1];
      if (!width || !height || !video) continue;
      if (!/^[A-Za-z0-9_]{1,40}(\.mp4)?$/.test(video)) continue;

      // The tallest that fits under the cap; failing that, the shortest.
      const fits = height <= REDDIT_MAX_HEIGHT;
      const better =
        !best ||
        (fits
          ? best.height > REDDIT_MAX_HEIGHT || height > best.height
          : best.height > REDDIT_MAX_HEIGHT && height < best.height);
      if (better) best = { video, width, height };
    }
  }
  return best ? { ...best, audio } : null;
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
  // also handles), and either frame URL somebody may paste as-is -- the card
  // at /embed/v2 or the player at /player/v1.
  const m = u.pathname.match(
    /^\/(?:@[^/]+\/(?:video|photo)|(?:embed|player)(?:\/v\d+)?)\/(\d{6,32})/,
  );
  return m ? m[1] : null;
}

/**
 * The share link TikTok's own app hands out, normalised, or null.
 *
 * `vm.tiktok.com/XXXX`, `vt.tiktok.com/XXXX` and `tiktok.com/t/XXXX` carry no
 * id at all; they are redirects, and only TikTok knows what to. The rule in
 * `tiktokId` above still holds -- nothing is asked of TikTok for a link that
 * merely scrolls past -- but the poster is already click-to-load, so the
 * redirect can be followed at the same moment the frame is, which is after
 * somebody has said they want to watch this one. Until then it is still just
 * text on screen.
 *
 * What comes back is rebuilt from the parts that were checked rather than
 * handed back as it arrived: it is given to the main process to request, so it
 * should be a string this file constructed, not a string somebody typed into a
 * message. The scheme is https whatever was written, since these hosts redirect
 * http to it anyway and there is no reason to make the first hop in the clear.
 */
export function tiktokShareUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  // The token is the app's own opaque short code -- letters and digits, no
  // separators, and no length worth trusting beyond a sane bound.
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    const m = u.pathname.match(/^\/([A-Za-z0-9]{4,32})\/?$/);
    return m ? `https://${host}/${m[1]}/` : null;
  }
  if (host === 'tiktok.com' || host === 'm.tiktok.com') {
    const m = u.pathname.match(/^\/t\/([A-Za-z0-9]{4,32})\/?$/);
    return m ? `https://www.tiktok.com/t/${m[1]}/` : null;
  }
  return null;
}

/**
 * The origin the player frame is loaded from.
 *
 * Written down once because it is used twice and the two uses have to agree:
 * it is what the frame `src` is built on, and it is what a `message` claiming
 * to come from that frame is checked against. A player message is read by
 * code that then draws something, so where it came from is the first question.
 */
export const TIKTOK_PLAYER_ORIGIN = 'https://www.tiktok.com';

/**
 * The frame URL for a post, or null if that is not an id.
 *
 * TikTok publishes two embeds. `/embed/v2` is the card the Share menu hands
 * out -- an avatar, a description, a like-comment-share rail, a promo bar, and
 * the post somewhere in the middle -- laid out to a height of its own
 * choosing, so a box that does not happen to match it gets a scrollbar inside
 * a chat message. `/player/v1` is the documented embedded player: the post and
 * its controls and nothing else, filling whatever frame it is given.
 *
 * https://developers.tiktok.com/doc/embed-player/
 *
 * The parameters are the documented ones, and each is here for a reason:
 *
 * - `autoplay=1`, because the poster has already been clicked. Without it that
 *   click is followed by a second one inside the frame, which is one more than
 *   anybody expects. A browser may still refuse to start it, and says so as
 *   error 3002 -- which is a click away from working and is not treated as a
 *   post that failed to load. See `tiktokPlayerError`.
 * - `rel=0`, so what follows the post is the author's own videos rather than
 *   whatever TikTok would like this reader to watch next. The YouTube embed
 *   carries the same parameter for the same reason.
 * - `music_info=0` and `description=0` are TikTok's defaults today and are
 *   still written out. The frame is a fixed shape; a default changed on their
 *   side would put text in it that there is no room for.
 *
 * The id is checked here rather than taken on trust. It is interpolated into a
 * URL, and the ids that reach this came out of a stranger's message or out of
 * a redirect that somebody else's server chose.
 */
export function tiktokPlayerUrl(id: string): string | null {
  if (!/^\d{6,32}$/.test(id)) return null;
  const params = 'autoplay=1&rel=0&music_info=0&description=0';
  return `${TIKTOK_PLAYER_ORIGIN}/player/v1/${id}?${params}`;
}

/**
 * The code out of a player error message, or null if this is not one.
 *
 * The player talks to whatever is hosting it by posting `{ type, value,
 * 'x-tiktok-player': true }`, and this reads the one message worth acting on.
 * Everything is checked rather than destructured: this runs on every `message`
 * the window receives, most of which have nothing to do with TikTok, and the
 * caller is about to draw what it returns.
 *
 * 3002 deliberately comes back as null. It means the browser refused to start
 * the video by itself, which is what `autoplay=1` asks for and what browsers
 * routinely decline; the post is fine and the play button works. An error card
 * in front of a video that plays is worse than no card at all.
 *
 * https://developers.tiktok.com/doc/embed-player/
 */
export function tiktokPlayerError(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message['x-tiktok-player'] !== true) return null;
  if (message['type'] !== 'onPlayerError') return null;

  const value = message['value'];
  if (!value || typeof value !== 'object') return null;

  const code = Number((value as Record<string, unknown>)['errorCode']);
  if (!Number.isInteger(code)) return null;
  // Autoplay was refused, which is not a post that will not play.
  return code === 3002 ? null : code;
}

/**
 * What to say about a code `tiktokPlayerError` handed back.
 *
 * Three of the documented codes say something a reader would want to know, and
 * the rest -- including any TikTok adds later -- get the wording the app used
 * before it could tell them apart. None of them mention a number: "1001" is
 * true and no help to anybody.
 */
export function tiktokErrorLabel(code: number): string {
  switch (code) {
    case 1001:
      return 'This post isn’t on TikTok any more';
    case 2001:
      return 'TikTok couldn’t serve this one';
    case 3001:
      return 'This one wouldn’t play';
    default:
      return 'Couldn’t load this one';
  }
}
