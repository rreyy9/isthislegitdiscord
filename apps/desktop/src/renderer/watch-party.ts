import { useCallback, useMemo, useRef, useState } from 'react';
import {
  partyControl,
  partyCurrent,
  partyJoin,
  partyLeave,
  partyQueue,
  partySay,
  partyStart,
  partySync,
  partyUnqueue,
  partyVideoEnded,
} from './socket';
import type { SocketEvents } from './socket';
import { youtubeId } from './link-utils';
import { fetchVideoTitle } from './youtube-player';
import type {
  WatchPartyActionName,
  WatchPartyChatDto,
  WatchPartyStateDto,
} from './watch-party-types';

/**
 * The client's half of a watch party.
 *
 * One hook, used by both windows -- the sidebar strip in the main window and
 * everything in the party window. They want different parts of it and the same
 * state, and two hooks would be two sets of socket handlers disagreeing about
 * who is watching.
 *
 * It holds no state anything else writes, which is what lets it live out here
 * instead of in `Chat.tsx`'s closure. That distinction is the README's, and it
 * is the reason this feature adds about forty lines to that file rather than
 * four hundred.
 *
 * Nothing here is persisted. A party is session-only on the server and it is
 * session-only here: closing the app is leaving, and nothing is written down
 * to be restored into a room that has moved on.
 */

/** How long a chat backlog is kept in memory. It is not history; it is a window. */
const CHAT_LIMIT = 300;

export interface WatchParty {
  /** The party in this guild, joined or not, or null when there is none. */
  party: WatchPartyStateDto | null;
  /** Lines said since this window opened. Never backfilled. */
  chat: WatchPartyChatDto[];
  /**
   * This machine's clock minus the server's, in milliseconds.
   *
   * Measured from the `serverTime` on every state rather than from a ping.
   * A player that silently desynced because somebody's clock is four minutes
   * fast is the failure this feature could least afford, and it is not one any
   * amount of drift tolerance would have caught.
   */
  skewMs: number;
  iAmHost: boolean;
  iAmWatching: boolean;
  /**
   * Spread into `connectSocket`'s event object. Stable across renders -- the
   * socket effect has these in its dependencies, and a new identity every
   * render would tear the connection down and rebuild it every render.
   */
  handlers: Pick<SocketEvents, 'onPartyState' | 'onPartyEnded' | 'onPartyChat'>;
  /** The last refusal, ready to show, or null. */
  error: string | null;
  clearError: () => void;

  start: (guildId: string, title: string) => Promise<boolean>;
  join: () => Promise<boolean>;
  leave: () => Promise<void>;
  /** Paste a link. Returns what happened, so the composer can say so. */
  queueLink: (url: string) => Promise<'queued' | 'not-a-video' | 'refused'>;
  unqueue: (itemId: string) => void;
  control: (action: WatchPartyActionName, position?: number) => void;
  say: (content: string) => void;
  videoEnded: (itemId: string) => void;
  /**
   * Ask for the current state and put this socket back in the party's room.
   *
   * Called on every reconnect, and it is not optional. A reconnect is a new
   * socket: rooms are per connection, so without this the party window stops
   * hearing chat while looking perfectly connected. It re-joins rather than
   * only syncing, because a client whose last socket dropped was taken out of
   * the party by the server and has to ask to be back in.
   */
  resync: () => void;
  /**
   * Ask whether this guild has a party running, once, as a window comes up.
   *
   * The strip is drawn from broadcasts, and a broadcast that happened before
   * this socket existed is one it never heard -- so without this, launching
   * into an evening already in progress shows nothing until somebody presses
   * something. Returns the party if there is one, so a window that opened for
   * a specific party can go straight in.
   */
  discover: (guildId: string) => Promise<WatchPartyStateDto | null>;
  /** Adopt a state handed over from elsewhere, e.g. a window that just opened. */
  adopt: (state: WatchPartyStateDto) => void;
}

export function useWatchParty(meId: string): WatchParty {
  const [party, setParty] = useState<WatchPartyStateDto | null>(null);
  const [chat, setChat] = useState<WatchPartyChatDto[]>([]);
  const [skewMs, setSkewMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /**
   * The party this client believes it is in, readable from a callback that
   * must not depend on the render it was made in. Every action below needs
   * the id, and closing over the state variable would give the socket
   * handlers a stale one after any reconnect.
   */
  const partyRef = useRef<WatchPartyStateDto | null>(null);
  /** Whether we joined on purpose, so a reconnect knows to go back in. */
  const joinedRef = useRef(false);

  const take = useCallback((state: WatchPartyStateDto | null) => {
    partyRef.current = state;
    setParty(state);
    if (state) {
      // The clock, on every state rather than once: a laptop that slept has a
      // different skew on the other side of the nap.
      setSkewMs(Date.now() - state.serverTime);
    }
  }, []);

  /* ------------------------------------------------------------ handlers */

  const handlers = useMemo<WatchParty['handlers']>(
    () => ({
      onPartyState: (state) => {
        // Every party in the guild arrives here, including one this client has
        // not joined -- the sidebar strip is drawn by people who have not.
        partyRef.current = state;
        setParty(state);
        setSkewMs(Date.now() - state.serverTime);
      },
      onPartyEnded: ({ partyId }) => {
        if (partyRef.current?.id !== partyId) return;
        partyRef.current = null;
        joinedRef.current = false;
        setParty(null);
        setChat([]);
      },
      onPartyChat: (line) => {
        setChat((prev) =>
          prev.length >= CHAT_LIMIT
            ? [...prev.slice(prev.length - CHAT_LIMIT + 1), line]
            : [...prev, line],
        );
      },
    }),
    [],
  );

  /* ------------------------------------------------------------- actions */

  const start = useCallback(
    async (guildId: string, title: string) => {
      const ack = await partyStart(guildId, title);
      if (!ack.ok || !ack.state) {
        setError('Could not start a watch party.');
        return false;
      }
      joinedRef.current = true;
      take(ack.state);
      return true;
    },
    [take],
  );

  const join = useCallback(async () => {
    const current = partyRef.current;
    if (!current) return false;
    const ack = await partyJoin(current.id);
    if (!ack.ok || !ack.state) {
      setError('That watch party has already finished.');
      return false;
    }
    joinedRef.current = true;
    take(ack.state);
    return true;
  }, [take]);

  const leave = useCallback(async () => {
    const current = partyRef.current;
    joinedRef.current = false;
    setChat([]);
    if (!current) return;
    await partyLeave(current.id);
    // Not cleared here: the party may still be running without us, and the
    // strip should turn back into a Join button rather than disappearing.
    // `party:updated` or `party:ended` decides which, and one of the two is
    // always on its way.
  }, []);

  const queueLink = useCallback(
    async (url: string): Promise<'queued' | 'not-a-video' | 'refused'> => {
      const current = partyRef.current;
      if (!current) return 'refused';

      const videoId = youtubeId(url);
      if (!videoId) return 'not-a-video';

      // The title is fetched before the queue rather than after, so the row
      // never appears as a bare id and then rewrites itself under the reader.
      // It cannot fail in a way that matters: `fetchVideoTitle` answers with
      // the id rather than throwing, and a queue that draws an id beats one
      // that refuses a video because a third party did not answer.
      const title = await fetchVideoTitle(videoId);
      const ack = await partyQueue(current.id, { videoId, title, duration: null });
      if (!ack.ok) {
        setError('That video could not be added to the queue.');
        return 'refused';
      }
      if (ack.state) take(ack.state);
      return 'queued';
    },
    [take],
  );

  const unqueue = useCallback(
    (itemId: string) => {
      const current = partyRef.current;
      if (!current) return;
      void partyUnqueue(current.id, itemId).then((ack) => {
        if (!ack.ok) setError('That is not yours to remove.');
        else if (ack.state) take(ack.state);
      });
    },
    [take],
  );

  const control = useCallback(
    (action: WatchPartyActionName, position?: number) => {
      const current = partyRef.current;
      if (!current) return;
      void partyControl(current.id, action, position).then((ack) => {
        if (!ack.ok) setError('Only the host can control playback.');
        else if (ack.state) take(ack.state);
      });
    },
    [take],
  );

  const say = useCallback((content: string) => {
    const current = partyRef.current;
    if (!current) return;
    // Not echoed locally the way a chat message is: there is no id to
    // reconcile and no history to insert into, so the round trip is the whole
    // of it and the line appears when the server says it did.
    void partySay(current.id, content);
  }, []);

  const videoEnded = useCallback((itemId: string) => {
    const current = partyRef.current;
    if (!current) return;
    void partyVideoEnded(current.id, itemId);
  }, []);

  const resync = useCallback(() => {
    const current = partyRef.current;
    if (!current) return;
    const ask = joinedRef.current
      ? partyJoin(current.id)
      : partySync(current.id);
    void ask.then((ack) => {
      if (ack.ok && ack.state) take(ack.state);
      else if (!ack.ok) {
        // It ended while this client was away. Nothing to go back into.
        partyRef.current = null;
        joinedRef.current = false;
        setParty(null);
        setChat([]);
      }
    });
  }, [take]);

  const discover = useCallback(
    async (guildId: string) => {
      const ack = await partyCurrent(guildId);
      // `ok` with no state is the ordinary "there is no party here" answer.
      // Only a refusal is worth clearing anything over, and there is nothing
      // to clear on the way up anyway.
      if (ack.ok && ack.state) {
        take(ack.state);
        return ack.state;
      }
      return null;
    },
    [take],
  );

  const adopt = useCallback(
    (state: WatchPartyStateDto) => {
      joinedRef.current = true;
      take(state);
    },
    [take],
  );

  return {
    party,
    chat,
    skewMs,
    iAmHost: party?.hostId === meId,
    iAmWatching: Boolean(party?.watchers.includes(meId)),
    handlers,
    error,
    clearError: useCallback(() => setError(null), []),
    start,
    join,
    leave,
    queueLink,
    unqueue,
    control,
    say,
    videoEnded,
    resync,
    discover,
    adopt,
  };
}
