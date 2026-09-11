import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dayLabel,
  describeBytes,
  guessReactions,
  isForever,
  lastSeenLabel,
  muteLabel,
  QUOTE_LINE_CHARS,
  quoteLine,
  sameDay,
  stamp,
  timeOf,
} from './chat-format';

/** Pin the clock, since half of this file is "relative to now" by definition. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}
afterEach(() => vi.useRealTimers());

describe('describeBytes', () => {
  it('matches the wording the server uses to refuse an upload', () => {
    // The two numbers get compared by whoever reads them, so they have to be
    // written the same way.
    expect(describeBytes(0)).toBe('0 B');
    expect(describeBytes(512)).toBe('512 B');
    expect(describeBytes(1024)).toBe('1 KB');
    expect(describeBytes(26_214_400)).toBe('25 MB');
  });

  it('keeps one decimal only where it says something', () => {
    expect(describeBytes(1536)).toBe('1.5 KB');
    expect(describeBytes(1024 * 1024 * 2)).toBe('2 MB');
    // Past 100 the fraction is noise.
    expect(describeBytes(Math.round(1024 * 150.7))).toBe('151 KB');
  });

  it('steps up through the units and stops at TB', () => {
    expect(describeBytes(1024 ** 3)).toBe('1 GB');
    expect(describeBytes(1024 ** 4)).toBe('1 TB');
    expect(describeBytes(1024 ** 5)).toBe('1024 TB');
  });
});

describe('dayLabel', () => {
  it('names today and yesterday rather than dating them', () => {
    at('2026-09-08T15:00:00');
    expect(dayLabel(new Date('2026-09-08T09:00:00').toISOString())).toBe('Today');
    expect(dayLabel(new Date('2026-09-07T23:59:00').toISOString())).toBe('Yesterday');
  });

  it('crosses midnight by the calendar day, not by elapsed hours', () => {
    // 00:30 and 23:30 are an hour apart and are still two different days,
    // which is what a reader means by "yesterday".
    at('2026-09-08T00:30:00');
    expect(dayLabel(new Date('2026-09-07T23:30:00').toISOString())).toBe('Yesterday');
  });

  it('dates anything older, and adds the year only when it differs', () => {
    at('2026-09-08T15:00:00');
    expect(dayLabel(new Date('2026-03-12T10:00:00').toISOString())).not.toMatch(/2026/);
    expect(dayLabel(new Date('2025-03-12T10:00:00').toISOString())).toMatch(/2025/);
  });
});

describe('sameDay', () => {
  it('is what decides whether a day separator is drawn', () => {
    expect(sameDay('2026-09-08T00:00:01', '2026-09-08T23:59:59')).toBe(true);
    expect(sameDay('2026-09-08T23:59:59', '2026-09-09T00:00:01')).toBe(false);
  });
});

describe('stamp', () => {
  it('carries its own date, because the pin board is read out of order', () => {
    at('2026-09-08T15:00:00');
    const iso = new Date('2026-09-08T14:32:00').toISOString();
    expect(stamp(iso)).toBe(`Today at ${timeOf(iso)}`);
  });
});

describe('isForever', () => {
  it('recognises the year-9999 sentinel an indefinite mute is stored as', () => {
    expect(isForever('9999-12-31T23:59:59.000Z')).toBe(true);
    expect(isForever('2026-09-08T00:00:00.000Z')).toBe(false);
  });
});

describe('muteLabel', () => {
  it('says microphone every time', () => {
    // "Muted" on its own reads as silenced everywhere, which is what this used
    // to do and deliberately no longer does.
    at('2026-09-08T15:00:00');
    expect(muteLabel('9999-12-31T23:59:59.000Z')).toBe('Microphone muted indefinitely');
    expect(muteLabel(new Date('2026-09-08T16:00:00').toISOString())).toMatch(
      /^Microphone muted until /,
    );
  });

  it('drops the date when the mute lifts today', () => {
    at('2026-09-08T15:00:00');
    const todayLabel = muteLabel(new Date('2026-09-08T16:00:00').toISOString());
    const laterLabel = muteLabel(new Date('2026-09-10T16:00:00').toISOString());
    expect(todayLabel.length).toBeLessThan(laterLabel.length);
    expect(laterLabel).toMatch(/Sep/);
  });
});

describe('lastSeenLabel', () => {
  const now = new Date('2026-09-08T15:00:00.000Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('gets coarser the further back it goes', () => {
    expect(lastSeenLabel(ago(5_000), now)).toBe('just now');
    expect(lastSeenLabel(ago(90_000), now)).toBe('1m ago');
    expect(lastSeenLabel(ago(2 * 3600_000), now)).toBe('2h ago');
    expect(lastSeenLabel(ago(3 * 86_400_000), now)).toBe('3d ago');
  });

  it('becomes a date past a week, because "23d" is not read as a length', () => {
    expect(lastSeenLabel(ago(23 * 86_400_000), now)).toMatch(/Aug/);
  });

  it('does not go negative on a clock that is slightly ahead', () => {
    // Two machines' clocks disagree by seconds routinely, and "-1m ago" is the
    // kind of thing that gets screenshotted.
    expect(lastSeenLabel(new Date(now + 5_000).toISOString(), now)).toBe('just now');
  });

  it('measures every row from the instant it is given', () => {
    // The caller passes `now` so one render cannot straddle a minute boundary
    // and show two different answers for the same moment.
    const a = lastSeenLabel(ago(59_999), now);
    const b = lastSeenLabel(ago(59_999), now);
    expect(a).toBe(b);
  });
});

describe('quoteLine', () => {
  it('collapses a quoted message onto one line', () => {
    expect(quoteLine('first\n\nsecond   third', 0, false)).toBe(
      'first second third',
    );
  });

  it('truncates rather than carrying a whole message around', () => {
    const line = quoteLine('x'.repeat(500), 0, false);
    expect(line).toHaveLength(QUOTE_LINE_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });

  it('leaves a message that fits exactly alone', () => {
    const exact = 'y'.repeat(QUOTE_LINE_CHARS);
    expect(quoteLine(exact, 0, false)).toBe(exact);
  });

  it('says what a message with no words was', () => {
    // A screenshot with nothing typed is a normal message, and a strip that
    // drew it as empty space would read as a bug rather than as a picture.
    expect(quoteLine('', 1, false)).toBe('📎 Attachment');
    expect(quoteLine('   ', 3, false)).toBe('📎 3 attachments');
  });

  it('says so when the original was removed, and says nothing else', () => {
    // The server sends no content for a deleted message; this is belt and
    // braces on the one path where a quote could otherwise outlive a deletion.
    expect(quoteLine('what was said', 2, true)).toBe('Message deleted');
  });
});

describe('guessReactions', () => {
  const me = 'u-me';

  it('adds an emoji nobody has used yet, at the end', () => {
    // At the end because that is where the server puts it -- piles are
    // ordered by when they were first added, so anywhere else would make the
    // row jump when the real answer lands.
    expect(guessReactions([{ emoji: '👍', userIds: ['u-a'] }], '🎉', false, me)).toEqual([
      { emoji: '👍', userIds: ['u-a'] },
      { emoji: '🎉', userIds: [me] },
    ]);
  });

  it('joins a pile that already exists without moving it', () => {
    expect(
      guessReactions(
        [
          { emoji: '👍', userIds: ['u-a'] },
          { emoji: '🎉', userIds: ['u-b'] },
        ],
        '👍',
        false,
        me,
      ),
    ).toEqual([
      { emoji: '👍', userIds: ['u-a', me] },
      { emoji: '🎉', userIds: ['u-b'] },
    ]);
  });

  it('leaves a pile it is already in alone', () => {
    // Two windows can disagree about whether it is mine. A second copy of one
    // id would show a count that cannot be taken back down.
    const before = [{ emoji: '👍', userIds: ['u-a', me] }];
    expect(guessReactions(before, '👍', false, me)).toEqual(before);
  });

  it('takes mine back and leaves the others', () => {
    expect(
      guessReactions([{ emoji: '👍', userIds: ['u-a', me, 'u-b'] }], '👍', true, me),
    ).toEqual([{ emoji: '👍', userIds: ['u-a', 'u-b'] }]);
  });

  it('removes the pile when the last person takes theirs back', () => {
    // An empty pile drawn as "👍 0" is the bug this exists to prevent.
    expect(
      guessReactions(
        [
          { emoji: '👍', userIds: [me] },
          { emoji: '🎉', userIds: ['u-a'] },
        ],
        '👍',
        true,
        me,
      ),
    ).toEqual([{ emoji: '🎉', userIds: ['u-a'] }]);
  });

  it('does not mutate what it was given', () => {
    const before = [{ emoji: '👍', userIds: ['u-a'] }];
    const snapshot = JSON.parse(JSON.stringify(before));
    guessReactions(before, '👍', false, me);
    // The rollback path holds on to the original array, so mutating it here
    // would make a failed request un-undoable.
    expect(before).toEqual(snapshot);
  });
});
