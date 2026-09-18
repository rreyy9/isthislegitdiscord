import { io, type Socket } from 'socket.io-client';
import { getServerUrl, getToken } from './api';
import { CLIENT_PLATFORM, CLIENT_VERSION } from './version';
import type { Message, PublicUser } from './types';

/**
 * Socket lifecycle.
 *
 * Three things matter here beyond "connect and listen", and the third is the
 * one that is different on a phone:
 *
 * - The token goes in the `auth` payload, because a WebSocket handshake takes
 *   no headers. The platform rides along in the same payload, which is what
 *   keeps this client's version numbers out of the desktop client's telemetry.
 * - `transports: ['websocket']` only, matching the desktop client and the
 *   reverse proxy in front of the server. There is no long-polling fallback,
 *   so a broken upgrade does not degrade -- it simply never connects.
 * - Reconnects are the normal case, not the exception. A desktop client
 *   disconnects when the laptop sleeps; a phone disconnects every time the
 *   screen goes off, and Android will freeze the socket within seconds of the
 *   app going to the background. So `onReconnected` fires many times an hour
 *   and the backfill behind it has to be cheap -- which is why it walks
 *   forward from the last message held rather than refetching the page.
 */

export interface SocketEvents {
  onMessage: (m: Message) => void;
  onMessageUpdated: (m: Message) => void;
  onMessageDeleted: (p: { id: string; channelId: string }) => void;
  /**
   * A message was posted in some channel, open or not. `onMessage` only fires
   * for the one this client has joined, so this is what lights the unread dot
   * on every other row of the channel list.
   */
  onChannelActivity: (p: { channelId: string; messageId: string }) => void;
  onMention: (p: {
    message: Message;
    channelName: string;
    kind?: 'mention' | 'reply';
  }) => void;
  onUserUpdated: (u: PublicUser) => void;
  /** Carries only the guild id: the handler refetches the channel list. */
  onGuildChanged: (p: { guildId: string }) => void;
  onPresence: (p: {
    userId: string;
    online: boolean;
    lastSeenAt: string | null;
  }) => void;
  onTyping: (p: { channelId: string; userId: string; typing: boolean }) => void;
  /** Only ever arrives for the signed-in user: they were kicked or banned. */
  onRemoved: (p: {
    guildId: string;
    kind: 'kick' | 'ban';
    reason: string | null;
  }) => void;
  /**
   * A newer APK has been published while this client was connected.
   *
   * Its own event rather than the desktop `client:update-available`, which
   * every desktop build already listens to and which carries a version number
   * on a different scale. A server older than the Android channel never sends
   * this, which reads correctly as "no update".
   */
  onAndroidUpdate: (p: { version: string; versionCode: number }) => void;
  /** The server is going down to be updated and will be back in seconds. */
  onServerRestarting: () => void;
  onStatus: (status: 'connected' | 'disconnected' | 'connecting') => void;
  onReconnected: () => void;
}

let socket: Socket | null = null;

export function connectSocket(events: SocketEvents): Socket {
  disconnectSocket();

  events.onStatus('connecting');
  socket = io(getServerUrl(), {
    transports: ['websocket'],
    auth: {
      token: getToken(),
      clientVersion: CLIENT_VERSION,
      platform: CLIENT_PLATFORM,
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    // A phone that has just woken up has a radio that is technically
    // associated and not yet passing traffic. The default 20s means the first
    // attempt after unlocking often burns the full timeout before the retry
    // that would have worked; a shorter one fails fast into that retry.
    timeout: 10_000,
  });

  let hasConnectedBefore = false;

  socket.on('connect', () => {
    events.onStatus('connected');
    // Backfill on reconnects only. The first connect is preceded by the REST
    // history fetch, which has already asked for everything this would.
    if (hasConnectedBefore) events.onReconnected();
    hasConnectedBefore = true;
  });

  socket.on('disconnect', () => events.onStatus('disconnected'));
  socket.io.on('reconnect_attempt', () => events.onStatus('connecting'));

  socket.on('message:new', events.onMessage);
  socket.on('message:updated', events.onMessageUpdated);
  socket.on('message:deleted', events.onMessageDeleted);
  socket.on('channel:activity', events.onChannelActivity);
  socket.on('mention:new', events.onMention);
  socket.on('user:updated', events.onUserUpdated);
  socket.on('guild:changed', events.onGuildChanged);
  socket.on('presence:changed', events.onPresence);
  socket.on('typing:changed', events.onTyping);
  socket.on('moderation:removed', events.onRemoved);
  socket.on('android:update-available', events.onAndroidUpdate);
  socket.on('server:restarting', () => events.onServerRestarting());

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function joinChannel(channelId: string) {
  socket?.emit('channel:join', { channelId });
}

export function leaveChannel(channelId: string) {
  socket?.emit('channel:leave', { channelId });
}

export function typingStart(channelId: string) {
  socket?.emit('typing:start', { channelId });
}

export function typingStop(channelId: string) {
  socket?.emit('typing:stop', { channelId });
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
