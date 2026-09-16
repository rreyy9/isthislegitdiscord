import {
  YT_BUFFERING,
  YT_CUED,
  YT_ENDED,
  YT_PAUSED,
  YT_PLAYING,
  YT_UNSTARTED,
} from './youtube-player';

/**
 * Keeping everybody's player on the same second.
 *
 * Pure arithmetic, in its own file, because it is the part of this feature
 * that is worth testing and the part most likely to be wrong -- the same
 * reason the noise gate and the URL parser live away from what draws them.
 *
 * ---------------------------------------------------------------------------
 * Why this seeks rather than nudges the playback rate
 * ---------------------------------------------------------------------------
 * The neat trick for this problem is to run slightly fast or slightly slow
 * until the drift is gone, so nobody hears a jump. It is not available here:
 * YouTube's player takes a playback rate from a fixed list, and the slowest
 * step either side of normal is 0.75x and 1.25x. Correcting a second of drift
 * at 1.25x means four seconds of chipmunk, which is far more noticeable than
 * the jump it was avoiding.
 *
 * So the rule is: tolerate small drift, and jump when it stops being small.
 * `TOLERANCE` is deliberately generous -- a second either way is invisible
 * when ten people are talking over a video, and a tight threshold on a player
 * that reports its position a few times a second produces a seek loop, which
 * is the one outcome worse than being a second behind.
 */

/** Drift we simply live with, in seconds. */
export const TOLERANCE = 1.5;

/**
 * How long after a correction before another may be made.
 *
 * A seek is not instant: the player reports its old position for a moment
 * afterwards, and a correction made from that stale reading seeks again, and
 * again. This is what turns a loop into one jump.
 */
export const COOLDOWN_MS = 3000;

export type SyncAction =
  | { kind: 'none' }
  /** Jump to `to` seconds, because the drift stopped being ignorable. */
  | { kind: 'seek'; to: number }
  /** The room is playing and this player is not. */
  | { kind: 'play' }
  /** The room is paused and this player is not. */
  | { kind: 'pause' };

export interface SyncInput {
  /** Where the room says the video should be, in seconds. */
  target: number;
  /** Where this player last said it was. */
  actual: number;
  /** Whether the room is playing. */
  playing: boolean;
  /** This player's state, from the YouTube table. */
  state: number;
  /** When this client last acted, or null if it has not. */
  lastCorrectionAt: number | null;
  now: number;
}

/**
 * What this player should do, if anything.
 *
 * Deliberately returns one action rather than a list. A frame where the player
 * is both paused and behind wants the play first -- the position it lands on
 * after resuming is what the next pass measures, and correcting a position
 * while paused only to resume into a different one is two jumps for one
 * problem.
 */
export function decideSync(input: SyncInput): SyncAction {
  const { target, actual, playing, state, lastCorrectionAt, now } = input;

  // A video that has run out is the host's to move on from, not this client's
  // to restart -- it would seek back and replay it under everybody.
  if (state === YT_ENDED) return { kind: 'none' };

  // Buffering is not drift. A player filling its buffer reports the position
  // it stalled at, and every second of the stall looks like another second
  // behind -- seeking then makes it buffer again from somewhere new. So one
  // person's stall does not pause the room; they catch up alone.
  if (state === YT_BUFFERING) return { kind: 'none' };

  const cooling =
    lastCorrectionAt !== null && now - lastCorrectionAt < COOLDOWN_MS;

  /**
   * A player that has never begun: autoplay was refused, or the video is cued
   * and waiting. This used to be treated as "nothing worth doing", on the
   * grounds that it has no position to correct -- which is true and beside the
   * point. What it needs is not a correction but a start, and without one it
   * sat there for the whole video while everybody else watched.
   */
  const notStarted = state === YT_UNSTARTED || state === YT_CUED;

  if (playing && (state === YT_PAUSED || notStarted)) {
    return cooling ? { kind: 'none' } : { kind: 'play' };
  }
  if (!playing && state === YT_PLAYING) {
    return cooling ? { kind: 'none' } : { kind: 'pause' };
  }

  // Paused and not started: correctly doing nothing, and there is no position
  // in a player that has not begun to compare against anyway.
  if (notStarted) return { kind: 'none' };

  if (cooling) return { kind: 'none' };
  if (Math.abs(target - actual) > TOLERANCE) {
    return { kind: 'seek', to: Math.max(0, target) };
  }
  return { kind: 'none' };
}

/**
 * Where the room's video is now, from the pair the server sends.
 *
 * `skewMs` is this client's clock minus the server's, measured from the
 * `serverTime` that rides on every state. Without it a machine whose clock is
 * four minutes fast computes four minutes of drift and seeks to the end of
 * the video, over and over -- which is the failure this whole field exists to
 * prevent, and which no amount of tolerance would have caught.
 */
export function positionNow(
  state: { playing: boolean; position: number; positionAt: number },
  now: number,
  skewMs: number,
): number {
  if (!state.playing) return state.position;
  const serverNow = now - skewMs;
  return Math.max(0, state.position + (serverNow - state.positionAt) / 1000);
}
