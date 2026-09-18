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

/** One run of a message: ordinary text, or somebody's name. */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string; isMe: boolean };

/**
 * Split a message into what should be drawn plainly and what should be drawn
 * as a tag.
 *
 * Returning parts rather than a string, because on this platform a tag is a
 * differently-styled `<Text>` inside the message body rather than a class on a
 * span -- there is no stylesheet to hand it to afterwards.
 *
 * An id with no name is drawn as `@unknown` rather than left as `<@abc123>`.
 * Both are wrong, but one of them reads as a person who has left and the other
 * reads as the app being broken. It happens for real: somebody kicked from the
 * guild is still tagged in every message that tagged them.
 */
export function splitMentions(
  content: string,
  nameFor: (userId: string) => string | null,
  meId: string,
): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;

  // `matchAll` rather than `exec` in a loop: the pattern is module-level and
  // global, so a shared `lastIndex` would make two callers interfere.
  for (const m of content.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: content.slice(last, at) });

    const userId = m[1];
    parts.push({
      kind: 'mention',
      text: `@${nameFor(userId) ?? 'unknown'}`,
      userId,
      isMe: userId === meId,
    });
    last = at + m[0].length;
  }

  if (last < content.length) {
    parts.push({ kind: 'text', text: content.slice(last) });
  }
  // A message that was only a tag produces no trailing text part, and one that
  // was empty produces nothing at all -- which the caller draws as a blank
  // line rather than crashing on `parts[0]`.
  return parts;
}

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
