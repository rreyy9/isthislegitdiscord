/**
 * Turning `:smile:` into 😄.
 *
 * The mirror image of `mention-utils.ts`, and deliberately the opposite
 * decision. A tag travels as `<@id>` because the name it stands for changes --
 * somebody picks a nicer display name and every message that ever tagged them
 * has to say the new one. A codepoint does not change: U+1F604 was U+1F604
 * when it was added and will be in twenty years. So there is nothing to
 * resolve at draw time and nothing to store but the character itself.
 *
 * Everything follows from that:
 *
 * - `MessageContent` needs no emoji pass. The character is already text and
 *   already draws; nothing is added to its token alternation.
 * - A client older than this feature renders an emoji perfectly, because to it
 *   the message is just text. This is the one feature that gets to skip the
 *   "unrecognised content renders as a placeholder" rule, and it skips it by
 *   having nothing to recognise.
 * - The edit box shows 😄, not `:smile:`. There is no `toPlain` inverse here
 *   the way there is for tags, because nothing was encoded on the way out.
 *
 * Everything in this file is pure and takes its data as an argument, for the
 * same reason `mention-utils.ts` takes the member list: the matching is the
 * part that looks right and quietly is not, and it should be testable without
 * loading forty kilobytes of JSON.
 */

/**
 * A shortcode and the emoji it stands for, in the order a picker offers them.
 *
 * An array of pairs rather than a lookup object because the order carries
 * information -- it is CLDR presentation order, which is what puts the common
 * face above the obscure one when two shortcodes match the same query. A
 * caller that wants lookups builds a Map from this once; see `emoji-data.ts`.
 */
export type EmojiPair = readonly [shortcode: string, emoji: string];

/** How a shortcode becomes an emoji, supplied by whoever loaded the data. */
export interface EmojiLookup {
  (shortcode: string): string | undefined;
}

/**
 * What may appear between the colons.
 *
 * Lowercase, digits, and the three punctuation marks gemoji actually uses --
 * `+1`, `-1`, `e-mail`, `thumbs_up`. No uppercase, because no shortcode has
 * any and accepting it would mean a case-folding pass on every keystroke for
 * nothing.
 */
const SHORTCODE_CHAR = /[a-z0-9_+-]/;

/**
 * How far back from a `:` a shortcode is allowed to run.
 *
 * The longest in the GitHub set is under thirty characters. The bound is not
 * really about them -- it is about not re-scanning a paragraph on every
 * keystroke when somebody has typed a colon at the top of it.
 */
const MAX_SHORTCODE_LEN = 36;

/**
 * The shortest query that opens the list.
 *
 * Two, where a tag opens on a bare `@`, and the difference is the whole reason
 * this constant has a name. `@` in ordinary prose is rare enough that the list
 * appearing is nearly always what somebody meant. A colon is not: it is in
 * `12:30`, in `note: this`, and in every URL. `startsToken` throws most of
 * those out on its own -- none of them has a colon at a word boundary -- but
 * a line that genuinely begins with one would otherwise leave a popup hanging
 * over the rest of the sentence, which is the failure `mentionQuery` already
 * warns about.
 */
const MIN_QUERY_LEN = 2;

/**
 * Only at a word boundary, so a time and a URL are never a shortcode.
 *
 * Nearly the same test `mention-utils.ts` applies to `@`, and the reason it is
 * a copy rather than an import is the one character they differ by: a colon
 * counts as a boundary here.
 *
 * That is what makes `:joy::joy:` two emoji instead of one and a leftover.
 * Reading left to right, the second shortcode opens on the closing colon of
 * the first, so without it the second is refused for sitting next to
 * punctuation -- which is the punctuation it was given by the emoji before it.
 * It costs nothing elsewhere: every case this rule exists to reject (`12:30`,
 * `note:`, `https://`) has a letter or a digit before the colon, not another
 * colon.
 */
function startsToken(text: string, at: number): boolean {
  return at === 0 || /[\s:([{"'`]/.test(text[at - 1]);
}

/* ------------------------------------------------------------- the picker */

export interface EmojiQuery {
  /** Index of the opening `:`, so the replacement knows what to overwrite. */
  start: number;
  /** What has been typed after it, never containing a colon or a space. */
  query: string;
}

/**
 * The shortcode being typed at the caret, if there is one.
 *
 * Returns null the moment the thing being typed stops looking like a
 * shortcode, which is what closes the list without anything having to decide
 * to close it. A closing colon does that too: `:smile:` has no open query at
 * its end, so the list is gone by the time the word is finished and `toEmoji`
 * is what converts it on the way out.
 */
export function emojiQuery(text: string, caret: number): EmojiQuery | null {
  const from = Math.max(0, caret - MAX_SHORTCODE_LEN);
  const before = text.slice(from, caret);
  const colon = before.lastIndexOf(':');
  if (colon < 0) return null;

  const start = from + colon;
  if (!startsToken(text, start)) return null;

  const query = text.slice(start + 1, caret);
  if (query.length < MIN_QUERY_LEN) return null;
  // One bad character ends it. A shortcode has no spaces and no second colon,
  // so anything else means this colon was punctuation after all.
  for (const ch of query) {
    if (!SHORTCODE_CHAR.test(ch)) return null;
  }
  return { start, query };
}

export interface EmojiMatch {
  shortcode: string;
  emoji: string;
}

/**
 * What the list should offer for a query, best first.
 *
 * Prefix beats substring, exactly as `matchUsers` scores a name: somebody
 * typing `:smi` means a shortcode that starts that way, and one that merely
 * contains it is a guess. Within a score the data's own order decides, which
 * is CLDR presentation order -- so `:smile:` comes above `:smiling_imp:`
 * without anything here knowing which is more common.
 *
 * The same emoji reached by two names is offered once. `:+1:` and `:thumbsup:`
 * are one picture, and two identical rows in a list of eight is a wasted row.
 */
export function matchEmoji(
  pairs: readonly EmojiPair[],
  query: string,
  limit = 8,
): EmojiMatch[] {
  const q = query.toLowerCase();
  if (!q) return [];

  const exact: EmojiMatch[] = [];
  const prefix: EmojiMatch[] = [];
  const contains: EmojiMatch[] = [];
  const seen = new Set<string>();

  for (const [shortcode, emoji] of pairs) {
    if (seen.has(emoji)) continue;

    // An exact hit is not a guess at all, and it has to outrank a prefix or
    // typing `:eyes` in full would offer `:eyeglasses:` above `:eyes:`.
    if (shortcode === q) {
      exact.push({ shortcode, emoji });
    } else if (shortcode.startsWith(q)) {
      prefix.push({ shortcode, emoji });
    } else if (shortcode.includes(q)) {
      contains.push({ shortcode, emoji });
    } else {
      continue;
    }
    seen.add(emoji);

    // Enough of every bucket to fill the list even if the better ones turn out
    // empty, without walking two thousand rows for a query that matches half
    // of them.
    if (exact.length + prefix.length >= limit && contains.length >= limit) break;
  }

  return [...exact, ...prefix, ...contains].slice(0, limit);
}

/**
 * Put a chosen emoji into the draft, and say where the caret goes after it.
 *
 * No trailing space, which is where this parts company with `applyMention`. A
 * name needs one because the space is the separator the matcher looks for when
 * it converts names to markers on the way out; an emoji is its own boundary,
 * and a forced space would make `👍👍` impossible to type from the list.
 */
export function applyEmoji(
  text: string,
  query: EmojiQuery,
  emoji: string,
): { text: string; caret: number } {
  const tail = text.slice(query.start + 1 + query.query.length);
  return {
    text: text.slice(0, query.start) + emoji + tail,
    caret: query.start + emoji.length,
  };
}

/* ------------------------------------------------------------ on render */

/**
 * Whether a message is nothing but emoji, and how many.
 *
 * A message of two hearts and no words is not the same kind of message as a
 * paragraph, and drawing it at the size of body text buries it. Discord draws
 * these large; so does everything else people have used, which makes the
 * absence of it read as a bug rather than as restraint.
 *
 * Null for everything else, including a message with one word in it, so the
 * caller is deciding on an answer rather than on a count that might be zero.
 *
 * Capped, and the cap is the point: a hundred emoji drawn at thirty-two pixels
 * is a message that takes over the channel, which is exactly what somebody
 * pasting a hundred emoji is trying to do.
 *
 * `\p{RGI_Emoji}` is the same property the server validates a reaction with
 * (see `canonicalEmoji` in packages/shared), so the two agree on what an emoji
 * is. It needs the `v` flag, which is why this app targets ES2024.
 */
export function emojiOnly(content: string, max = 27): number | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Out before the scanning starts, because this runs for every message in the
  // list on every render and the two passes below are not free on a four
  // thousand character message.
  //
  // Twenty units an emoji, which is loose on purpose. The longest sequence in
  // Unicode 17 is a kiss with two skin tones at fifteen UTF-16 units, and a
  // bound that only just cleared it would turn the next long sequence somebody
  // adds into a message that quietly stops drawing large. What this has to be
  // is small enough to reject a paragraph, and five hundred characters is.
  if (trimmed.length > max * 20) return null;

  // Anything left after the emoji are taken out, other than whitespace, means
  // this is ordinary text that happens to contain one.
  if (/\S/.test(trimmed.replace(/\p{RGI_Emoji}/gv, ''))) return null;

  let count = 0;
  for (const _ of trimmed.matchAll(/\p{RGI_Emoji}/gv)) {
    count += 1;
    if (count > max) return null;
  }
  return count > 0 ? count : null;
}

/* -------------------------------------------------------------- on send */

/**
 * Rewrite every complete `:shortcode:` in a draft as the emoji it names.
 *
 * The counterpart to `toMarkup`, run once on the way out, and the reason the
 * list is a convenience rather than the only way in: somebody who knows the
 * name types it in full, presses Enter, and gets the picture. It is also what
 * catches a shortcode pasted in from somewhere else.
 *
 * A name nothing answers to is left exactly as it was typed. `:-)` and `10:30`
 * are not shortcodes and must survive; so must `:notanemoji:`, because
 * silently deleting text somebody wrote is worse than leaving it.
 *
 * Hand-scanned rather than a regex with a lookbehind, so the word-boundary
 * rule is the same function `emojiQuery` uses rather than a second spelling of
 * it that can drift.
 */
export function toEmoji(text: string, lookup: EmojiLookup): string {
  if (!text.includes(':')) return text;

  let out = '';
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf(':', i);
    if (open < 0) break;

    if (!startsToken(text, open)) {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }

    // Walk the name, stopping at the closing colon or at the first character
    // that cannot be in one.
    let end = open + 1;
    while (
      end < text.length &&
      end - open <= MAX_SHORTCODE_LEN &&
      SHORTCODE_CHAR.test(text[end])
    ) {
      end += 1;
    }

    const name = text.slice(open + 1, end);
    const emoji = text[end] === ':' && name.length >= MIN_QUERY_LEN
      ? lookup(name)
      : undefined;

    if (emoji === undefined) {
      // Not a shortcode. Copy the colon and carry on from just after it --
      // never from `end`, or the closing colon of `:a::smile:` would be
      // skipped along with the opening one it shares.
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }

    out += text.slice(i, open) + emoji;
    i = end + 1;
  }

  return out + text.slice(i);
}
