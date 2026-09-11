import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { ParticipantInfo } from 'livekit-server-sdk';
import type { VoiceChannelState } from '@isthislegit/shared';
import { ChatGateway } from '../gateway/chat.gateway';
import { PrismaService } from '../prisma/prisma.service';

/** Room names are `channel-<channelId>`; this pair converts both ways. */
export const roomForChannel = (channelId: string) => `channel-${channelId}`;
export const channelForRoom = (room: string) =>
  room.startsWith('channel-') ? room.slice('channel-'.length) : null;

/**
 * Everything a participant is allowed to send.
 *
 * Written out rather than left unset, even though "unset" means the same
 * thing to LiveKit: the sweep below compares what a participant is permitted
 * to publish against what they should be, and a comparison needs both sides to
 * be spelled out or it fires on every pass.
 */
const ALL_SOURCES: readonly TrackSource[] = [
  TrackSource.CAMERA,
  TrackSource.MICROPHONE,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

/**
 * The same list with the microphone taken out — the entirety of what a mute
 * does.
 *
 * SCREEN_SHARE_AUDIO stays, and that is a decision rather than an oversight: a
 * mute is aimed at the microphone, and taking the sound off a shared game as
 * well would make it a different, larger punishment than the one that was
 * asked for. Somebody determined to be heard through a screen share is doing
 * something a moderator can see, and there is a kick for that.
 */
const SOURCES_WHILE_MUTED: readonly TrackSource[] = ALL_SOURCES.filter(
  (s) => s !== TrackSource.MICROPHONE,
);

/**
 * What this person may publish right now. Exported because the join token has
 * to agree with the sweep — two places deciding this separately is how a
 * muted person ends up with a working microphone until the next sweep, or a
 * released one ends up without.
 */
export function publishableSources(muted: boolean): TrackSource[] {
  return [...(muted ? SOURCES_WHILE_MUTED : ALL_SOURCES)];
}

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

  constructor(
    private readonly gateway: ChatGateway,
    private readonly prisma: PrismaService,
  ) {
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
    let participants: ParticipantInfo[] = [];
    try {
      participants = await this.client.listParticipants(
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
    await this.enforceMicPolicy(channelId, participants);
  }

  /* ------------------------------------------------------------- muting */

  /**
   * Make LiveKit agree with the mute column for everyone in this room.
   *
   * This hangs off the read rather than being a thing moderation does once,
   * and that is what makes a mute behave like the deadline it is stored as.
   * Nothing schedules the release: the sweep that already runs every thirty
   * seconds notices the date has passed and hands the microphone back. The
   * same pass repairs a LiveKit that was restarted, a webhook that went
   * missing, and a permission an admin changed by hand.
   *
   * Runs on every read, which includes the join and leave webhooks, so
   * somebody who joins a call while muted is silenced immediately rather than
   * up to a sweep later.
   *
   * Never throws: it is awaited inside `read`, whose contract is that it does
   * not reject.
   */
  private async enforceMicPolicy(
    channelId: string,
    participants: ParticipantInfo[],
  ): Promise<void> {
    if (participants.length === 0) return;
    try {
      const muted = await this.mutedAmong(
        channelId,
        participants.map((p) => p.identity),
      );
      await Promise.all(
        participants.map((p) =>
          this.applyMicPolicy(channelId, p, muted.has(p.identity)),
        ),
      );
    } catch (err) {
      // A room whose microphones are one sweep out of date is worth a line in
      // the log and nothing more; the next pass will have another go.
      this.log.warn(
        `could not apply mute policy in ${channelId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Which of these people may not speak here: everyone whose own mute is still
   * running, or everyone at all if the channel itself is listen-only.
   *
   * The channel's flag is read on every pass rather than remembered, which is
   * what makes it behave like the mute beside it -- an AFK room that was
   * changed in the database takes effect on the next sweep, in a call already
   * in progress, without anyone rejoining.
   */
  private async mutedAmong(
    channelId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true, listenOnly: true },
    });
    if (!channel) return new Set();

    // Nobody talks in an AFK channel, so there is nothing to ask the member
    // table: the answer is everyone in the room, admins included.
    if (channel.listenOnly) return new Set(userIds);

    // The deadline is applied in the query rather than in JavaScript, so an
    // expired mute simply does not come back and needs no clearing.
    const rows = await this.prisma.guildMember.findMany({
      where: {
        guildId: channel.guildId,
        userId: { in: userIds },
        mutedUntil: { gt: new Date() },
      },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /** One participant, brought into line with one boolean. */
  private async applyMicPolicy(
    channelId: string,
    participant: ParticipantInfo,
    muted: boolean,
  ): Promise<void> {
    const room = roomForChannel(channelId);
    const allowed = publishableSources(muted);

    // LiveKit reads an empty list as "no restriction", so that is what it has
    // to be compared against — otherwise a participant from a client that
    // never sent the list would look wrong on every pass and be rewritten
    // every thirty seconds for as long as they stayed in the call.
    const current = participant.permission?.canPublishSources ?? [];
    const effective = current.length ? current : ALL_SOURCES;
    const settled =
      effective.length === allowed.length &&
      allowed.every((s) => effective.includes(s));

    if (!settled) {
      // Permissions are replaced wholesale, not merged, so the rest of the
      // grant is restated here. It matches the join token by construction.
      await this.client.updateParticipant(room, participant.identity, {
        permission: {
          canSubscribe: true,
          canPublish: true,
          canPublishData: true,
          canPublishSources: allowed,
        },
      });
    }

    if (!muted) return;

    // Permission governs the next publish; a microphone already on the wire
    // has to be told to stop separately. LiveKit unpublishes revoked sources
    // itself in current versions, so this is usually a no-op -- and it is what
    // makes the behaviour not depend on that.
    await Promise.all(
      participant.tracks
        .filter((t) => t.source === TrackSource.MICROPHONE && !t.muted)
        .map((t) =>
          this.client
            .mutePublishedTrack(room, participant.identity, t.sid, true)
            // The track can be gone by now -- they stopped talking, or the
            // permission change above already took it.
            .then(
              () => undefined,
              () => undefined,
            ),
        ),
    );
  }

  /**
   * Re-apply the mute policy across a guild, for use the moment an admin
   * changes it.
   *
   * A whole-guild re-read rather than a surgical poke at one participant in
   * one room: `refresh` is the operation that already knows how to ask LiveKit
   * what is true and act on it, and muting somebody is rare enough that a
   * handful of localhost calls costs nothing. The alternative -- finding which
   * room they are sitting in first -- would be a second, subtly different copy
   * of the code above.
   */
  async syncMutes(guildId: string): Promise<void> {
    const rooms = await this.prisma.channel.findMany({
      where: { guildId, kind: 'VOICE' },
      select: { id: true },
    });
    await Promise.all(rooms.map((c) => this.refresh(c.id)));
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
   * Throw one person out of one call. Used by moderation for a kick or a ban,
   * which have to reach someone who is already talking rather than merely stop
   * the next join. Not by a mute: that leaves them in the room and takes the
   * microphone, which is `syncMutes`. A 404 here means they were not in that
   * room, which is the desired state anyway — hence the swallow.
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
