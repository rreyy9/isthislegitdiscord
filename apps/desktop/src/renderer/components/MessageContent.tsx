import { useEffect, useState } from 'react';
import { attachmentUrl, type AttachmentDto } from '../api';
import { IMAGE_EXT_RE, URL_RE, youtubeId, youtubeStart } from '../link-utils';
import { MENTION_RE } from '../mention-utils';
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
          {...imageProps({ src, name: file.fileName })}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------ forward compat */

/**
 * Something this build cannot draw.
 *
 * The server adds fields and events; it never renames or removes them, so an
 * older client keeps working and simply does not see what is new. That covers
 * almost everything -- but not the case where a message *has* content this
 * build has no idea how to render. Drawing nothing there is a lie about what
 * was said, so it says so instead.
 *
 * One branch, written once, covers every future case: anything unrecognised
 * lands here rather than needing its own handling in the version that predates
 * it.
 */
function Unrenderable({ what }: { what: string }) {
  return (
    <div className="attach-failed">
      This message has {what} this version cannot show — update to see it.
    </div>
  );
}

/** The types this build knows how to put on screen. */
const RENDERABLE = /^image\/(png|jpeg|gif|webp)$/i;

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
      if (yt) {
        embeds.push(<YouTube key={`y${key}`} id={yt} start={youtubeStart(url)} />);
      } else if (IMAGE_EXT_RE.test(url)) {
        embeds.push(<LinkedImage key={`i${key}`} url={url} />);
      }
    }
  }
  if (last < content.length) parts.push(content.slice(last));

  return (
    <>
      {(content || edited) && (
        <div className="msg-content">
          {parts}
          {edited && <span className="edited"> (edited)</span>}
        </div>
      )}
      {attachments.map((a) =>
        RENDERABLE.test(a.contentType) ? (
          <AttachmentImage key={a.id} file={a} />
        ) : (
          // A newer server accepting a file type this build was never taught
          // to draw. Naming it beats an empty space where a file should be.
          <Unrenderable key={a.id} what={`a ${a.contentType} attachment`} />
        ),
      )}
      {embeds}
    </>
  );
}
