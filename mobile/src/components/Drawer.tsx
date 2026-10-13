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
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderHandlers,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lastSeenLabel, personName } from '../format';
import { useSession } from '../session';
import { radius, spacing, TAP_TARGET, theme } from '../theme';
import type { Channel, Member } from '../types';
import { Avatar } from './Avatar';
import { ChannelRow, SectionHeader, useChannelSections } from './ChannelList';
import { Icon } from './Icon';
import { ServerMark, UserBar, useServerName } from './Identity';
import { Sheet, SheetDivider, SheetRow } from './Sheet';
import { VoiceSheet } from './VoiceSheet';

/**
 * The hamburger menu: channels, who is here, and the way to everything else.
 *
 * This is the app's navigation, and it is a panel rather than a route for one
 * reason above all the others -- it has to be reachable from inside a channel
 * without leaving it. Going "back to the channel list, then into another
 * channel" is two screens of animation to do the single most common thing
 * anybody does in a chat client.
 *
 * It is *not* `expo-router`'s drawer, and that is not laziness. That drawer is
 * built on `react-native-gesture-handler` and `react-native-reanimated`, and
 * this app excludes the first from its native build on purpose: its C++ codegen
 * produces object-file paths past the 260 characters ninja refuses, which is
 * the single most expensive problem this project has hit. The README said "add
 * a drawer and this comes back with it" -- so this is the drawer that does not.
 *
 * The slide, the backdrop, tap-away and the back button are `Modal` and
 * `Animated`. The swipes are `PanResponder`, which is React Native's own
 * responder system rather than gesture-handler's: a rightward swipe across a
 * screen opens the panel, a leftward one across the panel closes it. Neither
 * follows the finger the way a gesture-handler drawer would -- it is a flick
 * that triggers the same animation as the button -- and neither starts at the
 * very edge of the screen, because on a phone using gesture navigation that
 * edge belongs to Android's own back swipe and the system wins every time.
 */

type DrawerTab = 'channels' | 'people';

interface DrawerValue {
  /** Open the panel, on a particular tab if asked; otherwise where it was left. */
  open: (tab?: DrawerTab) => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerValue | null>(null);

/**
 * The hamburger button's other half. A no-op outside the provider, so a screen
 * rendered somewhere unexpected loses the menu rather than crashing.
 */
export function useDrawer(): DrawerValue {
  return useContext(DrawerContext) ?? { open: () => {}, close: () => {} };
}

/**
 * How far, how straight and how fast a swipe has to be before it counts.
 *
 * Deliberately strict. The screens this is spread on are mostly a vertical list
 * that people scroll constantly, and a drawer that opened on a slightly diagonal
 * scroll would be the most annoying thing in the app. A swipe that is clearly
 * sideways, clearly rightward and clearly meant is the only thing that opens it.
 */
const SWIPE_MIN_DX = 60;
const SWIPE_MAX_SLOPE = 0.5;
const SWIPE_MIN_VX = 0.2;
/** The strip down the left edge that is left alone for Android's back swipe. */
const SYSTEM_EDGE = 24;

/**
 * Handlers that open the drawer on a rightward swipe, to spread on a screen's
 * root view.
 *
 * `onMoveShouldSetPanResponder` and never the capture variant: anything inside
 * that wants the touch -- a horizontal scroller, a video's scrubber, a web
 * embed -- is asked first and keeps it.
 */
export function useSwipeToOpenDrawer(): GestureResponderHandlers {
  const { open } = useDrawer();
  const openRef = useRef(open);
  openRef.current = open;

  return useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (e, g) =>
          e.nativeEvent.pageX - g.dx > SYSTEM_EDGE &&
          g.dx > 16 &&
          Math.abs(g.dy) < g.dx * SWIPE_MAX_SLOPE,
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_e, g) => {
          if (
            g.dx > SWIPE_MIN_DX &&
            Math.abs(g.dy) < g.dx * SWIPE_MAX_SLOPE &&
            g.vx > SWIPE_MIN_VX
          ) {
            openRef.current();
          }
        },
      }).panHandlers,
    [],
  );
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<DrawerTab>('channels');
  const open = useCallback((which?: DrawerTab) => {
    if (which) setTab(which);
    setVisible(true);
  }, []);
  const close = useCallback(() => setVisible(false), []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <DrawerContext.Provider value={value}>
      {children}
      <DrawerPanel visible={visible} onClose={close} tab={tab} onTab={setTab} />
    </DrawerContext.Provider>
  );
}

/* --------------------------------------------------------------- panel */

/** How much of the screen the panel takes, and how much is left as backdrop. */
const PANEL_FRACTION = 0.86;
const PANEL_MAX_WIDTH = 360;

function DrawerPanel({
  visible,
  onClose,
  tab,
  onTab,
}: {
  visible: boolean;
  onClose: () => void;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { guilds, members, onlineIds, status, serverUrl } = useSession();
  const serverName = useServerName();
  const sections = useChannelSections();

  const panelWidth = Math.min(width * PANEL_FRACTION, PANEL_MAX_WIDTH);
  const slide = useRef(new Animated.Value(0)).current;
  const [member, setMember] = useState<Member | null>(null);
  const [voiceFor, setVoiceFor] = useState<Channel | null>(null);

  /** The channel on screen, so its row can be drawn as the one you are in. */
  const activeId = pathname.startsWith('/channel/')
    ? pathname.slice('/channel/'.length).split(/[/?]/)[0]
    : null;

  useEffect(() => {
    if (!visible) {
      slide.setValue(0);
      return;
    }
    Animated.timing(slide, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  /** A leftward flick across the panel closes it -- the same swipe, reversed. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const swipeClosed = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          g.dx < -16 && Math.abs(g.dy) < -g.dx * SWIPE_MAX_SLOPE,
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_e, g) => {
          if (
            g.dx < -SWIPE_MIN_DX &&
            Math.abs(g.dy) < -g.dx * SWIPE_MAX_SLOPE &&
            g.vx < -SWIPE_MIN_VX
          ) {
            onCloseRef.current();
          }
        },
      }).panHandlers,
    [],
  );

  /**
   * People, online first and alphabetical within each half.
   *
   * The same sort the desktop roster uses. Online-first matters more on a phone
   * than it does in a column beside the conversation: this list is behind a tap,
   * so whoever is actually around has to be in the part of it that is visible
   * without scrolling.
   */
  const people = useMemo(() => {
    const withPresence = members.map((m) => ({
      member: m,
      online: onlineIds.has(m.user.id),
    }));
    return withPresence.sort((a, b) =>
      a.online === b.online
        ? personName(a.member.user).localeCompare(personName(b.member.user))
        : a.online
          ? -1
          : 1,
    );
  }, [members, onlineIds]);

  const onlineCount = people.filter((p) => p.online).length;

  /** A minute clock, so "last seen 3m ago" does not sit there saying 3m. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || tab !== 'people') return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [visible, tab]);

  function go(path: string) {
    onClose();
    router.push(path as never);
  }

  const openChannel = useCallback(
    (channel: Channel) => {
      if (channel.kind === 'VOICE') {
        // The drawer stays open underneath, as it does for a member: the sheet
        // is a glance, and closing it should land back in the list it came
        // from rather than in whatever screen was behind the drawer.
        setVoiceFor(channel);
        return;
      }
      onClose();
      // `navigate` rather than `push`: this menu is reachable *from* a channel,
      // so pushing would stack a second copy of the same screen every time
      // somebody opened the menu and tapped where they already were -- and the
      // back gesture would then walk through every channel visited rather than
      // out to the list.
      router.navigate(`/channel/${channel.id}` as never);
    },
    [onClose, router],
  );

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
        statusBarTranslucent
      >
        <View style={styles.wrap}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityLabel="Close menu"
          />

          <Animated.View
            {...swipeClosed}
            style={[
              styles.panel,
              {
                width: panelWidth,
                paddingTop: insets.top,
                transform: [
                  {
                    translateX: slide.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-panelWidth, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            {/* --------------------------------------------- which server */}
            <View style={styles.server}>
              {guilds.length === 1 && <ServerMark name={serverName} size={36} />}
              <View style={styles.serverText}>
                <Text style={styles.serverName} numberOfLines={1}>
                  {serverName}
                </Text>
                <Text style={styles.serverHost} numberOfLines={1}>
                  {serverUrl.replace(/^https?:\/\//, '')}
                </Text>
              </View>
            </View>

            {/* Search looks like a field because that is what it opens to.
                It is a button into the search screen rather than a real input
                here: results need the whole screen, and a field in a panel
                that then navigates away would lose its own text. */}
            <Pressable
              onPress={() => go('/search')}
              style={({ pressed }) => [styles.search, pressed && styles.pressed]}
              accessibilityRole="search"
              accessibilityLabel="Search messages"
            >
              <Icon name="magnify" size={18} color={theme.textFaint} />
              <Text style={styles.searchText}>Search</Text>
            </Pressable>

            {/* --------------------------------------------------- the tabs */}
            <View style={styles.tabs} accessibilityRole="tablist">
              <Tab
                label="Channels"
                active={tab === 'channels'}
                onPress={() => onTab('channels')}
              />
              <Tab
                label={`People · ${onlineCount}`}
                active={tab === 'people'}
                onPress={() => onTab('people')}
              />
            </View>

            {tab === 'channels' ? (
              <SectionList
                sections={sections}
                keyExtractor={(channel) => channel.id}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                stickySectionHeadersEnabled={false}
                renderSectionHeader={({ section }) => (
                  <SectionHeader title={section.title} />
                )}
                ListEmptyComponent={
                  <Text style={styles.empty}>
                    {status === 'connected'
                      ? 'No channels here yet.'
                      : 'Waiting for the server…'}
                  </Text>
                }
                renderItem={({ item }) => (
                  <ChannelRow
                    channel={item}
                    active={item.id === activeId}
                    occupants="stack"
                    surface={theme.surface}
                    onOpen={openChannel}
                  />
                )}
              />
            ) : (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
              >
                {people.length === 0 && (
                  <Text style={styles.empty}>Nobody here yet.</Text>
                )}
                {people.map(({ member: m, online }) => (
                  <Pressable
                    key={m.user.id}
                    onPress={() => setMember(m)}
                    style={({ pressed }) => [
                      styles.person,
                      pressed && styles.pressed,
                      !online && styles.personOffline,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`${personName(m.user)}, ${online ? 'online' : 'offline'}`}
                  >
                    <Avatar
                      userId={m.user.id}
                      name={personName(m.user)}
                      image={m.user.image}
                      size={32}
                      online={online}
                      ringColor={theme.surface}
                    />
                    <View style={styles.personText}>
                      <Text style={styles.personName} numberOfLines={1}>
                        {personName(m.user)}
                      </Text>
                      {/* Only while they are away, and only when the server has
                          ever seen them: "last seen" under somebody who is right
                          there is noise, and under somebody who has never signed
                          in it is a blank. */}
                      {!online && m.lastSeenAt && (
                        <Text style={styles.personSeen} numberOfLines={1}>
                          {lastSeenLabel(m.lastSeenAt, now)}
                        </Text>
                      )}
                    </View>
                    {m.role === 'ADMIN' && <Text style={styles.adminTag}>admin</Text>}
                    {m.mutedUntil && (
                      <Icon name="comment-off-outline" size={16} color={theme.textFaint} />
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {/* ------------------------------------------------------- you */}
            <UserBar
              onPress={() => go('/settings')}
              surface={theme.surface}
              bottomInset={insets.bottom}
            />
          </Animated.View>
        </View>
      </Modal>

      {/* Outside the drawer's own `Modal` rather than inside it. Two stacked
          modals on Android is a window over a window, and the inner one is
          drawn behind the outer one's dimming on some builds -- which reads as
          a sheet that opened blank. As a sibling it is simply the next window
          up. */}
      <MemberSheet member={member} onClose={() => setMember(null)} />
      <VoiceSheet channel={voiceFor} onClose={() => setVoiceFor(null)} />
    </>
  );
}

/* ---------------------------------------------------------------- bits */

function Tab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One person, tapped.
 *
 * Deliberately read-only. Everything the desktop roster's menu offers -- mute,
 * kick, ban -- is moderation, and moderation from a phone is its own piece of
 * work with its own confirmations; a "Ban" row one tap from a member list, on a
 * device people use one-handed on a train, is exactly the wrong place to put it
 * without those. What is here is the thing somebody actually opens a member for:
 * who they are and whether they are around.
 */
function MemberSheet({
  member,
  onClose,
}: {
  member: Member | null;
  onClose: () => void;
}) {
  const { onlineIds, voiceByChannel, channelById } = useSession();
  if (!member) return null;

  const online = onlineIds.has(member.user.id);
  const inVoice = Object.entries(voiceByChannel).find(([, ids]) =>
    ids.includes(member.user.id),
  );
  const voiceChannel = inVoice ? channelById(inVoice[0]) : null;

  return (
    <Sheet visible onClose={onClose}>
      <View style={styles.card}>
        <Avatar
          userId={member.user.id}
          name={personName(member.user)}
          image={member.user.image}
          size={64}
          online={online}
          ringColor={theme.surface}
        />
        <View style={styles.cardText}>
          <Text style={styles.cardName}>{personName(member.user)}</Text>
          {/* The handle, always, even when it is the same as the name. It is
              what an @ mention matches and it is the thing somebody opened this
              sheet to find out. */}
          <Text style={styles.cardHandle}>@{member.user.username}</Text>
          <Text style={styles.cardStatus}>
            {online
              ? 'Online'
              : member.lastSeenAt
                ? `Last seen ${lastSeenLabel(member.lastSeenAt, Date.now())}`
                : 'Offline'}
          </Text>
          {voiceChannel && (
            <View style={styles.cardVoice}>
              <Icon name="volume-high" size={14} color={theme.online} />
              <Text style={styles.cardVoiceText} numberOfLines={1}>
                In {voiceChannel.name}
              </Text>
            </View>
          )}
        </View>
      </View>
      <SheetDivider />
      <SheetRow icon="close" label="Close" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.border,
  },
  pressed: { backgroundColor: theme.surfaceAlt },

  server: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  serverText: { flex: 1 },
  serverName: { color: theme.text, fontSize: 16, fontWeight: '700' },
  serverHost: { color: theme.textFaint, fontSize: 12 },

  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 38,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.bg,
  },
  searchText: { color: theme.textFaint, fontSize: 14 },

  tabs: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    padding: 3,
    borderRadius: radius.md,
    backgroundColor: theme.bg,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm - 1,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: theme.surfaceAlt },
  tabLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: theme.text },

  list: { flex: 1 },
  listContent: { paddingBottom: spacing.md },

  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  personOffline: { opacity: 0.55 },
  personText: { flex: 1 },
  personName: { color: theme.text, fontSize: 14 },
  personSeen: { color: theme.textFaint, fontSize: 11 },
  adminTag: {
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

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  cardText: { flex: 1 },
  cardName: { color: theme.text, fontSize: 18, fontWeight: '700' },
  cardHandle: { color: theme.textMuted, fontSize: 13, marginTop: 1 },
  cardStatus: { color: theme.textFaint, fontSize: 12, marginTop: spacing.xs },
  cardVoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  cardVoiceText: { color: theme.online, fontSize: 12, flexShrink: 1 },
});
