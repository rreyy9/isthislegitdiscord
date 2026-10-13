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
import {
  ChannelRow,
  SectionHeader,
  useChannelSections,
} from '../src/components/ChannelList';
import { useDrawer, useSwipeToOpenDrawer } from '../src/components/Drawer';
import { Icon } from '../src/components/Icon';
import { ServerMark, UserBar, useServerName } from '../src/components/Identity';
import { VoiceSheet } from '../src/components/VoiceSheet';
import { useSession } from '../src/session';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';
import type { Channel } from '../src/types';

/**
 * The channel list: this app's home.
 *
 * Almost everything that used to be reachable only from here now lives in the
 * drawer, which is reachable from inside a channel too. What this screen keeps
 * is being the place the app opens to, and the place the back gesture comes
 * back to -- so it is worth it being the same list, rather than a home screen
 * that shows something else. Both draw it through `ChannelList`, so the two
 * cannot disagree about what is unread.
 *
 * Voice channels show who is in them, one person per line. Tapping one opens a
 * sheet with the same people bigger; nothing joins a call from a phone, and
 * the sheet says where calls happen instead of offering a button that cannot.
 */

export default function Channels() {
  const {
    guilds,
    members,
    onlineIds,
    status,
    restarting,
    update,
    dismissedUpdate,
    dismissUpdate,
    totalMentions,
    inVoiceCount,
  } = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const drawer = useDrawer();
  const swipe = useSwipeToOpenDrawer();
  const insets = useSafeAreaInsets();
  const serverName = useServerName();
  const sections = useChannelSections();

  const [refreshing, setRefreshing] = useState(false);
  const [voiceFor, setVoiceFor] = useState<Channel | null>(null);

  const onlineCount = useMemo(
    () => members.filter((m) => onlineIds.has(m.user.id)).length,
    [members, onlineIds],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.title}>
          {guilds.length === 1 && <ServerMark name={serverName} size={30} />}
          <View style={styles.titleText}>
            <Text style={styles.titleName} numberOfLines={1}>
              {serverName}
            </Text>
            <Text style={styles.titleMeta} numberOfLines={1}>
              {status === 'connected'
                ? `${onlineCount} online` +
                  (inVoiceCount > 0 ? ` · ${inVoiceCount} in voice` : '')
                : status === 'connecting'
                  ? 'Connecting…'
                  : 'Offline'}
            </Text>
          </View>
        </View>
      ),
      headerLeft: () => (
        <Pressable
          onPress={() => drawer.open()}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel={
            totalMentions > 0
              ? `Open menu, ${totalMentions} unread mentions`
              : 'Open menu'
          }
        >
          <Icon name="menu" size={24} color={theme.text} />
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
          <Icon name="magnify" size={24} color={theme.text} />
        </Pressable>
      ),
    });
  }, [
    navigation,
    drawer,
    router,
    totalMentions,
    guilds.length,
    serverName,
    status,
    onlineCount,
    inVoiceCount,
  ]);

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
      if (channel.kind === 'VOICE') {
        setVoiceFor(channel);
        return;
      }
      router.push(`/channel/${channel.id}` as never);
    },
    [router],
  );

  /**
   * Whether to interrupt somebody with the banner.
   *
   * Greater-than and not inequality, so dismissing 403 stays dismissed when
   * 403 is re-announced on every reconnect, and stops applying the moment 404
   * is published. `undefined` is the dismissal not having been read back yet,
   * and draws nothing for the frame or two that takes -- a banner that appears
   * and then removes itself is worse than one that arrives a moment late.
   *
   * Dismissing hides only this; Settings goes on offering the download.
   */
  const showUpdate =
    update !== null &&
    dismissedUpdate !== undefined &&
    update.versionCode > (dismissedUpdate ?? 0);

  return (
    <View style={styles.flex} {...swipe}>
      {showUpdate && (
        <UpdateBanner version={update.version} onDismiss={dismissUpdate} />
      )}
      <ConnectionBanner status={status} restarting={restarting} />

      <SectionList
        sections={sections}
        keyExtractor={(channel) => channel.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.textMuted}
          />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {status === 'connected'
              ? 'No channels here yet.'
              : 'Waiting for the server…'}
          </Text>
        }
        renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
        renderItem={({ item }) => (
          <ChannelRow
            channel={item}
            occupants="list"
            surface={theme.bg}
            onOpen={open}
          />
        )}
      />

      <UserBar
        onPress={() => router.push('/settings')}
        surface={theme.surface}
        bottomInset={insets.bottom}
      />

      <VoiceSheet channel={voiceFor} onClose={() => setVoiceFor(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  listContent: { paddingBottom: spacing.lg },

  title: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleText: { flexShrink: 1 },
  titleName: { color: theme.text, fontSize: 16, fontWeight: '700' },
  titleMeta: { color: theme.textMuted, fontSize: 12 },

  headerButton: {
    minWidth: TAP_TARGET,
    height: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
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

  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    fontSize: 14,
  },
});
