import { Inject, Logger } from '@nestjs/common';
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
import type { Message } from '@isthislegit/shared';
import { AUTH, type Auth } from '../auth/auth.factory';
import { PermissionService } from '../auth/permission.guard';

interface SocketData {
  userId: string;
  username: string | null;
}

@WebSocketGateway({
  cors: { origin: true, credentials: true },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
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
  ) {}

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

      socket.data = {
        userId: session.user.id,
        username: (session.user as any).username ?? null,
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
      });
    } else {
      this.connections.set(data.userId, next);
    }
  }

  onlineUserIds(): string[] {
    return [...this.connections.keys()];
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
   * Deletion goes to everyone, not just the channel room: a client only joins
   * the room for the channel it is looking at, and a message deleted in
   * another channel still has to disappear from whatever that client has
   * cached. The payload carries no content, so this leaks nothing.
   */
  broadcastMessageDeleted(id: string, channelId: string) {
    this.server.emit('message:deleted', { id, channelId });
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

  broadcastVoiceParticipants(channelId: string, userIds: string[]) {
    this.server.emit('voice:participants', { channelId, userIds });
  }
}
