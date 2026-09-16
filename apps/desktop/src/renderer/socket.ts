import { io, type Socket } from 'socket.io-client';
import { getClientVersion, getServerUrl, getToken } from './api';
import type { MessageDto, PublicUserDto } from './api';
import type {
  PartyAck,
  WatchPartyActionName,
  WatchPartyChatDto,
  WatchPartyStateDto,
} from './watch-party-types';

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
  /**
   * A message was posted in some channel, open or not. `onMessage` only fires
   * for the open one, so this is what lights the unread dot everywhere else.
   * Never sent by a server older than this event, which just means no dot.
   */
  onChannelActivity: (p: { channelId: string; messageId: string }) => void;
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
  /**
   * Somebody tagged you. Delivered per user rather than per channel, which is
   * the point — it has to arrive for a channel this client is not looking at,
   * and `onMessage` only ever fires for the one it is.
   */
  onMention: (p: {
    message: MessageDto;
    channelName: string;
    /**
     * Why: somebody said your name, or somebody answered you. The same row in
     * the same table reaches you either way, and the only difference is the
     * sentence on the toast -- which is what this field is for.
     *
     * Absent from a server older than replies, where the only thing it could
     * have meant is a tag.
     */
    kind?: 'mention' | 'reply';
  }) => void;
  /**
   * A message in the open channel was pinned or unpinned. Per channel rather
   * than per user: a pin only changes what is drawn for the channel on screen,
   * which is the one room this client is in.
   */
  onPinChanged: (p: {
    channelId: string;
    messageId: string;
    pinnedAt: string | null;
  }) => void;
  /**
   * Somebody added or took back a reaction in the open channel.
   *
   * Carries the whole pile for that one emoji rather than a delta: a client
   * that has been asleep cannot apply "+1" to a number it never had. Empty
   * `userIds` means the last person took theirs back and the pile goes.
   *
   * Per channel like the pin, so a reaction in a channel this client is not
   * looking at is missed -- which costs nothing, because history carries
   * reactions and opening that channel asks for them.
   */
  onReactionChanged: (p: {
    channelId: string;
    messageId: string;
    emoji: string;
    userIds: string[];
  }) => void;
  /**
   * Somebody changed their display name or picture. Sent to everyone, because
   * the same user is drawn in several lists at once and they all have to move
   * together.
   */
  onUserUpdated: (u: PublicUserDto) => void;
  /**
   * A channel was added, renamed, reordered or removed somewhere in a guild.
   *
   * Carries only the guild id on purpose: the handler refetches the guild
   * list, which is what makes one event enough for all four operations and
   * keeps the ordering the server's business rather than this client's.
   */
  onGuildChanged: (p: { guildId: string }) => void;
  /**
   * Somebody came online or went offline. `lastSeenAt` rides along so the
   * member list can put a duration under a name the moment it dims, instead
   * of leaving the space blank until the next fetch answers.
   */
  onPresence: (p: {
    userId: string;
    online: boolean;
    lastSeenAt: string | null;
  }) => void;
  onTyping: (p: { channelId: string; userId: string; typing: boolean }) => void;
  onVoiceParticipants: (p: { channelId: string; userIds: string[] }) => void;
  /**
   * A newer build has been published while this client was connected. An older
   * client never registered this handler and simply drops the event, which is
   * why new features arrive as new events rather than changes to old ones.
   */
  onUpdateAvailable: (p: { version: string }) => void;
  /**
   * The server is on its way down to be updated, and will be back in a few
   * seconds. Arrives immediately before the disconnect, not instead of it --
   * the reconnect that follows is the ordinary one, and everything already
   * wired to `onStatus` and `onReconnected` behaves exactly as it does for any
   * other gap. All this changes is what the status line says while it waits.
   *
   * Not guaranteed: a server that is killed outright never sends it. Treat it
   * as an explanation when it turns up rather than as the thing that tells you
   * the connection dropped.
   */
  onServerRestarting: () => void;
  /**
   * A watch party opened, changed, or ended somewhere in the guild.
   *
   * Three handlers rather than one, because the sidebar treats "there is one
   * now" and "the one you are in moved on" differently -- and because a server
   * older than the feature sends none of the three, which is exactly what an
   * absent feature should look like: no strip, nothing to join, nothing drawn
   * wrongly.
   *
   * `onPartyState` fires for every party in the guild, joined or not: the
   * strip says who is watching and what is playing, and people who have not
   * joined draw it too.
   */
  onPartyState: (state: WatchPartyStateDto, started: boolean) => void;
  onPartyEnded: (p: { guildId: string; partyId: string }) => void;
  /**
   * Somebody said something in a party this socket is in. Session-only: there
   * is no history behind it and nothing backfills it, so a client that was not
   * connected simply missed it.
   */
  onPartyChat: (line: WatchPartyChatDto) => void;
  onStatus: (status: 'connected' | 'disconnected' | 'connecting') => void;
  onReconnected: () => void;
}

let socket: Socket | null = null;

export function connectSocket(events: SocketEvents): Socket {
  disconnectSocket();

  events.onStatus('connecting');
  socket = io(getServerUrl(), {
    transports: ['websocket'],
    // The version rides along with the token, in the one payload a renderer
    // can put anything in -- a WebSocket handshake takes no headers.
    auth: { token: getToken(), clientVersion: getClientVersion() },
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
  socket.on('channel:activity', events.onChannelActivity);
  socket.on('member:updated', events.onMemberUpdated);
  socket.on('mention:new', events.onMention);
  socket.on('moderation:removed', events.onRemoved);
  socket.on('pin:changed', events.onPinChanged);
  socket.on('reaction:changed', events.onReactionChanged);
  socket.on('user:updated', events.onUserUpdated);
  socket.on('guild:changed', events.onGuildChanged);
  socket.on('presence:changed', events.onPresence);
  socket.on('typing:changed', events.onTyping);
  socket.on('voice:participants', events.onVoiceParticipants);
  socket.on('client:update-available', events.onUpdateAvailable);
  socket.on('party:started', (state) => events.onPartyState(state, true));
  socket.on('party:updated', (state) => events.onPartyState(state, false));
  socket.on('party:ended', events.onPartyEnded);
  socket.on('party:chat', events.onPartyChat);
  socket.on('server:restarting', () => events.onServerRestarting());

  return socket;
}

/**
 * The live socket, for the network panel.
 *
 * Given out rather than wrapped because what that panel wants is the parts of
 * Socket.IO this module has no other use for -- the engine's packet counters
 * and the current transport -- and a wrapper around those would be a second
 * copy of the same state, kept in step by hand.
 */
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

/**
 * A full set of handlers that do nothing, to be spread and then overridden.
 *
 * For the watch party window, which is the same renderer bundle connected to
 * the same server but interested in almost none of it: it draws no channels,
 * no member list and no unread marks, so a message arriving is genuinely
 * nothing it has to do. Spreading these and overriding the four it wants is
 * both shorter and more honest than fourteen inline `() => {}`.
 *
 * It also has the right behaviour as this interface grows: an event added
 * later is ignored by that window until somebody decides it should not be,
 * rather than breaking its build for a feature it has no part in.
 */
export function idleEvents(): SocketEvents {
  const ignore = () => {};
  return {
    onMessage: ignore,
    onMessageUpdated: ignore,
    onMessageDeleted: ignore,
    onChannelActivity: ignore,
    onMemberUpdated: ignore,
    onRemoved: ignore,
    onMention: ignore,
    onPinChanged: ignore,
    onReactionChanged: ignore,
    onUserUpdated: ignore,
    onGuildChanged: ignore,
    onPresence: ignore,
    onTyping: ignore,
    onVoiceParticipants: ignore,
    onUpdateAvailable: ignore,
    onServerRestarting: ignore,
    onPartyState: ignore,
    onPartyEnded: ignore,
    onPartyChat: ignore,
    onStatus: ignore,
    onReconnected: ignore,
  };
}

/* ------------------------------------------------------------ watch party */

/**
 * Every party emit, acked.
 *
 * Acked rather than fire-and-forget because each of these can be refused --
 * a guest pressing pause, a video removed by somebody who did not queue it, a
 * party that ended while the click was in flight -- and a UI that assumed
 * success would show the room a state the server never agreed to. The ack also
 * carries the new state, which is what lets the window that asked update
 * without waiting for the broadcast to come back round.
 *
 * Resolves to `{ ok: false }` rather than rejecting when there is no socket,
 * so no caller has to wrap this in a try.
 */
function emitParty(event: string, payload: unknown): Promise<PartyAck> {
  return new Promise((resolve) => {
    if (!socket) return resolve({ ok: false });
    // A server too old to know this event never answers, so the promise would
    // hang and whatever awaited it would sit there. Socket.IO's own timeout
    // turns that into an ordinary refusal.
    socket
      .timeout(5000)
      .emit(event, payload, (err: unknown, ack: PartyAck | undefined) => {
        resolve(err || !ack ? { ok: false } : ack);
      });
  });
}

export function partyStart(guildId: string, title: string) {
  return emitParty('party:start', { guildId, title });
}
export function partyJoin(partyId: string) {
  return emitParty('party:join', { partyId });
}
export function partyLeave(partyId: string) {
  return emitParty('party:leave', { partyId });
}
export function partySync(partyId: string) {
  return emitParty('party:sync', { partyId });
}
/** Asked once per window on the way up. See `party:current` in shared. */
export function partyCurrent(guildId: string) {
  return emitParty('party:current', { guildId });
}
export function partyQueue(
  partyId: string,
  video: { videoId: string; title: string; duration: number | null },
) {
  return emitParty('party:queue', { partyId, ...video });
}
export function partyUnqueue(partyId: string, itemId: string) {
  return emitParty('party:unqueue', { partyId, itemId });
}
export function partyControl(
  partyId: string,
  action: WatchPartyActionName,
  position?: number,
) {
  return emitParty('party:control', { partyId, action, position });
}
export function partyVideoEnded(partyId: string, itemId: string) {
  return emitParty('party:video-ended', { partyId, itemId });
}
export function partySay(partyId: string, content: string) {
  return emitParty('party:say', { partyId, content });
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
