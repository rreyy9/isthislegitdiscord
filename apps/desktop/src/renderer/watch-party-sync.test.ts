import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, decideSync, positionNow, TOLERANCE } from './watch-party-sync';
import {
  formatDuration,
  YT_BUFFERING,
  YT_CUED,
  YT_ENDED,
  YT_PAUSED,
  YT_PLAYING,
  YT_UNSTARTED,
} from './youtube-player';

const base = {
  target: 100,
  actual: 100,
  playing: true,
  state: YT_PLAYING,
  lastCorrectionAt: null as number | null,
  now: 10_000,
};

describe('decideSync', () => {
  it('does nothing while the player is within tolerance', () => {
    expect(decideSync({ ...base, actual: 100 + TOLERANCE - 0.1 }).kind).toBe('none');
    expect(decideSync({ ...base, actual: 100 - TOLERANCE + 0.1 }).kind).toBe('none');
  });

  it('seeks once the drift stops being ignorable, in either direction', () => {
    expect(decideSync({ ...base, actual: 90 })).toEqual({ kind: 'seek', to: 100 });
    expect(decideSync({ ...base, actual: 130 })).toEqual({ kind: 'seek', to: 100 });
  });

  it('never seeks to a negative position', () => {
    const action = decideSync({ ...base, target: -5, actual: 40 });
    expect(action).toEqual({ kind: 'seek', to: 0 });
  });

  it('starts a player that is paused while the room is playing', () => {
    expect(decideSync({ ...base, state: YT_PAUSED }).kind).toBe('play');
  });

  it('pauses a player that is playing while the room is paused', () => {
    expect(decideSync({ ...base, playing: false, state: YT_PLAYING }).kind).toBe('pause');
  });

  it('prefers resuming over correcting the position it was paused at', () => {
    // Both are true: paused when the room is playing, and a long way behind.
    // Resuming first means the next pass measures where it actually lands.
    const action = decideSync({ ...base, state: YT_PAUSED, actual: 10 });
    expect(action.kind).toBe('play');
  });

  it('treats buffering as a stall rather than as drift', () => {
    // The stalled player reports the position it stopped at, so every second
    // of buffering looks like another second behind. Seeking makes it worse.
    expect(decideSync({ ...base, state: YT_BUFFERING, actual: 40 }).kind).toBe('none');
  });

  it('starts a player that never began, rather than leaving it sitting there', () => {
    // Autoplay refused, or a freshly cued video. It has no position worth
    // correcting -- what it needs is a start, and without one it sat out the
    // whole video while everybody else watched.
    expect(decideSync({ ...base, state: YT_UNSTARTED, actual: 0 }).kind).toBe('play');
    expect(decideSync({ ...base, state: YT_CUED, actual: 0 }).kind).toBe('play');
  });

  it('leaves an unstarted player alone while the room is paused too', () => {
    const paused = { ...base, playing: false, actual: 0 };
    expect(decideSync({ ...paused, state: YT_UNSTARTED }).kind).toBe('none');
    expect(decideSync({ ...paused, state: YT_CUED }).kind).toBe('none');
  });

  it('never restarts a finished video -- that is the host moving on', () => {
    expect(decideSync({ ...base, state: YT_ENDED, actual: 0 }).kind).toBe('none');
  });

  describe('the cooldown', () => {
    it('suppresses a second correction made from a stale reading', () => {
      const justCorrected = {
        ...base,
        actual: 40,
        lastCorrectionAt: base.now - (COOLDOWN_MS - 1),
      };
      expect(decideSync(justCorrected).kind).toBe('none');
    });

    it('lets the next one through once it has elapsed', () => {
      const settled = {
        ...base,
        actual: 40,
        lastCorrectionAt: base.now - (COOLDOWN_MS + 1),
      };
      expect(decideSync(settled)).toEqual({ kind: 'seek', to: 100 });
    });

    it('holds back play and pause as well, not just seeks', () => {
      const cooling = { ...base, lastCorrectionAt: base.now - 10 };
      expect(decideSync({ ...cooling, state: YT_PAUSED }).kind).toBe('none');
      expect(decideSync({ ...cooling, playing: false, state: YT_PLAYING }).kind).toBe(
        'none',
      );
    });
  });
});

describe('positionNow', () => {
  const playing = { playing: true, position: 30, positionAt: 1_000_000 };

  it('advances a playing video by the time since it was stamped', () => {
    expect(positionNow(playing, 1_004_000, 0)).toBeCloseTo(34, 5);
  });

  it('holds a paused video still however long ago it was stamped', () => {
    const paused = { playing: false, position: 30, positionAt: 1_000_000 };
    expect(positionNow(paused, 9_000_000, 0)).toBe(30);
  });

  it('subtracts clock skew, so a fast machine does not invent drift', () => {
    // This client's clock is four minutes ahead of the server's. Without the
    // correction it would compute 240 extra seconds and seek to the end.
    const skew = 4 * 60 * 1000;
    expect(positionNow(playing, 1_004_000 + skew, skew)).toBeCloseTo(34, 5);
  });

  it('handles a clock that is behind the server just as well', () => {
    const skew = -90_000;
    expect(positionNow(playing, 1_004_000 + skew, skew)).toBeCloseTo(34, 5);
  });

  it('never returns a negative position', () => {
    const odd = { playing: true, position: 0, positionAt: 5_000_000 };
    expect(positionNow(odd, 1_000_000, 0)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('draws minutes and seconds, zero padded', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(69)).toBe('1:09');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('adds an hours field only past an hour', () => {
    expect(formatDuration(3599)).toBe('59:59');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(6127)).toBe('1:42:07');
  });

  it('says so rather than guessing when the length is unknown', () => {
    // null is the only "unknown". Zero is a real position -- the start of a
    // video the transport has to be able to draw.
    expect(formatDuration(null)).toBe('--:--');
    expect(formatDuration(Number.NaN)).toBe('--:--');
    expect(formatDuration(-5)).toBe('--:--');
  });
});
