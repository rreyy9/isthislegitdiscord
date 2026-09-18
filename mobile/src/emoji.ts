/**
 * Emoji, as much of them as a phone needs.
 *
 * The desktop client carries two generated tables -- a 39 KB shortcode map it
 * consults on every keystroke after a colon, and a 200 KB catalogue it loads on
 * demand for the browse picker. Neither is here, and that is a decision.
 *
 * On a phone the system keyboard already has every emoji in Unicode, sorted,
 * searchable, and with the ones this person actually uses at the front. An app
 * that shipped its own two-thousand-entry picker on top of that would be
 * offering a worse copy of a control the platform gives away -- and paying 240
 * KB of bundle for it. What the keyboard cannot do is put a reaction on a
 * message, because a reaction is not text being typed; so what is here is the
 * short list a reaction picker needs, and nothing else.
 *
 * There is no `:shortcode:` expansion either, for the same reason: nobody types
 * `:smile:` on a soft keyboard when the emoji key is next to the space bar.
 */

/* ---------------------------------------------------------- big emoji */

/**
 * Whether a message is nothing but emoji, and how many.
 *
 * A message of two hearts and no words is not the same kind of message as a
 * paragraph, and drawing it at body size buries it. Null for everything else,
 * including a message with one word in it, so the caller is deciding on an
 * answer rather than on a count that might be zero.
 *
 * The desktop version tests `\p{RGI_Emoji}` with the `v` flag, which is the
 * same property the server validates a reaction with. That is the better test
 * and it is not used here: `v`-mode properties-of-strings are an ES2024 feature
 * and Hermes is not a browser engine on a release cadence anybody controls. A
 * regex that throws at parse time takes the whole bundle with it, and it would
 * do so on exactly the devices least likely to be tested on.
 *
 * So this walks code points against the emoji blocks instead. It is coarser --
 * it will accept a handful of non-emoji dingbats -- and the cost of being wrong
 * is that a message is drawn slightly too large. That is the right direction to
 * be wrong in.
 */
export function emojiOnly(content: string, max = 12): number | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Out before the scanning starts: this runs for every message in the list on
  // every render, and walking a four-thousand-character paragraph to conclude
  // it is a paragraph is not free. Twenty UTF-16 units an emoji is loose on
  // purpose -- the longest sequence in Unicode today is fifteen.
  if (trimmed.length > max * 20) return null;

  let count = 0;
  /** The last thing seen was a zero-width joiner, so the next emoji continues
   *  the same cluster rather than starting one: 👨‍👩‍👧 is one face, not three. */
  let joined = false;
  /** One regional indicator has been seen and is waiting for its pair. */
  let pendingPair = false;

  // `for..of` iterates code points, not UTF-16 units, which is the whole reason
  // it is used here -- indexing would split every emoji above the BMP in half.
  for (const char of trimmed) {
    const cp = char.codePointAt(0)!;

    if (isWhitespace(cp)) {
      joined = false;
      pendingPair = false;
      continue;
    }
    if (cp === 0x200d) {
      joined = true;
      continue;
    }
    // A variation selector, a skin tone or a flag tag. None of them starts an
    // emoji or ends a cluster; they modify the one already counted.
    if (isModifier(cp)) continue;

    if (!isEmoji(cp)) return null;

    if (joined) {
      // Part of the cluster already counted.
      joined = false;
      pendingPair = false;
      continue;
    }

    if (isRegionalIndicator(cp)) {
      // A flag is two of these. The first is counted and the second is not.
      if (pendingPair) {
        pendingPair = false;
        continue;
      }
      pendingPair = true;
    } else {
      pendingPair = false;
    }

    count += 1;
    // Capped, and the cap is the point: a hundred emoji drawn large is a
    // message that takes over the channel, which is exactly what somebody
    // pasting a hundred emoji is trying to do.
    if (count > max) return null;
  }

  return count > 0 ? count : null;
}

const isWhitespace = (cp: number): boolean =>
  cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0xa0;

/** Everything that attaches to the emoji before it rather than starting one. */
const isModifier = (cp: number): boolean =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
  (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin tone modifiers
  (cp >= 0xe0020 && cp <= 0xe007f) || // tag characters, for subdivision flags
  cp === 0x20e3; // combining enclosing keycap

const isRegionalIndicator = (cp: number): boolean =>
  cp >= 0x1f1e6 && cp <= 0x1f1ff;

/**
 * The blocks emoji actually live in.
 *
 * Deliberately a list of ranges rather than one wide test: `0x2000-0x3000`
 * would take in every piece of typographic punctuation, and a message of three
 * em-dashes would be drawn at thirty-two pixels.
 *
 * ASCII digits are **not** here, which means a keycap emoji -- `1️⃣`, which is
 * the digit one, a variation selector and a combining keycap -- is read as
 * ordinary text and drawn at body size. That is a known miss, taken knowingly:
 * admitting digits would make "2024" a message of four large emoji, and being
 * wrong about a year is worse than being wrong about a keycap.
 */
const isEmoji = (cp: number): boolean =>
  (cp >= 0x1f300 && cp <= 0x1faff) || // the main emoji planes
  (cp >= 0x1f000 && cp <= 0x1f0ff) || // mahjong, dominoes, cards
  (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators
  (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols and dingbats
  (cp >= 0x2b00 && cp <= 0x2bff) || // arrows and geometric shapes
  (cp >= 0x2190 && cp <= 0x21ff) || // arrows
  (cp >= 0x2900 && cp <= 0x297f) ||
  (cp >= 0x3297 && cp <= 0x3299) ||
  cp === 0x00a9 || // ©
  cp === 0x00ae || // ®
  cp === 0x203c || // ‼
  cp === 0x2049 || // ⁉
  cp === 0x2122 || // ™
  cp === 0x2139; // ℹ

/* -------------------------------------------------------- the reactions */

/**
 * The row offered without opening anything.
 *
 * Six, because that is what fits across a phone at a size a thumb can hit, and
 * because a longer row is a menu rather than a shortcut. These are the ones
 * that get used; anything else is two taps away in the picker below.
 */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

/** One page of the reaction picker. */
export interface EmojiGroup {
  label: string;
  emoji: string[];
}

/**
 * What the picker offers.
 *
 * Hand-picked rather than generated, and short on purpose: this is the list
 * somebody scrolls with a thumb while deciding whether a message deserves a
 * face. Two thousand entries is a search problem; a hundred and sixty is a
 * glance.
 */
export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    label: 'Smileys',
    emoji: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
      '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
      '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
      '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
      '🥵', '🥶', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕',
      '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨',
      '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩',
      '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '💩',
      '🤡', '👻', '👽', '🤖',
    ],
  },
  {
    label: 'Gestures',
    emoji: [
      '👍', '👎', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙',
      '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋',
      '🤝', '🙏', '✍️', '💪', '🦾', '👏', '🙌', '👐', '🤲', '🫶',
    ],
  },
  {
    label: 'Hearts & symbols',
    emoji: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '💢',
      '💥', '💫', '💦', '💨', '🕳️', '💬', '🗯️', '💭', '💤', '✅',
      '❌', '❗', '❓', '⚠️', '🚫', '🔥', '⭐', '🌟', '✨', '⚡',
    ],
  },
  {
    label: 'Things',
    emoji: [
      '🎉', '🎊', '🎁', '🏆', '🥇', '🎯', '🎮', '🎲', '🎵', '🎶',
      '📌', '📎', '🔗', '🔒', '🔑', '💻', '🖥️', '📱', '⌨️', '🖱️',
      '💾', '📷', '🎥', '📺', '☕', '🍕', '🍔', '🍟', '🌮', '🍺',
      '🍻', '🥂', '🍾', '🎂', '🍪', '🍩', '🚀', '✈️', '🚗', '🏠',
    ],
  },
];
