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
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
import {
  Composer,
  type EditTarget,
  type ReplyTarget,
  type StagedFile,
} from '../../src/components/Composer';
import { ConnectionBanner } from '../../src/components/Banners';
import { useDrawer } from '../../src/components/Drawer';
import { MessageRow } from '../../src/components/MessageRow';
import { MessageSheet } from '../../src/components/MessageSheet';
import { PinsSheet } from '../../src/components/PinsSheet';
import { Sheet, SheetRow } from '../../src/components/Sheet';
import {
  dayLabel,
  groupsWith,
  guessReactions,
  mentionsMe,
  personName,
  plainMentions,
  quoteLine,
  sameDay,
} from '../../src/format';
import { toPlain, type MentionUser } from '../../src/mention-utils';
import { spacing, TAP_TARGET, theme } from '../../src/theme';
import type { Message, MessageRef } from '../../src/types';

/**
 * One channel: the message list, and everything that acts on it.
 *
 * Messages are held **newest first**, which is the order an inverted list wants
 * and the opposite of the order the API hands them back. The conversion happens
 * once, at the edge, in the history fetch -- doing it per render would be an
 * O(n) copy of the whole channel every time somebody typed a character.
 *
 * Inverted rather than scrolled-to-bottom-on-load: a normal list has to be told
 * to jump to the end after every layout pass, which on a phone means a visible
 * scramble when the keyboard opens and again when an image decides how tall it
 * is. Inverting makes "the bottom" the natural origin, so none of that arises.
 */

/** How many messages a page holds. Matches the desktop client. */
const PAGE = 50;

/** How long a jumped-to message stays lit. Long enough to find, short enough
 *  not to look like a selection that has to be dismissed. */
const FLASH_MS = 1800;

/** A message this client has sent and the server has not yet confirmed. */
interface Pending {
  nonce: string;
  message: Message;
  failed: boolean;
  /** 0..1 while files are going out, null for a message with none. */
  progress: number | null;
  /** Everything needed to send it again, kept for the retry. */
  attempt: {
    content: string;
    files: StagedFile[];
    replyToId?: string;
    replyPing: boolean;
  };
}

export default function ChannelScreen() {
  const { id: channelId, jump } = useLocalSearchParams<{
    id: string;
    /** A message to land on, from a search result or a tag notice. */
    jump?: string;
  }>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const drawer = useDrawer();

  const {
    me,
    members,
    status,
    restarting,
    config,
    prefs,
    iAmAdmin,
    nameFor,
    userFor,
    channelById,
    setMessageSink,
    markRead,
    reconnectCount,
    guilds,
  } = useSession();

  const channel = channelById(channelId);

  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [newerCursor, setNewerCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typingIds, setTypingIds] = useState<string[]>([]);

  const [sheetFor, setSheetFor] = useState<Message | null>(null);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [flashing, setFlashing] = useState<string | null>(null);

  const list = useRef<FlatList<Row> | null>(null);

  /**
   * The newest message id held, as a ref.
   *
   * The backfill reads it from a socket callback that was registered once, so a
   * value from state would be the one captured at registration -- which is
   * `null`, forever. This is the classic stale-closure bug and it would show up
   * only after a reconnect, which is exactly when it matters.
   */
  const newestId = useRef<string | null>(null);
  const lastMarkedRead = useRef<string | null>(null);

  /* ---------------------------------------------------------- the header */

  useLayoutEffect(() => {
    navigation.setOptions({
      title: channel ? `#${channel.name}` : '',
      // The hamburger replaces the back arrow rather than sitting beside it.
      // Going back to the channel list and in again is two screens of animation
      // to do the thing the drawer does in one tap, and the back gesture still
      // works for anybody who reaches for it.
      headerLeft: () => (
        <Pressable
          onPress={drawer.open}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
        >
          <Text style={styles.headerGlyph}>☰</Text>
        </Pressable>
      ),
      headerRight: () => (
        <Pressable
          onPress={() => setShowPins(true)}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Pinned messages"
        >
          <Text style={styles.headerGlyph}>📌</Text>
        </Pressable>
      ),
    });
  }, [navigation, channel, drawer]);

  /* ------------------------------------------------------ message state */

  /**
   * Fold one message into the list, wherever it belongs.
   *
   * Every route in -- the send's own response, the socket broadcast, an edit,
   * the backfill, a reaction -- comes through here, because each of them can
   * arrive after or before the others. The POST response and `message:new` are
   * the same message and routinely race; without one place that reconciles them
   * the sender sees their own message twice, which is the most obvious possible
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
      // backfilled message older than the newest held has to land in the right
      // place rather than on top, or the day separators go wrong.
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
    setReply(null);
    setEdit(null);

    (async () => {
      try {
        const page = await api.history(channelId, undefined, PAGE);
        if (cancelled) return;

        // Oldest-first from the API, newest-first in state. One reverse, here.
        const newestFirst = [...page.messages].reverse();
        setMessages(newestFirst);
        setOlderCursor(page.nextCursor);
        setNewerCursor(null);
        newestId.current = newestFirst[0]?.id ?? null;
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [channelId]);

  /* ----------------------------------------------------------- the room */

  useEffect(() => {
    joinChannel(channelId);
    return () => leaveChannel(channelId);
    // Re-joined on every reconnect: the server's rooms do not survive a dropped
    // socket, so without this a phone that slept goes quiet and only the unread
    // badge would ever say otherwise.
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
   * A phone disconnects every time the screen goes off, so this runs many times
   * an hour -- which is why it walks forward from a cursor rather than
   * refetching the live page and reconciling. Looping, because a phone left in a
   * pocket for an hour can be more than one page behind, and a single call would
   * leave a hole in the middle of the conversation with no sign it was there.
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
          // A short page is the live end. `prevCursor` being null says the same
          // thing, and either is enough to stop.
          if (!page.prevCursor || page.messages.length < PAGE) return;
        }
      } catch {
        // The socket is live either way, so new messages still arrive. A failed
        // backfill costs whatever was said during the gap, which the next
        // reconnect picks up.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reconnectCount, channelId, upsert]);

  /* ------------------------------------------------------------- paging */

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

  /**
   * Walk back down to the live end, after a jump landed in the middle.
   *
   * `newerCursor` is set only by `jumpTo`, so this is a no-op in the ordinary
   * case -- a channel opened normally is already at the live end and has
   * nothing newer to fetch.
   */
  const loadNewer = useCallback(async () => {
    if (!newerCursor) return;
    try {
      const page = await api.historyAfter(channelId, newerCursor, PAGE);
      for (const m of page.messages) upsert(m);
      setNewerCursor(page.prevCursor ?? null);
    } catch {
      // As above.
    }
  }, [channelId, newerCursor, upsert]);

  /* ------------------------------------------------------------ sending */

  /** The request itself, shared by the first attempt and by a retry. */
  const deliver = useCallback(
    async (nonce: string, attempt: Pending['attempt']) => {
      const extra = attempt.replyToId
        ? {
            replyToId: attempt.replyToId,
            // Omitted when true: the server's default is to tag, which is what
            // replying is for, and sending the field only when it is off keeps
            // an ordinary reply an ordinary reply on the wire.
            ...(attempt.replyPing ? {} : { replyPing: false }),
          }
        : {};

      try {
        const saved =
          attempt.files.length > 0
            ? await api.sendWithFiles(
                channelId,
                attempt.content,
                nonce,
                attempt.files,
                extra,
                (fraction) =>
                  setPending((p) =>
                    p.map((x) => (x.nonce === nonce ? { ...x, progress: fraction } : x)),
                  ),
              )
            : await api.send(channelId, attempt.content, nonce, extra);
        // `upsert` drops the placeholder by nonce. The socket broadcast of the
        // same message arrives too and lands on the same id, which is why both
        // routes go through one function.
        upsert(saved);
      } catch {
        setPending((p) =>
          p.map((x) => (x.nonce === nonce ? { ...x, failed: true, progress: null } : x)),
        );
      }
    },
    [channelId, upsert],
  );

  const sendMessage = useCallback(
    async (content: string, files: StagedFile[], replyPing: boolean) => {
      if (!me) return;

      const replyToId = reply?.id;
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
        // The files are on this phone and not yet on the server, so there is no
        // attachment row to draw. The progress bar under the message is what
        // says they are on their way.
        attachments: [],
      };

      setPending((p) => [
        {
          nonce,
          message: optimistic,
          failed: false,
          progress: files.length > 0 ? 0 : null,
          attempt: { content, files, replyToId, replyPing },
        },
        ...p,
      ]);
      setReply(null);

      await deliver(nonce, { content, files, replyToId, replyPing });
    },
    [channelId, me, reply, deliver],
  );

  const retry = useCallback(
    (message: Message) => {
      const nonce = message.clientNonce;
      if (!nonce) return;
      setPending((p) =>
        p.map((x) =>
          x.nonce === nonce
            ? { ...x, failed: false, progress: x.attempt.files.length > 0 ? 0 : null }
            : x,
        ),
      );
      const held = pending.find((x) => x.nonce === nonce);
      if (held) void deliver(nonce, held.attempt);
    },
    [pending, deliver],
  );

  const discard = useCallback((nonce: string) => {
    setPending((p) => p.filter((x) => x.nonce !== nonce));
  }, []);

  /* --------------------------------------------------------- the actions */

  /**
   * A long press, routed.
   *
   * A message the server has not accepted yet has no id anything can point at
   * -- its `id` is `pending-<nonce>`, made up here -- so replying to it,
   * pinning it or reacting to it would send the server a reference to a message
   * that does not exist. The sheet is therefore only for confirmed messages,
   * and the one that is still on its way gets the only two answers that mean
   * anything for it.
   */
  const openSheet = useCallback(
    (message: Message) => {
      const held = pending.find((x) => x.message.id === message.id);
      if (!held) {
        setSheetFor(message);
        return;
      }
      if (!held.failed) return;

      Alert.alert('This message was not sent', held.attempt.content || undefined, [
        { text: 'Leave it', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => discard(held.nonce) },
        { text: 'Try again', onPress: () => void deliver(held.nonce, held.attempt) },
      ]);
    },
    [pending, discard, deliver],
  );


  const beginReply = useCallback(
    (message: Message) => {
      setEdit(null);
      setReply({
        id: message.id,
        authorName: personName(message.author),
        preview: quoteLine(
          plainMentions(message.content, nameFor),
          message.attachments.length,
          false,
        ),
      });
    },
    [nameFor],
  );

  const beginEdit = useCallback(
    (message: Message) => {
      setReply(null);
      // Markers back into names, so the box holds what the reader sees rather
      // than a row of ids. `toMarkup` converts them back on the way out, and a
      // tag naming somebody who has left survives the round trip untouched.
      setEdit({ id: message.id, text: toPlain(message.content, userFor) });
    },
    [userFor],
  );

  const saveEdit = useCallback(
    async (id: string, content: string) => {
      setEdit(null);
      try {
        upsert(await api.editMessage(channelId, id, content));
      } catch (e) {
        Alert.alert(
          'That edit did not save',
          e instanceof ApiError ? e.message : 'Check the connection and try again.',
        );
      }
    },
    [channelId, upsert],
  );

  const confirmDelete = useCallback(
    (message: Message) => {
      Alert.alert(
        'Delete this message?',
        // The text itself, so the confirmation is about a message rather than
        // about the word "message". On a phone the one being deleted is usually
        // behind the sheet that offered to delete it.
        quoteLine(plainMentions(message.content, nameFor), message.attachments.length, false),
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              // Removed here rather than waiting for the broadcast: the socket
              // will say the same thing a moment later and `remove` is
              // idempotent, but a row that lingers after a confirmed delete
              // reads as a delete that failed.
              remove(message.id);
              void api.deleteMessage(channelId, message.id).catch(() => {
                Alert.alert('That message could not be deleted.');
              });
            },
          },
        ],
      );
    },
    [channelId, nameFor, remove],
  );

  const togglePin = useCallback(
    async (message: Message, pinned: boolean) => {
      try {
        if (pinned) {
          await api.unpinMessage(channelId, message.id);
          upsert({ ...message, pinnedAt: null });
        } else {
          upsert(await api.pinMessage(channelId, message.id));
        }
      } catch (e) {
        Alert.alert(
          pinned ? 'That could not be unpinned' : 'That could not be pinned',
          e instanceof ApiError ? e.message : 'Try again in a moment.',
        );
      }
    },
    [channelId, upsert],
  );

  const toggleReaction = useCallback(
    async (message: Message, emoji: string, mine: boolean) => {
      if (!me) return;
      // Optimistic, and replaced wholesale by the server's answer a moment
      // later. The worst it can be is briefly wrong about somebody else's tap.
      upsert({
        ...message,
        reactions: guessReactions(message.reactions ?? [], emoji, mine, me.id),
      });
      try {
        const reactions = mine
          ? await api.unreact(channelId, message.id, emoji)
          : await api.react(channelId, message.id, emoji);
        upsert({ ...message, reactions });
      } catch {
        // Put it back. A reaction that stayed on screen after the server
        // refused it is a lie the next reload would silently correct.
        upsert(message);
      }
    },
    [channelId, me, upsert],
  );

  const forward = useCallback(
    async (message: Message, toChannelId: string) => {
      setForwarding(null);
      try {
        await api.send(toChannelId, '', `${Date.now()}-fwd`, {
          forwardedFromId: message.id,
        });
        const name = channelById(toChannelId)?.name ?? 'the channel';
        Alert.alert(`Forwarded to #${name}`);
      } catch (e) {
        Alert.alert(
          'That could not be forwarded',
          e instanceof ApiError ? e.message : 'Try again in a moment.',
        );
      }
    },
    [channelById],
  );

  /* ---------------------------------------------------------- jumping */

  /**
   * Go to a message, wherever it is.
   *
   * Two cases, and the cheap one is worth keeping separate: a message already in
   * the list is a scroll, and a message further back is a fetch of the page
   * around it. `historyAround` comes back with both cursors set, because a
   * window in the middle of a channel has history above it and live messages
   * below -- which is what `newerCursor` is for.
   */
  const jumpTo = useCallback(
    async (messageId: string) => {
      setShowPins(false);
      setFlashing(messageId);
      setTimeout(() => setFlashing((id) => (id === messageId ? null : id)), FLASH_MS);

      const index = messages.findIndex((m) => m.id === messageId);
      if (index >= 0) {
        // `pending` sits in front of the confirmed messages in `rows`, so the
        // index has to be shifted past it.
        list.current?.scrollToIndex({
          index: index + pending.length,
          animated: true,
          viewPosition: 0.5,
        });
        return;
      }

      try {
        const page = await api.historyAround(channelId, messageId, PAGE);
        const newestFirst = [...page.messages].reverse();
        setMessages(newestFirst);
        setOlderCursor(page.nextCursor);
        setNewerCursor(page.prevCursor ?? null);
        newestId.current = newestFirst[0]?.id ?? null;

        const at = newestFirst.findIndex((m) => m.id === messageId);
        if (at >= 0) {
          // After the list has been handed the new data. Without the tick the
          // index is measured against the page that is on its way out.
          setTimeout(
            () =>
              list.current?.scrollToIndex({
                index: at,
                animated: false,
                viewPosition: 0.5,
              }),
            60,
          );
        }
      } catch {
        Alert.alert('That message could not be loaded.');
      }
    },
    [channelId, messages, pending.length],
  );

  /* ----------------------------------------------------------- landing */

  /**
   * A message this screen was opened to show.
   *
   * Run once per `jump`, after the first page has landed -- the ordinary load is
   * already in flight when this screen mounts, and racing it would mean two
   * pages of history arriving in an order neither of them chose. A ref rather
   * than state because nothing on screen depends on it and re-running would
   * yank the reader back every time the list changed.
   */
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!jump || loading || jumped.current === jump) return;
    jumped.current = jump;
    void jumpTo(jump);
  }, [jump, loading, jumpTo]);

  /* --------------------------------------------------------- read marks */

  /**
   * Tell the server what has been read, once the newest message is on screen.
   *
   * Guarded by a ref rather than debounced: the list fires this on every scroll
   * frame, and the thing worth avoiding is not the frequency but the repetition
   * -- marking the same id read forty times is forty requests that all say what
   * the first one did.
   *
   * Only at the live end. After a jump into the middle of the channel the
   * newest message held is not the newest there is, and saying otherwise would
   * clear an unread badge for messages nobody has seen.
   */
  useEffect(() => {
    if (newerCursor) return;
    const newest = messages[0]?.id;
    if (!newest || newest === lastMarkedRead.current) return;
    lastMarkedRead.current = newest;
    markRead(channelId, newest);
  }, [messages, channelId, markRead, newerCursor]);

  /* ---------------------------------------------------------- rendering */

  /**
   * The list the screen actually draws: pending messages on top of confirmed
   * ones, which in a newest-first array means simply in front.
   */
  const rows = useMemo<Row[]>(() => {
    const confirmed = messages.map((message) => ({
      message,
      pendingState: null as Pending | null,
    }));
    const optimistic = pending.map((p) => ({ message: p.message, pendingState: p }));
    return [...optimistic, ...confirmed];
  }, [messages, pending]);

  /** The member list, as the composer's picker wants it. */
  const people = useMemo<MentionUser[]>(
    () => members.map((m) => m.user),
    [members],
  );

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

  /** Where a forward may go: every text channel in the guild, this one last. */
  const forwardTargets = useMemo(
    () =>
      guilds.flatMap((guild) =>
        guild.channels
          .filter((c) => c.kind === 'TEXT')
          .sort((a, b) => a.position - b.position),
      ),
    [guilds],
  );

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
        ref={list}
        inverted
        data={rows}
        keyExtractor={(row) => row.message.id}
        style={styles.list}
        // The list is inverted, so "the end" is the *oldest* message and this is
        // what pages backwards through history.
        onEndReached={loadOlder}
        onEndReachedThreshold={0.6}
        // And the *start* is the live end, which only has anything to fetch
        // after a jump landed in the middle of the channel.
        onStartReached={loadNewer}
        onStartReachedThreshold={0.4}
        keyboardDismissMode="interactive"
        // A jump asks for an index the list has not measured yet whenever the
        // target is far off screen. Without this that throws; with it the list
        // scrolls as close as it can and the second attempt lands.
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          setTimeout(
            () =>
              list.current?.scrollToIndex({
                index: info.index,
                animated: false,
                viewPosition: 0.5,
              }),
            80,
          );
        }}
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
          // `rows` is newest-first, so the message *above* this one on screen is
          // the next index, not the previous one. Getting this backwards groups
          // a message with the one that follows it, which looks almost right and
          // is why it is worth saying out loud.
          const above = rows[index + 1]?.message;
          const grouped = above ? groupsWith(above, item.message) : false;
          const needsDay =
            !above || !sameDay(above.createdAt, item.message.createdAt);

          return (
            <View>
              {/* First in the cell, not last. `inverted` reverses the order of
                  the cells but flips each one back, so layout *inside* a cell is
                  ordinary top-to-bottom -- and the top of this cell is the gap
                  between this message and the older one above it, which is where
                  a day separator belongs. */}
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
                progress={item.pendingState?.progress ?? null}
                flashing={flashing === item.message.id}
                meId={me?.id ?? ''}
                nameFor={nameFor}
                showEmbeds={prefs.showEmbeds}
                autoplayEmbeds={prefs.autoplayEmbeds}
                onLongPress={openSheet}
                onToggleReaction={toggleReaction}
                onJumpToRef={jumpToRef}
                onRetry={retry}
              />
            </View>
          );
        }}
      />

      {typingLabel && <Text style={styles.typing}>{typingLabel}</Text>}

      <Composer
        channelName={channel?.name ?? 'channel'}
        disabled={status !== 'connected'}
        people={people}
        enterSends={prefs.enterSends}
        maxUploadBytes={config?.maxUploadBytes ?? null}
        reply={reply}
        onCancelReply={() => setReply(null)}
        edit={edit}
        onCancelEdit={() => setEdit(null)}
        onSend={sendMessage}
        onSaveEdit={saveEdit}
        onTypingStart={() => typingStart(channelId)}
        onTypingStop={() => typingStop(channelId)}
      />

      <View style={{ height: insets.bottom, backgroundColor: theme.bg }} />

      <MessageSheet
        message={sheetFor}
        meId={me?.id ?? ''}
        iAmAdmin={iAmAdmin}
        nameFor={nameFor}
        onClose={() => setSheetFor(null)}
        onReply={beginReply}
        onEdit={beginEdit}
        onDelete={confirmDelete}
        onForward={setForwarding}
        onPin={togglePin}
        onReact={toggleReaction}
      />

      <PinsSheet
        visible={showPins}
        channelId={channelId}
        channelName={channel?.name ?? 'channel'}
        canPin={iAmAdmin}
        nameFor={nameFor}
        meId={me?.id ?? ''}
        onJump={jumpTo}
        onUnpin={(m) => void togglePin(m, true)}
        onClose={() => setShowPins(false)}
      />

      <Sheet
        visible={Boolean(forwarding)}
        onClose={() => setForwarding(null)}
        title="Forward to"
      >
        {forwardTargets.map((c) => (
          <SheetRow
            key={c.id}
            icon="#"
            label={c.name}
            onPress={() => forwarding && void forward(forwarding, c.id)}
          />
        ))}
      </Sheet>
    </KeyboardAvoidingView>
  );

  /** A quoted message's jump. Its own function so the row prop stays stable. */
  function jumpToRef(ref: MessageRef) {
    if (ref.channelId !== channelId) return;
    void jumpTo(ref.id);
  }
}

/** One cell of the list: a message, and its pending state if it has one. */
interface Row {
  message: Message;
  pendingState: Pending | null;
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
  headerButton: {
    minWidth: TAP_TARGET,
    height: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerGlyph: { color: theme.text, fontSize: 18 },
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
  dayLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
  },
  dayLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  typing: {
    color: theme.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
});
