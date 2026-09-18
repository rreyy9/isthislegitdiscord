import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectionBanner, UpdateBanner } from '../src/components/Banners';
import { Avatar } from '../src/components/Avatar';
import { useDrawer } from '../src/components/Drawer';
import { useSession } from '../src/session';
import { channelIcon } from '../src/format';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';
import type { Channel } from '../src/types';

/**
 * The channel list: this app's home.
 *
 * A `SectionList` keyed by guild, because a guild with its channels is exactly
 * what `GET /api/guilds` hands back and exactly how people think about it.
 * Sorted by `position`, which is the server's ordering and the same one the
 * desktop sidebar draws -- two clients disagreeing about the order of the
 * channel list would be immediately obvious and immediately annoying.
 *
 * Almost everything that used to be reachable only from here now lives in the
 * drawer, which is reachable from inside a channel too. What this screen keeps
 * is being the place the app opens to, and the place the back gesture comes
 * back to -- so it is worth it being the same list, rather than a home screen
 * that shows something else.
 *
 * Voice channels are listed but not joinable. They are drawn rather than
 * filtered out because a channel list that silently omits half the channels
 * looks like a sync bug; drawn and dimmed, it reads as "not yet", which is what
 * it is.
 */

export default function Channels() {
  const {
    guilds,
    members,
    onlineIds,
    me,
    status,
    restarting,
    update,
    isUnread,
    mentionsIn,
    totalMentions,
  } = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const drawer = useDrawer();
  const insets = useSafeAreaInsets();

  const [refreshing, setRefreshing] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState<number | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <Pressable
          onPress={drawer.open}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel={
            totalMentions > 0
              ? `Open menu, ${totalMentions} unread mentions`
              : 'Open menu'
          }
        >
          <Text style={styles.headerGlyph}>☰</Text>
          {/* The badge is on the button rather than only inside the menu: the
              whole point of a count is being seen without opening anything. */}
          {totalMentions > 0 && <View style={styles.headerDot} />}
        </Pressable>
      ),
      headerRight: () => (
        <Pressable
          onPress={() => router.push('/search')}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Search"
        >
          <Text style={styles.headerGlyph}>🔍</Text>
        </Pressable>
      ),
    });
  }, [navigation, drawer, router, totalMentions]);

  const sections = useMemo(
    () =>
      guilds.map((guild) => ({
        title: guild.name,
        data: [...guild.channels].sort((a, b) => a.position - b.position),
      })),
    [guilds],
  );

  const onlineCount = useMemo(
    () => members.filter((m) => onlineIds.has(m.user.id)).length,
    [members, onlineIds],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    // The session refetches guilds and members whenever the socket reconnects;
    // pulling down is for the case where somebody suspects it has not. A short
    // delay so the spinner is seen rather than flashing -- without it a fast
    // refresh looks like the gesture did nothing.
    await new Promise((r) => setTimeout(r, 350));
    setRefreshing(false);
  }, []);

  const open = useCallback(
    (channel: Channel) => {
      if (channel.kind !== 'TEXT') return;
      router.push(`/channel/${channel.id}` as never);
    },
    [router],
  );

  const showUpdate = update && dismissedUpdate !== update.versionCode;

  return (
    <View style={styles.flex}>
      {showUpdate && (
        <UpdateBanner
          version={update.version}
          onDismiss={() => setDismissedUpdate(update.versionCode)}
        />
      )}
      <ConnectionBanner status={status} restarting={restarting} />

      <SectionList
        sections={sections}
        keyExtractor={(channel) => channel.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.textMuted}
          />
        }
        ListHeaderComponent={
          me ? (
            <Pressable
              style={({ pressed }) => [styles.meRow, pressed && styles.pressed]}
              onPress={drawer.open}
              accessibilityRole="button"
              accessibilityLabel="Open menu"
            >
              <Avatar
                userId={me.id}
                name={me.displayName || me.username || '?'}
                image={me.image}
                size={36}
                online={status === 'connected'}
              />
              <View style={styles.meText}>
                <Text style={styles.meName} numberOfLines={1}>
                  {me.displayName || me.username}
                </Text>
                <Text style={styles.meMeta} numberOfLines={1}>
                  {onlineCount} online
                </Text>
              </View>
              <Text style={styles.meChevron}>›</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {status === 'connected'
              ? 'No channels here yet.'
              : 'Waiting for the server…'}
          </Text>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          const text = item.kind === 'TEXT';
          const unread = text && isUnread(item.id);
          const tags = text ? mentionsIn(item.id) : 0;

          return (
            <Pressable
              onPress={() => open(item)}
              disabled={!text}
              style={({ pressed }) => [
                styles.channel,
                pressed && text && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                `${item.name}${text ? '' : ', voice channel, not supported yet'}` +
                (tags ? `, ${tags} unread mentions` : unread ? ', unread' : '')
              }
            >
              <Text style={styles.channelIcon}>{channelIcon(item)}</Text>
              <Text
                style={[
                  styles.channelName,
                  !text && styles.channelDisabled,
                  unread && styles.channelUnread,
                ]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
              {tags > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{tags > 99 ? '99+' : tags}</Text>
                </View>
              )}
              {!text && <Text style={styles.soon}>voice</Text>}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  pressed: { backgroundColor: theme.surfaceAlt },

  headerButton: {
    minWidth: TAP_TARGET,
    height: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerGlyph: { color: theme.text, fontSize: 18 },
  headerDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 9,
    height: 9,
    borderRadius: radius.pill,
    backgroundColor: theme.danger,
    borderWidth: 1,
    borderColor: theme.surface,
  },

  meRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: theme.surface,
  },
  meText: { flex: 1 },
  meName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  meMeta: { color: theme.textMuted, fontSize: 12 },
  meChevron: { color: theme.textFaint, fontSize: 20 },

  sectionHeader: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    backgroundColor: theme.bg,
  },
  channel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  channelIcon: { color: theme.textFaint, fontSize: 15, width: 20 },
  channelName: { color: theme.textMuted, fontSize: 15, flex: 1 },
  // Unread is weight and colour rather than a dot in the margin: the whole row
  // is the thing being scanned, and a bold row is legible at arm's length in a
  // way a four-pixel dot is not.
  channelUnread: { color: theme.text, fontWeight: '700' },
  channelDisabled: { color: theme.textFaint },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: theme.danger,
    alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  soon: {
    color: theme.textFaint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    fontSize: 14,
  },
});
