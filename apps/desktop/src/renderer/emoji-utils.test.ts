import { describe, expect, it } from 'vitest';
import {
  applyEmoji,
  emojiOnly,
  emojiQuery,
  matchEmoji,
  toEmoji,
  type EmojiPair,
} from './emoji-utils';

/**
 * A stand-in for the generated table, in the order the real one is in: CLDR
 * presentation order, which is what decides ties. Small on purpose -- these
 * functions are about the matching, not about the data, and a test that loaded
 * two thousand pairs would be testing emojibase.
 */
const PAIRS: EmojiPair[] = [
  ['smile', '😄'],
  ['smiley', '😃'],
  ['laughing', '😆'],
  ['satisfied', '😆'],
  ['joy', '😂'],
  ['smiling_imp', '😈'],
  ['eyes', '👀'],
  ['eyeglasses', '👓'],
  ['+1', '👍'],
  ['thumbsup', '👍'],
  ['heart', '❤️'],
  ['e-mail', '📧'],
];

const lookup = (name: string) => PAIRS.find(([s]) => s === name)?.[1];

describe('emojiQuery', () => {
  it('finds the shortcode being typed', () => {
    expect(emojiQuery(':smi', 4)).toEqual({ start: 0, query: 'smi' });
    expect(emojiQuery('hey :sm', 7)).toEqual({ start: 4, query: 'sm' });
  });

  it('waits for two characters before opening', () => {
    // A bare colon and a one-letter query are both far more likely to be
    // punctuation than the start of a shortcode.
    expect(emojiQuery(':', 1)).toBeNull();
    expect(emojiQuery(':s', 2)).toBeNull();
    expect(emojiQuery(':sm', 3)).toEqual({ start: 0, query: 'sm' });
  });

  it('opens again straight after a shortcode that just closed', () => {
    // The colon a previous emoji left behind is a boundary, not punctuation
    // to be refused -- see startsToken.
    expect(emojiQuery(':joy::sm', 8)).toEqual({ start: 5, query: 'sm' });
  });

  it('ignores a colon that is not at a word boundary', () => {
    // The three this rule exists for: a time, a label, and every URL.
    expect(emojiQuery('at 12:30', 8)).toBeNull();
    expect(emojiQuery('note:this', 9)).toBeNull();
    expect(emojiQuery('see https://ex', 14)).toBeNull();
  });

  it('closes on anything a shortcode cannot contain', () => {
    expect(emojiQuery(':sm ile', 7)).toBeNull();
    expect(emojiQuery(':sm\nile', 7)).toBeNull();
    expect(emojiQuery(':SMI', 4)).toBeNull();
  });

  it('is closed once the shortcode is', () => {
    // `:smile:` has no open query at its end, so the list is gone by the time
    // the word is finished and `toEmoji` is what converts it.
    expect(emojiQuery(':smile:', 7)).toBeNull();
  });

  it('reads from the caret, not the end of the text', () => {
    expect(emojiQuery(':smi and more', 4)).toEqual({ start: 0, query: 'smi' });
  });

  it('gives up rather than scanning a paragraph', () => {
    expect(emojiQuery(':' + 'a'.repeat(200), 201)).toBeNull();
  });
});

describe('matchEmoji', () => {
  it('ranks an exact hit above a longer prefix', () => {
    // Typing `:eyes` in full must not offer `:eyeglasses:` first.
    expect(matchEmoji(PAIRS, 'eyes')[0]).toEqual({ shortcode: 'eyes', emoji: '👀' });
  });

  it('ranks a prefix above a substring', () => {
    const names = matchEmoji(PAIRS, 'smil').map((m) => m.shortcode);
    expect(names.indexOf('smile')).toBeLessThan(names.indexOf('smiling_imp'));
  });

  it('keeps the data order within a score', () => {
    expect(matchEmoji(PAIRS, 'sm').map((m) => m.shortcode)).toEqual([
      'smile',
      'smiley',
      'smiling_imp',
    ]);
  });

  it('offers one emoji once, however many names reach it', () => {
    // `:+1:` and `:thumbsup:` are one picture; two identical rows in a list of
    // eight is a wasted row.
    const hits = matchEmoji(PAIRS, 'satisfied');
    expect(hits).toEqual([{ shortcode: 'satisfied', emoji: '😆' }]);
    expect(matchEmoji(PAIRS, 'a').filter((m) => m.emoji === '😆')).toHaveLength(1);
  });

  it('matches the punctuation gemoji actually uses', () => {
    expect(matchEmoji(PAIRS, '+1')[0].emoji).toBe('👍');
    expect(matchEmoji(PAIRS, 'e-mail')[0].emoji).toBe('📧');
  });

  it('offers nothing for an empty query', () => {
    expect(matchEmoji(PAIRS, '')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(matchEmoji(PAIRS, 's', 2)).toHaveLength(2);
  });
});

describe('applyEmoji', () => {
  it('replaces the query and leaves no trailing space', () => {
    // Where this parts company with applyMention: a forced space would make
    // 👍👍 impossible to type from the list.
    const q = emojiQuery(':smi', 4)!;
    expect(applyEmoji(':smi', q, '😄')).toEqual({ text: '😄', caret: 2 });
  });

  it('keeps what follows the caret', () => {
    const q = emojiQuery('hey :smi there', 8)!;
    expect(applyEmoji('hey :smi there', q, '😄')).toEqual({
      text: 'hey 😄 there',
      caret: 6,
    });
  });

  it('puts the caret past a surrogate pair, not inside it', () => {
    const q = emojiQuery(':smi', 4)!;
    const { text, caret } = applyEmoji(':smi', q, '😄');
    expect(text.slice(caret)).toBe('');
    expect(caret).toBe('😄'.length);
  });
});

describe('toEmoji', () => {
  it('converts a complete shortcode', () => {
    expect(toEmoji('hello :smile:', lookup)).toBe('hello 😄');
  });

  it('converts several, including two in a row', () => {
    expect(toEmoji(':joy: and :+1:', lookup)).toBe('😂 and 👍');
    expect(toEmoji(':joy::joy:', lookup)).toBe('😂😂');
  });

  it('leaves a name nothing answers to exactly as it was typed', () => {
    // Silently deleting text somebody wrote is worse than leaving it.
    expect(toEmoji('a :notanemoji: b', lookup)).toBe('a :notanemoji: b');
  });

  it('leaves ordinary punctuation alone', () => {
    expect(toEmoji('be there at 10:30', lookup)).toBe('be there at 10:30');
    expect(toEmoji('note: bring the thing', lookup)).toBe('note: bring the thing');
    expect(toEmoji('see https://example.com/a', lookup)).toBe(
      'see https://example.com/a',
    );
    expect(toEmoji(':-)', lookup)).toBe(':-)');
  });

  it('does not let a false start eat the next shortcode', () => {
    // The reason the scan resumes just after the opening colon rather than at
    // the end of the name it rejected: these two share a colon.
    expect(toEmoji(':a::smile:', lookup)).toBe(':a:😄');
  });

  it('only converts at a word boundary', () => {
    expect(toEmoji('path:smile: here', lookup)).toBe('path:smile: here');
    expect(toEmoji('(:smile:)', lookup)).toBe('(😄)');
  });

  it('returns the text untouched when there is no colon in it', () => {
    expect(toEmoji('nothing to do here', lookup)).toBe('nothing to do here');
  });

  it('keeps the variation selector on an emoji that needs one', () => {
    // ❤️ is U+2764 U+FE0F. Without the selector it is a monochrome dingbat,
    // and the server's canonicalEmoji refuses it outright.
    expect(toEmoji(':heart:', lookup)).toBe('❤️');
  });
});

describe('emojiOnly', () => {
  it('counts a message that is nothing but emoji', () => {
    expect(emojiOnly('😄')).toBe(1);
    expect(emojiOnly('😄😄😄')).toBe(3);
    expect(emojiOnly('  😄 😂  ')).toBe(2);
  });

  it('counts a multi-codepoint emoji as one', () => {
    // A family is five codepoints and four zero-width joiners, and drawing it
    // as five emoji would be drawing it as five people.
    expect(emojiOnly('👨‍👩‍👧‍👦')).toBe(1);
    expect(emojiOnly('👋🏽')).toBe(1);
    expect(emojiOnly('🇬🇧')).toBe(1);
  });

  it('is null when there are words as well', () => {
    expect(emojiOnly('nice 👍')).toBeNull();
    expect(emojiOnly('👍!')).toBeNull();
  });

  it('is null for no emoji at all', () => {
    expect(emojiOnly('')).toBeNull();
    expect(emojiOnly('   ')).toBeNull();
    expect(emojiOnly('hello')).toBeNull();
  });

  it('gives up past the cap rather than filling the screen', () => {
    expect(emojiOnly('😄'.repeat(27))).toBe(27);
    expect(emojiOnly('😄'.repeat(28))).toBeNull();
  });
});

describe('emojiOnly, cheaply', () => {
  it('gives up on a long message without scanning it', () => {
    // This runs for every message in the list on every render, so a four
    // thousand character paragraph must not be walked twice to learn what its
    // length already said.
    expect(emojiOnly('a'.repeat(4000))).toBeNull();
  });

  it('still counts the longest thing that could qualify', () => {
    // Twenty-seven of the longest sequence in Unicode 17 -- a kiss with two
    // skin tones, fifteen UTF-16 units -- with a space between each. This is
    // the worst case the length guard has to let through, and it is what the
    // guard is sized against rather than against a four-person family.
    expect(emojiOnly(Array(27).fill('🧑🏻‍❤️‍💋‍🧑🏼').join(' '))).toBe(27);
  });
});
