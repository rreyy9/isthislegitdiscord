/**
 * Dates, sizes and labels for the chat screen.
 *
 * Pulled out of Chat.tsx, which had grown past 3,800 lines and held these
 * alongside the message list, the composer, moderation and every modal. They
 * come out first because they are the part with no React in them at all: pure
 * string in, string out, and so the part that can be tested directly rather
 * than by rendering a screen and looking at it.
 */

/**
 * The server's cap on one message, from `SendMessageInput` in
 * `@isthislegit/shared`.
 *
 * Copied rather than imported for the reason given in mention-utils.ts: the
 * renderer is an ESM bundle and nothing in that CommonJS package is imported
 * at runtime. The server is still the side that enforces it -- this is only so
 * the composer can say which limit was passed and by how much, instead of
 * sending something that comes back a bare 400.
 */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * Bytes as somebody would say them, matching the wording the server uses when
 * it refuses an upload -- the two numbers are compared by whoever reads them,
 * so they have to be written the same way.
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
    value >= 100 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

export function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** Today and Yesterday by name; anything older gets its date. */
export function dayLabel(iso: string) {
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
export const sameDay = (a: string, b: string) =>
  new Date(a).toDateString() === new Date(b).toDateString();
/**
 * "Today at 14:32", "12 March at 09:10". The pin board is read out of order
 * by definition — the whole list is old messages — so every row there has to
 * carry its own date rather than lean on a separator above it.
 */
export const stamp = (iso: string) => `${dayLabel(iso)} at ${timeOf(iso)}`;

/**
 * The character in front of a channel's name, everywhere one is drawn.
 *
 * Three places wanted it -- the sidebar, the chat header and the right-click
 * menu -- and while it was a ternary in each of them it was only ever going to
 * be two of the three that learned about a new kind of channel. The crossed-out
 * speaker is the AFK room, and it has to be legible in the sidebar without
 * hovering: that list is where somebody decides which channel to click.
 *
 * Structurally typed rather than taking a ChannelDto, so this file stays what
 * its header says it is: values in, string out, no imports.
 */
export function channelIcon(channel: {
  kind: 'TEXT' | 'VOICE';
  listenOnly?: boolean;
}): string {
  if (channel.kind !== 'VOICE') return '#';
  return channel.listenOnly ? '🔇' : '🔊';
}

/**
 * An indefinite mute is stored as a date in the year 9999, so that every check
 * is one comparison. Nobody wants to read that date, hence this.
 */
export const isForever = (iso: string) => new Date(iso).getFullYear() > 9000;

/**
 * What a mute says. "Microphone", explicitly, every time it is written: the
 * word "muted" on its own reads as "silenced everywhere", which is what this
 * used to do and no longer does.
 */
export function muteLabel(iso: string) {
  if (isForever(iso)) return 'Microphone muted indefinitely';
  const d = new Date(iso);
  const sameDayAsNow = d.toDateString() === new Date().toDateString();
  return `Microphone muted until ${
    sameDayAsNow
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
  }`;
}

/**
 * How long ago somebody was last here, in the smallest number of characters
 * that answers the question.
 *
 * Coarse on purpose, and coarser the further back it goes: under a name in a
 * narrow column, "2h" is the whole of what anyone wants to know, and the exact
 * minute of an absence three days old is noise. Anything past a week stops
 * being a duration and becomes a date, because "23d" is not something people
 * read as a length of time.
 *
 * `now` is passed in rather than read here so that every row in one render
 * measures from the same instant, and so the caller controls how often the
 * whole column re-renders.
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
 * How long a quoted message reads as one line.
 *
 * The strip above a reply is one line high whatever is in it, so the CSS would
 * clip a long message anyway. The cut is made here as well because the same
 * string goes into a `title` and into the bar above the composer, where there
 * is no line to clip against — and because a four-thousand-character message
 * quoted in full is four thousand characters carried around by a control that
 * shows forty of them.
 */
export const QUOTE_LINE_CHARS = 160;

/**
 * A quoted message as a single line: what a reply's strip says, and what the
 * "Replying to" bar above the composer says.
 *
 * Takes text that has already had its tags resolved to names — `toPlain` in
 * mention-utils does that — because this file is the one with no knowledge of
 * who anybody is, and keeping it that way is what makes it testable without a
 * member list.
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
): string {
  if (deleted) return 'Message deleted';
  // Newlines and runs of spaces collapse: this is one line, and a quoted
  // message with a blank line in it would otherwise be quoted as a gap.
  const text = plainContent.replace(/\s+/g, ' ').trim();
  if (text) {
    return text.length > QUOTE_LINE_CHARS
      ? `${text.slice(0, QUOTE_LINE_CHARS - 1).trimEnd()}…`
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
 * One pile of reactions: the emoji, and everyone who added it.
 *
 * Declared here rather than imported from `../api` so this module stays what
 * it is -- pure functions over plain data, with nothing that reaches the
 * network in its import graph. It is structurally the same type, which is all
 * TypeScript asks.
 */
export interface ReactionPile {
  emoji: string;
  userIds: string[];
}

/**
 * What the reaction row should look like the instant somebody clicks, before
 * the server has said anything.
 *
 * Pure, and here rather than inline in the click handler, because the awkward
 * cases are the ones nobody thinks to check by hand: taking back the only
 * reaction in a pile has to remove the pile rather than leave an empty one,
 * and adding an emoji nobody has used yet has to put it at the end rather than
 * anywhere that would make the existing piles jump.
 *
 * The guess is replaced wholesale by the server's answer a moment later, which
 * is why this can afford to be optimistic: the worst it can be is briefly
 * wrong about somebody else's click, and that corrects itself.
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
      // Guarded, because the click that got here believed it was not mine and
      // two windows can disagree. Adding a second copy of one id would show a
      // count nobody can take back down.
      r.emoji === emoji && !r.userIds.includes(meId)
        ? { ...r, userIds: [...r.userIds, meId] }
        : r,
    );
  }

  // New to the message: at the end, which is where the server will put it too
  // -- piles are ordered by when they were first added.
  return [...reactions, { emoji, userIds: [meId] }];
}
