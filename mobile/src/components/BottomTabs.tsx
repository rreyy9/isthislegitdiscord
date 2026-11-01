import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSession } from '../session';
import { radius, spacing, theme } from '../theme';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';

/**
 * The bar along the bottom of the two top-level screens: Channels, Messages,
 * and you.
 *
 * Three equal thirds, each a full-height tap target, in place of the profile
 * strip that used to sit here -- the profile is the third tab, so nothing it
 * offered has gone. Channels and Messages replace each other rather than
 * stacking, so moving between them never builds up a back history; Settings
 * is pushed, because it is somewhere you go and come back from.
 */
export function BottomTabs({
  active,
  bottomInset,
}: {
  active: 'channels' | 'messages';
  bottomInset: number;
}) {
  const router = useRouter();
  const { me, status, totalMentions, dmUnread } = useSession();
  const channelPings = Math.max(0, totalMentions - dmUnread);

  return (
    <View style={[styles.bar, { paddingBottom: bottomInset }]}>
      <Tab
        icon="pound"
        label="Channels"
        on={active === 'channels'}
        badge={channelPings}
        onPress={() => active !== 'channels' && router.replace('/')}
      />
      <Tab
        icon="message-text-outline"
        label="Messages"
        on={active === 'messages'}
        badge={dmUnread}
        onPress={() => active !== 'messages' && router.replace('/dms' as never)}
      />
      <Pressable
        style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
        onPress={() => router.push('/settings')}
        accessibilityRole="button"
        accessibilityLabel="Your profile and settings"
      >
        {me ? (
          <Avatar
            userId={me.id}
            name={me.displayName || me.username || '?'}
            image={me.image}
            size={24}
            online={status === 'connected'}
            ringColor={theme.surface}
          />
        ) : (
          <Icon name="cog-outline" size={24} />
        )}
        <Text style={styles.label}>You</Text>
      </Pressable>
    </View>
  );
}

function Tab({
  icon,
  label,
  on,
  badge,
  onPress,
}: {
  icon: IconName;
  label: string;
  on: boolean;
  badge: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={badge > 0 ? `${label}, ${badge} unread` : label}
    >
      <View>
        <Icon name={icon} size={24} color={on ? theme.accent : theme.textMuted} />
        {badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
      </View>
      <Text style={[styles.label, on && styles.labelOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    minHeight: 56,
  },
  pressed: { backgroundColor: theme.surfaceAlt },
  label: { color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  labelOn: { color: theme.accent },
  badge: {
    position: 'absolute',
    top: -4,
    right: -12,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: theme.danger,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: theme.surface,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
});
