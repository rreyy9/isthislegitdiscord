import { Avatar } from './Avatar';
import { mentionName, type MentionUser } from '../mention-utils';
import type { EmojiMatch } from '../emoji-utils';

/**
 * The two lists that open under the composer while you are typing.
 *
 * One file because they are one control wearing two labels: the same box, in
 * the same place, opened by a different character, dismissed the same way and
 * navigated with the same keys. Written apart they would drift into two
 * presentations of one idea, which is the argument that already keeps
 * `SearchPanel` and `PinsPanel` together.
 *
 * Both are handed their matches and their selected index rather than working
 * either out: the composer owns the draft and the caret, and a picker that
 * reached for those would need the composer's closure to do it.
 */

/**
 * The list that opens when you type `@`.
 *
 * Sits in the composer's own box rather than at the caret. A popup that
 * follows the caret needs the text measured to know where that is, which for a
 * textarea means rendering a mirror of it off-screen — a lot of machinery for
 * a box that is two lines tall, where the caret is never far from the left.
 *
 * `onMouseDown` rather than `onClick`, because clicking here blurs the
 * textarea and the blur closes the list: the click would land on nothing.
 */
export function MentionPicker({
  matches,
  index,
  onHover,
  onPick,
}: {
  matches: MentionUser[];
  index: number;
  onHover: (index: number) => void;
  onPick: (user: MentionUser) => void;
}) {
  return (
    <div className="mention-picker">
      <div className="mention-picker-head">Members</div>
      {matches.map((user, i) => (
        <button
          key={user.id}
          className={'mention-row' + (i === index ? ' on' : '')}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(user);
          }}
        >
          <Avatar
            className="tiny"
            name={mentionName(user)}
            image={user.image}
          />
          <span className="mention-row-name">{mentionName(user)}</span>
          {/* Only when it says something the name does not, which is how you
              tell two people apart who have picked the same display name. */}
          {user.displayName && user.displayName !== user.username && (
            <span className="mention-row-handle">{user.username}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The list that opens when you type `:` and two more characters.
 *
 * The same box as the tag list above, in the same place, with the same
 * `onMouseDown` rather than `onClick` -- a click blurs the textarea, the blur
 * closes the list, and an `onClick` would land on nothing.
 *
 * Two characters before it opens, where a tag opens on a bare `@`. A colon is
 * ordinary punctuation in a way `@` is not, and the reasoning is in
 * `emoji-utils.ts` beside the constant.
 */
export function EmojiPicker({
  matches,
  index,
  onHover,
  onPick,
}: {
  matches: EmojiMatch[];
  index: number;
  onHover: (index: number) => void;
  onPick: (match: EmojiMatch) => void;
}) {
  return (
    <div className="mention-picker">
      <div className="mention-picker-head">Emoji</div>
      {matches.map((match, i) => (
        <button
          key={match.shortcode}
          className={'mention-row' + (i === index ? ' on' : '')}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(match);
          }}
        >
          <span className="emoji-row-glyph">{match.emoji}</span>
          <span className="mention-row-name">:{match.shortcode}:</span>
        </button>
      ))}
    </div>
  );
}
