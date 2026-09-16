import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_PARTY_QUEUE,
  MAX_PARTY_TITLE,
  type WatchPartyAction,
  type WatchPartyState,
  type WatchPartyVideo,
} from '@isthislegit/shared';
import { newId } from '../common/ids';

/**
 * Watch parties, in memory and nowhere else.
 *
 * There is no table behind this and there is not meant to be one. A party is
 * somewhere people are for an evening, like a call -- the queue is gone when
 * it ends, the chat in it was never written down, and a server that restarts
 * ends every party rather than restoring one into a room that has since gone
 * to bed. Persisting it would buy a resumed playlist and cost a migration, a
 * retention rule, and a backup that carries somebody's Tuesday.
 *
 * Everything here is synchronous and pure state: no emitting, no sockets. The
 * gateway owns every broadcast, which is what keeps this testable and what
 * stops the module graph from pointing in a circle.
 *
 * One party per guild, by construction -- the map is keyed by guild id. See
 * the README: the sidebar draws one strip, and "which party am I in" is not a
 * question anybody should have to answer.
 */

@Injectable()
export class WatchPartyService {
  private readonly log = new Logger(WatchPartyService.name);

  /** guildId -> the one party in it. */
  private readonly parties = new Map<string, WatchPartyState>();

  /**
   * The clock, as an overridable method rather than a constructor argument.
   *
   * Nest builds this class, and a constructor parameter typed as a function
   * has no injection token -- it would be asking the container for something
   * it cannot name. A protected method costs nothing and a test subclass can
   * replace it, which is the whole of what the seam is for.
   */
  protected now(): number {
    return Date.now();
  }

  /* --------------------------------------------------------------- reads */

  byGuild(guildId: string): WatchPartyState | null {
    return this.parties.get(guildId) ?? null;
  }

  byId(partyId: string): WatchPartyState | null {
    for (const party of this.parties.values()) {
      if (party.id === partyId) return party;
    }
    return null;
  }

  /** Every party this person is watching. Normally one; never many. */
  private partiesWith(userId: string): WatchPartyState[] {
    return [...this.parties.values()].filter((p) => p.watchers.includes(userId));
  }

  /**
   * A copy stamped with the clock as it is now.
   *
   * Every payload leaving here goes through this, so `serverTime` is the
   * instant it was sent rather than the instant the state last changed. A
   * client measures its own skew against that; the same field carrying a
   * ten-minute-old timestamp would have it correcting for a skew it does not
   * have and seeking away from everybody else.
   */
  private stamp(party: WatchPartyState): WatchPartyState {
    return { ...party, serverTime: this.now() };
  }

  /* -------------------------------------------------------------- writes */

  /**
   * Open one. Anyone may, which is the difference between this and a channel:
   * a channel is the server's furniture and a party is an evening.
   *
   * A guild that already has one gets that one back rather than a second, and
   * the caller is told it is not new -- two parties in a sidebar with one strip
   * is a worse answer than joining the party that is already running.
   */
  start(
    guildId: string,
    userId: string,
    title: string,
  ): { party: WatchPartyState; created: boolean } {
    const existing = this.parties.get(guildId);
    if (existing) {
      return { party: this.join(existing.id, userId) ?? existing, created: false };
    }

    const party: WatchPartyState = {
      id: newId(),
      guildId,
      title: cleanTitle(title),
      hostId: userId,
      watchers: [userId],
      queue: [],
      playing: false,
      position: 0,
      positionAt: this.now(),
      serverTime: this.now(),
      startedAt: new Date(this.now()).toISOString(),
    };
    this.parties.set(guildId, party);
    this.log.log(`party ${party.id} started in guild ${guildId}`);
    return { party: this.stamp(party), created: true };
  }

  /**
   * Idempotent: somebody already watching gets the state back unchanged.
   *
   * That matters more than it looks. A person in a party has two windows and
   * two sockets, and the second one asks to join exactly as the first did --
   * so "already in" has to be an ordinary answer rather than an error, or
   * opening the party window would look like a failure every time.
   */
  join(partyId: string, userId: string): WatchPartyState | null {
    const party = this.byId(partyId);
    if (!party) return null;
    if (!party.watchers.includes(userId)) {
      party.watchers = [...party.watchers, userId];
    }
    return this.stamp(party);
  }

  /**
   * Leave, and say what became of the party.
   *
   * The host walking out does not end it: the longest-present watcher inherits
   * the controls, which is the rule that needs no dialog and no vote. It ends
   * when the last person leaves, because a party of nobody is a queue nothing
   * is playing to.
   */
  leave(
    partyId: string,
    userId: string,
  ): { party: WatchPartyState | null; ended: boolean; hostChanged: boolean } {
    const party = this.byId(partyId);
    if (!party) return { party: null, ended: false, hostChanged: false };
    if (!party.watchers.includes(userId)) {
      return { party: this.stamp(party), ended: false, hostChanged: false };
    }

    party.watchers = party.watchers.filter((id) => id !== userId);

    if (party.watchers.length === 0) {
      this.parties.delete(party.guildId);
      this.log.log(`party ${party.id} ended -- last watcher left`);
      return { party: this.stamp(party), ended: true, hostChanged: false };
    }

    let hostChanged = false;
    if (party.hostId === userId) {
      // `watchers` is arrival order, so [0] is whoever has been here longest.
      party.hostId = party.watchers[0]!;
      hostChanged = true;
      this.log.log(`party ${party.id} handed to ${party.hostId}`);
    }
    return { party: this.stamp(party), ended: false, hostChanged };
  }

  /**
   * Everything this person is in, dropped at once.
   *
   * Called when their last socket goes: closing the app is leaving. Their
   * *party* window closing is not -- that is one of two connections, and the
   * gateway only calls this when the count reaches zero.
   */
  dropUser(userId: string): {
    party: WatchPartyState;
    ended: boolean;
    hostChanged: boolean;
  }[] {
    return this.partiesWith(userId)
      .map((p) => this.leave(p.id, userId))
      .filter(
        (r): r is { party: WatchPartyState; ended: boolean; hostChanged: boolean } =>
          r.party !== null,
      );
  }

  /**
   * Queue a video. Anyone in the party may, which is the point of a party.
   *
   * An empty queue means this one starts playing: `queue[0]` is always what is
   * on screen, so the first video to arrive is the first video to play, and it
   * starts paused with the position at zero rather than playing to a room that
   * was not looking.
   */
  queue(
    partyId: string,
    userId: string,
    video: { videoId: string; title: string; duration: number | null },
  ): WatchPartyState | null {
    const party = this.byId(partyId);
    if (!party || !party.watchers.includes(userId)) return null;
    // Not an error, just a full queue. Ten friends cannot fill this by
    // accident; a stuck paste loop can, and the cap is what stops it.
    if (party.queue.length >= MAX_PARTY_QUEUE) return this.stamp(party);

    const item: WatchPartyVideo = {
      id: newId(),
      videoId: video.videoId,
      title: cleanTitle(video.title, 200) || video.videoId,
      duration: video.duration,
      addedBy: userId,
      addedAt: new Date(this.now()).toISOString(),
    };
    const first = party.queue.length === 0;
    party.queue = [...party.queue, item];
    if (first) {
      party.position = 0;
      party.positionAt = this.now();
      party.playing = false;
    }
    return this.stamp(party);
  }

  /**
   * Remove one. You may take back what you queued; the host may take anything.
   *
   * Removing what is currently playing is allowed and means "skip to the
   * next", which is the only thing it could mean -- the alternative is a
   * player sitting on a video that is no longer in the list.
   */
  unqueue(
    partyId: string,
    userId: string,
    itemId: string,
  ): WatchPartyState | null {
    const party = this.byId(partyId);
    if (!party || !party.watchers.includes(userId)) return null;

    const index = party.queue.findIndex((v) => v.id === itemId);
    if (index === -1) return null;
    const item = party.queue[index]!;
    if (item.addedBy !== userId && party.hostId !== userId) return null;

    party.queue = party.queue.filter((v) => v.id !== itemId);
    if (index === 0) this.rewind(party);
    return this.stamp(party);
  }

  /**
   * Play, pause, seek, skip -- the host only.
   *
   * Returning null for everybody else rather than silently doing nothing: the
   * client already hides these controls, so a non-host reaching this is a bug
   * or somebody with a socket and an idea, and both deserve the same answer.
   */
  control(
    partyId: string,
    userId: string,
    action: WatchPartyAction,
    position?: number,
  ): WatchPartyState | null {
    const party = this.byId(partyId);
    if (!party || party.hostId !== userId) return null;
    if (party.queue.length === 0) return this.stamp(party);

    switch (action) {
      case 'play':
        // From where it actually is, not from where it was when it paused: a
        // play that did not restamp would jump everyone forward by however
        // long the pause lasted.
        party.position = this.positionNow(party);
        party.positionAt = this.now();
        party.playing = true;
        break;
      case 'pause':
        party.position = this.positionNow(party);
        party.positionAt = this.now();
        party.playing = false;
        break;
      case 'seek':
        party.position = Math.max(0, position ?? 0);
        party.positionAt = this.now();
        break;
      case 'skip':
        party.queue = party.queue.slice(1);
        this.rewind(party);
        break;
    }
    return this.stamp(party);
  }

  /**
   * The video ended by itself, reported by the host's player.
   *
   * Only the host's, and only for the video it is actually on: every client is
   * playing the same thing and would otherwise all report the end, skipping
   * the queue forward by however many people are in the room. The id is what
   * makes a late report harmless -- it names the video that ended, so one that
   * arrives after somebody already skipped matches nothing and does nothing.
   */
  ended(
    partyId: string,
    userId: string,
    itemId: string,
  ): WatchPartyState | null {
    const party = this.byId(partyId);
    if (!party || party.hostId !== userId) return null;
    if (party.queue[0]?.id !== itemId) return null;

    party.queue = party.queue.slice(1);
    this.rewind(party);
    return this.stamp(party);
  }

  /* -------------------------------------------------------------- clock */

  /**
   * Where the video is now, in seconds.
   *
   * While paused this is just `position`; while playing it is that plus the
   * time since it was stamped. Every client works the same sum out from the
   * same two numbers, which is what makes them agree without anyone polling.
   */
  positionNow(party: WatchPartyState): number {
    if (!party.playing) return party.position;
    return party.position + (this.now() - party.positionAt) / 1000;
  }

  /**
   * Back to the start of whatever is at the front of the queue now.
   *
   * Playing continues across the join when there is something to continue
   * into: a skip in the middle of an evening should land on the next video
   * already running, not on a paused one waiting to be told again. An empty
   * queue pauses, because there is nothing for `playing` to be true of.
   */
  private rewind(party: WatchPartyState): void {
    party.position = 0;
    party.positionAt = this.now();
    if (party.queue.length === 0) party.playing = false;
  }
}

/** Trim, collapse whitespace, cap. Titles are drawn in a 226px sidebar. */
function cleanTitle(raw: string, max = MAX_PARTY_TITLE): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
