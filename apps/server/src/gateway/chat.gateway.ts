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
import { compareVersions } from '@isthislegit/shared';
import type { ConnectedClient, Message, PublicUser } from '@isthislegit/shared';
import { AUTH, type Auth } from '../auth/auth.factory';
import { PermissionService } from '../auth/permission.guard';
import { PrismaService } from '../prisma/prisma.service';
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

      socket.data = {
        userId: session.user.id,
        username: (session.user as any).username ?? null,
        clientVersion,
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
    const byUser = new Map<string, ConnectedClient>();
    for (const socket of this.server?.sockets?.sockets?.values() ?? []) {
      const data = socket.data as SocketData;
      if (!data?.userId) continue;

      const seen = byUser.get(data.userId);
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
      byUser.set(data.userId, {
        userId: data.userId,
        username: data.username,
        version: data.clientVersion,
        connections: 1,
      });
    }
    return [...byUser.values()];
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

  /* ----------------------------------------------- called by controllers */

  broadcastMessage(message: Message) {
    this.server.to(`channel:${message.channelId}`).emit('message:new', message);
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
