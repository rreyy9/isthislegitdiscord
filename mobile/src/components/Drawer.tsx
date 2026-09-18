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
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { channelIcon, lastSeenLabel, personName } from '../format';
import { useSession } from '../session';
import { radius, spacing, TAP_TARGET, theme } from '../theme';
import type { Channel, Member } from '../types';
import { Avatar } from './Avatar';
import { Sheet, SheetDivider, SheetRow } from './Sheet';

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
 * What that costs is the edge swipe. Everything else -- the slide, the
 * backdrop, tap-away, the back button -- is `Modal` and `Animated`, both of
 * which are React Native itself.
 */

interface DrawerValue {
  open: () => void;
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

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <DrawerContext.Provider value={value}>
      {children}
      <DrawerPanel visible={visible} onClose={close} />
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
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    me,
    guilds,
    members,
    onlineIds,
    status,
    serverUrl,
    isUnread,
    mentionsIn,
  } = useSession();

  const panelWidth = Math.min(width * PANEL_FRACTION, PANEL_MAX_WIDTH);
  const slide = useRef(new Animated.Value(0)).current;
  const [showing, setShowing] = useState<'channels' | 'people'>('channels');
  const [member, setMember] = useState<Member | null>(null);

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

  /**
   * Channels, by guild, in the server's order.
   *
   * `position` and not the name: it is the ordering the server decides and the
   * one the desktop sidebar draws. Two clients disagreeing about the order of
   * the channel list would be immediately obvious and immediately annoying.
   */
  const sections = useMemo(
    () =>
      guilds.map((guild) => ({
        title: guild.name,
        data: [...guild.channels].sort((a, b) => a.position - b.position),
      })),
    [guilds],
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
    if (!visible || showing !== 'people') return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [visible, showing]);

  function go(path: string) {
    onClose();
    router.push(path as never);
  }

  function openChannel(channel: Channel) {
    if (channel.kind !== 'TEXT') return;
    onClose();
    // `navigate` rather than `push`: this menu is reachable *from* a channel, so
    // pushing would stack a second copy of the same screen every time somebody
    // opened the menu and tapped where they already were -- and the back gesture
    // would then walk through every channel visited rather than out to the list.
    router.navigate(`/channel/${channel.id}` as never);
  }

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
            {/* ------------------------------------------------ who you are */}
            <Pressable
              style={({ pressed }) => [styles.meRow, pressed && styles.pressed]}
              onPress={() => go('/settings')}
              accessibilityRole="button"
              accessibilityLabel="Your profile and settings"
            >
              {me && (
                <Avatar
                  userId={me.id}
                  name={me.displayName || me.username || '?'}
                  image={me.image}
                  size={40}
                  online={status === 'connected'}
                />
              )}
              <View style={styles.meText}>
                <Text style={styles.meName} numberOfLines={1}>
                  {me?.displayName || me?.username || 'Signed out'}
                </Text>
                <Text style={styles.meMeta} numberOfLines={1}>
                  {status === 'connected'
                    ? `${onlineCount} online`
                    : status === 'connecting'
                      ? 'Reconnecting…'
                      : 'Offline'}
                </Text>
              </View>
              <Text style={styles.gear}>⚙</Text>
            </Pressable>

            {/* --------------------------------------------------- the tabs */}
            <View style={styles.tabs}>
              <Tab
                label="Channels"
                active={showing === 'channels'}
                onPress={() => setShowing('channels')}
              />
              <Tab
                label={`People · ${onlineCount}`}
                active={showing === 'people'}
                onPress={() => setShowing('people')}
              />
            </View>

            {showing === 'channels' ? (
              <SectionList
                sections={sections}
                keyExtractor={(channel) => channel.id}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                stickySectionHeadersEnabled={false}
                renderSectionHeader={({ section }) => (
                  <Text style={styles.sectionHeader}>{section.title}</Text>
                )}
                ListEmptyComponent={
                  <Text style={styles.empty}>
                    {status === 'connected'
                      ? 'No channels here yet.'
                      : 'Waiting for the server…'}
                  </Text>
                }
                renderItem={({ item }) => {
                  const text = item.kind === 'TEXT';
                  const unread = text && isUnread(item.id);
                  const tags = text ? mentionsIn(item.id) : 0;
                  return (
                    <Pressable
                      onPress={() => openChannel(item)}
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
                          // Unread is weight and colour rather than a dot in the
                          // margin: the whole row is the thing being scanned, and
                          // a bold row is legible at arm's length in a way a
                          // four-pixel dot is not.
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
                    {m.mutedUntil && <Text style={styles.mutedTag}>🔇</Text>}
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {/* ------------------------------------------------- the bottom */}
            <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
              <FooterButton label="Search" icon="🔍" onPress={() => go('/search')} />
              <FooterButton label="Settings" icon="⚙" onPress={() => go('/settings')} />
            </View>
            <Text style={styles.server} numberOfLines={1}>
              {serverUrl.replace(/^https?:\/\//, '')}
            </Text>
          </Animated.View>
        </View>
      </Modal>

      {/* Outside the drawer's own `Modal` rather than inside it. Two stacked
          modals on Android is a window over a window, and the inner one is
          drawn behind the outer one's dimming on some builds -- which reads as
          a sheet that opened blank. As a sibling it is simply the next window
          up. */}
      <MemberSheet member={member} onClose={() => setMember(null)} />
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

function FooterButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.footerButton, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.footerIcon}>{icon}</Text>
      <Text style={styles.footerLabel}>{label}</Text>
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
  const { onlineIds } = useSession();
  if (!member) return null;

  const online = onlineIds.has(member.user.id);

  return (
    <Sheet visible onClose={onClose}>
      <View style={styles.card}>
        <Avatar
          userId={member.user.id}
          name={personName(member.user)}
          image={member.user.image}
          size={64}
          online={online}
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
        </View>
      </View>
      <SheetDivider />
      <SheetRow
        icon="✕"
        label="Close"
        onPress={onClose}
      />
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

  meRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  meText: { flex: 1 },
  meName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  meMeta: { color: theme.textMuted, fontSize: 12 },
  gear: { color: theme.textMuted, fontSize: 18 },

  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: theme.surfaceAlt },
  tabLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: theme.text },

  list: { flex: 1 },
  listContent: { paddingBottom: spacing.md },
  sectionHeader: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
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
  mutedTag: { fontSize: 12 },

  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    fontSize: 14,
  },

  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  footerButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: TAP_TARGET,
    borderRadius: radius.sm,
  },
  footerIcon: { fontSize: 15 },
  footerLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  server: {
    color: theme.textFaint,
    fontSize: 10,
    textAlign: 'center',
    paddingBottom: spacing.sm,
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
});
