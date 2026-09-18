import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { fromNodeHeaders } from 'better-auth/node';
import { compareVersions, MAX_PARTY_CHAT } from '@isthislegit/shared';
import type {
  ClientPlatform,
  ConnectedClient,
  Message,
  PublicUser,
  WatchPartyAction,
  WatchPartyState,
} from '@isthislegit/shared';
import { AUTH, type Auth } from '../auth/auth.factory';
import { PermissionService } from '../auth/permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { WatchPartyService } from '../watchparty/watch-party.service';
import { newId } from '../common/ids';
import { allowedOrigins, isOriginAllowed } from '../common/cors';

interface SocketData {
  userId: string;
  username: string | null;
  /**
   * What the client says it is, or null from one too old to say. Kept in
   * memory only: this is telemetry for deciding when a compatibility branch is
   * safe to delete, not a record worth a table.
   */
  clientVersion: string | null;
  /**
   * Which client. Defaults to `desktop`, which is not a guess: every build
   * that predates this field is a desktop one, because on the day it was added
   * that was the only client there was.
   */
  platform: ClientPlatform;
}

// The same allowlist the HTTP API uses. Socket.IO has its own CORS handling
// and does not inherit `enableCors`, so pinning one and not the other would
// leave the socket -- which carries every message on the server -- open to any
// origin. Read once at import: this decorator argument runs before Nest builds
// the module graph, which is exactly the trap documented at the top of main.ts,
// and is safe here only because `dotenv/config` is imported above everything.
const socketOrigins = allowedOrigins();

@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) =>
      isOriginAllowed(origin, socketOrigins)
        ? callback(null, true)
        : callback(null, false),
    credentials: true,
  },
})
export class ChatGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnApplicationShutdown
{
  @WebSocketServer() server: Server;
  private readonly log = new Logger(ChatGateway.name);

  /**
   * Connections per user, not a boolean. Someone with the app open on two
   * machines closes one and must stay online; a boolean would show them
   * offline while they are still typing.
   */
  private readonly connections = new Map<string, number>();

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly permissions: PermissionService,
    private readonly prisma: PrismaService,
    private readonly parties: WatchPartyService,
  ) {}

  /**
   * Say on the way out that this is a restart, not the server falling over.
   *
   * The installer stops the server for a few seconds while it swaps the new
   * version in, and clients reconnect on their own inside that. The difference
   * this makes is only to what they show while they wait -- "updating" instead
   * of "offline" -- but that is the difference between an update nobody
   * mentions and ten people asking at once whether the server is down.
   *
   * Emitted synchronously and to everyone: there is no time here for a round
   * trip, and no reason to care whether it arrived. A client that misses it,
   * or is too old to listen for it, reconnects exactly as it did before.
   *
   * This only runs when the process is given the chance -- see the note on
   * enableShutdownHooks in main.ts. On Windows a forced kill skips it, which
   * is a quieter version of today's behaviour rather than a regression.
   */
  onApplicationShutdown(signal?: string) {
    if (!this.server) return;
    this.log.log(`shutting down (${signal ?? 'no signal'}) -- telling clients`);
    this.server.emit('server:restarting', { signal: signal ?? null });
  }

  /**
   * Authentication belongs here, not in handleConnection: Socket.IO awaits
   * middleware before it will deliver any event, whereas handleConnection is
   * not awaited — an early `channel:join` can otherwise arrive before the
   * session has been resolved.
   */
  afterInit(server: Server) {
    server.use(async (socket, next) => {
      // A browser cannot set headers on a WebSocket handshake, so the token
      // also arrives via `io(url, { auth: { token } })`. Cookies still work
      // for same-origin callers.
      const headers: Record<string, any> = { ...socket.handshake.headers };
      const token = (socket.handshake.auth as any)?.token;
      if (token && !headers.authorization) {
        headers.authorization = `Bearer ${token}`;
      }

      const session = await this.auth.api
        .getSession({ headers: fromNodeHeaders(headers) })
        .catch(() => null);

      if (!session?.user) {
        next(new Error('unauthorized'));
        return;
      }

      // A version is whatever the client claims, so it is clamped to
      // something short and printable before it is ever shown in the console.
      const claimed = (socket.handshake.auth as any)?.clientVersion;
      const clientVersion =
        typeof claimed === 'string' && /^[\w.+-]{1,32}$/.test(claimed)
          ? claimed
          : null;

      // Same treatment as the version: whatever the client says, reduced to
      // one of the values we know. Anything else -- including nothing at all,
      // from a build older than the field -- is a desktop client.
      const platform: ClientPlatform =
        (socket.handshake.auth as any)?.platform === 'android'
          ? 'android'
          : 'desktop';

      socket.data = {
        userId: session.user.id,
        username: (session.user as any).username ?? null,
        clientVersion,
        platform,
      } satisfies SocketData;
      next();
    });
  }

  handleConnection(socket: Socket) {
    const data = socket.data as SocketData;
    if (!data?.userId) {
      socket.disconnect(true);
      return;
    }

    const next = (this.connections.get(data.userId) ?? 0) + 1;
    this.connections.set(data.userId, next);
    socket.join(`user:${data.userId}`);

    if (next === 1) {
      this.server.emit('presence:changed', {
        userId: data.userId,
        online: true,
        lastSeenAt: this.touchLastSeen(data.userId),
      });
    }
    this.log.log(`connected ${data.username ?? data.userId} (${next} session(s))`);
  }

  handleDisconnect(socket: Socket) {
    const data = socket.data as SocketData;
    if (!data?.userId) return;

    const next = (this.connections.get(data.userId) ?? 1) - 1;
    if (next <= 0) {
      this.connections.delete(data.userId);
      // Their last window has gone, so they have left any party they were in.
      // Deliberately not on every disconnect: somebody in a party has two
      // sockets -- the main window and the party window -- and closing the
      // party window is putting the video away, not leaving.
      this.dropFromParties(data.userId);
      this.server.emit('presence:changed', {
        userId: data.userId,
        online: false,
        // The mark that matters: this is the instant the member list will be
        // counting from for as long as they stay away.
        lastSeenAt: this.touchLastSeen(data.userId),
      });
    } else {
      this.connections.set(data.userId, next);
    }
  }

  /**
   * Record that this person was here, and say when.
   *
   * Called at the two transitions only -- their first window opening and their
   * last one closing -- because in between they are online and the member list
   * draws a green dot rather than a duration. A server that dies mid-session
   * therefore leaves a mark from the start of that session rather than its
   * end; it is corrected the moment they reconnect, and "last seen" being an
   * hour early beats a heartbeat writing to the database all evening.
   *
   * The timestamp is returned rather than read back, so the socket event that
   * carries it goes out now instead of after a round trip to Postgres. The
   * write is deliberately not awaited for the same reason: a slow database
   * must not hold up presence, and a failed one costs a stale duration under
   * somebody's name, which is not worth refusing the connection over.
   */
  private touchLastSeen(userId: string): string {
    const at = new Date();
    // updateMany, not update: the column lives on the membership, so somebody
    // who belongs to two guilds has two rows, and one statement keeps them
    // from ever disagreeing.
    this.prisma.guildMember
      .updateMany({ where: { userId }, data: { lastSeenAt: at } })
      .catch((err: Error) =>
        this.log.warn(`could not record last seen for ${userId}: ${err.message}`),
      );
    return at.toISOString();
  }

  onlineUserIds(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * Who is connected and on what.
   *
   * This is the whole point of asking clients their version: it is what says
   * when a deprecated field is safe to delete. Without it, compatibility code
   * added for one release lives forever, because nobody can demonstrate it is
   * unused.
   */
  connectedClients(): ConnectedClient[] {
    // Keyed by person *and* platform, so somebody at their desk with the app
    // on their phone is two rows rather than one. Collapsing them would take
    // the older of two version numbers that are not on the same scale: the
    // Android client versions independently, so a phone on 0.1.0 would report
    // as this account's build and make it look like nobody had upgraded the
    // desktop app since the day it shipped -- which is exactly the figure this
    // whole method exists to answer.
    const byClient = new Map<string, ConnectedClient>();
    for (const socket of this.server?.sockets?.sockets?.values() ?? []) {
      const data = socket.data as SocketData;
      if (!data?.userId) continue;

      const platform = data.platform ?? 'desktop';
      const key = `${data.userId}:${platform}`;
      const seen = byClient.get(key);
      if (seen) {
        seen.connections += 1;
        // Two windows on two builds: report the older one, since that is the
        // one that constrains what the server can stop supporting.
        if (
          !seen.version ||
          (data.clientVersion &&
            compareVersions(data.clientVersion, seen.version) < 0)
        ) {
          seen.version = data.clientVersion;
        }
        continue;
      }
      byClient.set(key, {
        userId: data.userId,
        username: data.username,
        version: data.clientVersion,
        platform,
        connections: 1,
      });
    }
    return [...byClient.values()];
  }

  /**
   * Tell every connected client a newer build exists.
   *
   * Additive by construction: a client too old to have registered a handler
   * drops it, which is exactly why new features arrive as new events rather
   * than as changes to existing ones.
   */
  announceUpdate(version: string): number {
    this.server.emit('client:update-available', { version });
    return this.server?.sockets?.sockets?.size ?? 0;
  }

  /**
   * The same, for the Android client.
   *
   * Its own event rather than a field on `client:update-available`, which
   * every desktop build already listens to: adding a platform to that payload
   * would not help, because those builds were written before there was a
   * platform to check and would offer an Android version number as their own
   * update. A new event is dropped by everything that predates it, which is
   * the whole of why new features arrive this way here.
   *
   * `versionCode` rides along because it is what the phone actually compares
   * against itself -- see the note on `AndroidManifest`. The count returned is
   * every socket, not every phone: it is a line in the console saying the
   * announcement went out, and splitting it per platform would be a second
   * pass over the socket map for a number nobody acts on.
   */
  announceAndroidUpdate(version: string, versionCode: number): number {
    this.server.emit('android:update-available', { version, versionCode });
    return this.server?.sockets?.sockets?.size ?? 0;
  }

  /**
   * Round-trip probe for the client's network panel.
   *
   * Deliberately does no work: the number it produces is meant to be the cost
   * of the network and the event loop, and anything touched here (a database,
   * a lock) would be measured as latency and blamed on the connection.
   *
   * `t` is echoed rather than read so the client can pair a reply with the
   * probe that asked for it; `serverTime` is what lets it show clock skew,
   * which is the usual explanation for timestamps that look wrong.
   */
  @SubscribeMessage('net:ping')
  netPing(@MessageBody() body: { t?: number } | undefined) {
    return { t: typeof body?.t === 'number' ? body.t : null, serverTime: Date.now() };
  }

  @SubscribeMessage('channel:join')
  async joinChannel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { channelId: string },
  ) {
    const { userId } = socket.data as SocketData;
    if (!(await this.permissions.canInChannel(userId, body.channelId, 'channel.read'))) {
      return { ok: false };
    }
    socket.join(`channel:${body.channelId}`);
    return { ok: true };
  }

  @SubscribeMessage('channel:leave')
  leaveChannel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { channelId: string },
  ) {
    socket.leave(`channel:${body.channelId}`);
    return { ok: true };
  }

  @SubscribeMessage('typing:start')
  typingStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { channelId: string },
  ) {
    const { userId } = socket.data as SocketData;
    socket.to(`channel:${body.channelId}`).emit('typing:changed', {
      channelId: body.channelId,
      userId,
      typing: true,
    });
  }

  @SubscribeMessage('typing:stop')
  typingStop(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { channelId: string },
  ) {
    const { userId } = socket.data as SocketData;
    socket.to(`channel:${body.channelId}`).emit('typing:changed', {
      channelId: body.channelId,
      userId,
      typing: false,
    });
  }

  /* ------------------------------------------------------- watch parties */

  /**
   * Every party change leaves by this one door.
   *
   * The state goes to everyone rather than to the watchers, because the strip
   * in the sidebar -- who is watching, what is playing -- is drawn by people
   * who have not joined. Same reach as `guild:changed`, same reason.
   */
  private announce(state: WatchPartyState, started = false) {
    this.server.emit(started ? 'party:started' : 'party:updated', state);
  }

  /** Take one person out of every party they were in, and say so. */
  private dropFromParties(userId: string) {
    for (const { party, ended } of this.parties.dropUser(userId)) {
      if (ended) {
        this.server.emit('party:ended', {
          guildId: party.guildId,
          partyId: party.id,
        });
      } else {
        this.announce(party);
      }
    }
  }

  /**
   * Where a party's chat and nothing else is delivered.
   *
   * Per socket rather than per person: both of somebody's windows are in it,
   * and the party window is the one that draws the lines.
   */
  private partyRoom(partyId: string) {
    return `party:${partyId}`;
  }

  @SubscribeMessage('party:start')
  async partyStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { guildId: string; title: string },
  ) {
    const { userId } = socket.data as SocketData;
    if (!(await this.permissions.canInGuild(userId, body.guildId, 'party.join'))) {
      return { ok: false as const };
    }

    const { party, created } = this.parties.start(
      body.guildId,
      userId,
      body.title || 'Watch party',
    );
    await socket.join(this.partyRoom(party.id));
    this.announce(party, created);
    return { ok: true as const, state: party };
  }

  @SubscribeMessage('party:join')
  async partyJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { partyId: string },
  ) {
    const { userId } = socket.data as SocketData;
    const existing = this.parties.byId(body.partyId);
    if (!existing) return { ok: false as const };
    if (!(await this.permissions.canInGuild(userId, existing.guildId, 'party.join'))) {
      return { ok: false as const };
    }

    const already = existing.watchers.includes(userId);
    const party = this.parties.join(body.partyId, userId);
    if (!party) return { ok: false as const };

    // The room every time, the broadcast only when the watcher list actually
    // changed. A second window joining is not news to anybody else's sidebar.
    await socket.join(this.partyRoom(party.id));
    if (!already) this.announce(party);
    return { ok: true as const, state: party };
  }

  @SubscribeMessage('party:leave')
  async partyLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { partyId: string },
  ) {
    const { userId } = socket.data as SocketData;
    const { party, ended } = this.parties.leave(body.partyId, userId);
    if (!party) return { ok: false as const };

    // Every socket of theirs, not just the one that asked: leaving in the main
    // window has to stop the party window hearing chat as well.
    for (const s of await this.server.in(`user:${userId}`).fetchSockets()) {
      void s.leave(this.partyRoom(party.id));
    }

    if (ended) {
      this.server.emit('party:ended', {
        guildId: party.guildId,
        partyId: party.id,
      });
    } else {
      this.announce(party);
    }
    return { ok: true as const };
  }

  @SubscribeMessage('party:sync')
  partySync(@MessageBody() body: { partyId: string }) {
    const party = this.parties.byId(body.partyId);
    // Answered in the ack, not broadcast: nobody else's screen changes because
    // this laptop woke up or this window just opened.
    return party ? { ok: true as const, state: party } : { ok: false as const };
  }

  @SubscribeMessage('party:current')
  async partyCurrent(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { guildId: string },
  ) {
    const { userId } = socket.data as SocketData;
    if (!(await this.permissions.canInGuild(userId, body.guildId, 'party.join'))) {
      return { ok: false as const };
    }
    // `ok` with no state means "there is no party", which a client has to be
    // able to tell apart from "you may not ask".
    const party = this.parties.byGuild(body.guildId);
    return { ok: true as const, state: party ?? undefined };
  }

  @SubscribeMessage('party:queue')
  partyQueue(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: { partyId: string; videoId: string; title: string; duration: number | null },
  ) {
    const { userId } = socket.data as SocketData;
    // The one shape check the server makes. Everything else about a video is
    // whatever YouTube says it is, but the id is interpolated straight into an
    // embed URL by every client in the room.
    if (!/^[\w-]{11}$/.test(String(body.videoId ?? ''))) {
      return { ok: false as const };
    }

    const party = this.parties.queue(body.partyId, userId, {
      videoId: body.videoId,
      title: String(body.title ?? ''),
      duration:
        typeof body.duration === 'number' && Number.isFinite(body.duration)
          ? body.duration
          : null,
    });
    if (!party) return { ok: false as const };
    this.announce(party);
    return { ok: true as const, state: party };
  }

  @SubscribeMessage('party:unqueue')
  partyUnqueue(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { partyId: string; itemId: string },
  ) {
    const { userId } = socket.data as SocketData;
    const party = this.parties.unqueue(body.partyId, userId, body.itemId);
    if (!party) return { ok: false as const };
    this.announce(party);
    return { ok: true as const, state: party };
  }

  @SubscribeMessage('party:control')
  partyControl(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: { partyId: string; action: WatchPartyAction; position?: number },
  ) {
    const { userId } = socket.data as SocketData;
    const party = this.parties.control(
      body.partyId,
      userId,
      body.action,
      body.position,
    );
    // Null here is the non-host case, which the client already hides the
    // controls for. Somebody reaching it has a socket and an idea.
    if (!party) return { ok: false as const };
    this.announce(party);
    return { ok: true as const, state: party };
  }

  @SubscribeMessage('party:video-ended')
  partyVideoEnded(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { partyId: string; itemId: string },
  ) {
    const { userId } = socket.data as SocketData;
    const party = this.parties.ended(body.partyId, userId, body.itemId);
    if (!party) return { ok: false as const };
    this.announce(party);
    return { ok: true as const, state: party };
  }

  @SubscribeMessage('party:say')
  partySay(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { partyId: string; content: string },
  ) {
    const { userId } = socket.data as SocketData;
    const party = this.parties.byId(body.partyId);
    if (!party || !party.watchers.includes(userId)) return { ok: false as const };

    const content = String(body.content ?? '').slice(0, MAX_PARTY_CHAT).trim();
    if (!content) return { ok: false as const };

    // Straight out to the room and kept nowhere. No row, no id to edit later,
    // no backfill for somebody who joins in ten minutes: that is the whole of
    // what "session-only" means, and it is why this does not touch Prisma.
    this.server.to(this.partyRoom(party.id)).emit('party:chat', {
      partyId: party.id,
      id: newId(),
      userId,
      content,
      at: new Date().toISOString(),
    });
    return { ok: true as const };
  }

  /* ----------------------------------------------- called by controllers */

  /**
   * The message goes to the channel room; the fact of it goes to everyone.
   * A client only joins the room for the channel it has open, so without the
   * second emit nothing tells it another channel has something new, and the
   * unread dot there stays dark until the next launch. Ids only, like a
   * deletion, so it carries nothing a reader of that channel would not see.
   */
  broadcastMessage(message: Message) {
    this.server.to(`channel:${message.channelId}`).emit('message:new', message);
    this.server.emit('channel:activity', {
      channelId: message.channelId,
      messageId: message.id,
    });
  }

  broadcastMessageUpdated(message: Message) {
    this.server.to(`channel:${message.channelId}`).emit('message:updated', message);
  }

  /**
   * Tell people they have been tagged.
   *
   * Sent per user rather than to the channel room, and that is the entire
   * point: a client joins the room for the one channel it has open, so
   * `message:new` reaches nobody who is looking somewhere else — which is
   * precisely who a tag is for. The `user:` room covers every window they have
   * open, so a tag lights up on both their machines.
   *
   * The whole message rides along so the client can put the text in a
   * notification without fetching a channel it has never opened. The author is
   * dropped by the caller, not here: what counts as tagging yourself is a
   * question about the message, not about sockets.
   *
   * `kind` says why, and only that. A reply and a tag are the same row in the
   * same table and reach the same person the same way; the difference is one
   * sentence on a toast, so it is one field rather than a second event.
   */
  notifyMentions(
    message: Message,
    userIds: string[],
    channelName: string,
    kind: 'mention' | 'reply' = 'mention',
  ) {
    for (const userId of userIds) {
      this.server
        .to(`user:${userId}`)
        .emit('mention:new', { message, channelName, kind });
    }
  }

  /**
   * Deletion goes to everyone, not just the channel room: a client only joins
   * the room for the channel it is looking at, and a message deleted in
   * another channel still has to disappear from whatever that client has
   * cached. The payload carries no content, so this leaks nothing.
   */
  broadcastMessageDeleted(id: string, channelId: string) {
    this.server.emit('message:deleted', { id, channelId });
  }

  /**
   * A message was pinned or unpinned.
   *
   * The channel room, not everyone: the pin marker and the pin list are both
   * drawn for the channel on screen, and a client only joins the room for that
   * one. Unlike a deletion, nothing a client holds elsewhere goes wrong by not
   * hearing this.
   */
  broadcastPinChanged(
    channelId: string,
    messageId: string,
    pinnedAt: string | null,
  ) {
    this.server
      .to(`channel:${channelId}`)
      .emit('pin:changed', { channelId, messageId, pinnedAt });
  }

  /**
   * A reaction was added or taken back.
   *
   * The channel room, on the same reasoning as a pin: the only thing that
   * changes is what is drawn for the channel on screen. Somebody scrolled away
   * in another channel misses it and does not need it -- history carries
   * reactions, so opening that channel is what brings them.
   *
   * The whole pile for that emoji, not a delta. A client that has been asleep
   * cannot apply "+1" to a number it never had, and a pile it can drop in
   * place is right however far behind it was. Empty means the last person took
   * theirs back.
   */
  broadcastReactionChanged(
    channelId: string,
    messageId: string,
    emoji: string,
    userIds: string[],
  ) {
    this.server
      .to(`channel:${channelId}`)
      .emit('reaction:changed', { channelId, messageId, emoji, userIds });
  }

  broadcastMemberUpdated(
    guildId: string,
    userId: string,
    mutedUntil: Date | null,
  ) {
    this.server.emit('member:updated', {
      guildId,
      userId,
      mutedUntil: mutedUntil ? mutedUntil.toISOString() : null,
    });
  }

  /**
   * Tell one person they have been removed, then cut their sockets. The
   * message goes first — after the disconnect there is nobody to tell.
   */
  notifyRemoved(
    userId: string,
    payload: { guildId: string; kind: 'kick' | 'ban'; reason: string | null },
  ) {
    this.server.to(`user:${userId}`).emit('moderation:removed', payload);
  }

  /**
   * Drop every connection a user has. Their token may still be valid — a kick
   * does not sign them out of the account — but the socket has to go, or they
   * keep receiving messages from a guild they are no longer in.
   */
  disconnectUser(userId: string) {
    this.server.in(`user:${userId}`).disconnectSockets(true);
  }

  /**
   * Somebody changed their display name or avatar.
   *
   * To everyone, not just the guild: the same user is drawn in the member
   * list, on every message they have sent, and in the voice roster, and a
   * client that missed this would keep the old name in some of those and not
   * others. A client older than the feature never registered the handler and
   * drops it.
   */
  broadcastUserUpdated(user: PublicUser) {
    this.server.emit('user:updated', user);
  }

  /**
   * A channel was added, renamed, reordered or removed.
   *
   * Deliberately carries no channel in the payload. Everyone is told only that
   * the shape of a guild changed, and each client re-asks `GET /api/guilds`,
   * which answers with the channels *that client* is allowed to see. A delta
   * would have to be filtered per recipient here instead, and a broadcast of
   * one would put channel names in front of people who are not in the guild.
   *
   * That also makes one event enough for four operations: a rename and a
   * deletion are both "your list is stale", and the refetch sorts them the
   * same way the first load did rather than re-implementing the ordering on
   * the client.
   */
  broadcastGuildChanged(guildId: string) {
    this.server.emit('guild:changed', { guildId });
  }

  broadcastVoiceParticipants(channelId: string, userIds: string[]) {
    this.server.emit('voice:participants', { channelId, userIds });
  }
}
