import { useEffect, useState } from 'react';
import {
  attachmentUrl,
  fetchAttachmentBytes,
  type AttachmentDto,
} from '../api';
import { bridge } from '../bridge';
import {
  IMAGE_EXT_RE,
  URL_RE,
  VIDEO_EXT_RE,
  tiktokId,
  youtubeId,
  youtubeStart,
} from '../link-utils';
import { MENTION_RE } from '../mention-utils';
import { emojiOnly } from '../emoji-utils';
import { useImageActions } from './ImageViewer';

/**
 * Turning message text into something worth looking at.
 *
 * Deliberately not a markdown renderer. Message text is written by other
 * people, and the whole job here is done by splitting on a pattern and
 * building React elements — so there is no path by which message content
 * becomes markup. No dangerouslySetInnerHTML anywhere in this file.
 */

/* ------------------------------------------------------------ youtube */

function YouTube({ id, start }: { id: string; start: number | null }) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    const params = new URLSearchParams({ autoplay: '1', rel: '0' });
    if (start) params.set('start', String(start));
    return (
      <div className="yt">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?${params}`}
          allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          title="YouTube video"
        />
      </div>
    );
  }

  // A still until someone asks for the video: the player is a third-party frame
  // and there is no reason to load one for every link that scrolls past.
  return (
    <div className="yt poster" onClick={() => setPlaying(true)} title="Play">
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" />
      <div className="yt-play" aria-hidden>
        <svg viewBox="0 0 68 48" width="68" height="48">
          <path
            d="M66.5 7.7a8.6 8.6 0 0 0-6-6C55.3 0 34 0 34 0S12.7 0 7.5 1.7a8.6 8.6 0 0 0-6 6A89.5 89.5 0 0 0 0 24a89.5 89.5 0 0 0 1.5 16.3 8.6 8.6 0 0 0 6 6C12.7 48 34 48 34 48s21.3 0 26.5-1.7a8.6 8.6 0 0 0 6-6A89.5 89.5 0 0 0 68 24a89.5 89.5 0 0 0-1.5-16.3z"
            fill="#f00"
          />
          <path d="M27 34l18-10-18-10z" fill="#fff" />
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- tiktok */

/**
 * A TikTok post, on the same click-to-play deal as YouTube above.
 *
 * There is no still to show first. YouTube publishes a thumbnail at a URL
 * anyone can build from the id; TikTok's is only reachable through an oEmbed
 * call, which is a request to TikTok for every link in the channel -- exactly
 * what the poster pattern exists to avoid. So the placeholder is drawn here,
 * out of nothing, and the frame is loaded when somebody asks for it.
 */
function TikTok({ id }: { id: string }) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <div className="tt">
        <iframe
          src={`https://www.tiktok.com/embed/v2/${id}`}
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          title="TikTok video"
        />
      </div>
    );
  }

  return (
    <div className="tt poster" onClick={() => setPlaying(true)} title="Play">
      <div className="tt-mark" aria-hidden>
        <svg viewBox="0 0 48 48" width="40" height="40">
          <path
            d="M33.5 6h-5.7v25.2a4.6 4.6 0 1 1-4.6-4.6c.4 0 .8.1 1.2.2v-5.8a10.4 10.4 0 1 0 9.1 10.3V18.6a12 12 0 0 0 7 2.2v-5.7a6.9 6.9 0 0 1-7-7z"
            fill="currentColor"
          />
        </svg>
      </div>
      <div className="tt-label">Watch on TikTok</div>
    </div>
  );
}

/* -------------------------------------------------------- linked video */

/**
 * A video someone linked to directly.
 *
 * `preload="none"` is the whole of the politeness here: the element draws its
 * controls without fetching a byte, so a channel full of links costs nothing
 * until somebody presses play. It is the same bargain as the YouTube still.
 */
function LinkedVideo({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a className="link" href={url} onClick={openExternal(url)}>
        {url}
      </a>
    );
  }
  return (
    <div className="embed-video">
      <video src={url} controls preload="none" onError={() => setFailed(true)} />
    </div>
  );
}

/* -------------------------------------------------------- linked image */

/** An image someone linked to directly, rather than uploaded. */
function LinkedImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const { imageProps } = useImageActions();
  if (failed) {
    return (
      <a className="link" href={url} onClick={openExternal(url)}>
        {url}
      </a>
    );
  }
  return (
    <div className="embed-img">
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        {...imageProps({ src: url, name: fileNameOf(url) })}
      />
    </div>
  );
}

/** The last path segment of a URL, which is the only name a link ever has. */
function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
  } catch {
    return url;
  }
}

/* --------------------------------------------------------- attachments */

/** One uploaded image, fetched with the token and shown from an object URL. */
export function AttachmentImage({ file }: { file: AttachmentDto }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { imageProps } = useImageActions();

  useEffect(() => {
    let live = true;
    attachmentUrl(file.id, file.url).then(
      (url) => live && setSrc(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [file.id, file.url]);

  // Reserving the real aspect ratio before the bytes arrive is the whole
  // reason width and height are stored: without it the message list jumps
  // around as images load and reading it becomes unpleasant.
  const ratio = file.width && file.height ? `${file.width} / ${file.height}` : undefined;
  const maxWidth = file.width ? Math.min(file.width, 420) : 420;

  if (failed) {
    return <div className="attach-failed">Could not load {file.fileName}</div>;
  }

  return (
    <div
      className={'attach' + (src ? '' : ' loading')}
      style={{ aspectRatio: ratio, maxWidth }}
    >
      {src && (
        <img
          src={src}
          alt={file.fileName}
          // A fetch that worked and bytes that will not decode is a real
          // state: a server newer than this build may call something inline
          // that this one has no idea how to draw, and a silent empty box is
          // the worst way to say so.
          onError={() => setFailed(true)}
          {...imageProps({ src, name: file.fileName })}
        />
      )}
    </div>
  );
}

/**
 * One uploaded video.
 *
 * Loaded on a click rather than on sight. The bytes come through `fetch` with
 * the bearer token and become an object URL, exactly as a picture does -- a
 * `<video src>` can no more carry an Authorization header than an `<img>` can
 * -- but a video is the largest thing anyone sends, and pulling every one in
 * the scrollback down the moment it draws would be a channel that costs
 * hundreds of megabytes to scroll through. So: a card with the name on it,
 * and the fetch happens when somebody wants to watch.
 *
 * There is no ranged playback here. The whole file arrives before the first
 * frame plays, which is honest about what the server offers -- one stream of
 * the whole object -- and affordable because the upload limit is what it is.
 */
export function AttachmentVideo({ file }: { file: AttachmentDto }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const expired = Boolean(file.expiredAt);

  function load() {
    if (loading || src) return;
    setLoading(true);
    attachmentUrl(file.id, file.url).then(
      (url) => {
        setSrc(url);
        setLoading(false);
      },
      () => {
        setFailed(true);
        setLoading(false);
      },
    );
  }

  // Expired is not a failure and gets the same card a file does: the row
  // outlives the bytes so the message can still say what was there.
  if (expired) return <AttachmentFile file={file} />;
  if (failed) {
    return <div className="attach-failed">Could not load {file.fileName}</div>;
  }

  // Said on the card as well as on a file, because it is just as true and
  // twice as surprising: a video is drawn inline and looks like part of the
  // conversation, and it is still on the same clock as everything that is not
  // a picture.
  const left = file.expiresAt ? timeLeft(file.expiresAt) : null;
  const meta = (
    <div className="attach-video-meta">
      <span title={file.fileName}>{file.fileName}</span>
      <span>{fileSize(file.size)}</span>
      {left && <span className="attach-file-clock">· {left}</span>}
    </div>
  );

  if (src) {
    return (
      <div className="attach-video">
        {/* Autoplay only because a click just asked for it -- this branch is
            unreachable until somebody presses the card. */}
        <video src={src} controls autoPlay />
        {meta}
      </div>
    );
  }

  return (
    <div
      className={'attach-video poster' + (loading ? ' loading' : '')}
      onClick={load}
      title={loading ? 'Loading…' : 'Play'}
    >
      <div className="attach-video-play" aria-hidden>
        {loading ? '…' : '▶'}
      </div>
      {meta}
    </div>
  );
}

/** The types this build knows how to put on screen. */
const RENDERABLE = /^image\/(png|jpeg|gif|webp)$/i;

/**
 * Whether to draw an attachment as a picture.
 *
 * The server's answer wins. It is the side that decides what it will hand back
 * as a renderable type and what it will only ever hand back as bytes to save,
 * and those two answers have to be the same one -- a client that put an
 * uploaded file in an `<img>` against the server's judgement is exactly the
 * case the download rules exist to prevent.
 *
 * `inline` is absent from a server older than the feature, where every
 * attachment was a picture. Falling back to the content type is what this
 * build did before being told, so an old server behaves as it always did.
 */
const drawInline = (file: AttachmentDto): boolean =>
  file.inline ?? RENDERABLE.test(file.contentType);

/**
 * Which of the two inline shapes an attachment is.
 *
 * Read off the content type rather than off `inline`, because `inline` only
 * answers "may this be drawn" and a server newer than this build could widen
 * it again. Anything inline that is not video is a picture, which is what this
 * build has always assumed and remains true for every type on the list.
 */
const isVideo = (file: AttachmentDto): boolean =>
  /^video\//i.test(file.contentType);

/* --------------------------------------------------------------- files */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

function fileSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`;
}

/**
 * How long is left, in the largest unit that is still true.
 *
 * Rounded down, never up: "expires in 1 hour" on something with fifty-nine
 * minutes left is a promise that can be kept, and the reverse is not.
 */
function timeLeft(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'expiring now';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `expires in ${days} day${days === 1 ? '' : 's'}`;
  }
  if (hours >= 1) return `expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * One uploaded file that is not a picture.
 *
 * Save, and only save. The server hands these back as an octet-stream
 * attachment that nothing will render, and this end matches that: there is no
 * open, no preview, and no reveal-in-folder. Anyone with an invite may upload
 * anything, including a program, and an app that opens one of those on the
 * reader's behalf is the thing that ran it.
 */
export function AttachmentFile({ file }: { file: AttachmentDto }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const expired = Boolean(file.expiredAt);
  const left = file.expiresAt && !expired ? timeLeft(file.expiresAt) : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const bytes = await fetchAttachmentBytes(file.url);
      const path = await bridge.saveFile({ name: file.fileName, bytes });
      // Null is a cancelled dialog, which is not a failure and gets no
      // message: the person who cancelled it knows what they did.
      if (path) setSavedTo(path);
    } catch (e: any) {
      setError(e?.message ?? 'That file could not be downloaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={'attach-file' + (expired ? ' expired' : '')}>
      <div className="attach-file-icon" aria-hidden>
        {expired ? '✕' : '▤'}
      </div>
      <div className="attach-file-body">
        <div className="attach-file-name" title={file.fileName}>
          {file.fileName}
        </div>
        <div className="attach-file-meta">
          {expired ? (
            <span className="attach-file-gone">
              No longer on the server — files that are not pictures are kept
              for a limited time.
            </span>
          ) : (
            <>
              <span>{fileSize(file.size)}</span>
              {left && <span className="attach-file-clock">· {left}</span>}
            </>
          )}
        </div>
        {savedTo && <div className="attach-file-saved">Saved to {savedTo}</div>}
        {error && <div className="attach-file-error">{error}</div>}
      </div>
      {!expired && (
        <button className="attach-file-save" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ mentions */

/**
 * One tag, drawn as a pill.
 *
 * The name is looked up at the moment of drawing rather than read out of the
 * message, which is the entire reason the wire format carries an id: somebody
 * changes their display name and every message that ever tagged them says the
 * new one, with nothing rewritten and no migration.
 */
function Mention({ name, self }: { name: string; self: boolean }) {
  return <span className={'mention' + (self ? ' self' : '')}>@{name}</span>;
}

/**
 * A tag naming somebody this client cannot identify — usually a member who has
 * since been removed. Named rather than left as raw `<@…>`, which is an id and
 * tells the reader nothing, and not hidden, which would quietly rewrite what
 * was said.
 */
function UnknownMention() {
  return (
    <span className="mention unknown" title="This account is no longer here">
      @unknown
    </span>
  );
}

/**
 * Both patterns in one pass.
 *
 * Two passes would mean the second one walking over text the first has already
 * turned into elements — the classic way a link inside a name, or a name
 * inside a link, comes out mangled. One alternation means every character
 * belongs to exactly one token. Group 1 is the mention's id; the URL half
 * captures nothing, so its presence is what tells the two apart.
 */
const TOKEN_RE = new RegExp(`${URL_RE.source}|${MENTION_RE.source}`, 'gi');

/* ------------------------------------------------------------- content */

/** Links open in the real browser, never inside the app window. */
function openExternal(url: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    window.open(url, '_blank');
  };
}

/** How a `<@id>` becomes a name, supplied by whoever has the member list. */
export interface MentionLookup {
  (id: string): { name: string; self: boolean } | null;
}

export function MessageContent({
  content,
  attachments,
  edited = false,
  lookupMention,
}: {
  content: string;
  attachments: AttachmentDto[];
  /** Adds the small "(edited)" mark, inline at the end of the text. */
  edited?: boolean;
  /**
   * Resolves a tagged id to a name. Omitted — as it is in the update banner
   * and anywhere else without a member list — tags draw as "@unknown" rather
   * than as raw markers.
   */
  lookupMention?: MentionLookup;
}) {
  const parts: React.ReactNode[] = [];
  const embeds: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of content.matchAll(TOKEN_RE)) {
    const whole = match[0];
    const mentionId = match[1];
    const at = match.index ?? 0;

    if (at > last) parts.push(content.slice(last, at));
    last = at + whole.length;

    if (mentionId !== undefined) {
      const who = lookupMention?.(mentionId) ?? null;
      parts.push(
        who ? (
          <Mention key={`m${key++}`} name={who.name} self={who.self} />
        ) : (
          <UnknownMention key={`m${key++}`} />
        ),
      );
      continue;
    }

    const url = whole;
    parts.push(
      <a key={`l${key++}`} className="link" href={url} onClick={openExternal(url)}>
        {url}
      </a>,
    );

    // One embed per message keeps a wall-of-links message readable.
    if (embeds.length === 0) {
      const yt = youtubeId(url);
      const tt = yt ? null : tiktokId(url);
      if (yt) {
        embeds.push(<YouTube key={`y${key}`} id={yt} start={youtubeStart(url)} />);
      } else if (tt) {
        embeds.push(<TikTok key={`t${key}`} id={tt} />);
      } else if (IMAGE_EXT_RE.test(url)) {
        embeds.push(<LinkedImage key={`i${key}`} url={url} />);
      } else if (VIDEO_EXT_RE.test(url)) {
        embeds.push(<LinkedVideo key={`v${key}`} url={url} />);
      }
    }
  }
  if (last < content.length) parts.push(content.slice(last));

  // A message that is nothing but emoji is drawn large. It is not the same
  // kind of message as a paragraph, and at body size it is a line of specks.
  // Read off `content` rather than off `parts`, because a tag or a link in
  // there is exactly what makes it ordinary text again -- and `emojiOnly`
  // says so by finding something that is not an emoji.
  const big = emojiOnly(content);

  return (
    <>
      {(content || edited) && (
        <div className={'msg-content' + (big ? ` big big-${Math.min(big, 3)}` : '')}>
          {parts}
          {edited && <span className="edited"> (edited)</span>}
        </div>
      )}
      {attachments.map((a) =>
        !drawInline(a) ? (
          // Everything that is not a picture or a video: named, sized, and
          // offered as a download. This used to be the "cannot draw this"
          // branch, which was the right answer when pictures were the only
          // thing that could be sent and is the wrong one now that files can.
          <AttachmentFile key={a.id} file={a} />
        ) : isVideo(a) ? (
          <AttachmentVideo key={a.id} file={a} />
        ) : (
          <AttachmentImage key={a.id} file={a} />
        ),
      )}
      {embeds}
    </>
  );
}
