import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { VoiceChannelState } from '@isthislegit/shared';
import { ChatGateway } from '../gateway/chat.gateway';

/** Room names are `channel-<channelId>`; this pair converts both ways. */
export const roomForChannel = (channelId: string) => `channel-${channelId}`;
export const channelForRoom = (room: string) =>
  room.startsWith('channel-') ? room.slice('channel-'.length) : null;

/**
 * How often the cache is checked against LiveKit outright.
 *
 * Webhooks are best-effort: LiveKit sends one POST per event, and a chat server
 * that was restarting, garbage-collecting or simply slow at that instant never
 * hears about it. One missed `participant_left` used to leave somebody sitting
 * in a channel until the next restart, because nothing else ever re-read the
 * room. This sweep is what makes that self-correcting.
 */
const SWEEP_MS = 30_000;

/**
 * Who is in which voice channel.
 *
 * Held in memory because LiveKit is the source of truth — this is a cache of
 * its state, not a second copy of it. Every webhook therefore triggers a
 * re-read of the room's participant list rather than incrementing a counter:
 * one localhost round trip, and in exchange a dropped, duplicated or
 * out-of-order webhook cannot leave a ghost sitting in a channel forever.
 */
@Injectable()
export class VoiceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(VoiceService.name);
  private readonly byChannel = new Map<string, string[]>();
  private readonly client: RoomServiceClient;

  /**
   * One in-flight read per channel, and at most one more queued behind it.
   *
   * Two webhooks arriving together used to start two overlapping reads, and
   * whichever answer came back last won — including when it was the older of
   * the two. A join immediately followed by a leave could therefore settle on
   * the join's snapshot and leave a ghost in the channel, with no further
   * event coming to correct it. Serialising per channel makes the last read
   * the last write, and one queued read is enough for any number of events:
   * it runs after all of them, and it asks LiveKit rather than replaying them.
   */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private sweep?: NodeJS.Timeout;

  constructor(private readonly gateway: ChatGateway) {
    this.client = new RoomServiceClient(
      httpUrlForLivekit(process.env.LIVEKIT_URL),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );
  }

  /**
   * A restarted chat server has an empty cache while calls are still in
   * progress, so ask LiveKit what is actually going on — and keep asking, on a
   * timer, for the reasons above `SWEEP_MS`. Failure is expected and harmless:
   * LiveKit is often not running during development.
   */
  async onModuleInit() {
    const rooms = await this.reconcile();
    if (rooms === null) {
      this.log.log('LiveKit not reachable at startup; voice state starts empty');
    } else if (rooms > 0) {
      this.log.log(`resumed ${rooms} voice room(s)`);
    }

    this.sweep = setInterval(() => void this.reconcile(), SWEEP_MS);
    // Nothing here should hold the process open on its own.
    this.sweep.unref?.();
  }

  onModuleDestroy() {
    if (this.sweep) clearInterval(this.sweep);
  }

  /**
   * Compare every channel LiveKit knows about — and every one we think has
   * somebody in it — against the real thing.
   *
   * Returns the number of live rooms, or null if LiveKit could not be reached,
   * a difference that is only worth telling apart at startup.
   */
  private async reconcile(): Promise<number | null> {
    let rooms;
    try {
      rooms = await this.client.listRooms();
    } catch {
      // Leave the cache alone: an unreachable LiveKit is not an empty one.
      return null;
    }

    const live = rooms
      .map((r) => channelForRoom(r.name))
      .filter((id): id is string => Boolean(id));

    // Channels we still believe in but LiveKit no longer lists are exactly the
    // ghosts this sweep exists to clear, so they have to be visited too.
    const channels = new Set([...live, ...this.byChannel.keys()]);
    await Promise.all([...channels].map((id) => this.refresh(id)));
    return rooms.length;
  }

  /** Re-read one channel's occupants from LiveKit and tell everyone. */
  refresh(channelId: string): Promise<void> {
    const running = this.reading.get(channelId);

    if (!running) return this.track(channelId, this.read(channelId));

    // A read is already in flight, and it may have asked LiveKit before the
    // event we are handling happened — so one more has to follow it. A second
    // waiting read would answer the same question as the first, so one is the
    // most that is ever queued.
    if (this.queued.has(channelId)) return running;
    this.queued.add(channelId);
    return this.track(
      channelId,
      running.then(() => {
        this.queued.delete(channelId);
        return this.read(channelId);
      }),
    );
  }

  /** Record `work` as this channel's in-flight read until it settles. */
  private track(channelId: string, work: Promise<void>): Promise<void> {
    const done: Promise<void> = work.finally(() => {
      if (this.reading.get(channelId) === done) this.reading.delete(channelId);
    });
    this.reading.set(channelId, done);
    return done;
  }

  /** The read itself. Never rejects — a rejection would break the chain. */
  private async read(channelId: string): Promise<void> {
    let userIds: string[];
    try {
      const participants = await this.client.listParticipants(
        roomForChannel(channelId),
      );
      // The token sets identity to the user id, so this needs no lookup.
      userIds = [...new Set(participants.map((p) => p.identity))];
    } catch (err) {
      // A room with nobody in it does not exist as far as LiveKit is
      // concerned, and asking about it is a 404. Empty is the right answer.
      //
      // Anything else — LiveKit restarting, a timeout, a refused connection —
      // means we do not know who is in there, which is not the same as nobody
      // being in there. Publishing an empty list for a call that is still
      // going empties the sidebar for everyone, and nothing puts it back until
      // the next join or leave.
      if (!isRoomGone(err)) {
        this.log.warn(
          `could not read voice channel ${channelId}: ${(err as Error).message}`,
        );
        return;
      }
      userIds = [];
    }

    this.apply(channelId, userIds);
  }

  private apply(channelId: string, userIds: string[]) {
    const previous = this.byChannel.get(channelId) ?? [];
    if (previous.length === 0 && userIds.length === 0) {
      this.byChannel.delete(channelId);
      return;
    }
    if (same(previous, userIds)) return;

    if (userIds.length) this.byChannel.set(channelId, userIds);
    else this.byChannel.delete(channelId);

    this.gateway.broadcastVoiceParticipants(channelId, userIds);
  }

  /** Every channel that currently has someone in it. */
  state(): VoiceChannelState[] {
    return [...this.byChannel.entries()].map(([channelId, userIds]) => ({
      channelId,
      userIds,
    }));
  }

  /**
   * Throw one person out of one call. Used by moderation: a mute, kick or ban
   * has to reach someone who is already talking, not just stop the next join.
   * A 404 here means they were not in that room, which is the desired state
   * anyway — hence the swallow.
   */
  async removeParticipant(channelId: string, userId: string) {
    try {
      await this.client.removeParticipant(roomForChannel(channelId), userId);
    } catch {
      return;
    }
    await this.refresh(channelId);
  }

  /** Admin hammer: end a call, e.g. to clear a wedged room. */
  async closeRoom(channelId: string) {
    await this.client.deleteRoom(roomForChannel(channelId));
    await this.refresh(channelId);
  }
}

function same(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Did LiveKit answer "no such room", as opposed to not answering at all?
 *
 * The server SDK raises a `ServerError` carrying both the HTTP status and the
 * Twirp code; a transport failure raises something else entirely, with
 * neither. Both are checked because which of the two is populated has moved
 * between SDK versions.
 */
function isRoomGone(err: unknown): boolean {
  const e = err as { status?: number; code?: string | number } | null;
  return e?.status === 404 || e?.code === 'not_found';
}

/**
 * Clients are given a `ws://` URL; the server SDK talks plain HTTP to the same
 * host and port.
 */
export function httpUrlForLivekit(url = 'ws://localhost:7880') {
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}
