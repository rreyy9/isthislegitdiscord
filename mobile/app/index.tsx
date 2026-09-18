import { useCallback, useMemo, useState } from 'react';
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
import { useLayoutEffect } from 'react';
import { ConnectionBanner, UpdateBanner } from '../src/components/Banners';
import { Avatar } from '../src/components/Avatar';
import { useSession } from '../src/session';
import { channelIcon, personName } from '../src/format';
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
 * Voice channels are listed but not joinable. They are drawn rather than
 * filtered out because a channel list that silently omits half the channels
 * looks like a sync bug; drawn and dimmed, it reads as "not yet", which is
 * what it is.
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
    signOut,
  } = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [refreshing, setRefreshing] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState<number | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={signOut} hitSlop={12} style={styles.signOut}>
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
      ),
    });
  }, [navigation, signOut]);

  const sections = useMemo(
    () =>
      guilds.map((guild) => ({
        title: guild.name,
        data: [...guild.channels].sort((a, b) => a.position - b.position),
      })),
    [guilds],
  );

  const onlineMembers = useMemo(
    () => members.filter((m) => onlineIds.has(m.user.id)),
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
      router.push(`/channel/${channel.id}`);
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
            <View style={styles.meRow}>
              <Avatar
                userId={me.id}
                name={me.displayName || me.username || '?'}
                image={me.image}
                size={36}
                online
              />
              <View style={styles.meText}>
                <Text style={styles.meName} numberOfLines={1}>
                  {me.displayName || me.username}
                </Text>
                <Text style={styles.meMeta} numberOfLines={1}>
                  {onlineMembers.length} online
                </Text>
              </View>
            </View>
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
          return (
            <Pressable
              onPress={() => open(item)}
              disabled={!text}
              style={({ pressed }) => [
                styles.channel,
                pressed && text && styles.channelPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}${text ? '' : ', voice channel, not supported yet'}`}
            >
              <Text style={styles.channelIcon}>{channelIcon(item)}</Text>
              <Text
                style={[styles.channelName, !text && styles.channelDisabled]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
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
  channelPressed: { backgroundColor: theme.surfaceAlt },
  channelIcon: { color: theme.textFaint, fontSize: 15, width: 20 },
  channelName: { color: theme.text, fontSize: 15, flex: 1 },
  channelDisabled: { color: theme.textFaint },
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
  signOut: { paddingHorizontal: spacing.sm },
  signOutLabel: { color: theme.accent, fontSize: 14 },
});
