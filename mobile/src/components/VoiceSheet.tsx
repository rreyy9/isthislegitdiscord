import { StyleSheet, Text, View } from 'react-native';
import { personName } from '../format';
import { useSession } from '../session';
import { radius, spacing, theme } from '../theme';
import type { Channel, PublicUser } from '../types';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/**
 * A voice channel, tapped: who is in it.
 *
 * Read-only, on purpose. The phone cannot join a call -- that needs LiveKit's
 * native SDK, a foreground service and audio focus, none of which are in this
 * build -- and a "Join" button that explained it could not join would be worse
 * than no button. What somebody opens a voice channel on their phone for is
 * whether their friends are on, and that is the whole of this sheet.
 *
 * Live: it reads the session's voice map on every render rather than taking a
 * snapshot, so somebody joining while it is open appears in it.
 */
export function VoiceSheet({
  channel,
  onClose,
}: {
  channel: Channel | null;
  onClose: () => void;
}) {
  const { voiceByChannel, userFor, onlineIds } = useSession();
  if (!channel) return null;

  const inside = voiceByChannel[channel.id] ?? [];
  const people = inside
    .map((id) => userFor(id))
    .filter((u): u is PublicUser => u !== null);
  const unknown = inside.length - people.length;

  return (
    <Sheet visible onClose={onClose}>
      <View style={styles.head}>
        <Icon
          name={channel.listenOnly ? 'volume-off' : 'volume-high'}
          size={22}
          color={inside.length > 0 ? theme.online : theme.textMuted}
        />
        <View style={styles.headText}>
          <Text style={styles.title} numberOfLines={1}>
            {channel.name}
          </Text>
          <Text style={styles.subtitle}>
            {inside.length === 0
              ? 'Nobody is in here right now'
              : inside.length === 1
                ? '1 person in voice'
                : `${inside.length} people in voice`}
            {channel.listenOnly ? ' · listen only' : ''}
          </Text>
        </View>
      </View>

      {people.length > 0 && (
        <View style={styles.faces}>
          {people.map((user) => (
            <View key={user.id} style={styles.face}>
              <Avatar
                userId={user.id}
                name={personName(user)}
                image={user.image}
                size={52}
                online={onlineIds.has(user.id)}
                ringColor={theme.surface}
              />
              <Text style={styles.faceName} numberOfLines={1}>
                {personName(user)}
              </Text>
            </View>
          ))}
          {unknown > 0 && (
            <View style={styles.face}>
              <View style={styles.more}>
                <Text style={styles.moreText}>+{unknown}</Text>
              </View>
              <Text style={styles.faceName}>others</Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.note}>
        <Icon name="monitor" size={18} color={theme.textMuted} />
        <Text style={styles.noteText}>
          Voice works in the desktop app. On your phone you can see who is
          here.
        </Text>
      </View>
    </Sheet>
  );
}

const FACE = 64;

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  headText: { flex: 1 },
  title: { color: theme.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: 13, marginTop: 1 },

  faces: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  face: { width: FACE, alignItems: 'center', gap: spacing.xs },
  faceName: { color: theme.text, fontSize: 12, maxWidth: FACE, textAlign: 'center' },
  more: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: { color: theme.textMuted, fontSize: 15, fontWeight: '700' },

  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surfaceAlt,
  },
  noteText: { color: theme.textMuted, fontSize: 13, flex: 1, lineHeight: 18 },
});
