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
import { AppState, type AppStateStatus } from 'react-native';
import { api, ApiError, configure } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';
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

  /** Registered by the open channel screen so the socket can reach it. */
  setMessageSink: (sink: MessageSink | null) => void;
  /** Bumped on every reconnect, so the open channel knows to backfill. */
  reconnectCount: number;
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
   * A ref rather than state: the socket handlers below are registered once,
   * and a sink in state would mean tearing the socket down and rebuilding it
   * every time somebody opened a different channel.
   */
  const sink = useRef<MessageSink | null>(null);
  const setMessageSink = useCallback((next: MessageSink | null) => {
    sink.current = next;
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
  }, [me, refreshGuilds, refreshMembers, refreshConfig]);

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
  }, []);

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
      },
      onServerRestarting: () => setRestarting(true),

      onMessage: (m) => {
        if (sink.current?.channelId === m.channelId) sink.current.onMessage(m);
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

      onChannelActivity: () => {
        // Phase 2: this is what lights the unread dot on the channel list.
        // Deliberately ignored rather than half-implemented -- a dot that
        // appears and never clears is worse than no dot.
      },
      onMention: () => {
        // Phase 3, with notifications. Nothing useful to do with it while the
        // app is in the foreground and the message is already on screen.
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
  }, [me, refreshGuilds, refreshMembers, refreshConfig, signOut]);

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
      setMessageSink,
      reconnectCount,
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
      setMessageSink,
      reconnectCount,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
