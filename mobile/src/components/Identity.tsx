import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../session';
import { radius, spacing, TAP_TARGET, theme } from '../theme';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * The two "who" pieces both the home screen and the drawer draw: which server
 * this is, and who you are on it.
 */

/**
 * A server's mark: its initials on a rounded square.
 *
 * A square and not a circle, because circles are people everywhere else in the
 * app. Guilds have no picture of their own on this server, so initials are the
 * mark rather than the fallback for one.
 */
export function ServerMark({ name, size = 32 }: { name: string; size?: number }) {
  const initials =
    name
      .split(/[\s\-_]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
      .join('') || '?';
  return (
    <View
      style={[
        styles.mark,
        { width: size, height: size, borderRadius: Math.round(size * 0.3) },
      ]}
    >
      <Text style={[styles.markText, { fontSize: size * 0.38 }]}>{initials}</Text>
    </View>
  );
}

/** The guild's name, when there is one guild; a generic title otherwise. */
export function useServerName(): string {
  const { guilds } = useSession();
  return guilds.length === 1 ? guilds[0].name : 'Channels';
}

/**
 * You, along the bottom of a panel: face, name, connection, and the way into
 * Settings.
 *
 * At the bottom rather than the top because it is the thing reached for least,
 * and the bottom of a list is the part a thumb on a big phone reaches most
 * easily without it being in the way of the channels above.
 */
export function UserBar({
  onPress,
  surface,
  bottomInset,
}: {
  onPress: () => void;
  /** The panel this sits on, so the presence dot's ring matches it. */
  surface: string;
  bottomInset: number;
}) {
  const { me, status } = useSession();
  if (!me) return null;

  const name = me.displayName || me.username || '?';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.bar,
        { backgroundColor: surface, paddingBottom: bottomInset + spacing.sm },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel="Your profile and settings"
    >
      <Avatar
        userId={me.id}
        name={name}
        image={me.image}
        size={34}
        online={status === 'connected'}
        ringColor={surface}
      />
      <View style={styles.barText}>
        <Text style={styles.barName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.barMeta} numberOfLines={1}>
          {status === 'connected'
            ? 'Online'
            : status === 'connecting'
              ? 'Reconnecting…'
              : 'Offline'}
        </Text>
      </View>
      <View style={styles.gear}>
        <Icon name="cog-outline" size={22} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mark: {
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { color: theme.accentText, fontWeight: '700' },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  pressed: { opacity: 0.8 },
  barText: { flex: 1 },
  barName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  barMeta: { color: theme.textMuted, fontSize: 12 },
  gear: {
    width: TAP_TARGET,
    height: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
});
