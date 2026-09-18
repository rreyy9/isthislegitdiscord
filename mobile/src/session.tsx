import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Vibration, type AppStateStatus } from 'react-native';
import { api, ApiError, configure } from './api';
import { plainMentions, quoteLine } from './format';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { DEFAULT_PREFS, prefsStore, type Prefs } from './prefs';
import { DEFAULT_SERVER_URL, normaliseServerUrl, store } from './store';
import { CLIENT_VERSION_CODE } from './version';
import type {
  Channel,
  Guild,
  Me,
  Member,
  Message,
  PublicUser,
  ServerConfig,
} from './types';

/**
 * Everything that outlives one screen: who is signed in, which server, the
 * socket, and the two lists every screen draws from.
 *
 * One provider rather than a store library. The state here is small and almost
 * all of it is server-owned -- the guild list, the member list, who is online.
 * A reducer and a set of actions over that would be ceremony around what is
 * really "fetch it, then let the socket correct it", which is what the desktop
 * client does in `App.tsx` too.
 *
 * What is deliberately *not* here is message state. Messages are per channel,
 * are paged, and are the one thing that would make this object large and make
 * every screen re-render when a message arrives in a channel nobody is
 * looking at. They live in the channel screen, which is the only thing that
 * draws them.
 */

export type Status = 'connected' | 'connecting' | 'disconnected';

/**
 * How long the per-channel "newest message" sweep is allowed to be reused for.
 *
 * Two minutes is roughly "the screen went off and came back on", which is the
 * case worth suppressing. Anything longer than that and the sweep is worth
 * running again.
 */
const HEADS_MIN_INTERVAL_MS = 120_000;

interface SessionValue {
  /** Null until the stored token has been read and checked. */
  me: Me | null;
  /** True while the app is still deciding whether there is a session. */
  loading: boolean;
  serverUrl: string;
  config: ServerConfig | null;

  guilds: Guild[];
  members: Member[];
  onlineIds: Set<string>;

  status: Status;
  /** The server said it is restarting, so the gap is expected and brief. */
  restarting: boolean;

  /** A published APK newer than this build, or null. */
  update: { version: string; versionCode: number } | null;

  signIn: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<void>;
  register: (
    serverUrl: string,
    body: { username: string; password: string; inviteCode: string },
  ) => Promise<void>;
  signOut: () => Promise<void>;

  /** Name for a user id, from the member list. Null when nobody matches. */
  nameFor: (userId: string) => string | null;
  userFor: (userId: string) => PublicUser | null;
  channelById: (channelId: string) => Channel | null;
  /** The guild a channel belongs to, for search scoping and the drawer header. */
  guildFor: (channelId: string) => Guild | null;
  /** Whether this account may pin, moderate and manage channels. */
  iAmAdmin: boolean;

  /** Registered by the open channel screen so the socket can reach it. */
  setMessageSink: (sink: MessageSink | null) => void;
  /** Bumped on every reconnect, so the open channel knows to backfill. */
  reconnectCount: number;

  /* ------------------------------------------------------------ unread */

  /**
   * Whether a channel holds something this reader has not seen.
   *
   * Phase 2 in the README, and the reason it was deliberately left out until
   * now: `channel:activity` on its own lights a dot that nothing ever clears.
   * It needs the read state beside it, which is what `reads` is -- so the two
   * arrived together or not at all.
   */
  isUnread: (channelId: string) => boolean;
  /** How many unread tags are waiting in a channel. Zero for none. */
  mentionsIn: (channelId: string) => number;
  /** Total across every channel, for the badge on the hamburger button. */
  totalMentions: number;
  /** Any channel at all holding something unread. */
  anyUnread: boolean;
  /** Told by the open channel screen when the reader reaches the live end. */
  markRead: (channelId: string, messageId: string) => void;

  /* ----------------------------------------------------------- settings */

  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  /** Your own profile changed here, or on another device signed in as you. */
  applyMe: (user: PublicUser) => void;

  /**
   * The tag that just arrived while somebody was reading something else, or
   * null. Cleared by the strip that shows it.
   */
  notice: Notice | null;
  dismissNotice: () => void;
}

/** One tag, on its way to the strip at the top of the screen. */
export interface Notice {
  channelId: string;
  /** The message itself, so tapping the strip lands on it rather than near it. */
  messageId: string;
  channelName: string;
  authorName: string;
  /** Already resolved to names -- the strip has no member list of its own. */
  preview: string;
  kind: 'mention' | 'reply';
}

/** What the open channel screen wants told to it, if anything is open. */
export interface MessageSink {
  channelId: string;
  onMessage: (m: Message) => void;
  onUpdated: (m: Message) => void;
  onDeleted: (id: string) => void;
  onTyping: (userId: string, typing: boolean) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [config, setConfig] = useState<ServerConfig | null>(null);

  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  const [status, setStatus] = useState<Status>('disconnected');
  const [restarting, setRestarting] = useState(false);
  const [update, setUpdate] = useState<SessionValue['update']>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  /**
   * Unread state, as three maps keyed by channel id.
   *
   * `reads` is the server's record of how far this account has read. `latest`
   * is the newest message id this client knows of in each channel, which comes
   * from `channel:activity` and from the guild load. A channel is unread when
   * the second is greater than the first -- ids are UUIDv7, so a string
   * comparison is a chronological one and no dates are involved.
   *
   * `mentionCounts` is separate rather than derived, because it answers a
   * different question. Unread moves every time anybody says anything; a tag
   * moves only when somebody says your name, and the two are drawn differently
   * for exactly that reason.
   */
  const [reads, setReads] = useState<Record<string, string>>({});
  const [latest, setLatest] = useState<Record<string, string>>({});
  const [mentionCounts, setMentionCounts] = useState<Record<string, number>>({});

  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [notice, setNotice] = useState<Notice | null>(null);

  /**
   * The channel the reader is looking at, as a ref.
   *
   * Read from socket callbacks that were registered once, so state here would
   * be the value captured at registration -- `null`, forever, which would make
   * every tag in the open channel raise a strip about a message already on
   * screen. The sink below carries the same id and is the thing that knows.
   */
  const openChannel = useRef<string | null>(null);

  /** The member lookup, reachable from the socket handlers. See `byId` below. */
  const byIdRef = useRef<Map<string, PublicUser>>(new Map());

  /** The channel list, for the same reason: `refreshHeads` runs from a socket. */
  const guildsRef = useRef<Guild[]>([]);
  guildsRef.current = guilds;

  /**
   * A ref rather than state: the socket handlers below are registered once,
   * and a sink in state would mean tearing the socket down and rebuilding it
   * every time somebody opened a different channel.
   */
  const sink = useRef<MessageSink | null>(null);
  const setMessageSink = useCallback((next: MessageSink | null) => {
    sink.current = next;
    openChannel.current = next?.channelId ?? null;
  }, []);

  /**
   * The preferences, read once at launch.
   *
   * Not awaited before the app draws: they all have defaults, and a splash
   * screen held open for a SecureStore read is a slower launch to avoid a
   * single frame in which "show embeds" is true when somebody turned it off.
   */
  useEffect(() => {
    let cancelled = false;
    void prefsStore.read().then((saved) => {
      if (!cancelled) setPrefsState(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The preferences, again, as a ref.
   *
   * The socket handlers are registered once and must not be torn down and
   * rebuilt because somebody turned off vibration -- a reconnect costs a
   * backfill in every open channel. So the one handler that reads a preference
   * reads it from here, where it is always current, rather than from a value
   * it closed over when the socket was built.
   */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch };
      // Written from inside the updater so what is persisted is what was
      // stored, rather than a value assembled from a `prefs` this callback
      // closed over an unknown number of renders ago.
      void prefsStore.write(next);
      return next;
    });
  }, []);

  /* ------------------------------------------------------ initial load */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [savedUrl, savedToken] = await Promise.all([
        store.getServerUrl(),
        store.getToken(),
      ]);
      if (cancelled) return;

      setServerUrl(savedUrl);
      configure({ serverUrl: savedUrl, token: savedToken ?? '' });

      if (!savedToken) {
        setLoading(false);
        return;
      }

      try {
        const who = await api.me();
        if (!cancelled) setMe(who);
      } catch (e) {
        // A 401 is a token that has expired or been revoked -- sign out
        // quietly and show the sign-in screen, which is what the person would
        // do next anyway. Anything else is the server being unreachable, and
        // dropping a perfectly good token because the train went into a tunnel
        // would be the worst possible response to a bad connection.
        if (e instanceof ApiError && e.status === 401) {
          await store.clearToken();
          configure({ token: '' });
        } else if (!cancelled) {
          setStatus('disconnected');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------ everything a session needs */

  const refreshGuilds = useCallback(async () => {
    try {
      setGuilds(await api.guilds());
    } catch {
      // The socket will say `guild:changed` again, or the next foreground
      // will refetch. A failed refresh is not worth a message on screen.
    }
  }, []);

  const refreshMembers = useCallback(async () => {
    try {
      const rows = await api.members();
      setMembers(rows);
      setOnlineIds(
        new Set(rows.filter((m) => m.online).map((m) => m.user.id)),
      );
    } catch {
      // As above.
    }
  }, []);

  /**
   * How far this account has read, and what is waiting.
   *
   * Two calls rather than one, matching the server's two routes and the
   * desktop client's two loads. They move on completely different clocks:
   * `reads` changes every time the reader scrolls, `mentions` only when
   * somebody says your name.
   */
  const refreshUnread = useCallback(async () => {
    try {
      const [rows, tags] = await Promise.all([api.reads(), api.mentions()]);

      const read: Record<string, string> = {};
      for (const r of rows) {
        if (r.lastReadMessageId) read[r.channelId] = r.lastReadMessageId;
      }
      setReads(read);

      const counts: Record<string, number> = {};
      for (const t of tags) counts[t.channelId] = t.count;
      setMentionCounts(counts);
    } catch {
      // A dot that is briefly wrong is not worth a message on screen, and the
      // next reconnect asks again.
    }
  }, []);

  /**
   * The newest message in every text channel, one cheap page each.
   *
   * Unread is `latest > lastRead`, and `channel:activity` only ever says what
   * happened while this client was connected -- so without this a phone that was
   * asleep overnight opens with no unread marks at all, which is the one moment
   * they matter most. The desktop client does exactly the same thing in
   * `loadReads`, for the same reason.
   *
   * `limit=1` per channel, in parallel. That is N requests, which is only
   * acceptable because this is a single-server application with a handful of
   * channels -- and it is why the throttle below exists: a phone reconnects
   * every time the screen goes off, and doing this on each of those would be a
   * burst of requests several times an hour for an answer that has usually not
   * changed.
   */
  const lastHeadsAt = useRef(0);
  const refreshHeads = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastHeadsAt.current < HEADS_MIN_INTERVAL_MS) return;
    lastHeadsAt.current = now;

    const texts = guildsRef.current
      .flatMap((g) => g.channels)
      .filter((c) => c.kind === 'TEXT');
    if (texts.length === 0) return;

    const heads = await Promise.all(
      texts.map(async (c) => {
        try {
          const page = await api.history(c.id, undefined, 1);
          // Oldest-first from the API, so the newest of a one-message page is
          // the last entry -- which for a page of one is also the first, and
          // writing it this way keeps it correct if the limit ever changes.
          return [c.id, page.messages[page.messages.length - 1]?.id] as const;
        } catch {
          return [c.id, undefined] as const;
        }
      }),
    );

    setLatest((current) => {
      const next = { ...current };
      for (const [id, head] of heads) {
        // Never backwards: a head fetched a moment ago can lose a race with a
        // `channel:activity` for a newer message, and taking the older one would
        // clear a dot that should be lit.
        if (head && (!next[id] || next[id] < head)) next[id] = head;
      }
      return next;
    });
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const next = await api.config();
      setConfig(next);

      // The update check, run wherever the config is read. `versionCode` and
      // not the semver, because that is the number Android compares -- and
      // because it is the one the server has promised rises with every build.
      const code = next.latestAndroidVersionCode;
      if (
        typeof code === 'number' &&
        code > CLIENT_VERSION_CODE &&
        next.latestAndroidVersion
      ) {
        setUpdate({ version: next.latestAndroidVersion, versionCode: code });
      } else {
        setUpdate(null);
      }
    } catch {
      // An older server has no config route worth failing over.
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    void refreshGuilds();
    void refreshMembers();
    void refreshConfig();
    void refreshUnread();
  }, [me, refreshGuilds, refreshMembers, refreshConfig, refreshUnread]);

  /**
   * The heads, once the channel list is in.
   *
   * Its own effect because it needs `guilds` to have arrived, and forced here
   * rather than throttled: this is the launch, which is the case the throttle
   * exists to protect and not one it should block.
   */
  useEffect(() => {
    if (!me || guilds.length === 0) return;
    void refreshHeads(true);
  }, [me, guilds, refreshHeads]);

  /* --------------------------------------------------------------- auth */

  const afterToken = useCallback(async (url: string, token: string) => {
    await store.setServerUrl(url);
    await store.setToken(token);
    configure({ serverUrl: url, token });
    setServerUrl(url);
    setMe(await api.me());
  }, []);

  const signIn = useCallback(
    async (url: string, username: string, password: string) => {
      const base = normaliseServerUrl(url);
      // The address is passed explicitly rather than configured first: a failed
      // sign-in against a mistyped server must not leave the app pointed at it.
      const { token } = await api.login(username, password, base);
      await afterToken(base, token);
    },
    [afterToken],
  );

  const register = useCallback(
    async (
      url: string,
      body: { username: string; password: string; inviteCode: string },
    ) => {
      const base = normaliseServerUrl(url);
      const { token } = await api.register(body, base);
      await afterToken(base, token);
    },
    [afterToken],
  );

  const signOut = useCallback(async () => {
    disconnectSocket();
    await store.clearToken();
    configure({ token: '' });
    setMe(null);
    setGuilds([]);
    setMembers([]);
    setOnlineIds(new Set());
    setConfig(null);
    setStatus('disconnected');
    // Everything below is about one account's reading. Left behind, the next
    // person to sign in on this phone would be shown somebody else's unread
    // dots until the first refresh replaced them.
    setReads({});
    setLatest({});
    setMentionCounts({});
    setNotice(null);
  }, []);

  /* ------------------------------------------------------------- unread */

  const markRead = useCallback((channelId: string, messageId: string) => {
    // Locally first, and unconditionally: the dot has to go out the moment the
    // reader reaches the bottom, not a round trip later. The server's answer
    // only ever confirms this.
    setReads((current) =>
      // Guarded against going backwards. The list fires this as it scrolls, and
      // a stale call landing after a newer one would put the dot back on a
      // channel somebody is looking at.
      !current[channelId] || current[channelId] < messageId
        ? { ...current, [channelId]: messageId }
        : current,
    );
    setMentionCounts((current) =>
      current[channelId] ? { ...current, [channelId]: 0 } : current,
    );
    void api.markRead(channelId, messageId).catch(() => {
      // Nothing on screen depends on the answer; the next refresh redraws the
      // badges from the server's record either way.
    });
  }, []);

  const isUnread = useCallback(
    (channelId: string) => {
      const newest = latest[channelId];
      if (!newest) return false;
      const seen = reads[channelId];
      // Ids are UUIDv7, so they sort chronologically and a string comparison is
      // a date comparison with no parsing in it.
      return !seen || newest > seen;
    },
    [latest, reads],
  );

  const mentionsIn = useCallback(
    (channelId: string) => mentionCounts[channelId] ?? 0,
    [mentionCounts],
  );

  const totalMentions = useMemo(
    () => Object.values(mentionCounts).reduce((sum, n) => sum + n, 0),
    [mentionCounts],
  );

  const anyUnread = useMemo(
    () =>
      Object.entries(latest).some(
        ([channelId, newest]) => !reads[channelId] || newest > reads[channelId],
      ),
    [latest, reads],
  );

  const applyMe = useCallback((user: PublicUser) => {
    setMe((current) =>
      current && current.id === user.id
        ? { ...current, displayName: user.displayName, image: user.image }
        : current,
    );
    setMembers((rows) =>
      rows.map((row) =>
        row.user.id === user.id ? { ...row, user: { ...row.user, ...user } } : row,
      ),
    );
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  /* ---------------------------------------------------------- the socket */

  useEffect(() => {
    if (!me) {
      disconnectSocket();
      setStatus('disconnected');
      return;
    }

    connectSocket({
      onStatus: (s) => {
        setStatus(s);
        // Whatever the gap was, it is over. Left set, the banner would say
        // "updating" until the next restart.
        if (s === 'connected') setRestarting(false);
      },
      onReconnected: () => {
        setReconnectCount((n) => n + 1);
        void refreshGuilds();
        void refreshMembers();
        void refreshConfig();
        void refreshUnread();
        // Throttled: a phone reconnects every time the screen goes off.
        void refreshHeads();
      },
      onServerRestarting: () => setRestarting(true),

      onMessage: (m) => {
        if (sink.current?.channelId === m.channelId) sink.current.onMessage(m);
        // Also here, and not only in `channel:activity`: the server sends that
        // event for every channel *except* the one this socket has joined, so
        // without this the open channel would be the one place the newest id
        // never moved -- and leaving it would mean walking back into a channel
        // just read and finding it unread.
        setLatest((current) =>
          !current[m.channelId] || current[m.channelId] < m.id
            ? { ...current, [m.channelId]: m.id }
            : current,
        );
      },
      onMessageUpdated: (m) => {
        if (sink.current?.channelId === m.channelId) sink.current.onUpdated(m);
      },
      onMessageDeleted: ({ id, channelId }) => {
        if (sink.current?.channelId === channelId) sink.current.onDeleted(id);
      },
      onTyping: ({ channelId, userId, typing }) => {
        if (sink.current?.channelId === channelId) {
          sink.current.onTyping(userId, typing);
        }
      },

      onChannelActivity: ({ channelId, messageId }) => {
        setLatest((current) =>
          !current[channelId] || current[channelId] < messageId
            ? { ...current, [channelId]: messageId }
            : current,
        );
      },

      /**
       * Somebody said your name.
       *
       * The count moves whatever happens, because that badge is the record of
       * what is waiting. The strip is the part with a judgement in it, and it
       * has exactly one rule: not for the channel already on screen. A banner
       * about a message the reader is looking at is noise, and it is the fastest
       * way to make somebody turn the feature off.
       *
       * This is not a push notification and does not pretend to be one -- the
       * server has no push infrastructure, so none of this happens while the
       * app is closed. What it replaces is the desktop client's ping, which is
       * also only ever heard by somebody with the app open.
       */
      onMention: ({ message, channelName, kind }) => {
        setMentionCounts((current) => ({
          ...current,
          [message.channelId]: (current[message.channelId] ?? 0) + 1,
        }));
        setLatest((current) =>
          !current[message.channelId] || current[message.channelId] < message.id
            ? { ...current, [message.channelId]: message.id }
            : current,
        );

        if (message.channelId === openChannel.current) return;
        const settings = prefsRef.current;
        if (!settings.mentionAlerts) return;

        if (settings.vibrate) {
          // One short buzz. A pattern would be a notification imitating a
          // phone call, for a message in a chat app.
          Vibration.vibrate(40);
        }
        setNotice({
          channelId: message.channelId,
          messageId: message.id,
          channelName,
          authorName: message.author.displayName || message.author.username,
          // Tags resolved here, where the member list is, because the strip is
          // drawn above every screen and has no session of its own to ask.
          preview: quoteLine(
            plainMentions(message.content, (id) => {
              const user = byIdRef.current.get(id);
              return user ? user.displayName || user.username : null;
            }),
            message.attachments.length,
            false,
          ),
          kind: kind ?? 'mention',
        });
      },

      onUserUpdated: (u: PublicUser) => {
        setMembers((rows) =>
          rows.map((row) =>
            row.user.id === u.id ? { ...row, user: { ...row.user, ...u } } : row,
          ),
        );
        // Their own name changing has to move the profile row too.
        setMe((current) =>
          current && current.id === u.id
            ? { ...current, displayName: u.displayName, image: u.image }
            : current,
        );
      },
      onGuildChanged: () => void refreshGuilds(),
      onPresence: ({ userId, online }) => {
        setOnlineIds((prev) => {
          const next = new Set(prev);
          if (online) next.add(userId);
          else next.delete(userId);
          return next;
        });
      },
      onRemoved: () => {
        // Kicked or banned. The server cuts the socket immediately after, so
        // there is no point keeping a token that can no longer read anything.
        void signOut();
      },
      onAndroidUpdate: ({ version, versionCode }) => {
        if (versionCode > CLIENT_VERSION_CODE) setUpdate({ version, versionCode });
      },
    });

    return () => disconnectSocket();
  }, [
    me,
    refreshGuilds,
    refreshMembers,
    refreshConfig,
    refreshUnread,
    refreshHeads,
    signOut,
  ]);

  /* ------------------------------------------------------ foregrounding */

  /**
   * Android freezes a backgrounded app's socket within seconds, and does not
   * always tell it. Coming back to the foreground is therefore the one moment
   * this client can be sure it may have missed something, and the cheapest
   * place to find out.
   *
   * Socket.IO reconnects on its own, but only once it notices -- which can be
   * a ping interval away. Asking it directly is what makes the app feel live
   * the instant it is opened rather than a few seconds later.
   */
  useEffect(() => {
    if (!me) return;

    const onChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      const socket = getSocket();
      if (socket && !socket.connected) socket.connect();
      void refreshConfig();
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [me, refreshConfig]);

  /* ------------------------------------------------------------ lookups */

  const byId = useMemo(() => {
    const map = new Map<string, PublicUser>();
    for (const m of members) map.set(m.user.id, m.user);
    return map;
  }, [members]);

  // The socket handlers resolve names from here rather than from `byId`, which
  // they would have captured empty when the socket was built.
  byIdRef.current = byId;

  const userFor = useCallback(
    (userId: string) => byId.get(userId) ?? null,
    [byId],
  );

  const nameFor = useCallback(
    (userId: string) => {
      const user = byId.get(userId);
      return user ? user.displayName || user.username : null;
    },
    [byId],
  );

  const channelById = useCallback(
    (channelId: string) => {
      for (const guild of guilds) {
        const found = guild.channels.find((c) => c.id === channelId);
        if (found) return found;
      }
      return null;
    },
    [guilds],
  );

  const guildFor = useCallback(
    (channelId: string) =>
      guilds.find((g) => g.channels.some((c) => c.id === channelId)) ?? null,
    [guilds],
  );

  /**
   * Whether this account is an admin anywhere.
   *
   * One flag rather than a per-guild answer, because this is a single-server
   * application with one guild in it -- the desktop client reads the role the
   * same way. What it gates is drawn-or-not: the pin button on a message, the
   * moderation entries in a member's sheet. The server checks every one of
   * those again regardless, so this is about not offering somebody a button
   * that will refuse them, not about permission.
   */
  const iAmAdmin = useMemo(
    () => members.some((m) => m.user.id === me?.id && m.role === 'ADMIN'),
    [members, me],
  );

  const value = useMemo<SessionValue>(
    () => ({
      me,
      loading,
      serverUrl,
      config,
      guilds,
      members,
      onlineIds,
      status,
      restarting,
      update,
      signIn,
      register,
      signOut,
      nameFor,
      userFor,
      channelById,
      guildFor,
      iAmAdmin,
      setMessageSink,
      reconnectCount,
      isUnread,
      mentionsIn,
      totalMentions,
      anyUnread,
      markRead,
      prefs,
      setPrefs,
      applyMe,
      notice,
      dismissNotice,
    }),
    [
      me,
      loading,
      serverUrl,
      config,
      guilds,
      members,
      onlineIds,
      status,
      restarting,
      update,
      signIn,
      register,
      signOut,
      nameFor,
      userFor,
      channelById,
      guildFor,
      iAmAdmin,
      setMessageSink,
      reconnectCount,
      isUnread,
      mentionsIn,
      totalMentions,
      anyUnread,
      markRead,
      prefs,
      setPrefs,
      applyMe,
      notice,
      dismissNotice,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
