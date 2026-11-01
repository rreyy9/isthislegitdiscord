import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../src/api';
import { Avatar } from '../src/components/Avatar';
import { BottomTabs } from '../src/components/BottomTabs';
import { ConnectionBanner } from '../src/components/Banners';
import { Icon } from '../src/components/Icon';
import { dmTitle, useSession } from '../src/session';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';
import type { DirectMessage } from '../src/types';

/** The newest message in a conversation, opened, for the line under its name. */
interface Preview {
  id: string;
  text: string;
  mine: boolean;
  at: string;
}

/**
 * The Messages tab: every direct message, newest first.
 *
 * Each row's preview is the conversation's newest message, fetched and
 * decrypted here -- the server cannot say what it was, so the list asks for
 * one message per conversation and opens it on the phone. Ten people means a
 * handful of tiny requests, and only for conversations that moved.
 */
export default function Messages() {
  const { me, dms, onlineIds, status, restarting, hideDm, isUnread, mentionsIn } = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [previews, setPreviews] = useState<Record<string, Preview>>({});

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: 'Messages',
      headerLeft: () => null,
      headerRight: () => (
        <Pressable
          onPress={() => router.push('/new-message' as never)}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="New message"
        >
          <Icon name="square-edit-outline" size={24} color={theme.accent} />
        </Pressable>
      ),
    });
  }, [navigation, router]);

  useEffect(() => {
    let live = true;
    for (const dm of dms) {
      if (!dm.lastMessageId || previews[dm.channelId]?.id === dm.lastMessageId) continue;
      api
        .history(dm.channelId, undefined, 1)
        .then((page) => {
          const m = page.messages[page.messages.length - 1];
          if (!live || !m) return;
          const text = m.sealedError
            ? '🔒 Encrypted message'
            : m.content.trim() ||
              (m.attachments.length ? 'Sent an attachment' : 'Forwarded a message');
          setPreviews((current) => ({
            ...current,
            [dm.channelId]: { id: m.id, text, mine: m.author.id === me?.id, at: m.createdAt },
          }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // `previews` is read only to skip what is already known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dms, me?.id]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dms;
    return dms.filter(
      (d) =>
        dmTitle(d).toLowerCase().includes(q) ||
        d.users.some((u) => u.username.toLowerCase().includes(q)),
    );
  }, [dms, query]);

  const closeRow = (dm: DirectMessage) =>
    Alert.alert(`Close ${dmTitle(dm)}?`, 'It comes back with the next message.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: () => hideDm(dm.channelId) },
    ]);

  return (
    <View style={styles.flex}>
      <ConnectionBanner status={status} restarting={restarting} />
      <View style={styles.searchWrap}>
        <Icon name="magnify" size={18} color={theme.textFaint} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search people"
          placeholderTextColor={theme.textFaint}
        />
      </View>

      <FlatList
        data={shown}
        keyExtractor={(d) => d.channelId}
        contentContainerStyle={shown.length === 0 && styles.emptyWrap}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="message-text-lock-outline" size={40} color={theme.textFaint} />
            <Text style={styles.emptyTitle}>
              {query ? 'Nobody matches' : 'No conversations yet'}
            </Text>
            {!query && (
              <Pressable
                style={styles.emptyButton}
                onPress={() => router.push('/new-message' as never)}
              >
                <Text style={styles.emptyButtonText}>Start one</Text>
              </Pressable>
            )}
          </View>
        }
        renderItem={({ item: dm }) => {
          const first = dm.users[0];
          const count = mentionsIn(dm.channelId);
          const unread = count > 0 || isUnread(dm.channelId);
          const p = previews[dm.channelId];
          const gone = dm.kind === 'direct' && !dm.canSend;
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              onPress={() => router.push(`/channel/${dm.channelId}` as never)}
              onLongPress={() => closeRow(dm)}
              accessibilityRole="button"
              accessibilityLabel={`${dmTitle(dm)}${count ? `, ${count} unread` : ''}`}
            >
              {dm.kind === 'direct' && first ? (
                <Avatar
                  userId={first.id}
                  name={dmTitle(dm)}
                  image={first.image}
                  size={44}
                  online={!gone && onlineIds.has(first.id)}
                />
              ) : (
                <View style={styles.groupIcon}>
                  <Icon name="account-group" size={22} color={theme.text} />
                </View>
              )}
              <View style={styles.rowText}>
                <View style={styles.rowTop}>
                  <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
                    {dmTitle(dm)}
                  </Text>
                  {p && <Text style={styles.time}>{when(p.at)}</Text>}
                </View>
                <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
                  {p
                    ? `${p.mine ? 'You: ' : ''}${p.text}`
                    : dm.kind === 'group'
                      ? `${dm.users.length + 1} members`
                      : gone
                        ? 'Not on your server'
                        : first && onlineIds.has(first.id)
                          ? 'Online'
                          : 'Offline'}
                </Text>
              </View>
              {count > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
                </View>
              )}
            </Pressable>
          );
        }}
      />

      <BottomTabs active="messages" bottomInset={insets.bottom} />
    </View>
  );
}

/** "20:14" today, "Mon" this week, "28 Oct" before that. */
function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (now.getTime() - d.getTime() < 6 * 24 * 3600 * 1000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  headerButton: {
    minWidth: TAP_TARGET,
    height: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: theme.surfaceAlt,
    borderRadius: radius.md,
  },
  search: { flex: 1, color: theme.text, fontSize: 15, paddingVertical: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  pressed: { backgroundColor: theme.surfaceAlt },
  groupIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  name: { flex: 1, color: theme.text, fontSize: 15, fontWeight: '600' },
  nameUnread: { fontWeight: '800' },
  time: { color: theme.textFaint, fontSize: 12 },
  preview: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  previewUnread: { color: theme.text, fontWeight: '600' },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    backgroundColor: theme.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  emptyWrap: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  emptyTitle: { color: theme.textMuted, fontSize: 15 },
  emptyButton: {
    backgroundColor: theme.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  emptyButtonText: { color: theme.accentText, fontWeight: '700' },
});
