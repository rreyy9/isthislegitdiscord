import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError } from '../../src/api';
import {
  joinChannel,
  leaveChannel,
  typingStart,
  typingStop,
} from '../../src/socket';
import { useSession } from '../../src/session';
import { Composer } from '../../src/components/Composer';
import { ConnectionBanner } from '../../src/components/Banners';
import { MessageRow } from '../../src/components/MessageRow';
import { dayLabel, groupsWith, mentionsMe, sameDay } from '../../src/format';
import { spacing, theme } from '../../src/theme';
import type { Message } from '../../src/types';

/**
 * One channel: the message list, and the box under it.
 *
 * Messages are held **newest first**, which is the order an inverted list
 * wants and the opposite of the order the API hands them back. The conversion
 * happens once, at the edge, in `pageIntoState` -- doing it per render would
 * be an O(n) copy of the whole channel every time somebody typed a character.
 *
 * Inverted rather than scrolled-to-bottom-on-load: a normal list has to be
 * told to jump to the end after every layout pass, which on a phone means a
 * visible scramble when the keyboard opens and again when an image decides how
 * tall it is. Inverting makes "the bottom" the natural origin, so none of that
 * arises.
 */

/** How many messages a page holds. Matches the desktop client. */
const PAGE = 50;

/** A message this client has sent and the server has not yet confirmed. */
interface Pending {
  nonce: string;
  message: Message;
  failed: boolean;
}

export default function ChannelScreen() {
  const { id: channelId } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const {
    me,
    status,
    restarting,
    nameFor,
    channelById,
    setMessageSink,
    reconnectCount,
  } = useSession();

  const channel = channelById(channelId);

  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typingIds, setTypingIds] = useState<string[]>([]);

  /**
   * The newest message id held, as a ref.
   *
   * The backfill reads it from a socket callback that was registered once, so
   * a value from state would be the one captured at registration -- which is
   * `null`, forever. This is the classic stale-closure bug and it would show
   * up only after a reconnect, which is exactly when it matters.
   */
  const newestId = useRef<string | null>(null);
  const lastMarkedRead = useRef<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: channel ? `#${channel.name}` : '' });
  }, [navigation, channel]);

  /* ------------------------------------------------------ message state */

  /**
   * Fold one message into the list, wherever it belongs.
   *
   * Every route in -- the send's own response, the socket broadcast, an edit,
   * the backfill -- comes through here, because each of them can arrive after
   * or before the others. The POST response and `message:new` are the same
   * message and routinely race; without one place that reconciles them the
   * sender sees their own message twice, which is the most obvious possible
   * bug and one only the sender ever sees.
   */
  const upsert = useCallback((incoming: Message) => {
    setMessages((current) => {
      const at = current.findIndex((m) => m.id === incoming.id);
      if (at >= 0) {
        const next = [...current];
        next[at] = incoming;
        return next;
      }
      // Newest first, and ids are UUIDv7 so they sort chronologically. A
      // backfilled message that is older than the newest held has to land in
      // the right place rather than on top, or the day separators go wrong.
      const index = current.findIndex((m) => m.id < incoming.id);
      if (index === -1) return [...current, incoming];
      return [...current.slice(0, index), incoming, ...current.slice(index)];
    });

    if (!newestId.current || incoming.id > newestId.current) {
      newestId.current = incoming.id;
    }

    // Its own send coming back: drop the placeholder that was standing in.
    if (incoming.clientNonce) {
      setPending((p) => p.filter((x) => x.nonce !== incoming.clientNonce));
    }
  }, []);

  const remove = useCallback((id: string) => {
    setMessages((current) => current.filter((m) => m.id !== id));
  }, []);

  /* --------------------------------------------------------- first load */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const page = await api.history(channelId, undefined, PAGE);
        if (cancelled) return;

        // Oldest-first from the API, newest-first in state. One reverse, here.
        const newestFirst = [...page.messages].reverse();
        setMessages(newestFirst);
        setOlderCursor(page.nextCursor);
        newestId.current = newestFirst[0]?.id ?? null;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [channelId]);

  /* ---------------------------------------------------------- the room */

  useEffect(() => {
    joinChannel(channelId);
    return () => leaveChannel(channelId);
    // Re-joined on every reconnect: the server's rooms do not survive a
    // dropped socket, so without this a phone that slept goes quiet and only
    // the unread dot would ever say otherwise.
  }, [channelId, reconnectCount]);

  useEffect(() => {
    setMessageSink({
      channelId,
      onMessage: upsert,
      onUpdated: upsert,
      onDeleted: remove,
      onTyping: (userId, typing) => {
        setTypingIds((ids) => {
          if (typing) return ids.includes(userId) ? ids : [...ids, userId];
          return ids.filter((x) => x !== userId);
        });
      },
    });
    return () => setMessageSink(null);
  }, [channelId, upsert, remove, setMessageSink]);

  /* ------------------------------------------------------- the backfill */

  /**
   * Walk forward from the newest message held, after every reconnect.
   *
   * A phone disconnects every time the screen goes off, so this runs many
   * times an hour -- which is why it walks forward from a cursor rather than
   * refetching the live page and reconciling. Refetching would be a page of
   * fifty messages and a diff, mostly to discover nothing had happened.
   *
   * Looping, because a phone left in a pocket for an hour can be more than one
   * page behind, and a single call would leave a hole in the middle of the
   * conversation with no sign that it was there.
   */
  useEffect(() => {
    if (reconnectCount === 0) return;
    let cancelled = false;

    (async () => {
      try {
        for (let guard = 0; guard < 20; guard += 1) {
          const cursor = newestId.current;
          if (!cursor || cancelled) return;

          const page = await api.historyAfter(channelId, cursor, PAGE);
          if (cancelled) return;

          for (const m of page.messages) upsert(m);
          // A short page is the live end. `prevCursor` being null says the
          // same thing, and either is enough to stop.
          if (!page.prevCursor || page.messages.length < PAGE) return;
        }
      } catch {
        // The socket is live either way, so new messages still arrive. A
        // failed backfill costs whatever was said during the gap, which the
        // next reconnect will pick up.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reconnectCount, channelId, upsert]);

  /* ----------------------------------------------------------- paging */

  const loadOlder = useCallback(async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.history(channelId, olderCursor, PAGE);
      // Oldest-first from the API; these all belong at the far end of a
      // newest-first list, so the reverse then a plain append is correct and
      // does not need `upsert`'s search.
      setMessages((current) => [...current, ...[...page.messages].reverse()]);
      setOlderCursor(page.nextCursor);
    } catch {
      // Leave the cursor where it is; scrolling again retries.
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, olderCursor, loadingOlder]);

  /* ------------------------------------------------------------ sending */

  const sendMessage = useCallback(
    async (content: string) => {
      if (!me) return;

      // A nonce the server echoes back, which is what lets the optimistic copy
      // be matched to the real one rather than guessed at by content.
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const optimistic: Message = {
        id: `pending-${nonce}`,
        channelId,
        author: {
          id: me.id,
          username: me.username ?? '',
          displayName: me.displayName,
          image: me.image,
        },
        content,
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        clientNonce: nonce,
        attachments: [],
      };

      setPending((p) => [{ nonce, message: optimistic, failed: false }, ...p]);

      try {
        const saved = await api.send(channelId, content, nonce);
        // `upsert` drops the placeholder by nonce. The socket broadcast of the
        // same message arrives too and lands on the same id, which is why both
        // routes go through one function.
        upsert(saved);
      } catch {
        setPending((p) =>
          p.map((x) => (x.nonce === nonce ? { ...x, failed: true } : x)),
        );
      }
    },
    [channelId, me, upsert],
  );

  /* --------------------------------------------------------- read marks */

  /**
   * Tell the server what has been read, once the newest message is on screen.
   *
   * Guarded by a ref rather than debounced: the list fires this on every
   * scroll frame, and the thing worth avoiding is not the frequency but the
   * repetition -- marking the same id read forty times is forty requests that
   * all say what the first one did.
   */
  useEffect(() => {
    const newest = messages[0]?.id;
    if (!newest || newest === lastMarkedRead.current) return;
    lastMarkedRead.current = newest;
    void api.markRead(channelId, newest).catch(() => {
      // Nothing on screen depends on this; the badge is redrawn from the
      // server's answer next time the list is fetched.
      lastMarkedRead.current = null;
    });
  }, [messages, channelId]);

  /* ---------------------------------------------------------- rendering */

  /**
   * The list the screen actually draws: pending messages on top of confirmed
   * ones, which in a newest-first array means simply in front.
   */
  const rows = useMemo(() => {
    const confirmed = messages.map((message) => ({
      message,
      pendingState: null as Pending | null,
    }));
    const optimistic = pending.map((p) => ({ message: p.message, pendingState: p }));
    return [...optimistic, ...confirmed];
  }, [messages, pending]);

  const typingLabel = useMemo(() => {
    const names = typingIds
      .filter((id) => id !== me?.id)
      .map((id) => nameFor(id))
      .filter((n): n is string => Boolean(n));

    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return 'Several people are typing…';
  }, [typingIds, nameFor, me]);

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={insets.top + 44}
    >
      <ConnectionBanner status={status} restarting={restarting} />

      <FlatList
        inverted
        data={rows}
        keyExtractor={(row) => row.message.id}
        style={styles.list}
        // The list is inverted, so "the end" is the *oldest* message and this
        // is what pages backwards through history.
        onEndReached={loadOlder}
        onEndReachedThreshold={0.6}
        keyboardDismissMode="interactive"
        ListFooterComponent={
          loadingOlder ? (
            <ActivityIndicator style={styles.older} color={theme.textMuted} />
          ) : !olderCursor && messages.length > 0 ? (
            <Text style={styles.start}>
              This is the beginning of #{channel?.name ?? 'the channel'}.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.empty}>Nothing here yet. Say something.</Text>
        }
        renderItem={({ item, index }) => {
          // `rows` is newest-first, so the message *above* this one on screen
          // is the next index, not the previous one. Getting this backwards
          // groups a message with the one that follows it, which looks almost
          // right and is why it is worth saying out loud.
          const above = rows[index + 1]?.message;
          const grouped = above ? groupsWith(above, item.message) : false;
          const needsDay =
            !above || !sameDay(above.createdAt, item.message.createdAt);

          return (
            <View>
              {/* First in the cell, not last. `inverted` reverses the order of
                  the cells but flips each one back, so layout *inside* a cell
                  is ordinary top-to-bottom -- and the top of this cell is the
                  gap between this message and the older one above it, which is
                  where a day separator belongs. */}
              {needsDay && (
                <View style={styles.day}>
                  <View style={styles.dayLine} />
                  <Text style={styles.dayLabel}>
                    {dayLabel(item.message.createdAt)}
                  </Text>
                  <View style={styles.dayLine} />
                </View>
              )}
              <MessageRow
                message={item.message}
                grouped={grouped && !needsDay}
                highlighted={me ? mentionsMe(item.message, me.id) : false}
                pending={Boolean(item.pendingState && !item.pendingState.failed)}
                failed={item.pendingState?.failed}
                meId={me?.id ?? ''}
                nameFor={nameFor}
              />
            </View>
          );
        }}
      />

      {typingLabel && <Text style={styles.typing}>{typingLabel}</Text>}

      <Composer
        channelName={channel?.name ?? 'channel'}
        disabled={status !== 'connected'}
        onSend={sendMessage}
        onTypingStart={() => typingStart(channelId)}
        onTypingStop={() => typingStop(channelId)}
      />

      <View style={{ height: insets.bottom, backgroundColor: theme.bg }} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  list: { flex: 1 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bg,
    padding: spacing.lg,
  },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  // No `scaleY: -1` on these, which is the tempting fix and the wrong one.
  // VirtualizedList already composes its inversion transform onto the header,
  // the footer and the empty component; adding another here would either
  // double-flip them or override the one that was correcting them, and both
  // land upside down.
  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    fontSize: 14,
  },
  older: { marginVertical: spacing.md },
  start: {
    color: theme.textFaint,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  day: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  dayLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  typing: {
    color: theme.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
});
