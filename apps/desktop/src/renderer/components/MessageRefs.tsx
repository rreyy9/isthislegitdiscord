import type { MessageDto, MessageRefDto } from '../api';
import { Avatar } from './Avatar';
import { MessageContent } from './MessageContent';
import { quoteLine, stamp } from './chat-format';
import { toPlain } from '../mention-utils';

/**
 * The two ways one message shows another: the strip above a reply, and the
 * card inside a forward.
 *
 * They are together because they draw the same object -- a `MessageRefDto`,
 * which is one type for both for the same reason -- and because keeping them
 * side by side is what stops "a quoted message" turning into two unrelated
 * presentations of one idea. That is the argument that put `SearchPanel` and
 * `PinsPanel` in one file, and it applies here twice over.
 *
 * Both take `lookupMention` rather than the member list, because that is all
 * either of them needs to turn `<@id>` into a name -- and a component holding
 * the whole roster would redraw every time anybody went offline.
 */

type Lookup = (id: string) => { name: string; self: boolean } | null;

/**
 * A message this client already holds, as the quote of it the server would
 * have sent.
 *
 * For the optimistic copy of a reply, which has to draw its strip before there
 * is anything to draw it from: the echo arrives a moment later carrying the
 * real thing, derived from the database, and replaces the whole row. This only
 * fills that moment, which is why it is a conversion and not a second source
 * of truth.
 */
export function toRef(m: MessageDto): MessageRefDto {
  return {
    id: m.id,
    channelId: m.channelId,
    author: m.author,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    attachments: m.attachments,
    // Nothing deleted is in the list to be replied to in the first place.
    deleted: false,
  };
}

/**
 * Tags become names before anything measures or truncates the line.
 *
 * `toPlain` asks for a whole `MentionUser` and uses one field of it, so the
 * name from `lookupMention` is handed over as the username -- which is what
 * `mentionName` falls back to. That is one lookup for this file instead of
 * two nearly identical ones, and it is the same answer either way.
 */
function plainOf(ref: MessageRefDto, lookupMention: Lookup): string {
  return toPlain(ref.content, (id) => {
    const found = lookupMention(id);
    return found ? { id, username: found.name, displayName: null } : null;
  });
}

/**
 * One message with its quote of `changedId` brought up to date, or unchanged
 * if it does not quote it.
 *
 * A quote is a copy of another message taken when the list was loaded, so
 * editing or deleting the original leaves every reply and forward on screen
 * still showing what it used to say. The server has it right on the next load;
 * this is what keeps the open channel honest in between.
 *
 * `next` is the new quote, or null when the original was deleted -- which
 * blanks the content and sets `deleted`, exactly as the server would have.
 */
export function requoted<T extends MessageDto>(
  m: T,
  changedId: string,
  next: MessageRefDto | null,
): T {
  const gone = (ref: MessageRefDto): MessageRefDto => ({
    ...ref,
    content: '',
    attachments: [],
    deleted: true,
  });
  const patch = (ref: MessageRefDto | null | undefined) =>
    ref && ref.id === changedId ? (next ?? gone(ref)) : ref;

  const replyTo = patch(m.replyTo);
  const forwardedFrom = patch(m.forwardedFrom);
  // Returned as-is when nothing moved, so the list's identity check still
  // holds and React redraws only what actually changed.
  if (replyTo === m.replyTo && forwardedFrom === m.forwardedFrom) return m;
  return { ...m, replyTo, forwardedFrom };
}

/**
 * The one line above a reply saying what it answers.
 *
 * A button, because it goes somewhere: clicking it lands on the original,
 * wherever that is in the channel's history. That is half of what replying is
 * for -- a conversation eight messages deep is unreadable if following it
 * means scrolling and guessing.
 *
 * Truncated to one line and never more. The strip is context, not a second
 * copy of the message; anybody who wants the whole thing clicks it.
 */
export function ReplyStrip({
  refMsg,
  lookupMention,
  onJump,
}: {
  refMsg: MessageRefDto;
  lookupMention: Lookup;
  onJump: () => void;
}) {
  const who = refMsg.author.displayName || refMsg.author.username;
  const line = quoteLine(
    plainOf(refMsg, lookupMention),
    refMsg.attachments.length,
    refMsg.deleted,
  );

  // A deleted original has nowhere to go, so it is not a button. Still drawn,
  // because a reply whose strip vanished would read as an answer to nothing --
  // the strip is exactly what says that something was there and was removed.
  if (refMsg.deleted) {
    return (
      <div className="reply-strip gone">
        <span className="reply-hook" aria-hidden />
        <span className="reply-line">Original message was deleted</span>
      </div>
    );
  }

  return (
    <button
      className="reply-strip"
      title={`Go to ${who}'s message`}
      onClick={onJump}
    >
      <span className="reply-hook" aria-hidden />
      <Avatar name={who} image={refMsg.author.image} />
      <span className="reply-who">{who}</span>
      <span className="reply-line">{line}</span>
    </button>
  );
}

/**
 * A message carried in from another channel.
 *
 * Drawn as itself -- the original's author, words and files -- rather than as
 * text copied into the forwarder's message. That is the whole reason a forward
 * is a pointer in the database: what somebody said arrives under their own
 * name, and nobody can pass on a version of it that they never wrote.
 *
 * The header is the link, not the whole card. The body holds real content,
 * where clicking a picture opens it and clicking a link follows it, and a card
 * that navigated out from under those would take the click that was meant for
 * them.
 */
export function ForwardCard({
  refMsg,
  channelName,
  lookupMention,
  onJump,
}: {
  refMsg: MessageRefDto;
  /** Where it came from. Null when this client does not know that channel. */
  channelName: string | null;
  lookupMention: Lookup;
  onJump: () => void;
}) {
  const who = refMsg.author.displayName || refMsg.author.username;

  if (refMsg.deleted) {
    return (
      <div className="fwd-card gone">
        <div className="fwd-head">
          <span className="fwd-mark" aria-hidden>
            ↪
          </span>
          Forwarded
        </div>
        <div className="fwd-gone">That message has since been deleted.</div>
      </div>
    );
  }

  return (
    <div className="fwd-card">
      <button className="fwd-head" title="Go to the original" onClick={onJump}>
        <span className="fwd-mark" aria-hidden>
          ↪
        </span>
        Forwarded{channelName ? ` from #${channelName}` : ''}
      </button>
      <div className="fwd-body">
        <Avatar name={who} image={refMsg.author.image} />
        <div className="fwd-text">
          <div className="msg-head">
            <span className="msg-author">{who}</span>
            <span className="msg-time">{stamp(refMsg.createdAt)}</span>
          </div>
          <MessageContent
            content={refMsg.content}
            attachments={refMsg.attachments}
            edited={Boolean(refMsg.editedAt)}
            lookupMention={lookupMention}
          />
        </div>
      </div>
    </div>
  );
}
