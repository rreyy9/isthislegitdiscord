import { io, type Socket } from 'socket.io-client';
import { getServerUrl, getToken } from './api';
import type { MessageDto } from './api';

/**
 * Socket lifecycle. Two things here matter beyond "connect and listen":
 *
 * - The token goes in the `auth` payload, because a browser/renderer cannot set
 *   an Authorization header on a WebSocket handshake.
 * - On every (re)connect we emit 'reconnected' so the app can backfill messages
 *   missed while offline. A laptop that slept for an hour hits this constantly;
 *   without the backfill it silently drops whatever arrived while it was away.
 */

export interface SocketEvents {
  onMessage: (m: MessageDto) => void;
  onMessageUpdated: (m: MessageDto) => void;
  onMessageDeleted: (p: { id: string; channelId: string }) => void;
  onMemberUpdated: (p: {
    guildId: string;
    userId: string;
    mutedUntil: string | null;
  }) => void;
  /** Only ever arrives for the signed-in user: they were kicked or banned. */
  onRemoved: (p: {
    guildId: string;
    kind: 'kick' | 'ban';
    reason: string | null;
  }) => void;
  onPresence: (p: { userId: string; online: boolean }) => void;
  onTyping: (p: { channelId: string; userId: string; typing: boolean }) => void;
  onVoiceParticipants: (p: { channelId: string; userIds: string[] }) => void;
  onStatus: (status: 'connected' | 'disconnected' | 'connecting') => void;
  onReconnected: () => void;
}

let socket: Socket | null = null;

export function connectSocket(events: SocketEvents): Socket {
  disconnectSocket();

  events.onStatus('connecting');
  socket = io(getServerUrl(), {
    transports: ['websocket'],
    auth: { token: getToken() },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  let hasConnectedBefore = false;

  socket.on('connect', () => {
    events.onStatus('connected');
    // Fire backfill on reconnects, not the first connect (initial load already
    // fetches history through the REST call).
    if (hasConnectedBefore) events.onReconnected();
    hasConnectedBefore = true;
  });

  socket.on('disconnect', () => events.onStatus('disconnected'));
  socket.io.on('reconnect_attempt', () => events.onStatus('connecting'));

  socket.on('message:new', events.onMessage);
  socket.on('message:updated', events.onMessageUpdated);
  socket.on('message:deleted', events.onMessageDeleted);
  socket.on('member:updated', events.onMemberUpdated);
  socket.on('moderation:removed', events.onRemoved);
  socket.on('presence:changed', events.onPresence);
  socket.on('typing:changed', events.onTyping);
  socket.on('voice:participants', events.onVoiceParticipants);

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
