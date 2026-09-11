import { describe, expect, it } from 'vitest';
import { canonicalEmoji } from './index';

/**
 * The rule that decides what may sit in `MessageReaction.emoji`, and what
 * spelling it sits there in.
 *
 * Worth its own file because it is the one piece of validation between a URL
 * anybody can construct and a column everybody in the channel reads, and
 * because the variation-selector half of it is not guessable -- see the note
 * on `canonicalEmoji`.
 */

describe('canonicalEmoji', () => {
  it('accepts an ordinary emoji', () => {
    expect(canonicalEmoji('👍')).toBe('👍');
    expect(canonicalEmoji('😂')).toBe('😂');
    expect(canonicalEmoji('🎉')).toBe('🎉');
  });

  it('accepts sequences, not just single codepoints', () => {
    expect(canonicalEmoji('👋🏽')).toBe('👋🏽');
    expect(canonicalEmoji('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
    expect(canonicalEmoji('🇬🇧')).toBe('🇬🇧');
    expect(canonicalEmoji('🏴‍☠️')).toBe('🏴‍☠️');
  });

  it('settles on one spelling whichever way it arrives', () => {
    // The whole reason this function exists. Without it, two clients sending
    // what looks like the same emoji make two piles on one message.
    expect(canonicalEmoji('👍')).toBe(canonicalEmoji('👍️'));
    expect(canonicalEmoji('❤')).toBe(canonicalEmoji('❤️'));
  });

  it('drops the selector from an emoji that does not want one', () => {
    // 1F44D is emoji-presentation already; RGI refuses it *with* U+FE0F.
    expect(canonicalEmoji('👍️')).toBe('👍');
    expect([...canonicalEmoji('👍️')!].length).toBe(1);
  });

  it('keeps or adds the selector on one that needs it', () => {
    // 2764 defaults to text presentation: without U+FE0F it is a monochrome
    // dingbat, and RGI refuses it.
    expect(canonicalEmoji('❤️')).toBe('❤️');
    expect(canonicalEmoji('❤')).toBe('❤️');
    expect([...canonicalEmoji('❤')!].length).toBe(2);
  });

  it('is idempotent, so re-canonicalising a stored value changes nothing', () => {
    for (const e of ['👍', '❤️', '👋🏽', '👨‍👩‍👧‍👦', '🇬🇧']) {
      const once = canonicalEmoji(e)!;
      expect(canonicalEmoji(once)).toBe(once);
    }
  });

  it('refuses anything that is not exactly one emoji', () => {
    // A URL path segment is a string, and anybody can put anything in one.
    expect(canonicalEmoji('a')).toBeNull();
    expect(canonicalEmoji('')).toBeNull();
    expect(canonicalEmoji(' ')).toBeNull();
    expect(canonicalEmoji('👍👍')).toBeNull();
    expect(canonicalEmoji('👍a')).toBeNull();
    expect(canonicalEmoji(':smile:')).toBeNull();
    expect(canonicalEmoji('<script>')).toBeNull();
    expect(canonicalEmoji('👍 ')).toBeNull();
  });

  it('refuses half a flag', () => {
    // One regional indicator letter is not an emoji by anybody's definition,
    // including Unicode's -- it takes two to make a flag.
    expect(canonicalEmoji('🇬')).toBeNull();
  });

  it('takes a lone skin-tone modifier, because Unicode says it is one', () => {
    // Surprising, and left alone on purpose. U+1F3FD is Emoji_Presentation and
    // therefore RGI, so a swatch with no gesture under it is a valid emoji as
    // far as this validator's question goes -- "is this one emoji" -- even
    // though it is a piece of one as far as a person is concerned.
    //
    // The picker does not offer these (see the generator's COMPONENT_GROUP),
    // so reaching this needs a hand-made request, and the worst it produces is
    // a small brown square in a reaction row that is capped at twenty. A
    // special case here would be a rule invented to guard nothing.
    expect(canonicalEmoji('🏽')).toBe('🏽');
  });
});
