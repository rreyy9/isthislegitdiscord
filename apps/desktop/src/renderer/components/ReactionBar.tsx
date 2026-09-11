import type { ReactionDto } from '../api';

/**
 * The row of reaction piles under a message.
 *
 * Drawn by the message list rather than by `MessageContent`, and that is a
 * decision rather than an accident: the pin board and the search results draw
 * message content too, and neither should carry reactions. Both are reading
 * lists -- you open one to find a message and then jump to it -- so a count
 * sitting in one is a number nobody can click and nothing refreshes. Putting
 * this here makes "not there" the default instead of something to remember to
 * suppress in two places.
 *
 * Nothing in here knows how to react. It is handed the piles and a callback,
 * which is what lets the same component sit under a message in the list and
 * under one anywhere else it is ever wanted.
 */
export function ReactionBar({
  reactions,
  meId,
  lookupName,
  onToggle,
}: {
  reactions: ReactionDto[];
  meId: string;
  /** A user id to a name, for the tooltip. Null for somebody who has left. */
  lookupName: (id: string) => string | null;
  onToggle: (emoji: string, mine: boolean) => void;
}) {
  if (reactions.length === 0) return null;

  return (
    <div className="reactions">
      {reactions.map((r) => {
        const mine = r.userIds.includes(meId);
        return (
          <button
            key={r.emoji}
            className={'reaction' + (mine ? ' mine' : '')}
            title={describe(r, meId, lookupName)}
            onClick={() => onToggle(r.emoji, mine)}
          >
            <span className="reaction-glyph">{r.emoji}</span>
            <span className="reaction-count">{r.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Alice, Bob and you reacted with 👍".
 *
 * The whole reason the wire format carries ids rather than a count: a number
 * on its own cannot say who, and who is most of what anybody wants from a
 * reaction on a message they did not write.
 *
 * "You" comes last however early it was added. It is the one name the reader
 * already knows, so it is the one that should not be in the way of the others.
 */
function describe(
  reaction: ReactionDto,
  meId: string,
  lookupName: (id: string) => string | null,
): string {
  const names = reaction.userIds
    .filter((id) => id !== meId)
    // Somebody who has since left the guild. Named rather than dropped, so the
    // count and the list cannot disagree about how many people are in it.
    .map((id) => lookupName(id) ?? 'someone who has left');
  if (reaction.userIds.includes(meId)) names.push('you');

  const joined =
    names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  return `${joined} reacted with ${reaction.emoji}`;
}
