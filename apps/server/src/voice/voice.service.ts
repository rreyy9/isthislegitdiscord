import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { VoiceChannelState } from '@isthislegit/shared';
import { ChatGateway } from '../gateway/chat.gateway';

/** Room names are `channel-<channelId>`; this pair converts both ways. */
export const roomForChannel = (channelId: string) => `channel-${channelId}`;
export const channelForRoom = (room: string) =>
  room.startsWith('channel-') ? room.slice('channel-'.length) : null;

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
export class VoiceService implements OnModuleInit {
  private readonly log = new Logger(VoiceService.name);
  private readonly byChannel = new Map<string, string[]>();
  private readonly client: RoomServiceClient;

  constructor(private readonly gateway: ChatGateway) {
    this.client = new RoomServiceClient(
      httpUrlForLivekit(process.env.LIVEKIT_URL),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );
  }

  /**
   * A restarted chat server has an empty cache while calls are still in
   * progress, so ask LiveKit what is actually going on. Failure is expected and
   * harmless — LiveKit is often not running during development.
   */
  async onModuleInit() {
    try {
      const rooms = await this.client.listRooms();
      await Promise.all(
        rooms
          .map((r) => channelForRoom(r.name))
          .filter((id): id is string => Boolean(id))
          .map((id) => this.refresh(id)),
      );
      if (rooms.length) this.log.log(`resumed ${rooms.length} voice room(s)`);
    } catch {
      this.log.log('LiveKit not reachable at startup; voice state starts empty');
    }
  }

  /** Re-read one channel's occupants from LiveKit and tell everyone. */
  async refresh(channelId: string) {
    let userIds: string[] = [];
    try {
      const participants = await this.client.listParticipants(
        roomForChannel(channelId),
      );
      // The token sets identity to the user id, so this needs no lookup.
      userIds = [...new Set(participants.map((p) => p.identity))];
    } catch {
      // A room with nobody in it does not exist as far as LiveKit is
      // concerned, and asking about it is a 404. Empty is the right answer.
      userIds = [];
    }

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
 * Clients are given a `ws://` URL; the server SDK talks plain HTTP to the same
 * host and port.
 */
export function httpUrlForLivekit(url = 'ws://localhost:7880') {
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}
