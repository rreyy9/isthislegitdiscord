import { beforeEach, describe, expect, it } from 'vitest';
import { WatchPartyService } from './watch-party.service';

/**
 * The clock is the interesting part of this service, so the tests own it.
 * `positionAt` is stamped from `now()` on every write and the position every
 * client draws is derived from the pair -- a test that used the real clock
 * would be asserting against however long the assertion took.
 */
class TestParties extends WatchPartyService {
  public clock = 1_000_000;
  protected override now(): number {
    return this.clock;
  }
  tick(ms: number) {
    this.clock += ms;
  }
}

const GUILD = 'guild-1';
const HOST = 'user-host';
const GUEST = 'user-guest';
const THIRD = 'user-third';

function video(n = 1) {
  return { videoId: `vid${String(n).padStart(7, '0')}`, title: `Video ${n}`, duration: 100 };
}

describe('WatchPartyService', () => {
  let parties: TestParties;

  beforeEach(() => {
    parties = new TestParties();
  });

  describe('starting', () => {
    it('opens one and makes the starter the host and first watcher', () => {
      const { party, created } = parties.start(GUILD, HOST, 'Movie Night');
      expect(created).toBe(true);
      expect(party.hostId).toBe(HOST);
      expect(party.watchers).toEqual([HOST]);
      expect(party.title).toBe('Movie Night');
      expect(party.playing).toBe(false);
    });

    it('joins the existing one rather than opening a second in the guild', () => {
      const first = parties.start(GUILD, HOST, 'Movie Night').party;
      const { party, created } = parties.start(GUILD, GUEST, 'Other Night');

      expect(created).toBe(false);
      expect(party.id).toBe(first.id);
      // The one already running keeps its name and its host.
      expect(party.title).toBe('Movie Night');
      expect(party.hostId).toBe(HOST);
      expect(party.watchers).toEqual([HOST, GUEST]);
      expect(parties.byGuild(GUILD)!.id).toBe(first.id);
    });

    it('collapses whitespace and caps a very long title', () => {
      const { party } = parties.start(GUILD, HOST, `  a${'x'.repeat(200)}\n b  `);
      expect(party.title.length).toBeLessThanOrEqual(60);
      expect(party.title.startsWith('ax')).toBe(true);
    });
  });

  describe('joining and leaving', () => {
    it('is idempotent, because a second window asks exactly as the first did', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      const again = parties.join(id, GUEST);
      expect(again!.watchers).toEqual([HOST, GUEST]);
    });

    it('hands the party to the longest-present watcher when the host leaves', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      parties.join(id, THIRD);

      const { party, ended, hostChanged } = parties.leave(id, HOST);
      expect(ended).toBe(false);
      expect(hostChanged).toBe(true);
      expect(party!.hostId).toBe(GUEST);
      expect(party!.watchers).toEqual([GUEST, THIRD]);
    });

    it('does not change the host when somebody who is not the host leaves', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      const { hostChanged, party } = parties.leave(id, GUEST);
      expect(hostChanged).toBe(false);
      expect(party!.hostId).toBe(HOST);
    });

    it('ends when the last watcher leaves, and frees the guild for a new one', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      const { ended } = parties.leave(id, HOST);
      expect(ended).toBe(true);
      expect(parties.byGuild(GUILD)).toBeNull();
      expect(parties.byId(id)).toBeNull();

      expect(parties.start(GUILD, GUEST, 'next').created).toBe(true);
    });

    it('drops somebody out of the party when their last window goes', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      const dropped = parties.dropUser(GUEST);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.party.watchers).toEqual([HOST]);
    });

    it('leaving a party you are not in changes nothing', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      const { ended, hostChanged, party } = parties.leave(id, GUEST);
      expect(ended).toBe(false);
      expect(hostChanged).toBe(false);
      expect(party!.watchers).toEqual([HOST]);
    });
  });

  describe('the queue', () => {
    it('lets anybody in the party queue, and refuses anybody who is not', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      expect(parties.queue(id, GUEST, video(1))).not.toBeNull();
      expect(parties.queue(id, THIRD, video(2))).toBeNull();
    });

    it('starts the first video paused at zero rather than playing to nobody', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.tick(5_000);
      const state = parties.queue(id, HOST, video(1))!;
      expect(state.queue).toHaveLength(1);
      expect(state.playing).toBe(false);
      expect(state.position).toBe(0);
      expect(state.positionAt).toBe(parties.clock);
    });

    it('leaves what is playing alone when a second video is queued', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.queue(id, HOST, video(1));
      parties.control(id, HOST, 'play');
      parties.tick(3_000);
      const state = parties.queue(id, HOST, video(2))!;
      expect(state.playing).toBe(true);
      expect(state.queue[0]!.title).toBe('Video 1');
      expect(parties.positionNow(state)).toBeCloseTo(3, 5);
    });

    it('lets you remove your own, and refuses somebody else you did not add', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      const mine = parties.queue(id, GUEST, video(1))!.queue[0]!;
      expect(parties.unqueue(id, THIRD, mine.id)).toBeNull();
      expect(parties.unqueue(id, GUEST, mine.id)!.queue).toHaveLength(0);
    });

    it('lets the host remove anything', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      const theirs = parties.queue(id, GUEST, video(1))!.queue[0]!;
      expect(parties.unqueue(id, HOST, theirs.id)!.queue).toHaveLength(0);
    });

    it('removing what is playing moves on to the next and starts it at zero', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      const first = parties.queue(id, HOST, video(1))!.queue[0]!;
      parties.queue(id, HOST, video(2));
      parties.control(id, HOST, 'play');
      parties.tick(9_000);

      const state = parties.unqueue(id, HOST, first.id)!;
      expect(state.queue[0]!.title).toBe('Video 2');
      expect(state.position).toBe(0);
      expect(state.playing).toBe(true);
    });

    it('caps the queue rather than growing without end', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      for (let i = 0; i < 105; i += 1) parties.queue(id, HOST, video(i));
      expect(parties.byId(id)!.queue).toHaveLength(100);
    });
  });

  describe('playback control', () => {
    it('is refused to everybody but the host', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      parties.queue(id, HOST, video(1));
      expect(parties.control(id, GUEST, 'play')).toBeNull();
      expect(parties.byId(id)!.playing).toBe(false);
    });

    it('play resumes from where it actually is, not from where it paused', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.queue(id, HOST, video(1));
      parties.control(id, HOST, 'play');
      parties.tick(10_000);
      parties.control(id, HOST, 'pause');

      // Ten minutes go by while it is paused.
      parties.tick(600_000);
      const resumed = parties.control(id, HOST, 'play')!;
      expect(resumed.position).toBeCloseTo(10, 5);

      parties.tick(2_000);
      expect(parties.positionNow(resumed)).toBeCloseTo(12, 5);
    });

    it('a paused position does not drift with the clock', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.queue(id, HOST, video(1));
      parties.control(id, HOST, 'play');
      parties.tick(4_000);
      const paused = parties.control(id, HOST, 'pause')!;
      parties.tick(60_000);
      expect(parties.positionNow(paused)).toBeCloseTo(4, 5);
    });

    it('seek moves the clock and refuses to go negative', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.queue(id, HOST, video(1));
      expect(parties.control(id, HOST, 'seek', 42)!.position).toBe(42);
      expect(parties.control(id, HOST, 'seek', -9)!.position).toBe(0);
    });

    it('skip advances the queue and keeps playing into the next one', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.queue(id, HOST, video(1));
      parties.queue(id, HOST, video(2));
      parties.control(id, HOST, 'play');
      parties.tick(5_000);

      const state = parties.control(id, HOST, 'skip')!;
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0]!.title).toBe('Video 2');
      expect(state.position).toBe(0);
      expect(state.playing).toBe(true);
    });

    it('skipping the last one pauses, because there is nothing to be playing', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.queue(id, HOST, video(1));
      parties.control(id, HOST, 'play');
      const state = parties.control(id, HOST, 'skip')!;
      expect(state.queue).toHaveLength(0);
      expect(state.playing).toBe(false);
    });
  });

  describe('a video running out', () => {
    it('is taken from the host and nobody else', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      parties.join(id, GUEST);
      const first = parties.queue(id, HOST, video(1))!.queue[0]!;
      parties.queue(id, HOST, video(2));

      expect(parties.ended(id, GUEST, first.id)).toBeNull();
      expect(parties.byId(id)!.queue).toHaveLength(2);

      expect(parties.ended(id, HOST, first.id)!.queue).toHaveLength(1);
    });

    it('a late report names a video that has already gone, and does nothing', () => {
      const id = parties.start(GUILD, HOST, 'p').party.id;
      const first = parties.queue(id, HOST, video(1))!.queue[0]!;
      parties.queue(id, HOST, video(2));
      parties.control(id, HOST, 'skip');

      // The host's player reaches the end of a video the room already left.
      expect(parties.ended(id, HOST, first.id)).toBeNull();
      expect(parties.byId(id)!.queue).toHaveLength(1);
    });
  });

  it('stamps serverTime on the way out, not when the state last changed', () => {
    const id = parties.start(GUILD, HOST, 'p').party.id;
    parties.tick(30_000);
    expect(parties.join(id, GUEST)!.serverTime).toBe(parties.clock);
  });
});
