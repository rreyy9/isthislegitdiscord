/**
 * Dates, names and labels for the chat screen.
 *
 * Ported from the desktop client's `components/chat-format.ts` and
 * `mention-utils.ts`, keeping the wording identical wherever both apps show
 * the same thing: two clients against one server that describe the same
 * message two different ways is how people start distrusting one of them.
 *
 * Pure throughout -- values in, strings out, no imports. That is what makes it
 * the part worth testing directly rather than by rendering a screen and
 * looking at it, and it is why the port was mechanical.
 */

/** The server's cap on one message, from `SendMessageInput` in shared. */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * A tag, on the wire: `<@userId>`. One line of the contract in
 * `packages/shared`, copied for the reason the DTOs are. The server validates;
 * this only draws.
 */
export const MENTION_RE = /<@([A-Za-z0-9_-]{1,64})>/g;

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Today and Yesterday by name; anything older gets its date. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const midnight = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(d)) / 86400000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export const sameDay = (a: string, b: string): boolean =>
  new Date(a).toDateString() === new Date(b).toDateString();

/**
 * The character in front of a channel's name. Structurally typed rather than
 * taking a Channel, so this file keeps its no-imports promise.
 */
export function channelIcon(channel: {
  kind: 'TEXT' | 'VOICE';
  listenOnly?: boolean;
}): string {
  if (channel.kind !== 'VOICE') return '#';
  return channel.listenOnly ? '🔇' : '🔊';
}

/** What a person is called. Display name if they set one, handle otherwise. */
export function personName(user: {
  username: string;
  displayName: string | null;
}): string {
  return user.displayName || user.username;
}

/**
 * How long ago somebody was last here, coarser the further back it goes.
 *
 * `now` is passed in rather than read here so every row in one render measures
 * from the same instant, and so the caller controls how often the whole list
 * re-renders.
 */
export function lastSeenLabel(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * Bytes as somebody would say them, matching the wording the server uses when
 * it refuses an upload -- the two numbers get compared by whoever reads them.
 */
export function describeBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    value >= 100 || Number.isInteger(value)
      ? Math.round(value)
      : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

/* ------------------------------------------------------------- mentions */

/** Whether a message tagged this person, for the highlight behind it. */
export function mentionsMe(
  message: { mentions?: string[]; content: string },
  meId: string,
): boolean {
  // `mentions` is resolved and validated by the server and is the answer when
  // it is there. A server older than the field sends none, and then the text
  // is all there is to go on -- which is what this client would have had to do
  // anyway before the field existed.
  if (message.mentions) return message.mentions.includes(meId);
  return textMentions(message.content, meId);
}

function textMentions(content: string, meId: string): boolean {
  for (const m of content.matchAll(MENTION_RE)) {
    if (m[1] === meId) return true;
  }
  return false;
}

/**
 * Whether two messages should be drawn as one block -- same author, close
 * enough in time, same day.
 *
 * Five minutes matches the desktop client. The rule matters more on a phone
 * than it does on a desktop: the screen is a fifth of the width, so a repeated
 * avatar and name above every line costs a third of the visible conversation.
 */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function groupsWith(
  previous: { author: { id: string }; createdAt: string } | undefined,
  message: { author: { id: string }; createdAt: string },
): boolean {
  if (!previous) return false;
  if (previous.author.id !== message.author.id) return false;
  if (!sameDay(previous.createdAt, message.createdAt)) return false;
  const gap =
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return gap >= 0 && gap < GROUP_WINDOW_MS;
}

/**
 * Tags resolved to names, for somewhere there is no room to draw a pill.
 *
 * The reply strip, the pin board's one-line summaries, the tag notice: all
 * three are plain strings in a `<Text numberOfLines={1}>`, and a raw `<@abc123>`
 * sitting in one is an id shown to a human being. Somebody the client cannot
 * identify keeps their marker rather than being blanked -- see `toPlain` in
 * mention-utils, which does the same for the edit box and for the same reason.
 */
export function plainMentions(
  content: string,
  nameFor: (userId: string) => string | null,
): string {
  return content.replace(MENTION_RE, (whole, id: string) => {
    const name = nameFor(id);
    return name ? `@${name}` : whole;
  });
}

/**
 * How long a quoted message reads as one line.
 *
 * The desktop client cuts at 160, where the strip is the width of a window.
 * Here it is the width of a phone, so the same 160 characters is four lines of
 * text that will be clipped to one anyway -- and a four-thousand-character
 * message quoted in full is four thousand characters carried around by a
 * control that shows perhaps fifty of them.
 */
export const QUOTE_LINE_CHARS = 100;

/**
 * A quoted message as a single line: what a reply's strip says, what the
 * "Replying to" bar above the composer says, and what a tag notice previews.
 *
 * Takes text that has already had its tags resolved -- `plainMentions` above --
 * because this file is the one with no knowledge of who anybody is, and keeping
 * it that way is what makes it testable without a member list.
 *
 * The three cases are the three things a quoted message can be. Words win when
 * there are any. A message that was only a screenshot has to say so, or the
 * strip is a blank space that reads as a bug. A deleted one says that instead
 * of nothing, because a reply to nothing looks like a reply that lost its
 * point, and the point is that somebody removed it.
 */
export function quoteLine(
  plainContent: string,
  attachmentCount: number,
  deleted: boolean,
  limit = QUOTE_LINE_CHARS,
): string {
  if (deleted) return 'Message deleted';
  // Newlines and runs of spaces collapse: this is one line, and a quoted
  // message with a blank line in it would otherwise be quoted as a gap.
  const text = plainContent.replace(/\s+/g, ' ').trim();
  if (text) {
    return text.length > limit
      ? `${text.slice(0, limit - 1).trimEnd()}…`
      : text;
  }
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? '📎 Attachment' : `📎 ${attachmentCount} attachments`;
  }
  // Nothing to show and nothing removed. Reachable only for a forwarded
  // message with neither words nor files, which the server refuses to create;
  // a strip saying so beats one that is empty.
  return 'Message';
}

/**
 * One pile of reactions, as this file sees it: structurally the same type as
 * `Reaction` in types.ts, redeclared so this module keeps its no-imports
 * promise. TypeScript asks for nothing more.
 */
export interface ReactionPile {
  emoji: string;
  userIds: string[];
}

/**
 * What the reaction row should look like the instant somebody taps, before the
 * server has said anything.
 *
 * Pure, and here rather than inline in the handler, because the awkward cases
 * are the ones nobody thinks to check by hand: taking back the only reaction in
 * a pile has to remove the pile rather than leave an empty one, and adding an
 * emoji nobody has used yet has to go at the end rather than anywhere that
 * would make the existing piles jump under a thumb already moving towards one.
 *
 * The guess is replaced wholesale by the server's answer a moment later, which
 * is why it can afford to be optimistic: the worst it can be is briefly wrong
 * about somebody else's tap, and that corrects itself.
 */
export function guessReactions(
  reactions: ReactionPile[],
  emoji: string,
  mine: boolean,
  meId: string,
): ReactionPile[] {
  if (mine) {
    return reactions
      .map((r) =>
        r.emoji === emoji
          ? { ...r, userIds: r.userIds.filter((id) => id !== meId) }
          : r,
      )
      // The last person taking theirs back takes the pile with it.
      .filter((r) => r.userIds.length > 0);
  }

  if (reactions.some((r) => r.emoji === emoji)) {
    return reactions.map((r) =>
      // Guarded, because the tap that got here believed it was not mine and two
      // devices can disagree. Adding a second copy of one id would show a count
      // nobody can take back down.
      r.emoji === emoji && !r.userIds.includes(meId)
        ? { ...r, userIds: [...r.userIds, meId] }
        : r,
    );
  }

  // New to the message: at the end, which is where the server will put it too
  // -- piles are ordered by when they were first added.
  return [...reactions, { emoji, userIds: [meId] }];
}

/** "Today at 14:32", "12 March at 09:10". What a message out of order needs. */
export const stamp = (iso: string): string => `${dayLabel(iso)} at ${timeOf(iso)}`;
