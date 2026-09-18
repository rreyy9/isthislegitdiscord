import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '../api';
import { personName, stamp } from '../format';
import { spacing, theme } from '../theme';
import type { Message } from '../types';
import { Avatar } from './Avatar';
import { MessageContent } from './MessageContent';
import { Sheet } from './Sheet';

/**
 * The pin board for one channel.
 *
 * A sheet rather than a screen, because it is a reference and not a
 * destination: people open it to check what was agreed, glance, and carry on
 * typing. Pushing a route for that would put the conversation behind a back
 * gesture for something read mid-sentence.
 *
 * Newest post first, and every row stamped with the date it was *posted* -- not
 * the date it was pinned. What people look for on a board is when the thing was
 * said; pinning last March's message this morning must not put it above a
 * message from an hour ago.
 *
 * Every row is `textOnly`: a pin is a link to somewhere, and a video player
 * inside a control whose whole job is to be tapped is a control nobody can use.
 */

export interface PinsSheetProps {
  visible: boolean;
  channelId: string;
  channelName: string;
  /** Whether this account may take things off the board. Admins only. */
  canPin: boolean;
  meId: string;
  nameFor: (userId: string) => string | null;
  onJump: (messageId: string) => void;
  onUnpin: (message: Message) => void;
  onClose: () => void;
}

export function PinsSheet({
  visible,
  channelId,
  channelName,
  canPin,
  meId,
  nameFor,
  onJump,
  onUnpin,
  onClose,
}: PinsSheetProps) {
  /** Null until the first load lands; the sheet opens before its contents do. */
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Loaded when the sheet opens, and again every time it is reopened.
   *
   * Not cached across opens: the board is small, it is read rarely, and a stale
   * one is worse than a moment's wait -- somebody opening it a second time is
   * usually doing so because they have just pinned something.
   */
  useEffect(() => {
    if (!visible) {
      setPins(null);
      setError(null);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const rows = await api.pins(channelId);
        if (!cancelled) setPins(rows);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiError ? e.message : 'The pin board could not be loaded.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, channelId]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Pinned messages" tall>
      <ScrollView contentContainerStyle={styles.body}>
        {error && <Text style={styles.error}>{error}</Text>}
        {!pins && !error && <Text style={styles.hint}>Loading…</Text>}

        {pins?.length === 0 && (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyMark}>📌</Text>
            <Text style={styles.empty}>Nothing is pinned in #{channelName} yet.</Text>
            {canPin && (
              <Text style={styles.hint}>
                Hold a message and choose “Pin to channel” to put it here.
              </Text>
            )}
          </View>
        )}

        {pins?.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => onJump(m.id)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            accessibilityRole="button"
            accessibilityLabel={`Go to ${personName(m.author)}'s pinned message`}
          >
            <Avatar
              userId={m.author.id}
              name={personName(m.author)}
              image={m.author.image}
              size={32}
            />
            <View style={styles.rowBody}>
              <View style={styles.rowHead}>
                <Text style={styles.rowAuthor} numberOfLines={1}>
                  {personName(m.author)}
                </Text>
                {/* Every row carries its own date. The board is read out of
                    order by definition -- the whole list is old messages -- so
                    there is no separator above it to lean on. */}
                <Text style={styles.rowTime}>{stamp(m.createdAt)}</Text>
              </View>
              <MessageContent
                content={m.content}
                attachments={m.attachments}
                edited={Boolean(m.editedAt)}
                textOnly
                lookupMention={(id) => {
                  const name = nameFor(id);
                  return name ? { name, self: id === meId } : null;
                }}
              />
            </View>
            {canPin && (
              <Pressable
                onPress={() => {
                  // Or unpinning would also navigate to the message it just took
                  // off the board, which is the one place nobody wants to be
                  // sent.
                  onUnpin(m);
                  setPins((current) =>
                    current ? current.filter((p) => p.id !== m.id) : current,
                  );
                }}
                hitSlop={10}
                style={styles.unpin}
                accessibilityRole="button"
                accessibilityLabel="Unpin"
              >
                <Text style={styles.unpinLabel}>✕</Text>
              </Pressable>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  error: { color: theme.danger, fontSize: 13, padding: spacing.md },
  hint: { color: theme.textFaint, fontSize: 12, padding: spacing.md, textAlign: 'center' },
  emptyBox: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyMark: { fontSize: 30, marginBottom: spacing.sm },
  empty: { color: theme.textMuted, fontSize: 14, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: 8,
  },
  rowPressed: { backgroundColor: theme.surfaceAlt },
  rowBody: { flex: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  rowAuthor: { color: theme.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  rowTime: { color: theme.textFaint, fontSize: 11 },
  unpin: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  unpinLabel: { color: theme.textMuted, fontSize: 14 },
});
